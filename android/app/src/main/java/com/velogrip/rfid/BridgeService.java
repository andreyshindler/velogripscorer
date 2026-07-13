package com.velogrip.rfid;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.NetworkRequest;
import android.net.wifi.WifiNetworkSpecifier;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;

import com.velogrip.rfid.db.RaceStore;
import com.velogrip.rfid.net.Uploader;
import com.velogrip.rfid.protocol.AsciiLineParser;
import com.velogrip.rfid.protocol.LlrpEngine;
import com.velogrip.rfid.protocol.TagParser;
import com.velogrip.rfid.protocol.UhfFrameParser;

import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Random;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;

/**
 * Foreground service that bridges the RFID reader to the scoring platform:
 *
 *   [RFID reader] --TCP over reader WiFi--> [this service] --HTTPS--> [server]
 *
 * When a WiFi SSID is configured (Android 10+), the service requests that
 * network with a WifiNetworkSpecifier and binds only the reader socket to it,
 * so the phone keeps cellular/internet for uploads while talking to the
 * reader's router on a network that has no internet access.
 */
public class BridgeService extends Service {

    public static final String ACTION_START = "com.velogrip.rfid.START";
    public static final String ACTION_STOP = "com.velogrip.rfid.STOP";
    public static final String ACTION_STATUS = "com.velogrip.rfid.STATUS";

    public static final String EXTRA_RUNNING = "running";
    public static final String EXTRA_READER_CONNECTED = "readerConnected";
    public static final String EXTRA_WIFI_STATE = "wifiState";
    public static final String EXTRA_PENDING = "pending";
    public static final String EXTRA_UPLOADED = "uploaded";
    public static final String EXTRA_LAST_EPC = "lastEpc";
    public static final String EXTRA_LOG = "log";

    private static final String CHANNEL_ID = "bridge";
    private static final int NOTIFICATION_ID = 1;
    private static final int UPLOAD_INTERVAL_MS = 3000;
    private static final int BATCH_SIZE = 200;

    private final AtomicBoolean running = new AtomicBoolean(false);
    private final AtomicBoolean readerConnected = new AtomicBoolean(false);
    private final AtomicLong uploadedTotal = new AtomicLong(0);
    private final AtomicReference<Network> readerNetwork = new AtomicReference<>(null);
    private final AtomicReference<String> wifiState = new AtomicReference<>("default");
    private final Map<String, Long> lastSeen = new HashMap<>();
    private volatile java.util.Set<String> registeredEpcs = java.util.Collections.emptySet();
    private volatile java.util.Map<String, String> epcRacer = java.util.Collections.emptyMap();
    private final java.util.Set<String> beepedRacers = new java.util.HashSet<>(); // reader thread only
    private long registeredAt = 0;
    private android.media.ToneGenerator tone;

    private Prefs prefs;
    private RaceStore store;
    private Thread readerThread;
    private Thread uploadThread;
    private ConnectivityManager.NetworkCallback wifiCallback;
    private PowerManager.WakeLock wakeLock;
    private volatile Socket readerSocket;

    @Override
    public void onCreate() {
        super.onCreate();
        prefs = new Prefs(this);
        store = new RaceStore(this);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent != null ? intent.getAction() : ACTION_START;
        if (ACTION_STOP.equals(action)) {
            stopBridge();
            stopSelf();
            return START_NOT_STICKY;
        }
        startBridge();
        return START_STICKY;
    }

    private void startBridge() {
        if (!running.compareAndSet(false, true)) return;
        startForeground(NOTIFICATION_ID, buildNotification(getString(R.string.notif_starting)));

        PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "velogrip:bridge");
        wakeLock.acquire();

        requestReaderWifi();

        readerThread = new Thread(this::readerLoop, "reader");
        readerThread.start();
        uploadThread = new Thread(this::uploadLoop, "uploader");
        uploadThread.start();
        broadcastStatus(getString(R.string.log_started));
    }

    private void stopBridge() {
        if (!running.compareAndSet(true, false)) return;
        closeSocket();
        if (readerThread != null) readerThread.interrupt();
        if (uploadThread != null) uploadThread.interrupt();
        if (wifiCallback != null) {
            ConnectivityManager cm = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
            try {
                cm.unregisterNetworkCallback(wifiCallback);
            } catch (IllegalArgumentException ignored) { }
            wifiCallback = null;
        }
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        if (tone != null) { tone.release(); tone = null; }
        readerConnected.set(false);
        broadcastStatus(getString(R.string.log_stopped));
        stopForeground(true);
    }

    // ---- Reader WiFi binding (local-only network, phone keeps internet) ----

    private void requestReaderWifi() {
        String ssid = prefs.wifiSsid();
        if (ssid.isEmpty()) {
            wifiState.set("default");
            return;
        }
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            // Pre-Android 10: user must join the reader WiFi manually in system settings.
            wifiState.set("manual");
            broadcastStatus(getString(R.string.log_wifi_manual, ssid));
            return;
        }
        wifiState.set("requesting");
        WifiNetworkSpecifier.Builder spec = new WifiNetworkSpecifier.Builder().setSsid(ssid);
        if (!prefs.wifiPass().isEmpty()) spec.setWpa2Passphrase(prefs.wifiPass());
        NetworkRequest request = new NetworkRequest.Builder()
                .addTransportType(NetworkCapabilities.TRANSPORT_WIFI)
                .removeCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                .setNetworkSpecifier(spec.build())
                .build();
        final ConnectivityManager cm = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
        wifiCallback = new ConnectivityManager.NetworkCallback() {
            @Override
            public void onAvailable(Network network) {
                readerNetwork.set(network);
                wifiState.set("connected");
                broadcastStatus(getString(R.string.log_wifi_connected, prefs.wifiSsid()));
                closeSocket(); // force reconnect through the reader network
            }

            @Override
            public void onLost(Network network) {
                readerNetwork.compareAndSet(network, null);
                wifiState.set("lost");
                broadcastStatus(getString(R.string.log_wifi_lost));
                closeSocket();
            }

            @Override
            public void onUnavailable() {
                wifiState.set("unavailable");
                broadcastStatus(getString(R.string.log_wifi_unavailable));
            }
        };
        cm.requestNetwork(request, wifiCallback);
    }

    // ---- Reader connection loop ----

    private void readerLoop() {
        if (Prefs.PROTOCOL_DEMO.equals(prefs.protocol())) {
            demoLoop();
            return;
        }
        int backoffMs = 1000;
        while (running.get()) {
            try {
                // If a specific reader WiFi was requested, wait until it is up.
                if (!prefs.wifiSsid().isEmpty() && Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q
                        && readerNetwork.get() == null) {
                    Thread.sleep(500);
                    continue;
                }
                connectAndRead();
                backoffMs = 1000;
            } catch (InterruptedException e) {
                return;
            } catch (Exception e) {
                readerConnected.set(false);
                broadcastStatus(getString(R.string.log_reader_error, shortMessage(e)));
                try {
                    Thread.sleep(backoffMs);
                } catch (InterruptedException ie) {
                    return;
                }
                backoffMs = Math.min(backoffMs * 2, 15_000);
            }
        }
    }

    private void connectAndRead() throws Exception {
        boolean isLlrp = Prefs.PROTOCOL_LLRP.equals(prefs.protocol());
        LlrpEngine llrp = isLlrp ? new LlrpEngine() : null;
        TagParser parser = isLlrp ? llrp
                : Prefs.PROTOCOL_UHF.equals(prefs.protocol()) ? new UhfFrameParser()
                : new AsciiLineParser();

        Network network = readerNetwork.get();
        Socket socket = network != null
                ? network.getSocketFactory().createSocket()
                : new Socket();
        readerSocket = socket;
        socket.connect(new InetSocketAddress(prefs.readerHost(), prefs.readerPort()), 8000);
        socket.setSoTimeout(2000);
        readerConnected.set(true);
        broadcastStatus(getString(R.string.log_reader_connected,
                prefs.readerHost() + ":" + prefs.readerPort()));

        InputStream in = socket.getInputStream();
        OutputStream out = socket.getOutputStream();

        if (isLlrp) {
            // LLRP handshake: clear old ROSpecs, install ours, start inventory.
            out.write(llrp.onConnect());
            out.flush();
        } else {
            byte[] onConnect = hexToBytes(prefs.onConnectHex());
            if (onConnect.length > 0) {
                out.write(onConnect);
                out.flush();
            }
        }
        byte[] poll = isLlrp ? new byte[0] : hexToBytes(prefs.pollHex());
        long lastPoll = 0;

        byte[] buf = new byte[4096];
        while (running.get() && !socket.isClosed()) {
            if (poll.length > 0 && System.currentTimeMillis() - lastPoll >= prefs.pollIntervalMs()) {
                out.write(poll);
                out.flush();
                lastPoll = System.currentTimeMillis();
            }
            int n;
            try {
                n = in.read(buf);
            } catch (java.net.SocketTimeoutException timeout) {
                continue; // idle: loop to honor poll schedule and running flag
            }
            if (n < 0) throw new java.io.EOFException("reader closed the connection");
            if (n > 0) {
                handleReads(parser.feed(buf, n));
                if (isLlrp) {
                    byte[] pending = llrp.takeOutbound(); // keepalive ACKs
                    if (pending.length > 0) {
                        out.write(pending);
                        out.flush();
                    }
                }
            }
        }
    }

    private void demoLoop() {
        // Demo mode: emits fake tag reads so the whole pipeline (queue, upload,
        // live web view) can be tested before the reader hardware is on site.
        readerConnected.set(true);
        broadcastStatus(getString(R.string.log_demo));
        String[] epcs = {"E280116060000201DEMO0001", "E280116060000201DEMO0002",
                "E280116060000201DEMO0003"};
        Random random = new Random();
        TagParser parser = new AsciiLineParser();
        while (running.get()) {
            try {
                Thread.sleep(1500 + random.nextInt(2000));
            } catch (InterruptedException e) {
                return;
            }
            String line = epcs[random.nextInt(epcs.length)] + ",-" + (40 + random.nextInt(40)) + "\n";
            byte[] bytes = line.getBytes();
            handleReads(parser.feed(bytes, bytes.length));
        }
    }

    private void handleReads(List<TagRead> reads) {
        long now = System.currentTimeMillis();
        int window = prefs.dedupeWindowMs();
        for (TagRead read : reads) {
            if (!registered(read.epc)) continue;               // ignore tags not on the start list
            Long prev = lastSeen.get(read.epc);
            if (prev != null && now - prev < window) continue; // same tag within window
            lastSeen.put(read.epc, now);
            store.addPassing(read);
            // Beep once the first time each racer is detected — not on every read.
            String racerKey = epcRacer.get(read.epc);
            if (racerKey == null) racerKey = "e:" + read.epc; // no roster: key by chip
            if (beepedRacers.add(racerKey)) beep();
            Intent status = statusIntent(null);
            status.putExtra(EXTRA_LAST_EPC, read.epc
                    + (read.rssi != null ? String.format(Locale.US, " (%.0f dBm)", read.rssi) : ""));
            sendBroadcast(status);
        }
        if (lastSeen.size() > 5000) lastSeen.clear(); // bounded memory at big events
    }

    /** Short confirmation beep for a detected chip; opt-out in Settings. */
    private void beep() {
        if (!prefs.beepOnRead()) return;
        try {
            android.media.ToneGenerator t = tone;
            if (t == null) {
                t = new android.media.ToneGenerator(
                        android.media.AudioManager.STREAM_NOTIFICATION, 90);
                tone = t;
            }
            t.startTone(android.media.ToneGenerator.TONE_PROP_BEEP, 120);
        } catch (RuntimeException e) {
            tone = null; // some devices throw if the audio resource is busy; skip this beep
        }
    }

    /** True if this chip belongs to a racer on the start list. Refreshed every
     *  few seconds so late edits take effect. When the start list is empty
     *  (e.g. building one by scanning) every tag is accepted. */
    private boolean registered(String epc) {
        long now = System.currentTimeMillis();
        if (now - registeredAt > 5000) {
            java.util.HashSet<String> set = new java.util.HashSet<>();
            java.util.HashMap<String, String> map = new java.util.HashMap<>();
            for (RaceStore.Racer r : store.racers()) {
                if (r.epc == null || r.epc.isEmpty()) continue;
                set.add(r.epc);
                // two chips share a racer: key by bib so both beep as one racer
                map.put(r.epc, (r.bib == null || r.bib.isEmpty()) ? "e:" + r.epc : "b:" + r.bib);
            }
            registeredEpcs = set;
            epcRacer = map;
            registeredAt = now;
        }
        java.util.Set<String> set = registeredEpcs;
        return set.isEmpty() || set.contains(epc);
    }

    // ---- Upload loop ----

    private void uploadLoop() {
        Uploader uploader = new Uploader(prefs.serverUrl(), prefs.readerToken());
        while (running.get()) {
            try {
                Thread.sleep(UPLOAD_INTERVAL_MS);
                // gun times first: results on the web are wrong without them
                for (RaceStore.Wave wave : store.unsyncedStartedWaves()) {
                    if (wave.name.isEmpty()) continue; // local mass-start marker
                    if (uploader.uploadWaveStart(wave.name, wave.startedAtMs)) {
                        store.markWaveSynced(wave.name);
                        broadcastStatus(getString(R.string.log_wave_synced, wave.name));
                    }
                }
                List<RaceStore.Passing> batch = store.pendingUpload(BATCH_SIZE);
                if (batch.isEmpty()) continue;
                if (uploader.upload(batch)) {
                    store.markUploaded(batch.get(batch.size() - 1).id);
                    uploadedTotal.addAndGet(batch.size());
                    broadcastStatus(null);
                    updateNotification();
                }
            } catch (InterruptedException e) {
                return;
            } catch (Exception e) {
                broadcastStatus(getString(R.string.log_upload_error, shortMessage(e)));
            }
        }
    }

    // ---- Status plumbing ----

    private Intent statusIntent(String log) {
        Intent intent = new Intent(ACTION_STATUS);
        intent.setPackage(getPackageName());
        intent.putExtra(EXTRA_RUNNING, running.get());
        intent.putExtra(EXTRA_READER_CONNECTED, readerConnected.get());
        intent.putExtra(EXTRA_WIFI_STATE, wifiState.get());
        intent.putExtra(EXTRA_PENDING, store.pendingCount());
        intent.putExtra(EXTRA_UPLOADED, uploadedTotal.get());
        if (log != null) intent.putExtra(EXTRA_LOG, log);
        return intent;
    }

    private void broadcastStatus(String log) {
        sendBroadcast(statusIntent(log));
    }

    private Notification buildNotification(String text) {
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm.getNotificationChannel(CHANNEL_ID) == null) {
            nm.createNotificationChannel(new NotificationChannel(
                    CHANNEL_ID, getString(R.string.notif_channel), NotificationManager.IMPORTANCE_LOW));
        }
        Intent open = new Intent(this, MainActivity.class);
        PendingIntent pi = PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE);
        return new Notification.Builder(this, CHANNEL_ID)
                .setSmallIcon(android.R.drawable.stat_notify_sync)
                .setContentTitle(getString(R.string.app_name))
                .setContentText(text)
                .setContentIntent(pi)
                .setOngoing(true)
                .build();
    }

    private void updateNotification() {
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        nm.notify(NOTIFICATION_ID, buildNotification(
                getString(R.string.notif_status, uploadedTotal.get(), store.pendingCount())));
    }

    private void closeSocket() {
        Socket socket = readerSocket;
        if (socket != null) {
            try {
                socket.close();
            } catch (Exception ignored) { }
        }
    }

    private static String shortMessage(Exception e) {
        String msg = e.getMessage();
        return e.getClass().getSimpleName() + (msg != null ? ": " + msg : "");
    }

    static byte[] hexToBytes(String hex) {
        String clean = hex.replaceAll("[^0-9A-Fa-f]", "");
        if (clean.length() % 2 != 0) clean = clean.substring(0, clean.length() - 1);
        byte[] out = new byte[clean.length() / 2];
        for (int i = 0; i < out.length; i++) {
            out[i] = (byte) Integer.parseInt(clean.substring(i * 2, i * 2 + 2), 16);
        }
        return out;
    }

    @Override
    public void onDestroy() {
        stopBridge();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}

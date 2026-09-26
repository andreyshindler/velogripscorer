package com.velogrip.rfid;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.net.Network;
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

/**
 * Foreground service that bridges the RFID reader to the scoring platform:
 *
 *   [RFID reader] --TCP over reader WiFi/Ethernet--> [this service] --HTTPS--> [server]
 *
 * When a WiFi SSID is configured (Android 10+), the operator's explicit
 * Connect in Settings ({@link ReaderWifi}) requests that network and binds
 * only the reader socket to it. A wired Ethernet adapter needs no such
 * configuration, so {@link ReaderEthernet} holds it automatically. Either way
 * the phone keeps cellular/WiFi for uploads while talking to the reader's
 * router on a network that may have no internet access of its own.
 */
public class BridgeService extends Service {

    public static final String ACTION_START = "com.velogrip.rfid.START";
    public static final String ACTION_STOP = "com.velogrip.rfid.STOP";
    public static final String ACTION_STATUS = "com.velogrip.rfid.STATUS";
    public static final String ACTION_TEST = "com.velogrip.rfid.TEST"; // arm a one-shot reader test

    public static final String EXTRA_RUNNING = "running";
    public static final String EXTRA_READER_CONNECTED = "readerConnected";
    public static final String EXTRA_WIFI_STATE = "wifiState";
    public static final String EXTRA_PENDING = "pending";
    public static final String EXTRA_UPLOADED = "uploaded";
    public static final String EXTRA_ONLINE = "online";
    // Manual checkpoint: upload the marshal's tapped passes without opening the
    // RFID reader socket (no reader hardware at this checkpoint).
    public static final String EXTRA_MANUAL_ONLY = "manualOnly";
    public static final String EXTRA_CHECKPOINT = "checkpoint"; // stamp+upload reads in server time
    public static final String EXTRA_LAST_EPC = "lastEpc";
    public static final String EXTRA_TEST_EPC = "testEpc"; // a tag seen during a reader test
    public static final String EXTRA_LOG = "log";

    // "_v2": a fresh channel id so setShowBadge(false) actually applies —
    // Android caches a channel's settings once it's been created.
    private static final String CHANNEL_ID = "bridge_v2";
    private static final int NOTIFICATION_ID = 1;
    private static final int UPLOAD_INTERVAL_MS = 3000;
    private static final int BATCH_SIZE = 200;

    private final AtomicBoolean running = new AtomicBoolean(false);
    private final AtomicBoolean readerConnected = new AtomicBoolean(false);
    // Whether the last server sync attempt succeeded — drives the on-screen
    // "offline / N buffered" indicator. Starts true (optimistic).
    private final AtomicBoolean online = new AtomicBoolean(true);
    private final AtomicBoolean testMode = new AtomicBoolean(false); // one-shot reader test
    private boolean manualOnly = false;
    private boolean checkpoint = false; // reads are stamped + uploaded in server time
    private final AtomicLong uploadedTotal = new AtomicLong(0);
    private final Map<String, Long> lastSeen = new HashMap<>();
    private volatile java.util.Set<String> registeredEpcs = java.util.Collections.emptySet();
    private volatile java.util.Map<String, String> epcRacer = java.util.Collections.emptyMap();
    private volatile java.util.Map<String, String> epcWave = java.util.Collections.emptyMap();
    private volatile java.util.Map<String, String> epcDistance = java.util.Collections.emptyMap();
    private volatile java.util.Map<String, Integer> lapCaps = java.util.Collections.emptyMap();
    // epc -> how many CROSSINGS it has produced, and when the last one was.
    // Distinct from lastSeen, which is the hardware dedupe and ticks even when
    // the read is skipped.
    private final java.util.Map<String, Crossings> crossingsByEpc = new java.util.HashMap<>();

    /** A chip's recorded crossings so far: how many, and when the last one was. */
    private static final class Crossings {
        int count;
        long last;
    }
    private final java.util.Set<String> beepedRacers = new java.util.HashSet<>(); // reader thread only
    private long registeredAt = 0;
    private android.media.ToneGenerator tone;
    private int toneVolume = -1; // volume the cached ToneGenerator was built with

    private Prefs prefs;
    private RaceStore store;
    private Thread readerThread;
    private Thread uploadThread;
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
        if (ACTION_TEST.equals(action)) {
            testMode.set(true); // next tag read is reported as a test, not recorded
            return START_STICKY;
        }
        manualOnly = intent != null && intent.getBooleanExtra(EXTRA_MANUAL_ONLY, false);
        checkpoint = intent != null && intent.getBooleanExtra(EXTRA_CHECKPOINT, false);
        startBridge();
        return START_STICKY;
    }

    private void startBridge() {
        if (!running.compareAndSet(false, true)) return;
        startForeground(NOTIFICATION_ID, buildNotification(getString(R.string.notif_starting)));

        PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "velogrip:bridge");
        wakeLock.acquire();
        // Reader WiFi is (re)connected from the foreground console on each race
        // start (RaceTimingActivity.startReader) — more reliable than from a
        // background service — and the reader socket binds to it here. Ethernet
        // needs no such per-race setup: hold it automatically the whole time
        // the bridge runs, so a wired adapter (if any) just works.
        // A manual checkpoint has no RFID reader — skip the reader socket/loop and
        // just run the uploader for the marshal's tapped passes.
        if (!manualOnly) {
            ReaderEthernet.start(this);
            readerThread = new Thread(this::readerLoop, "reader");
            readerThread.start();
        }
        uploadThread = new Thread(this::uploadLoop, "uploader");
        uploadThread.start();
        broadcastStatus(getString(R.string.log_started));
    }

    private void stopBridge() {
        if (!running.compareAndSet(true, false)) return;
        closeSocket();
        if (readerThread != null) readerThread.interrupt();
        if (uploadThread != null) uploadThread.interrupt();
        ReaderEthernet.stop(this);
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        if (tone != null) { tone.release(); tone = null; }
        readerConnected.set(false);
        broadcastStatus(getString(R.string.log_stopped));
        stopForeground(true);
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
                connectAndRead();   // binds to reader WiFi/Ethernet if held, else default network
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

    /** How often a buffered reader is asked to hand over what it has. */
    private static final long BUFFERED_POLL_MS = 250;

    /** Silent this long and the operator is told the reader is down. */
    private static final long SILENT_WARN_MS = LlrpEngine.KEEPALIVE_MS * 3L;
    /** Silent this long and the connection is written off and rebuilt. */
    private static final long SILENT_DROP_MS = 60_000L;

    private void connectAndRead() throws Exception {
        boolean isLlrp = Prefs.PROTOCOL_LLRP.equals(prefs.protocol());
        // Buffered: the reader accumulates reads and we poll for them, so a
        // read taken while the link was down still arrives once it is back.
        final boolean buffered = isLlrp && prefs.readerBuffered();
        LlrpEngine llrp = isLlrp ? new LlrpEngine(buffered) : null;
        TagParser parser = isLlrp ? llrp
                : Prefs.PROTOCOL_UHF.equals(prefs.protocol()) ? new UhfFrameParser()
                : new AsciiLineParser();

        // Prefer an explicit reader-WiFi hold (operator-configured in Settings),
        // then a held Ethernet adapter (automatic, no setup needed); only fall
        // back to the ambiguous "default network" when neither is held — e.g.
        // the tablet is already sitting on the reader's WiFi as its only network.
        Network network = ReaderNet.pickForHost(this, prefs.readerHost());
        Socket socket = network != null
                ? network.getSocketFactory().createSocket()
                : new Socket();
        readerSocket = socket;
        socket.connect(new InetSocketAddress(prefs.readerHost(), prefs.readerPort()), 8000);
        // Polling only gets its turn between reads, so the blocking read has to
        // be shorter than the poll interval or the poll schedule slips to it.
        socket.setSoTimeout(buffered ? 200 : 2000);
        socket.setKeepAlive(true); // TCP-level belt and braces; slow, but free
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
        byte[] poll = isLlrp
                ? (buffered ? llrp.getReport() : new byte[0])
                : hexToBytes(prefs.pollHex());
        long pollEveryMs = buffered ? BUFFERED_POLL_MS : prefs.pollIntervalMs();
        long lastPoll = 0;
        long lastByteAt = System.currentTimeMillis();

        byte[] buf = new byte[4096];
        while (running.get() && !socket.isClosed()) {
            if (poll.length > 0 && System.currentTimeMillis() - lastPoll >= pollEveryMs) {
                out.write(poll);
                out.flush();
                lastPoll = System.currentTimeMillis();
            }
            int n;
            try {
                n = in.read(buf);
            } catch (java.net.SocketTimeoutException timeout) {
                // A yanked cable sends no FIN, so read() just keeps timing out
                // and the link looks alive forever. Once the reader has proved
                // it sends keepalives we can call silence what it is — and
                // only then, so a reader that ignores the config (or an idle
                // stretch with no chips crossing) is never judged at all.
                if (!isLlrp || !llrp.keepaliveSeen()) continue;
                long silentFor = System.currentTimeMillis() - lastByteAt;
                // Warning and giving up are deliberately NOT the same moment.
                // While the cable is out the reader keeps timing tags and piling
                // the reports into its socket; TCP retransmits, so plugging back
                // in delivers that backlog — with the reader's own timestamps,
                // so those racers get the time they actually crossed. Closing
                // the socket is what throws that away for good. So say the
                // reader is down early, where the operator can act on it, and
                // only reconnect once the link has had a fair chance to heal.
                if (silentFor > SILENT_DROP_MS) {
                    throw new java.io.IOException("reader stopped answering");
                }
                if (silentFor > SILENT_WARN_MS && readerConnected.compareAndSet(true, false)) {
                    broadcastStatus(null);
                }
                continue; // idle: loop to honor poll schedule and running flag
            }
            lastByteAt = System.currentTimeMillis();
            if (n > 0 && readerConnected.compareAndSet(false, true)) {
                // It healed on its own, without a reconnect — so whatever the
                // reader buffered is arriving now rather than being discarded.
                broadcastStatus(getString(R.string.log_reader_connected,
                        prefs.readerHost() + ":" + prefs.readerPort()));
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
        // Fell out without throwing (stopped, or the socket was closed under
        // us): the status strip must not go on claiming a live reader.
        readerConnected.set(false);
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
        // Reader test: report the first tag seen (any tag, on the start list or not)
        // and record nothing — the marshal is just verifying the reader reads.
        if (testMode.get() && !reads.isEmpty()) {
            testMode.set(false);
            TagRead t = reads.get(0);
            Intent status = statusIntent(null);
            status.putExtra(EXTRA_TEST_EPC, t.epc
                    + (t.rssi != null ? String.format(Locale.US, " (%.0f dBm)", t.rssi) : ""));
            sendBroadcast(status);
            beep();
            return;
        }
        // Reads now carry the time the READER saw the tag, so a batch is not
        // necessarily in order once a backlog flushes. Sort it: the duplicate
        // and lap-gap tests below both walk forward from the last crossing.
        if (reads.size() > 1) {
            reads = new java.util.ArrayList<>(reads);
            java.util.Collections.sort(reads, new java.util.Comparator<TagRead>() {
                @Override public int compare(TagRead a, TagRead b) {
                    return Long.compare(a.readAtMs, b.readAtMs);
                }
            });
        }
        int window = prefs.dedupeWindowMs();
        // Fresh gun check per batch (not the 5 s roster cache) so recording
        // starts the instant the race does; while there's no gun (setup / after
        // a restart) the per-racer beeps are re-armed.
        boolean started = raceHasGun();
        // No gun anywhere means setup or a restart: forget what we have stored,
        // so a re-gunned race records its crossings from scratch.
        if (!started) { beepedRacers.clear(); crossingsByEpc.clear(); }
        // Gun time per wave, read fresh for each batch: a cached copy would keep
        // rejecting a wave's racers for seconds after its gun, losing the very
        // first crossings. Cheap — one query per batch, not per read.
        final java.util.Map<String, Long> gunByWave = new java.util.HashMap<>();
        for (RaceStore.Wave w : store.waves()) gunByWave.put(w.name, w.startedAtMs);
        for (TagRead read : reads) {
            if (!registered(read.epc)) continue;               // ignore tags not on the start list
            Long prev = lastSeen.get(read.epc);
            // Against the read's own time, not the batch's. A burst that flushes
            // after an outage spans real seconds; measuring it against a single
            // "now" would collapse a racer's two genuine crossings into one.
            if (prev != null && Math.abs(read.readAtMs - prev) < window) continue;
            lastSeen.put(read.epc, read.readAtMs);
            // Before the gun there is nothing to time against: the engine drops
            // reads earlier than the start, and the start-line roll call only
            // counts reads since the gun. Storing them just fills the device and
            // the upload queue with setup noise — chips lying near the antenna
            // add a row every dedupe window. The read is still reported below,
            // so antenna placement can be checked before the start.
            // A checkpoint keeps recording: it may not have synced the gun time
            // yet, and its passes are real mid-race splits.
            // Per WAVE, not per race: with a stagger, wave 2 is still standing
            // around the start/finish while wave 1 races, and their chips read
            // constantly. Those reads can never be crossings — their wave has no
            // gun to measure from — so recording them only inflates the queue.
            String wave = epcWave.get(read.epc);
            Long waveGun = gunByWave.get(wave == null ? "" : wave);
            boolean racerStarted = waveGun != null;
            // Reads inside the start-suppression window are the racer crossing
            // the START mat at the gun. They must still be stored — the roll
            // call marks anyone never read since the gun as DNS — but they are
            // NOT a crossing: they are not this racer's time, and treating one
            // as a finish would block every later read and lose the real finish.
            final long crossingFrom = racerStarted ? waveGun + prefs.suppressSecs() * 1000L : Long.MAX_VALUE;
            // A crossing is a read that stands for a time: the finish, or a lap.
            boolean crossing = racerStarted && !checkpoint && read.readAtMs >= crossingFrom;
            // A racer who has finished and stands by the gate is read every
            // dedupe window, and every stored pass re-renders the screen — which
            // is what keeps throwing the finish list back to their row. A chip
            // only has as many crossings to give as the race has laps, so stop
            // recording once it has given them: a lap race takes its lap count,
            // and a race without laps takes exactly one, the finish. Reads after
            // that are still reported on the status strip, just not stored.
            final long gapMs = prefs.lapGapSecs() * 1000L;
            boolean record = racerStarted;
            Crossings cr = null;
            if (crossing) {
                cr = crossingsFor(read.epc, crossingFrom, gapMs);
                if (cr.count >= crossingCap(epcDistance.get(read.epc))) {
                    record = false;    // every lap already timed: this racer is done
                    crossing = false;
                } else if (cr.count > 0 && Math.abs(read.readAtMs - cr.last) < gapMs) {
                    // Absolute: a read either side of the last crossing by less
                    // than the lap gap is that same crossing read again. One
                    // EARLIER by more than the gap is a real crossing that
                    // arrived late, and must not be written off as a duplicate.
                    record = false;    // same crossing, read again within the lap gap
                    crossing = false;
                }
            }
            if (record || checkpoint) {
                // A checkpoint stamps reads in server time now, so splits survive a later
                // clock jump; the finish device keeps device time (reconciled server-side).
                if (checkpoint) {
                    store.addPassing(new TagRead(read.epc, read.rssi, prefs.toServerTime(read.readAtMs), read.antenna));
                } else {
                    store.addPassing(read);
                    // Only a crossing counts towards the lap tally; a start-mat
                    // read must not, or the racer's real finish gets blocked.
                    if (crossing && cr != null) { cr.count++; cr.last = Math.max(cr.last, read.readAtMs); }
                }
            }
            // The beep marks a TIME, so it sounds on the crossing — not on the
            // start-mat read seconds earlier, which is what the operator was
            // hearing while the read that actually counted went by in silence.
            // In a lap race every lap is a time, so every lap beeps; in a
            // single-crossing race only the finish does, so a finisher loitering
            // by the gate cannot keep the beeper going.
            String racerKey = epcRacer.get(read.epc);
            if (racerKey == null) racerKey = "e:" + read.epc; // no roster: key by chip
            if (crossing && (prefs.recordLaps() || beepedRacers.add(racerKey))) beep();
            Intent status = statusIntent(null);
            status.putExtra(EXTRA_LAST_EPC, read.epc
                    + (read.rssi != null ? String.format(Locale.US, " (%.0f dBm)", read.rssi) : ""));
            sendBroadcast(status);
        }
        if (lastSeen.size() > 5000) lastSeen.clear(); // bounded memory at big events
    }

    /** How many CROSSINGS this chip has produced, and when the last one was — a
     *  read at or after minAt, the end of the start-suppression window. Start-mat
     *  reads are deliberately not counted: they are stored for the roll call but
     *  are not crossings, and mistaking one for a lap would retire the chip early.
     *  Seeded from the store on first sight, applying the same lap gap, so a
     *  mid-race app restart re-derives the tally instead of starting from zero
     *  and handing every racer their laps a second time. */
    private Crossings crossingsFor(String epc, long minAt, long gapMs) {
        Crossings c = crossingsByEpc.get(epc);
        if (c != null) return c;
        c = new Crossings();
        for (RaceStore.Passing p : store.passingsForEpc(epc)) { // ordered by read_at
            if (p.readAtMs < minAt) continue;
            if (c.count == 0 || p.readAtMs - c.last >= gapMs) { c.count++; c.last = p.readAtMs; }
        }
        crossingsByEpc.put(epc, c);
        return c;
    }

    /** How many crossings this racer's distance is worth: its lap count, the
     *  race-wide lap count, or — when the race is not scored on laps at all —
     *  exactly one, the finish. An unknown lap count in a lap race is left
     *  uncapped rather than guessed at. Mirrors CheckpointActivity.maxTaps. */
    private int crossingCap(String distance) {
        Integer laps = lapCaps.get(distance == null ? "" : distance);
        if (laps != null && laps > 0) return laps;
        if (prefs.raceLaps() > 0) return prefs.raceLaps();
        return prefs.recordLaps() ? Integer.MAX_VALUE : 1;
    }

    /** True once any wave has a gun time (the race is running). */
    private boolean raceHasGun() {
        for (RaceStore.Wave w : store.waves()) if (w.startedAtMs != null) return true;
        return false;
    }

    /** Short confirmation beep for a detected chip; opt-out in Settings. */
    private void beep() {
        if (!prefs.beepOnRead()) return;
        try {
            int vol = prefs.beepVolume();
            android.media.ToneGenerator t = tone;
            if (t == null || toneVolume != vol) { // rebuild when the volume changed
                if (t != null) t.release();
                t = new android.media.ToneGenerator(android.media.AudioManager.STREAM_NOTIFICATION, vol);
                tone = t;
                toneVolume = vol;
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
            java.util.HashMap<String, String> waves = new java.util.HashMap<>();
            java.util.HashMap<String, String> dists = new java.util.HashMap<>();
            for (RaceStore.Racer r : store.racers()) {
                if (r.epc == null || r.epc.isEmpty()) continue;
                set.add(r.epc);
                // two chips share a racer: key by bib so both beep as one racer
                map.put(r.epc, (r.bib == null || r.bib.isEmpty()) ? "e:" + r.epc : "b:" + r.bib);
                waves.put(r.epc, r.wave == null ? "" : r.wave);
                dists.put(r.epc, r.distance == null ? "" : r.distance);
            }
            registeredEpcs = set;
            epcRacer = map;
            epcWave = waves;
            epcDistance = dists;
            // Laps per distance, refreshed with the roster so a lap count edited
            // mid-race takes effect without restarting the service.
            lapCaps = store.lapTargets();
            registeredAt = now;
        }
        java.util.Set<String> set = registeredEpcs;
        return set.isEmpty() || set.contains(epc);
    }

    // ---- Upload loop ----

    private void uploadLoop() {
        Uploader uploader = new Uploader(prefs.serverUrl(), prefs.readerToken());
        boolean lapTargetsSynced = false;
        while (running.get()) {
            try {
                Thread.sleep(UPLOAD_INTERVAL_MS);
                // The finish device publishes its lap counts once, so checkpoints
                // can cap taps. A manual checkpoint has none of its own to send.
                if (!manualOnly && !lapTargetsSynced) {
                    if (uploader.uploadLapTargets(store.lapTargets(), prefs.recordLaps(), prefs.leaderEndsRace())) lapTargetsSynced = true;
                }
                // "Live results: off" means the race is not published while it
                // runs: hold the gun times and the passes on the phone until the
                // operator posts the results, which re-sends both anyway. Read
                // fresh each pass, so flipping it mid-race takes effect at once.
                if (!prefs.liveResults()) continue;
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
                if (uploader.upload(batch, checkpoint)) {
                    store.markUploaded(batch.get(batch.size() - 1).id);
                    uploadedTotal.addAndGet(batch.size());
                    online.set(true);
                    broadcastStatus(null);
                    updateNotification();
                }
            } catch (InterruptedException e) {
                return;
            } catch (Exception e) {
                // Upload failed (no internet / server unreachable): the passes
                // stay buffered and the screen shows "offline / N waiting".
                online.set(false);
                broadcastStatus(getString(R.string.log_upload_error, shortMessage(e)));
            }
        }
    }

    // ---- Status plumbing ----

    /** Which network the reader socket is actually bound to right now. */
    private static String networkState() {
        if (ReaderWifi.isConnected()) return "wifi";
        if (ReaderEthernet.isConnected()) return "ethernet";
        return "default";
    }

    private Intent statusIntent(String log) {
        Intent intent = new Intent(ACTION_STATUS);
        intent.setPackage(getPackageName());
        intent.putExtra(EXTRA_RUNNING, running.get());
        intent.putExtra(EXTRA_READER_CONNECTED, readerConnected.get());
        intent.putExtra(EXTRA_WIFI_STATE, networkState());
        intent.putExtra(EXTRA_PENDING, store.pendingCount());
        intent.putExtra(EXTRA_UPLOADED, uploadedTotal.get());
        intent.putExtra(EXTRA_ONLINE, online.get());
        if (log != null) intent.putExtra(EXTRA_LOG, log);
        return intent;
    }

    private void broadcastStatus(String log) {
        sendBroadcast(statusIntent(log));
    }

    private Notification buildNotification(String text) {
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm.getNotificationChannel(CHANNEL_ID) == null) {
            NotificationChannel channel = new NotificationChannel(
                    CHANNEL_ID, getString(R.string.notif_channel), NotificationManager.IMPORTANCE_LOW);
            channel.setShowBadge(false); // silent, no app-icon badge dot
            nm.createNotificationChannel(channel);
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

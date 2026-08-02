package com.velogrip.rfid;

import android.content.Context;
import android.net.ConnectivityManager;
import android.net.LinkAddress;
import android.net.LinkProperties;
import android.net.Network;

import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

/**
 * "Scan for reader": sweeps the /24 of the phone's current reader network (or
 * of the currently entered reader IP as a fallback) probing the reader TCP
 * port, mirroring the reader-discovery flow of commercial timing apps. Connect
 * to the RFID router — WiFi or Ethernet — before scanning.
 */
public final class ReaderScanner {

    private static final int CONNECT_TIMEOUT_MS = 400;
    private static final int THREADS = 32;

    private ReaderScanner() { }

    /** Returns the first IP with the port open, or null. Blocks; call off the UI thread. */
    public static String scan(Context ctx, String hintIp, int port) {
        String prefix = subnetPrefix(ctx, hintIp);
        if (prefix == null) return null;

        ExecutorService pool = Executors.newFixedThreadPool(THREADS);
        AtomicReference<String> found = new AtomicReference<>(null);
        List<Runnable> probes = new ArrayList<>();
        for (int host = 1; host <= 254; host++) {
            final String ip = prefix + host;
            probes.add(() -> {
                if (found.get() != null) return;
                Socket socket = new Socket();
                try {
                    socket.connect(new InetSocketAddress(ip, port), CONNECT_TIMEOUT_MS);
                    found.compareAndSet(null, ip);
                } catch (Exception ignored) {
                    // closed or unreachable: not the reader
                } finally {
                    try {
                        socket.close();
                    } catch (Exception ignored) { }
                }
            });
        }
        for (Runnable probe : probes) pool.execute(probe);
        pool.shutdown();
        try {
            pool.awaitTermination(60, TimeUnit.SECONDS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
        return found.get();
    }

    /** Progressive scan for the "Scan for Reader" screen. */
    public interface ScanListener {
        void onProgress(String ip);
        void onFound(String ip);
        void onFinished(boolean cancelled, boolean noSubnet);
    }

    /** Cancel handle for an in-flight progressive scan. */
    public static final class Handle {
        private volatile boolean cancelled;
        public void cancel() { cancelled = true; }
        public boolean isCancelled() { return cancelled; }
    }

    /**
     * Steps sequentially through the WiFi subnet so the UI can show the address
     * being probed, reporting each reader it finds. Runs on its own thread;
     * callbacks fire on that thread — marshal to the UI thread in the listener.
     */
    public static Handle scanProgressive(Context ctx, String hintIp, int port,
                                         int timeoutMs, ScanListener listener) {
        final Handle handle = new Handle();
        final String prefix = subnetPrefix(ctx, hintIp);
        new Thread(() -> {
            if (prefix == null) {
                listener.onFinished(false, true);
                return;
            }
            for (int host = 1; host <= 254 && !handle.cancelled; host++) {
                final String ip = prefix + host;
                listener.onProgress(ip);
                Socket socket = new Socket();
                try {
                    socket.connect(new InetSocketAddress(ip, port), timeoutMs);
                    listener.onFound(ip);
                } catch (Exception ignored) {
                    // closed or unreachable: not the reader
                } finally {
                    try {
                        socket.close();
                    } catch (Exception ignored) { }
                }
            }
            listener.onFinished(handle.cancelled, false);
        }).start();
        return handle;
    }

    private static String subnetPrefix(Context ctx, String hintIp) {
        // Prefer whichever network the reader socket itself would bind to (an
        // explicit WiFi/Ethernet hold), else the OS default network — checked
        // via ConnectivityManager/LinkProperties so it reflects the network
        // that's actually active right now, Ethernet included. (The old
        // WifiManager-only lookup could report a stale WiFi address even while
        // connected over Ethernet, scanning the wrong subnet entirely.)
        try {
            ConnectivityManager cm = (ConnectivityManager)
                    ctx.getApplicationContext().getSystemService(Context.CONNECTIVITY_SERVICE);
            Network net = ReaderEthernet.getNetwork();
            if (net == null) net = ReaderWifi.getNetwork();
            if (net == null && cm != null) net = cm.getActiveNetwork();
            String prefix = subnetPrefixOf(cm, net);
            if (prefix != null) return prefix;
        } catch (Exception ignored) { }
        // Fall back to the subnet of whatever IP is already typed in.
        if (hintIp != null && hintIp.matches("\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}")) {
            return hintIp.substring(0, hintIp.lastIndexOf('.') + 1);
        }
        return null;
    }

    /** First IPv4 /24 prefix (e.g. "192.168.0.") on the given network, or null. */
    private static String subnetPrefixOf(ConnectivityManager cm, Network net) {
        if (cm == null || net == null) return null;
        LinkProperties lp = cm.getLinkProperties(net);
        if (lp == null) return null;
        for (LinkAddress la : lp.getLinkAddresses()) {
            InetAddress addr = la.getAddress();
            if (addr instanceof Inet4Address && !addr.isLoopbackAddress()) {
                String ip = addr.getHostAddress();
                int lastDot = ip.lastIndexOf('.');
                if (lastDot > 0) return ip.substring(0, lastDot + 1);
            }
        }
        return null;
    }
}

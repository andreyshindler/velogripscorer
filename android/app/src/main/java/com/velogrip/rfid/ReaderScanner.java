package com.velogrip.rfid;

import android.content.Context;
import android.net.Network;

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
        String prefix = ReaderNet.subnetPrefix(ctx, hintIp);
        if (prefix == null) return null;
        // Probe over the interface actually on that subnet (Ethernet included),
        // not the OS default — a bare socket would sweep the reader's addresses
        // from the WiFi side and reach nothing.
        final Network bindNet = ReaderNet.pickForHost(ctx, prefix + "1");

        ExecutorService pool = Executors.newFixedThreadPool(THREADS);
        AtomicReference<String> found = new AtomicReference<>(null);
        List<Runnable> probes = new ArrayList<>();
        for (int host = 1; host <= 254; host++) {
            final String ip = prefix + host;
            probes.add(() -> {
                if (found.get() != null) return;
                Socket socket = newSocket(bindNet);
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
     * being probed, stopping at the first reader it finds. Runs on its own
     * thread; callbacks fire on that thread — marshal to the UI thread in the
     * listener.
     */
    public static Handle scanProgressive(Context ctx, String hintIp, int port,
                                         int timeoutMs, ScanListener listener) {
        final Handle handle = new Handle();
        final String prefix = ReaderNet.subnetPrefix(ctx, hintIp);
        final Network bindNet = prefix == null ? null : ReaderNet.pickForHost(ctx, prefix + "1");
        new Thread(() -> {
            if (prefix == null) {
                listener.onFinished(false, true);
                return;
            }
            for (int host = 1; host <= 254 && !handle.cancelled; host++) {
                final String ip = prefix + host;
                listener.onProgress(ip);
                Socket socket = newSocket(bindNet);
                try {
                    socket.connect(new InetSocketAddress(ip, port), timeoutMs);
                    listener.onFound(ip);
                    break; // reader found — no need to sweep the rest of the subnet
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

    /** A socket bound to the reader's network when one is held, else a plain one. */
    private static Socket newSocket(Network bindNet) {
        if (bindNet != null) {
            try {
                return bindNet.getSocketFactory().createSocket();
            } catch (Exception ignored) {
                // fall through to a plain socket
            }
        }
        return new Socket();
    }
}

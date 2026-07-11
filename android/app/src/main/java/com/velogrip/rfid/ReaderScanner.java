package com.velogrip.rfid;

import android.content.Context;
import android.net.wifi.WifiInfo;
import android.net.wifi.WifiManager;

import java.net.InetSocketAddress;
import java.net.Socket;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

/**
 * "Scan for reader": sweeps the /24 of the phone's current WiFi network (or of
 * the currently entered reader IP as a fallback) probing the reader TCP port,
 * mirroring the reader-discovery flow of commercial timing apps. Join the RFID
 * router's WiFi before scanning.
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

    private static String subnetPrefix(Context ctx, String hintIp) {
        // Prefer the phone's current WiFi address (the RFID router's subnet).
        try {
            WifiManager wifi = (WifiManager) ctx.getApplicationContext().getSystemService(Context.WIFI_SERVICE);
            WifiInfo info = wifi != null ? wifi.getConnectionInfo() : null;
            int ip = info != null ? info.getIpAddress() : 0;
            if (ip != 0) {
                return (ip & 0xFF) + "." + ((ip >> 8) & 0xFF) + "." + ((ip >> 16) & 0xFF) + ".";
            }
        } catch (Exception ignored) { }
        // Fall back to the subnet of whatever IP is already typed in.
        if (hintIp != null && hintIp.matches("\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}")) {
            return hintIp.substring(0, hintIp.lastIndexOf('.') + 1);
        }
        return null;
    }
}

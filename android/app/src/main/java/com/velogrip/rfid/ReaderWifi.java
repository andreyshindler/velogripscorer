package com.velogrip.rfid;

import android.content.Context;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.NetworkRequest;
import android.net.wifi.WifiNetworkSpecifier;

/**
 * Process-scoped hold on the reader's WiFi. The connection outlives any single
 * screen: connecting in Settings and navigating away keeps the phone on the
 * reader network until {@link #disconnect} (or the process dies). Uses a
 * WifiNetworkSpecifier so the phone keeps its other network for internet.
 */
public final class ReaderWifi {

    public static final String IDLE = "idle", CONNECTING = "connecting",
            CONNECTED = "connected", FAILED = "failed", LOST = "lost";

    private static ConnectivityManager cm;
    private static ConnectivityManager.NetworkCallback callback;
    private static volatile Network network;
    private static volatile String state = IDLE;
    private static volatile String ssid = "";

    private ReaderWifi() { }

    public static String state() { return state; }
    public static String ssid() { return ssid; }
    public static boolean isActive() { return callback != null; }
    /** True only when actually joined (a failed/lost attempt is not connected). */
    public static boolean isConnected() { return CONNECTED.equals(state) && network != null; }
    /** The held reader network, or null if not connected yet. */
    public static Network getNetwork() { return network; }

    public static synchronized void connect(Context ctx, String wantSsid, String pass) {
        Context app = ctx.getApplicationContext();
        disconnect(app);                       // drop any previous hold first
        ssid = wantSsid;
        state = CONNECTING;
        WifiNetworkSpecifier.Builder spec = new WifiNetworkSpecifier.Builder().setSsid(wantSsid);
        if (pass != null && !pass.isEmpty()) spec.setWpa2Passphrase(pass);
        NetworkRequest request = new NetworkRequest.Builder()
                .addTransportType(NetworkCapabilities.TRANSPORT_WIFI)
                .removeCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                .setNetworkSpecifier(spec.build())
                .build();
        cm = (ConnectivityManager) app.getSystemService(Context.CONNECTIVITY_SERVICE);
        callback = new ConnectivityManager.NetworkCallback() {
            @Override public void onAvailable(Network n) { network = n; state = CONNECTED; }
            @Override public void onLost(Network n) { network = null; state = LOST; }
            @Override public void onUnavailable() { state = FAILED; }
        };
        cm.requestNetwork(request, callback);
    }

    public static synchronized void disconnect(Context ctx) {
        if (callback != null && cm != null) {
            try { cm.unregisterNetworkCallback(callback); } catch (IllegalArgumentException ignored) { }
        }
        callback = null;
        network = null;
        state = IDLE;
    }
}

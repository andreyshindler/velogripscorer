package com.velogrip.rfid;

import android.content.Context;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.NetworkRequest;

/**
 * Process-scoped hold on any Ethernet network, mirroring {@link ReaderWifi}.
 * Unlike the reader WiFi (which needs an SSID/password the operator enters),
 * a wired adapter has no credentials to ask for, so this is requested
 * automatically whenever the bridge service is running and simply stays
 * unsatisfied if no Ethernet adapter is plugged in. Binding the reader socket
 * to this specific network — instead of the plain, unbound socket the app
 * falls back to otherwise — is what makes the reader reliably reachable over
 * Ethernet: a bare socket.connect() rides whatever Android currently treats as
 * the device's "default" network, which on a tablet with cellular data can
 * silently stay on cellular even with the Ethernet cable plugged in, since
 * the reader's router has no internet uplink for Android to prefer it.
 */
public final class ReaderEthernet {

    private static ConnectivityManager cm;
    private static ConnectivityManager.NetworkCallback callback;
    private static volatile Network network;

    private ReaderEthernet() { }

    /** True once an Ethernet network is actually held. */
    public static boolean isConnected() { return network != null; }
    /** The held Ethernet network, or null if none is available yet. */
    public static Network getNetwork() { return network; }

    public static synchronized void start(Context ctx) {
        if (callback != null) return; // already requested
        Context app = ctx.getApplicationContext();
        NetworkRequest request = new NetworkRequest.Builder()
                .addTransportType(NetworkCapabilities.TRANSPORT_ETHERNET)
                .removeCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                .build();
        cm = (ConnectivityManager) app.getSystemService(Context.CONNECTIVITY_SERVICE);
        callback = new ConnectivityManager.NetworkCallback() {
            @Override public void onAvailable(Network n) { network = n; }
            @Override public void onLost(Network n) { if (network == n) network = null; }
        };
        cm.requestNetwork(request, callback);
    }

    public static synchronized void stop(Context ctx) {
        if (callback != null && cm != null) {
            try { cm.unregisterNetworkCallback(callback); } catch (IllegalArgumentException ignored) { }
        }
        callback = null;
        network = null;
    }
}

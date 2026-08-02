package com.velogrip.rfid;

import android.content.Context;
import android.net.ConnectivityManager;
import android.net.LinkAddress;
import android.net.LinkProperties;
import android.net.Network;
import android.net.NetworkCapabilities;

import java.net.Inet4Address;
import java.net.InetAddress;

/**
 * Picks the local network that can actually reach the reader.
 *
 * The reader sits on a router that usually has no internet uplink, so Android
 * keeps WiFi/cellular as its "default" network even with the Ethernet cable
 * plugged in. A bare {@code new Socket()} rides that default, so it leaves the
 * tablet on 192.168.1.x (WiFi) and never reaches a reader on 192.168.0.x
 * (Ethernet) — exactly the "failed to connect to /192.168.0.8 … from
 * /192.168.1.123" symptom seen in the field.
 *
 * The fix is transport-agnostic: among every network the device currently has
 * — enumerated via {@link ConnectivityManager#getAllNetworks()}, which lists
 * the Ethernet link even when nothing explicitly requested it — pick the one
 * whose own IPv4 address shares the reader's /24. Binding the socket to that
 * {@link Network} routes over the right interface no matter which of WiFi /
 * Ethernet / cellular Android happens to call the default.
 */
public final class ReaderNet {

    private ReaderNet() { }

    /**
     * The network on the same /24 as {@code host}, or null to let the caller
     * fall back to a plain socket. Falls back to an explicit Ethernet then WiFi
     * hold when no interface matches the reader's subnet (e.g. host not set).
     */
    public static Network pickForHost(Context ctx, String host) {
        ConnectivityManager cm = (ConnectivityManager)
                ctx.getApplicationContext().getSystemService(Context.CONNECTIVITY_SERVICE);
        String hostPrefix = slash24(host);
        if (cm != null && hostPrefix != null) {
            try {
                for (Network net : cm.getAllNetworks()) {
                    if (hostPrefix.equals(subnetOf(cm, net))) return net;
                }
            } catch (Exception ignored) { }
        }
        // No interface on the reader's subnet: use an explicit hold if we have one.
        Network eth = ReaderEthernet.getNetwork();
        if (eth != null) return eth;
        return ReaderWifi.getNetwork();
    }

    /**
     * The /24 prefix (e.g. "192.168.0.") to sweep when scanning for the reader:
     * the subnet of the reader IP already entered, else — with no IP typed —
     * the wired Ethernet interface's subnet (where the reader almost always
     * sits), else whichever network is active (an Ethernet/WiFi hold, else the
     * OS default), else null. Preferring Ethernet is what stops an empty-field
     * scan from sweeping the tablet's WiFi subnet (192.168.1.x) when the reader
     * is on the cable's LAN (192.168.0.x).
     */
    public static String subnetPrefix(Context ctx, String hintIp) {
        // A typed reader IP is the operator telling us the reader's subnet.
        String hint = slash24(hintIp);
        if (hint != null) return hint;
        ConnectivityManager cm = (ConnectivityManager)
                ctx.getApplicationContext().getSystemService(Context.CONNECTIVITY_SERVICE);
        if (cm == null) return null;
        try {
            String eth = ethernetSubnet(cm);
            if (eth != null) return eth;
            Network net = ReaderEthernet.getNetwork();
            if (net == null) net = ReaderWifi.getNetwork();
            if (net == null) net = cm.getActiveNetwork();
            return subnetOf(cm, net);
        } catch (Exception ignored) {
            return null;
        }
    }

    /** The /24 of the first wired-Ethernet interface the device has, or null. */
    private static String ethernetSubnet(ConnectivityManager cm) {
        for (Network net : cm.getAllNetworks()) {
            NetworkCapabilities caps = cm.getNetworkCapabilities(net);
            if (caps != null && caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET)) {
                String s = subnetOf(cm, net);
                if (s != null) return s;
            }
        }
        return null;
    }

    /** First non-loopback IPv4 /24 prefix on the given network, or null. */
    private static String subnetOf(ConnectivityManager cm, Network net) {
        if (cm == null || net == null) return null;
        LinkProperties lp = cm.getLinkProperties(net);
        if (lp == null) return null;
        for (LinkAddress la : lp.getLinkAddresses()) {
            InetAddress addr = la.getAddress();
            if (addr instanceof Inet4Address && !addr.isLoopbackAddress()) {
                return slash24(addr.getHostAddress());
            }
        }
        return null;
    }

    /** "192.168.0.8" -> "192.168.0."; null for anything not a dotted IPv4. */
    private static String slash24(String ip) {
        if (ip == null || !ip.matches("\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}")) return null;
        int i = ip.lastIndexOf('.');
        return i > 0 ? ip.substring(0, i + 1) : null;
    }
}

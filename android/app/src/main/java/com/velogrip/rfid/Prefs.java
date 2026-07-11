package com.velogrip.rfid;

import android.content.Context;
import android.content.SharedPreferences;

/** Thin wrapper around SharedPreferences for the bridge configuration. */
public final class Prefs {

    public static final String PROTOCOL_ASCII = "ascii";
    public static final String PROTOCOL_UHF = "uhf";
    public static final String PROTOCOL_DEMO = "demo";

    private final SharedPreferences sp;

    public Prefs(Context ctx) {
        sp = ctx.getSharedPreferences("bridge", Context.MODE_PRIVATE);
    }

    public String serverUrl() { return sp.getString("serverUrl", ""); }
    public String readerToken() { return sp.getString("readerToken", ""); }
    public String readerHost() { return sp.getString("readerHost", ""); }
    public int readerPort() { return sp.getInt("readerPort", 6000); }
    public String protocol() { return sp.getString("protocol", PROTOCOL_ASCII); }
    public String onConnectHex() { return sp.getString("onConnectHex", ""); }
    public String pollHex() { return sp.getString("pollHex", ""); }
    public int pollIntervalMs() { return sp.getInt("pollIntervalMs", 1000); }
    public String wifiSsid() { return sp.getString("wifiSsid", ""); }
    public String wifiPass() { return sp.getString("wifiPass", ""); }
    public int dedupeWindowMs() { return sp.getInt("dedupeWindowMs", 2000); }

    public boolean isConfigured() {
        boolean serverOk = !serverUrl().isEmpty() && !readerToken().isEmpty();
        boolean readerOk = PROTOCOL_DEMO.equals(protocol()) || !readerHost().isEmpty();
        return serverOk && readerOk;
    }

    public void save(String serverUrl, String readerToken, String readerHost, int readerPort,
                     String protocol, String onConnectHex, String pollHex, int pollIntervalMs,
                     String wifiSsid, String wifiPass, int dedupeWindowMs) {
        sp.edit()
                .putString("serverUrl", serverUrl.replaceAll("/+$", ""))
                .putString("readerToken", readerToken.trim())
                .putString("readerHost", readerHost.trim())
                .putInt("readerPort", readerPort)
                .putString("protocol", protocol)
                .putString("onConnectHex", onConnectHex.trim())
                .putString("pollHex", pollHex.trim())
                .putInt("pollIntervalMs", pollIntervalMs)
                .putString("wifiSsid", wifiSsid.trim())
                .putString("wifiPass", wifiPass)
                .putInt("dedupeWindowMs", dedupeWindowMs)
                .apply();
    }
}

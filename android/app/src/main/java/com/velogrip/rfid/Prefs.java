package com.velogrip.rfid;

import android.content.Context;
import android.content.SharedPreferences;

/** Thin wrapper around SharedPreferences for the bridge configuration. */
public final class Prefs {

    public static final String PROTOCOL_ASCII = "ascii";
    public static final String PROTOCOL_UHF = "uhf";
    public static final String PROTOCOL_LLRP = "llrp";
    public static final String PROTOCOL_DEMO = "demo";

    private final SharedPreferences sp;

    public Prefs(Context ctx) {
        sp = ctx.getSharedPreferences("bridge", Context.MODE_PRIVATE);
    }

    // Defaults preconfigured for this deployment: fresh installs are ready to
    // log in without typing the server address.
    public static final String DEFAULT_SERVER_URL = "https://srv1515969.hstgr.cloud/veloscorer";
    public static final String DEFAULT_EMAIL = "admin@velogripscorer.local";

    public String serverUrl() { return sp.getString("serverUrl", DEFAULT_SERVER_URL); }
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
    public int suppressSecs() { return sp.getInt("suppressSecs", 10); }
    public int lapGapSecs() { return sp.getInt("lapGapSecs", 30); }
    public String contestTitle() { return sp.getString("contestTitle", ""); }

    public String accountEmail() { return sp.getString("accountEmail", DEFAULT_EMAIL); }
    public String accountPass() { return sp.getString("accountPass", ""); }

    /** How the race starts: "mass" (one gun for everyone) or "wave". */
    public String startType() { return sp.getString("startType", ""); }
    public void setStartType(String type) { sp.edit().putString("startType", type).apply(); }
    public void setContestTitle(String title) { sp.edit().putString("contestTitle", title.trim()).apply(); }

    /** Remembered after the first successful login so race downloads are one tap. */
    public void saveAccount(String email, String password) {
        sp.edit().putString("accountEmail", email.trim())
                .putString("accountPass", password).apply();
    }

    /** Called when the user picks a race after logging in: wires the pairing. */
    public void savePairing(String readerToken, String contestTitle, String email) {
        sp.edit()
                .putString("readerToken", readerToken.trim())
                .putString("contestTitle", contestTitle)
                .putString("accountEmail", email.trim())
                .apply();
    }

    public void saveTimingSettings(int suppressSecs, int lapGapSecs, String contestTitle) {
        sp.edit()
                .putInt("suppressSecs", suppressSecs)
                .putInt("lapGapSecs", lapGapSecs)
                .putString("contestTitle", contestTitle)
                .apply();
    }

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

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
    public int readerPort() { return sp.getInt("readerPort", 5084); }
    // Deployment reader is RFID-LLRP, so that's the default protocol.
    public String protocol() { return sp.getString("protocol", PROTOCOL_LLRP); }
    public void setProtocol(String protocol) {
        sp.edit().putString("protocol", protocol).apply();
    }
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

    // Lap setup: results split per distance, and whether extra crossings
    // count as laps (off = first valid crossing is the finish).
    public boolean multiDistance(boolean fallback) { return sp.getBoolean("multiDistance", fallback); }
    public void setMultiDistance(boolean on) { sp.edit().putBoolean("multiDistance", on).apply(); }
    public boolean recordLaps() { return sp.getBoolean("recordLaps", true); }
    public void setRecordLaps(boolean on) { sp.edit().putBoolean("recordLaps", on).apply(); }

    // Hardware setup: whether an RFID reader is used for this race. Off means
    // manual-only timing (no reader connection shown in the race console).
    public boolean chipTiming() { return sp.getBoolean("chipTiming", true); }
    public void setChipTiming(boolean on) { sp.edit().putBoolean("chipTiming", on).apply(); }

    // Chip Timing detail screen.
    public boolean chipIdEqualsBib() { return sp.getBoolean("chipIdEqualsBib", false); }
    public int chipsPerRacer() { return sp.getInt("chipsPerRacer", 2); }
    public int antennaPower() { return sp.getInt("antennaPower", 100); }
    public boolean beepUnknownChip() { return sp.getBoolean("beepUnknownChip", true); }
    public void saveReaderHostPort(String host, int port) {
        sp.edit().putString("readerHost", host.trim()).putInt("readerPort", port).apply();
    }
    public void saveChipTiming(boolean idEqualsBib, int chipsPerRacer, int suppressSecs,
                              int lapGapSecs, int antennaPower, boolean beepUnknown) {
        sp.edit()
                .putBoolean("chipIdEqualsBib", idEqualsBib)
                .putInt("chipsPerRacer", Math.max(1, chipsPerRacer))
                .putInt("suppressSecs", Math.max(0, suppressSecs))
                .putInt("lapGapSecs", Math.max(0, lapGapSecs))
                .putInt("antennaPower", Math.min(100, Math.max(1, antennaPower)))
                .putBoolean("beepUnknownChip", beepUnknown)
                .apply();
    }

    // Racer setup: which fields each racer requires, and the bib format.
    public boolean requireName() { return sp.getBoolean("reqName", true); }
    public boolean requireBib() { return sp.getBoolean("reqBib", true); }
    public boolean bibAlphanumeric() { return sp.getBoolean("bibAlpha", false); }
    public boolean requireCategory() { return sp.getBoolean("reqCategory", true); }
    public boolean requireGender() { return sp.getBoolean("reqGender", false); }
    public void setRacerSetup(boolean name, boolean bib, boolean alpha, boolean category, boolean gender) {
        sp.edit().putBoolean("reqName", name).putBoolean("reqBib", bib)
                .putBoolean("bibAlpha", alpha).putBoolean("reqCategory", category)
                .putBoolean("reqGender", gender).apply();
    }

    /** A different race was loaded: race-specific choices return to defaults. */
    public void resetRaceSetup() {
        sp.edit().remove("startType").remove("multiDistance").remove("recordLaps")
                .remove("reqName").remove("reqBib").remove("bibAlpha")
                .remove("reqCategory").remove("reqGender").apply();
    }

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

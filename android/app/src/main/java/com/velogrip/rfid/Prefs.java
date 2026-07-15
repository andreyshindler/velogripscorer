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
    public String wifiSsid() { return sp.getString("wifiSsid", "Tenda_raceit"); }
    public String wifiPass() { return sp.getString("wifiPass", ""); }
    public void setWifi(String ssid, String pass) {
        sp.edit().putString("wifiSsid", ssid.trim()).putString("wifiPass", pass).apply();
    }
    public int dedupeWindowMs() { return sp.getInt("dedupeWindowMs", 2000); }
    public int suppressSecs() { return sp.getInt("suppressSecs", 10); }
    public int lapGapSecs() { return sp.getInt("lapGapSecs", 30); }
    // Start-line roll call: seconds after the gun before racers never read are
    // auto-marked DNS (0 = off). rollCallClosedAt is a runtime "closed now" stamp
    // set by the manual button and reset when a race starts.
    public int rollCallSecs() { return sp.getInt("rollCallSecs", 0); } // 0 = off by default
    public long rollCallClosedAt() { return sp.getLong("rollCallClosedAt", 0L); }
    public void setRollCallClosedAt(long ms) { sp.edit().putLong("rollCallClosedAt", ms).apply(); }
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
    public void saveChipsPerRacer(int n) { sp.edit().putInt("chipsPerRacer", Math.max(1, n)).apply(); }
    public boolean beepUnknownChip() { return sp.getBoolean("beepUnknownChip", true); }
    public void saveReaderHostPort(String host, int port) {
        sp.edit().putString("readerHost", host.trim()).putInt("readerPort", port).apply();
    }
    public void saveChipTiming(boolean idEqualsBib, int chipsPerRacer, int suppressSecs,
                              int lapGapSecs, int antennaPower, boolean beepUnknown, int rollCallSecs) {
        sp.edit()
                .putBoolean("chipIdEqualsBib", idEqualsBib)
                .putInt("chipsPerRacer", Math.max(1, chipsPerRacer))
                .putInt("suppressSecs", Math.max(0, suppressSecs))
                .putInt("lapGapSecs", Math.max(0, lapGapSecs))
                .putInt("antennaPower", Math.min(100, Math.max(1, antennaPower)))
                .putBoolean("beepUnknownChip", beepUnknown)
                .putInt("rollCallSecs", Math.max(0, rollCallSecs))
                .apply();
    }

    // Set when the race is finished with "laps down": partial-lap racers are
    // then finalised as finishers at their last crossing.
    public boolean raceFinalized() { return sp.getBoolean("raceFinalized", false); }
    public void setRaceFinalized(boolean on) { sp.edit().putBoolean("raceFinalized", on).apply(); }

    /** Short beep on each detected chip (defaults on). */
    public boolean beepOnRead() { return sp.getBoolean("beepOnRead", true); }
    public void setBeepOnRead(boolean on) { sp.edit().putBoolean("beepOnRead", on).apply(); }

    /** Appearance: "system" (follow the phone), "light", or "dark". */
    public String themeMode() { return sp.getString("themeMode", "system"); }
    public void setThemeMode(String mode) { sp.edit().putString("themeMode", mode).apply(); }

    // Race start options.
    public long clockAdjustMs() { return sp.getLong("clockAdjustMs", 0); }
    public void setClockAdjustMs(long ms) { sp.edit().putLong("clockAdjustMs", ms).apply(); }
    public boolean liveResults() { return sp.getBoolean("liveResults", false); }
    public void setLiveResults(boolean on) { sp.edit().putBoolean("liveResults", on).apply(); }

    // Live-results screen.
    public int contestId() { return sp.getInt("contestId", 0); }
    public void setContestId(int id) { sp.edit().putInt("contestId", id).apply(); }
    public boolean resultsPrivate() { return sp.getBoolean("resultsPrivate", false); }
    public void setResultsPrivate(boolean on) { sp.edit().putBoolean("resultsPrivate", on).apply(); }
    public String sport() { return sp.getString("sport", ""); }
    public void setSport(String s) { sp.edit().putString("sport", s.trim()).apply(); }
    public boolean emailParticipants() { return sp.getBoolean("emailParticipants", false); }
    public void setEmailParticipants(boolean on) { sp.edit().putBoolean("emailParticipants", on).apply(); }

    /** Public live-results link at the deployment's /race-results/<id> path. */
    public String publicResultsUrl() {
        String base = serverUrl().replaceAll("/+$", "");
        int id = contestId();
        return id > 0 ? base + "/race-results/" + id : base + "/race-results/";
    }

    // Results options.
    public static final String ORDER_TIME = "time";
    public static final String ORDER_BIB = "bib";
    public static final String ORDER_NAME = "name";
    public String resultsOrder() { return sp.getString("resultsOrder", ORDER_TIME); }
    public int timingDecimals() { return sp.getInt("timingDecimals", 1); } // 0=1s,1=0.1,2=0.01,3=0.001
    public boolean categoryResults() { return sp.getBoolean("categoryResults", true); }
    public boolean overallByDistance() { return sp.getBoolean("overallByDistance", true); }
    public boolean overallByGender() { return sp.getBoolean("overallByGender", false); }
    public boolean overallAllDistances() { return sp.getBoolean("overallAllDistances", false); }
    public void saveResultsOptions(String order, int decimals, boolean category,
                                   boolean byDistance, boolean byGender, boolean allDistances) {
        sp.edit()
                .putString("resultsOrder", order)
                .putInt("timingDecimals", Math.max(0, Math.min(3, decimals)))
                .putBoolean("categoryResults", category)
                .putBoolean("overallByDistance", byDistance)
                .putBoolean("overallByGender", byGender)
                .putBoolean("overallAllDistances", allDistances)
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
                .remove("reqCategory").remove("reqGender")
                .remove("resultsOrder").remove("timingDecimals").remove("categoryResults")
                .remove("overallByDistance").remove("overallByGender").remove("overallAllDistances")
                .apply();
    }

    /** Remembered after the first successful login so race downloads are one tap. */
    public void saveAccount(String email, String password) {
        sp.edit().putString("accountEmail", email.trim())
                .putString("accountPass", password).apply();
    }

    /** Called when the user picks a race after logging in: wires the pairing. */
    public void savePairing(String readerToken, String contestTitle, String email, int contestId) {
        sp.edit()
                .putString("readerToken", readerToken.trim())
                .putString("contestTitle", contestTitle)
                .putString("accountEmail", email.trim())
                .putInt("contestId", contestId)
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

package com.velogrip.rfid.net;

import com.velogrip.rfid.Prefs;
import com.velogrip.rfid.db.RaceStore;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.Locale;

/** Pulls the paired race's start list from the web into the local store. */
public final class StartListSync {

    public static final class Result {
        public final int racers, waves;
        Result(int racers, int waves) { this.racers = racers; this.waves = waves; }
    }

    private StartListSync() { }

    /** Blocking — call from a worker thread. Local gun times always win. */
    public static Result download(Prefs prefs, RaceStore store) throws Exception {
        String body = new Uploader(prefs.serverUrl(), prefs.readerToken()).downloadStartList();
        JSONObject json = new JSONObject(body);
        prefs.saveTimingSettings(
                json.optInt("suppress_secs", 10),
                json.optInt("min_lap_gap_secs", 30),
                json.getJSONObject("contest").optString("title", ""));
        JSONArray waves = json.getJSONArray("waves");
        for (int i = 0; i < waves.length(); i++) {
            JSONObject w = waves.getJSONObject(i);
            RaceStore.Wave local = store.wave(w.getString("name"));
            if (local == null || local.startedAtMs == null) {
                String at = w.isNull("started_at") ? null : w.getString("started_at");
                store.upsertWave(w.getString("name"),
                        at == null ? null : parseIso(at), at != null);
            }
        }
        JSONArray racers = json.getJSONArray("racers");
        // Two-chip racers arrive as one row per chip; count people, not chips.
        java.util.HashSet<String> distinct = new java.util.HashSet<>();
        for (int i = 0; i < racers.length(); i++) {
            JSONObject r = racers.getJSONObject(i);
            String bib = r.optString("bib", "");
            distinct.add(bib.isEmpty() ? "e:" + r.getString("epc") : "b:" + bib);
            store.upsertRacer(new RaceStore.Racer(
                    r.getString("epc"), bib, r.optString("participant", ""),
                    r.optString("category", ""), r.isNull("wave") ? "" : r.optString("wave", ""),
                    r.isNull("distance") ? "" : r.optString("distance", ""), "",
                    r.isNull("gender") ? "" : r.optString("gender", ""),
                    r.isNull("team") ? "" : r.optString("team", "")));
        }
        return new Result(distinct.size(), waves.length());
    }

    public static long parseIso(String iso) {
        try {
            java.text.SimpleDateFormat fmt =
                    new java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US);
            fmt.setTimeZone(java.util.TimeZone.getTimeZone("UTC"));
            return fmt.parse(iso).getTime();
        } catch (Exception e) {
            return System.currentTimeMillis();
        }
    }
}

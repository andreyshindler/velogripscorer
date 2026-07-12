package com.velogrip.rfid;

import com.velogrip.rfid.db.RaceStore;

import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * On-device race results — the same rules the server applies, so the phone can
 * run the whole race with zero connectivity:
 *   - reads inside the start-suppression window are ignored
 *   - crossings closer together than the minimum lap gap collapse into one
 *   - elapsed = last crossing − gun time; more laps beats fewer, then fastest
 */
public final class RaceEngine {

    public static final class Result {
        public int rank;                 // 0 = unranked
        public final String bib, name, category, wave, distance;
        public final String status;     // finished | on_course | not_started
        public final int laps;
        public final long elapsedMs;    // 0 unless finished

        Result(String bib, String name, String category, String wave, String distance,
               String status, int laps, long elapsedMs) {
            this.bib = bib; this.name = name; this.category = category; this.wave = wave;
            this.distance = distance;
            this.status = status; this.laps = laps; this.elapsedMs = elapsedMs;
        }
    }

    private RaceEngine() { }

    public static List<Result> compute(List<RaceStore.Racer> racers, List<RaceStore.Wave> waves,
                                       List<RaceStore.Passing> passings,
                                       int suppressSecs, int minLapGapSecs) {
        return compute(racers, waves, passings, suppressSecs, minLapGapSecs, true);
    }

    public static List<Result> compute(List<RaceStore.Racer> racers, List<RaceStore.Wave> waves,
                                       List<RaceStore.Passing> passings,
                                       int suppressSecs, int minLapGapSecs, boolean recordLaps) {
        return compute(racers, waves, passings, suppressSecs, minLapGapSecs, recordLaps, null);
    }

    /**
     * lapTargets maps distance -> laps to finish (default 1 per distance);
     * null means the legacy unlimited mode where any crossing finishes and
     * every further crossing counts as another lap.
     */
    public static List<Result> compute(List<RaceStore.Racer> racers, List<RaceStore.Wave> waves,
                                       List<RaceStore.Passing> passings,
                                       int suppressSecs, int minLapGapSecs, boolean recordLaps,
                                       Map<String, Integer> lapTargets) {
        return compute(racers, waves, passings, suppressSecs, minLapGapSecs, recordLaps, lapTargets, false);
    }

    /**
     * finalizeLapsDown: when the race is closed with racers still out, those
     * with at least one crossing are finished at their last crossing with the
     * laps they completed (ranked below full-distance finishers).
     */
    public static List<Result> compute(List<RaceStore.Racer> racers, List<RaceStore.Wave> waves,
                                       List<RaceStore.Passing> passings,
                                       int suppressSecs, int minLapGapSecs, boolean recordLaps,
                                       Map<String, Integer> lapTargets, boolean finalizeLapsDown) {
        Map<String, Long> gunByWave = new HashMap<>();
        for (RaceStore.Wave w : waves) {
            if (w.startedAtMs != null) gunByWave.put(w.name, w.startedAtMs);
        }
        Map<String, List<Long>> readsByEpc = new HashMap<>();
        for (RaceStore.Passing p : passings) {
            List<Long> list = readsByEpc.get(p.epc);
            if (list == null) readsByEpc.put(p.epc, list = new ArrayList<>());
            list.add(p.readAtMs);
        }

        long suppressMs = suppressSecs * 1000L;
        long lapGapMs = minLapGapSecs * 1000L;

        // Racers can carry two chips: rows sharing a non-empty bib are merged
        // so a read from either chip counts for the racer.
        Map<String, List<RaceStore.Racer>> groups = new java.util.LinkedHashMap<>();
        for (RaceStore.Racer racer : racers) {
            String key = racer.bib.isEmpty() ? "epc:" + racer.epc : "bib:" + racer.bib;
            List<RaceStore.Racer> group = groups.get(key);
            if (group == null) groups.put(key, group = new ArrayList<>());
            group.add(racer);
        }

        List<Result> results = new ArrayList<>();
        for (List<RaceStore.Racer> group : groups.values()) {
            RaceStore.Racer racer = group.get(0);
            // organizer-declared status (DNS/DNF/DSQ) overrides everything
            String declared = "";
            for (RaceStore.Racer member : group) {
                if (member.status != null && !member.status.isEmpty()) { declared = member.status; break; }
            }
            if (!declared.isEmpty()) {
                results.add(new Result(racer.bib, racer.name, racer.category, racer.wave,
                        racer.distance, declared, 0, 0));
                continue;
            }
            // racers without a wave start with the mass gun (wave named "")
            Long gun = gunByWave.get(racer.wave);
            if (gun == null) {
                results.add(new Result(racer.bib, racer.name, racer.category, racer.wave,
                        racer.distance, "not_started", 0, 0));
                continue;
            }
            List<Long> raw = new ArrayList<>();
            for (RaceStore.Racer member : group) {
                List<Long> reads = readsByEpc.get(member.epc);
                if (reads != null) raw.addAll(reads);
            }
            int target;
            if (!recordLaps) target = 1;
            else if (lapTargets == null) target = Integer.MAX_VALUE; // unlimited
            else {
                Integer t = lapTargets.get(racer.distance);
                target = Math.max(1, t == null ? 1 : t);
            }
            List<Long> crossings = new ArrayList<>();
            if (!raw.isEmpty()) {
                Collections.sort(raw);
                for (long at : raw) {
                    if (at < gun + suppressMs) continue;
                    if (crossings.size() >= target) break; // race done for this racer
                    if (crossings.isEmpty() || at - crossings.get(crossings.size() - 1) >= lapGapMs) {
                        crossings.add(at);
                    }
                }
            }
            boolean unlimited = target == Integer.MAX_VALUE;
            if (crossings.isEmpty()) {
                results.add(new Result(racer.bib, racer.name, racer.category, racer.wave,
                        racer.distance, "on_course", 0, 0));
            } else if (!unlimited && crossings.size() < target && !finalizeLapsDown) {
                // laps completed so far, still on course to the lap target
                results.add(new Result(racer.bib, racer.name, racer.category, racer.wave,
                        racer.distance, "on_course", crossings.size(), 0));
            } else {
                long last = crossings.get(crossings.size() - 1);
                results.add(new Result(racer.bib, racer.name, racer.category, racer.wave,
                        racer.distance, "finished", crossings.size(), last - gun));
            }
        }

        Collections.sort(results, new Comparator<Result>() {
            @Override
            public int compare(Result a, Result b) {
                boolean fa = "finished".equals(a.status), fb = "finished".equals(b.status);
                if (fa != fb) return fa ? -1 : 1;
                if (!fa) return b.laps - a.laps; // on-course: most laps done first
                if (a.laps != b.laps) return b.laps - a.laps;
                return Long.compare(a.elapsedMs, b.elapsedMs);
            }
        });
        int rank = 1;
        for (Result r : results) {
            if ("finished".equals(r.status)) r.rank = rank++;
        }
        return results;
    }

    /** 0.1-second precision, mm:ss.t or h:mm:ss.t — matches the web display. */
    public static String formatElapsed(long ms) {
        return formatElapsed(ms, 1);
    }

    /** Configurable timing precision: decimals 0 (1s), 1 (0.1s), 2, or 3. */
    public static String formatElapsed(long ms, int decimals) {
        decimals = Math.max(0, Math.min(3, decimals));
        long scale = (long) Math.pow(10, decimals);          // fractional units per second
        long units = Math.round(ms / (1000.0 / scale));      // total fractional units
        long h = units / (3600 * scale);
        long m = (units / (60 * scale)) % 60;
        long s = (units / scale) % 60;
        long frac = units % scale;
        String head = h > 0
                ? String.format(Locale.US, "%d:%02d", h, m)
                : String.valueOf(m);
        String body = head + String.format(Locale.US, ":%02d", s);
        return decimals == 0 ? body
                : body + "." + String.format(Locale.US, "%0" + decimals + "d", frac);
    }

    public static String formatClock(long ms) {
        long secs = Math.max(0, ms / 1000);
        return String.format(Locale.US, "%d:%02d:%02d", secs / 3600, (secs % 3600) / 60, secs % 60);
    }
}

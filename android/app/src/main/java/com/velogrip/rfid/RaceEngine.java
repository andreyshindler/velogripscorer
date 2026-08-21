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
        public final String bib, name, category, wave, distance, gender;
        public final String status;     // finished | on_course | not_started
        public final int laps;
        public final long elapsedMs;    // 0 unless finished
        public long[] lapElapsed = new long[0];   // elapsed of each counted crossing

        Result(String bib, String name, String category, String wave, String distance, String gender,
               String status, int laps, long elapsedMs) {
            this.bib = bib; this.name = name; this.category = category; this.wave = wave;
            this.distance = distance; this.gender = gender;
            this.status = status; this.laps = laps; this.elapsedMs = elapsedMs;
        }
    }

    /** A crossing time plus whether it came from a deliberate operator tap. */
    private static final class Read {
        final long at;
        final boolean manual;
        Read(long at, boolean manual) { this.at = at; this.manual = manual; }
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
        return compute(racers, waves, passings, suppressSecs, minLapGapSecs, recordLaps,
                lapTargets, finalizeLapsDown, 0L, 0L, 0L);
    }

    /**
     * Start-line roll call. nowMs is the current time; a racer whose wave has
     * been gunned, who has no crossings and was never read since the gun, is
     * marked DNS once the roll call has closed for that wave — either the window
     * (rollCallWindowMs, 0 = off) has elapsed or the operator closed it manually
     * (rollCallClosedAt, 0 = open). It is recomputed every call, so a later read
     * clears it automatically. All three zero = feature off (legacy behaviour).
     */
    public static List<Result> compute(List<RaceStore.Racer> racers, List<RaceStore.Wave> waves,
                                       List<RaceStore.Passing> passings,
                                       int suppressSecs, int minLapGapSecs, boolean recordLaps,
                                       Map<String, Integer> lapTargets, boolean finalizeLapsDown,
                                       long nowMs, long rollCallWindowMs, long rollCallClosedAt) {
        return compute(racers, waves, passings, suppressSecs, minLapGapSecs, recordLaps,
                lapTargets, finalizeLapsDown, nowMs, rollCallWindowMs, rollCallClosedAt, false);
    }

    /** As above plus the MTB "leader ends race" rule (opt-in). */
    public static List<Result> compute(List<RaceStore.Racer> racers, List<RaceStore.Wave> waves,
                                       List<RaceStore.Passing> passings,
                                       int suppressSecs, int minLapGapSecs, boolean recordLaps,
                                       Map<String, Integer> lapTargets, boolean finalizeLapsDown,
                                       boolean leaderEndsRace) {
        return compute(racers, waves, passings, suppressSecs, minLapGapSecs, recordLaps,
                lapTargets, finalizeLapsDown, 0L, 0L, 0L, leaderEndsRace);
    }

    /**
     * leaderEndsRace (MTB/XCO): once the first racer completes the target laps,
     * the race is over — everyone still out finishes only their current lap and
     * later crossings are ignored. Needs a lap target; inert otherwise.
     */
    public static List<Result> compute(List<RaceStore.Racer> racers, List<RaceStore.Wave> waves,
                                       List<RaceStore.Passing> passings,
                                       int suppressSecs, int minLapGapSecs, boolean recordLaps,
                                       Map<String, Integer> lapTargets, boolean finalizeLapsDown,
                                       long nowMs, long rollCallWindowMs, long rollCallClosedAt,
                                       boolean leaderEndsRace) {
        Map<String, Long> gunByWave = new HashMap<>();
        for (RaceStore.Wave w : waves) {
            if (w.startedAtMs != null) gunByWave.put(w.name, w.startedAtMs);
        }
        Map<String, List<Read>> readsByEpc = new HashMap<>();
        for (RaceStore.Passing p : passings) {
            List<Read> list = readsByEpc.get(p.epc);
            if (list == null) readsByEpc.put(p.epc, list = new ArrayList<>());
            list.add(new Read(p.readAtMs, p.manual));
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

        // Leader cutoff = the earliest wall-clock time any racer completes their
        // target laps (first finisher ends it for the whole field). MAX_VALUE =
        // nobody has finished the full distance yet, so the rule stays inert.
        long cutoff = Long.MAX_VALUE;
        if (leaderEndsRace) {
            for (List<RaceStore.Racer> group : groups.values()) {
                RaceStore.Racer racer = group.get(0);
                if (!declaredStatus(group).isEmpty()) continue;
                Long gun = gunByWave.get(racer.wave);
                if (gun == null) continue;
                int target = resolveTarget(recordLaps, lapTargets, racer.distance);
                if (target == Integer.MAX_VALUE) continue;
                List<Long> cr = buildCrossings(collectRaw(group, readsByEpc), gun, suppressMs, lapGapMs, target);
                if (cr.size() >= target) cutoff = Math.min(cutoff, cr.get(target - 1));
            }
        }

        List<Result> results = new ArrayList<>();
        for (List<RaceStore.Racer> group : groups.values()) {
            RaceStore.Racer racer = group.get(0);
            // organizer-declared status (DNS/DNF/DSQ) overrides everything
            String declared = declaredStatus(group);
            if (!declared.isEmpty()) {
                results.add(new Result(racer.bib, racer.name, racer.category, racer.wave,
                        racer.distance, racer.gender,declared, 0, 0));
                continue;
            }
            // racers without a wave start with the mass gun (wave named "")
            Long gun = gunByWave.get(racer.wave);
            if (gun == null) {
                results.add(new Result(racer.bib, racer.name, racer.category, racer.wave,
                        racer.distance, racer.gender,"not_started", 0, 0));
                continue;
            }
            List<Read> raw = collectRaw(group, readsByEpc);
            int target = resolveTarget(recordLaps, lapTargets, racer.distance);
            List<Long> crossings = buildCrossings(raw, gun, suppressMs, lapGapMs, target);

            // Leader rule: finish on the first crossing that reaches the target
            // OR falls at/after the cutoff (the current lap); drop the rest.
            boolean cutByLeader = false;
            if (leaderEndsRace && cutoff != Long.MAX_VALUE && !crossings.isEmpty()) {
                int idx = -1;
                for (int i = 0; i < crossings.size(); i++) {
                    if ((target != Integer.MAX_VALUE && i + 1 >= target) || crossings.get(i) >= cutoff) { idx = i; break; }
                }
                if (idx >= 0) {
                    crossings = new ArrayList<>(crossings.subList(0, idx + 1));
                    cutByLeader = crossings.get(crossings.size() - 1) >= cutoff;
                }
            }

            boolean unlimited = target == Integer.MAX_VALUE;
            // elapsed of each counted crossing, for per-lap split rows
            long[] splits = new long[crossings.size()];
            for (int i = 0; i < crossings.size(); i++) splits[i] = crossings.get(i) - gun;
            Result res;
            if (crossings.isEmpty()) {
                // Start-line roll call: gunned but no crossings. If the roll call
                // has closed and this racer was never read since the gun, they
                // didn't start -> DNS; otherwise they're still out on course.
                boolean seenSinceGun = false;
                for (Read rd : raw) { if (rd.at >= gun) { seenSinceGun = true; break; } }
                boolean rollCallClosed = (rollCallClosedAt > 0 && rollCallClosedAt > gun)
                        || (rollCallWindowMs > 0 && nowMs >= gun + rollCallWindowMs);
                String s = (rollCallClosed && !seenSinceGun) ? "DNS" : "on_course";
                res = new Result(racer.bib, racer.name, racer.category, racer.wave,
                        racer.distance, racer.gender, s, 0, 0);
            } else if (!unlimited && crossings.size() < target && !finalizeLapsDown && !cutByLeader) {
                // laps completed so far, still on course to the lap target
                res = new Result(racer.bib, racer.name, racer.category, racer.wave,
                        racer.distance, racer.gender,"on_course", crossings.size(), 0);
            } else {
                long last = crossings.get(crossings.size() - 1);
                res = new Result(racer.bib, racer.name, racer.category, racer.wave,
                        racer.distance, racer.gender,"finished", crossings.size(), last - gun);
            }
            res.lapElapsed = splits;
            results.add(res);
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

    /** Organizer-declared status (DNS/DNF/DSQ) on any chip of a merged racer. */
    private static String declaredStatus(List<RaceStore.Racer> group) {
        for (RaceStore.Racer m : group) {
            if (m.status != null && !m.status.isEmpty()) return m.status;
        }
        return "";
    }

    /** All reads for a merged racer (a rider may carry two chips). */
    private static List<Read> collectRaw(List<RaceStore.Racer> group, Map<String, List<Read>> readsByEpc) {
        List<Read> raw = new ArrayList<>();
        for (RaceStore.Racer m : group) {
            List<Read> reads = readsByEpc.get(m.epc);
            if (reads != null) raw.addAll(reads);
        }
        return raw;
    }

    /** Laps to finish: per-distance target, else 1; unlimited when no targets. */
    private static int resolveTarget(boolean recordLaps, Map<String, Integer> lapTargets, String distance) {
        if (!recordLaps) return 1;
        if (lapTargets == null) return Integer.MAX_VALUE;
        Integer t = lapTargets.get(distance);
        return Math.max(1, t == null ? 1 : t);
    }

    /** Valid crossings (suppression + lap-gap applied), capped at the target. */
    private static List<Long> buildCrossings(List<Read> raw, long gun, long suppressMs, long lapGapMs, int target) {
        List<Long> crossings = new ArrayList<>();
        if (raw.isEmpty()) return crossings;
        Collections.sort(raw, new Comparator<Read>() {
            @Override public int compare(Read a, Read b) { return Long.compare(a.at, b.at); }
        });
        for (Read rd : raw) {
            // Manual operator taps are deliberate: they skip the RFID start-
            // suppression window and the lap-gap de-dup, so each tap is a crossing.
            if (!rd.manual && rd.at < gun + suppressMs) continue;
            if (crossings.size() >= target) break; // race done for this racer
            if (rd.manual || crossings.isEmpty()
                    || rd.at - crossings.get(crossings.size() - 1) >= lapGapMs) {
                crossings.add(rd.at);
            }
        }
        return crossings;
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

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
        public final String bib, name, category, wave;
        public final String status;     // finished | on_course | not_started
        public final int laps;
        public final long elapsedMs;    // 0 unless finished

        Result(String bib, String name, String category, String wave,
               String status, int laps, long elapsedMs) {
            this.bib = bib; this.name = name; this.category = category; this.wave = wave;
            this.status = status; this.laps = laps; this.elapsedMs = elapsedMs;
        }
    }

    private RaceEngine() { }

    public static List<Result> compute(List<RaceStore.Racer> racers, List<RaceStore.Wave> waves,
                                       List<RaceStore.Passing> passings,
                                       int suppressSecs, int minLapGapSecs) {
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

        List<Result> results = new ArrayList<>();
        for (RaceStore.Racer racer : racers) {
            Long gun = racer.wave.isEmpty() ? null : gunByWave.get(racer.wave);
            if (gun == null) {
                results.add(new Result(racer.bib, racer.name, racer.category, racer.wave,
                        "not_started", 0, 0));
                continue;
            }
            List<Long> raw = readsByEpc.get(racer.epc);
            List<Long> crossings = new ArrayList<>();
            if (raw != null) {
                Collections.sort(raw);
                for (long at : raw) {
                    if (at < gun + suppressMs) continue;
                    if (crossings.isEmpty() || at - crossings.get(crossings.size() - 1) >= lapGapMs) {
                        crossings.add(at);
                    }
                }
            }
            if (crossings.isEmpty()) {
                results.add(new Result(racer.bib, racer.name, racer.category, racer.wave,
                        "on_course", 0, 0));
            } else {
                long last = crossings.get(crossings.size() - 1);
                results.add(new Result(racer.bib, racer.name, racer.category, racer.wave,
                        "finished", crossings.size(), last - gun));
            }
        }

        Collections.sort(results, new Comparator<Result>() {
            @Override
            public int compare(Result a, Result b) {
                boolean fa = "finished".equals(a.status), fb = "finished".equals(b.status);
                if (fa != fb) return fa ? -1 : 1;
                if (!fa) return 0;
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
        long tenths = Math.round(ms / 100.0);
        long h = tenths / 36000;
        long m = (tenths % 36000) / 600;
        long s = (tenths % 600) / 10;
        long t = tenths % 10;
        String head = h > 0
                ? String.format(Locale.US, "%d:%02d", h, m)
                : String.valueOf(m);
        return head + String.format(Locale.US, ":%02d.%d", s, t);
    }

    public static String formatClock(long ms) {
        long secs = Math.max(0, ms / 1000);
        return String.format(Locale.US, "%d:%02d:%02d", secs / 3600, (secs % 3600) / 60, secs % 60);
    }
}

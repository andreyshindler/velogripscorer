package com.velogrip.rfid;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.Gravity;
import android.view.View;
import android.widget.GridLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import com.velogrip.rfid.db.RaceStore;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * Race Timing — the live console. A running race clock, a paginated grid of
 * bib tiles (tap to finish a racer now), a "No Bib" tile / clock button that
 * records an unassigned time you can assign later, and the live finish order
 * below. Reads from the RFID reader (via the bridge) land here too.
 */
public class RaceTimingActivity extends Activity {

    private static final String NO_BIB = "NOBIB";
    private static final int PAGE_SIZE = 20;

    private RaceStore store;
    private Prefs prefs;
    private TextView clockText, hint;
    private GridLayout grid;
    private LinearLayout resultsBox;
    private int page;
    private boolean showSplits = true;
    private long lastSplitMs = -1;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Runnable ticker = new Runnable() {
        @Override public void run() { tickClock(); handler.postDelayed(this, 100); }
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_race_timing);
        store = new RaceStore(this);
        prefs = new Prefs(this);

        clockText = findViewById(R.id.clockText);
        grid = findViewById(R.id.bibGrid);
        resultsBox = findViewById(R.id.resultsBox);
        hint = findViewById(R.id.timingHint);

        findViewById(R.id.homeButton).setOnClickListener(v -> {
            Intent i = new Intent(this, MainActivity.class);
            i.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
            startActivity(i);
        });
        findViewById(R.id.finishButton).setOnClickListener(v -> finishRace());
        findViewById(R.id.clockButton).setOnClickListener(v -> recordNoBib());
        findViewById(R.id.prevPage).setOnClickListener(v -> { if (page > 0) { page--; render(); } });
        findViewById(R.id.nextPage).setOnClickListener(v -> { page++; render(); });

        findViewById(R.id.aSplits).setOnClickListener(v -> { showSplits = true; render(); });
        findViewById(R.id.bHide).setOnClickListener(v -> { showSplits = false; render(); });
        findViewById(R.id.aControl).setOnClickListener(v -> raceControl());
        findViewById(R.id.aMoreT).setOnClickListener(v -> togglePage(true));
        findViewById(R.id.bMoreT).setOnClickListener(v -> togglePage(false));
        int[] stubs = {R.id.aNormal, R.id.aKeypad, R.id.bPause, R.id.bDist, R.id.bCat};
        for (int id : stubs) findViewById(id).setOnClickListener(v ->
                Toast.makeText(this, R.string.view_option_unsupported, Toast.LENGTH_SHORT).show());
    }

    private void togglePage(boolean showB) {
        findViewById(R.id.tbarA).setVisibility(showB ? View.GONE : View.VISIBLE);
        findViewById(R.id.tbarB).setVisibility(showB ? View.VISIBLE : View.GONE);
    }

    // ---- race clock ----

    private Long gunTime() {
        Long earliest = null;
        for (RaceStore.Wave w : store.waves()) {
            if (w.startedAtMs != null && (earliest == null || w.startedAtMs < earliest)) earliest = w.startedAtMs;
        }
        return earliest;
    }

    private void tickClock() {
        Long gun = gunTime();
        long elapsed = gun == null ? 0 : System.currentTimeMillis() - gun;
        clockText.setText(RaceEngine.formatElapsed(Math.max(0, elapsed), 1));
    }

    // ---- recording finishes ----

    private void recordNoBib() {
        store.recordPassing(NO_BIB, System.currentTimeMillis());
        render();
    }

    private void finishRacer(RaceStore.Racer r) {
        store.recordPassing(r.epc, System.currentTimeMillis());
        Toast.makeText(this, "⏱ #" + r.bib + "  " + r.name, Toast.LENGTH_SHORT).show();
        render();
    }

    // ---- rendering ----

    private void render() {
        List<RaceEngine.Result> results = RaceEngine.compute(
                store.racers(), store.waves(), store.allPassings(),
                prefs.suppressSecs(), prefs.lapGapSecs(), prefs.recordLaps(), store.lapTargets(),
                prefs.raceFinalized());

        java.util.Set<String> finishedBibs = new java.util.HashSet<>();
        for (RaceEngine.Result r : results) if ("finished".equals(r.status)) finishedBibs.add(bibKey(r.bib, ""));

        // grid tiles: No Bib + racers not yet finished
        List<RaceStore.Racer> pending = new ArrayList<>();
        for (RaceStore.Racer r : store.startListEntries()) {
            if (!finishedBibs.contains(bibKey(r.bib, r.epc)) && r.status.isEmpty()) pending.add(r);
        }
        java.util.Collections.sort(pending, (a, b) -> Long.compare(bibNum(a.bib), bibNum(b.bib)));

        List<Object> tiles = new ArrayList<>();
        tiles.add(NO_BIB);
        tiles.addAll(pending);
        int pages = Math.max(1, (int) Math.ceil(tiles.size() / (double) PAGE_SIZE));
        if (page >= pages) page = pages - 1;
        renderGrid(tiles.subList(page * PAGE_SIZE, Math.min(tiles.size(), (page + 1) * PAGE_SIZE)));

        renderResults(results);

        int racerTotal = store.racerCount();
        if (showSplits && lastSplitMs >= 0) {
            hint.setText(getString(R.string.finish_split, RaceEngine.formatElapsed(lastSplitMs, 1)));
        } else {
            hint.setText(getString(R.string.timing_hint, racerTotal, page + 1, pages));
        }
    }

    private void renderGrid(List<Object> tiles) {
        grid.removeAllViews();
        int cols = 4;
        grid.setColumnCount(cols);
        int margin = dp(4);
        for (Object t : tiles) {
            LinearLayout tile = new LinearLayout(this);
            tile.setOrientation(LinearLayout.VERTICAL);
            tile.setGravity(Gravity.CENTER);
            tile.setPadding(dp(6), dp(14), dp(6), dp(14));

            TextView top = new TextView(this);
            top.setTextSize(20);
            top.setTypeface(null, android.graphics.Typeface.BOLD);
            top.setGravity(Gravity.CENTER);
            TextView bottom = new TextView(this);
            bottom.setTextSize(13);
            bottom.setGravity(Gravity.CENTER);

            if (t instanceof String) { // No Bib
                tile.setBackgroundColor(0xFF8A8F98);
                top.setText(R.string.no_bib);
                top.setTextColor(0xFFFFFFFF);
                bottom.setText("");
                tile.setOnClickListener(v -> recordNoBib());
            } else {
                final RaceStore.Racer r = (RaceStore.Racer) t;
                tile.setBackgroundColor(0xFF8DC63F);
                top.setText(r.bib);
                top.setTextColor(0xFF1A1A1A);
                bottom.setText(R.string.tap_to_finish);
                bottom.setTextColor(0xFF1A3A0A);
                tile.setOnClickListener(v -> finishRacer(r));
            }
            tile.addView(top);
            tile.addView(bottom);

            GridLayout.LayoutParams lp = new GridLayout.LayoutParams();
            lp.width = 0;
            lp.height = GridLayout.LayoutParams.WRAP_CONTENT;
            lp.columnSpec = GridLayout.spec(GridLayout.UNDEFINED, 1f);
            lp.setMargins(margin, margin, margin, margin);
            tile.setLayoutParams(lp);
            grid.addView(tile);
        }
    }

    private void renderResults(List<RaceEngine.Result> results) {
        resultsBox.removeAllViews();
        int decimals = prefs.timingDecimals();
        int place = 1;
        long prevElapsed = -1;
        // unassigned No-Bib times first (need attention)
        for (RaceStore.Passing p : store.passingsForEpc(NO_BIB)) {
            Long gun = gunTime();
            long elapsed = gun == null ? 0 : p.readAtMs - gun;
            resultsBox.addView(resultRow("—", getString(R.string.no_bib_short), "",
                    RaceEngine.formatElapsed(Math.max(0, elapsed), decimals), true, () -> assignNoBib(p)));
        }
        for (RaceEngine.Result r : results) {
            if (!"finished".equals(r.status)) continue;
            String time = RaceEngine.formatElapsed(r.elapsedMs, decimals);
            resultsBox.addView(resultRow(String.valueOf(place++), r.bib, r.name, time, false, null));
            if (prevElapsed >= 0) lastSplitMs = r.elapsedMs - prevElapsed;
            prevElapsed = r.elapsedMs;
        }
    }

    private View resultRow(String place, String bib, String name, String time,
                           boolean unassigned, Runnable onTap) {
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL);
        row.setPadding(dp(10), dp(12), dp(10), dp(12));

        TextView pl = chip(place, dp(34), unassigned ? 0xFFEED202 : 0xFFF2E400);
        TextView bibv = chip(bib, dp(48), 0xFFF2E400);
        TextView nm = new TextView(this);
        nm.setText(name);
        nm.setTextSize(17);
        nm.setTextColor(0xFF111111);
        nm.setPadding(dp(8), 0, dp(8), 0);
        nm.setLayoutParams(new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f));
        TextView tv = chip(time, LinearLayout.LayoutParams.WRAP_CONTENT, 0xFFF2E400);

        row.addView(pl);
        row.addView(bibv);
        row.addView(nm);
        row.addView(tv);
        if (onTap != null) {
            TextView chevron = new TextView(this);
            chevron.setText("❯");
            chevron.setTextColor(0xFF76B82A);
            chevron.setTextSize(15);
            chevron.setBackgroundResource(R.drawable.bg_chevron);
            chevron.setPadding(dp(9), dp(3), dp(9), dp(3));
            row.addView(chevron);
            row.setOnClickListener(v -> onTap.run());
        }
        return row;
    }

    private TextView chip(String text, int width, int bg) {
        TextView t = new TextView(this);
        t.setText(text);
        t.setTextSize(17);
        t.setTextColor(0xFF111111);
        t.setGravity(Gravity.CENTER);
        t.setPadding(dp(6), dp(4), dp(6), dp(4));
        android.graphics.drawable.GradientDrawable bgd = new android.graphics.drawable.GradientDrawable();
        bgd.setColor(bg);
        bgd.setCornerRadius(dp(4));
        t.setBackground(bgd);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(width, LinearLayout.LayoutParams.WRAP_CONTENT);
        lp.setMargins(dp(2), 0, dp(2), 0);
        t.setLayoutParams(lp);
        return t;
    }

    private void assignNoBib(RaceStore.Passing p) {
        List<RaceStore.Racer> racers = store.startListEntries();
        java.util.Collections.sort(racers, (a, b) -> Long.compare(bibNum(a.bib), bibNum(b.bib)));
        final String[] labels = new String[racers.size()];
        for (int i = 0; i < racers.size(); i++) labels[i] = "#" + racers.get(i).bib + "  " + racers.get(i).name;
        new android.app.AlertDialog.Builder(this)
                .setTitle(R.string.assign_to_racer)
                .setItems(labels, (d, which) -> {
                    store.deletePassing(p.id);
                    store.recordPassing(racers.get(which).epc, p.readAtMs);
                    render();
                })
                .setNegativeButton(android.R.string.cancel, null)
                .show();
    }

    private void raceControl() {
        final String[] options = {
                getString(R.string.rc_restart), getString(R.string.rc_finish), getString(R.string.rc_live),
                getString(R.string.rc_progress), getString(R.string.rc_settings)};
        new android.app.AlertDialog.Builder(this)
                .setTitle(R.string.choose_race_control)
                .setItems(options, (d, which) -> {
                    switch (which) {
                        case 0:   // Restart race (false start)
                            restartRace();
                            break;
                        case 1:   // Finish race (race completed)
                            finishRace();
                            break;
                        case 2:   // Live results view / update
                            boolean on = !prefs.liveResults();
                            prefs.setLiveResults(on);
                            Toast.makeText(this, getString(on ? R.string.live_results_on : R.string.live_results_off),
                                    Toast.LENGTH_LONG).show();
                            break;
                        case 3:   // Race progress (view)
                            showRaceProgress();
                            break;
                        default:  // Settings
                            startActivity(new Intent(this, SettingsActivity.class));
                    }
                })
                .setNegativeButton(R.string.close, null)
                .show();
    }

    /** Finish race: if racers are still out, offer DNF or laps-down; else results. */
    private void finishRace() {
        List<RaceEngine.Result> results = RaceEngine.compute(
                store.racers(), store.waves(), store.allPassings(),
                prefs.suppressSecs(), prefs.lapGapSecs(), prefs.recordLaps(), store.lapTargets(),
                prefs.raceFinalized());
        final List<RaceEngine.Result> unfinished = new ArrayList<>();
        for (RaceEngine.Result r : results) {
            if ("on_course".equals(r.status) || "not_started".equals(r.status)) unfinished.add(r);
        }
        if (unfinished.isEmpty()) {
            startActivity(new Intent(this, RaceArchiveActivity.class));
            return;
        }
        new android.app.AlertDialog.Builder(this)
                .setTitle(R.string.still_on_course)
                .setItems(new String[]{getString(R.string.mark_dnf), getString(R.string.mark_laps_down)},
                        (d, which) -> {
                            if (which == 0) {                       // Mark racers as DNF
                                for (RaceEngine.Result r : unfinished) store.setRacerStatus(r.bib, "DNF");
                            } else {                                // Mark racers as laps down
                                prefs.setRaceFinalized(true);
                                for (RaceEngine.Result r : unfinished) {
                                    if (r.laps == 0) store.setRacerStatus(r.bib, "DNF"); // never crossed
                                }
                            }
                            startActivity(new Intent(this, RaceArchiveActivity.class));
                        })
                .setNegativeButton(R.string.cancel_popup, null)
                .show();
    }

    /** Restart (false start): keep or discard the already-recorded times, then re-gun. */
    private void restartRace() {
        new android.app.AlertDialog.Builder(this)
                .setTitle(R.string.restart_results_prompt)
                .setItems(new String[]{getString(R.string.restart_save), getString(R.string.restart_discard)},
                        (d, which) -> {
                            if (which == 1) store.clearPassings(); // Discard
                            long now = System.currentTimeMillis();
                            store.startWave("", now, true);
                            for (RaceStore.Wave w : store.waves())
                                if (!w.name.isEmpty()) store.startWave(w.name, now, true);
                            lastSplitMs = -1;
                            page = 0;
                            Toast.makeText(this, R.string.race_restarted, Toast.LENGTH_LONG).show();
                            render();
                        })
                .setNegativeButton(R.string.cancel_popup, null)
                .show();
    }

    private void showRaceProgress() {
        List<RaceEngine.Result> results = RaceEngine.compute(
                store.racers(), store.waves(), store.allPassings(),
                prefs.suppressSecs(), prefs.lapGapSecs(), prefs.recordLaps(), store.lapTargets(),
                prefs.raceFinalized());
        int finished = 0, onCourse = 0, notStarted = 0, dns = 0;
        long lastElapsed = 0;
        for (RaceEngine.Result r : results) {
            switch (r.status) {
                case "finished": finished++; lastElapsed = Math.max(lastElapsed, r.elapsedMs); break;
                case "on_course": onCourse++; break;
                case "not_started": notStarted++; break;
                default: dns++;
            }
        }
        int noBib = store.passingsForEpc(NO_BIB).size();
        String body = getString(R.string.race_progress_body,
                store.racerCount(), finished, onCourse, notStarted, dns, noBib,
                RaceEngine.formatElapsed(lastElapsed, prefs.timingDecimals()));
        new android.app.AlertDialog.Builder(this)
                .setTitle(R.string.rc_progress)
                .setMessage(body)
                .setPositiveButton(android.R.string.ok, null)
                .show();
    }

    private static String bibKey(String bib, String epc) {
        return bib == null || bib.isEmpty() ? "e:" + epc : "b:" + bib;
    }

    private static long bibNum(String bib) {
        try { return Long.parseLong(bib.replaceAll("[^0-9]", "")); }
        catch (NumberFormatException e) { return Long.MAX_VALUE; }
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    @Override
    protected void onResume() {
        super.onResume();
        render();
        handler.post(ticker);
    }

    @Override
    protected void onPause() {
        super.onPause();
        handler.removeCallbacks(ticker);
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        store.close();
    }
}

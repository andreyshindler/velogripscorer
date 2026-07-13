package com.velogrip.rfid;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.Gravity;
import android.view.View;
import android.view.GestureDetector;
import android.view.MotionEvent;
import android.widget.EditText;
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
    private TextView clockText, clockSub, hint;
    private GridLayout grid;
    private LinearLayout resultsBox;
    private int page;
    private boolean showSplits = true;
    private long lastSplitMs = -1;
    // Pre-entry: a racer tapped first waits here for the next timer press.
    private RaceStore.Racer pendingRacer;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Runnable ticker = new Runnable() {
        @Override public void run() { tickClock(); handler.postDelayed(this, 100); }
    };
    private GestureDetector swipe;

    /** Reader reads arrive as passings written by BridgeService; refresh on each. */
    private final android.content.BroadcastReceiver bridgeReceiver = new android.content.BroadcastReceiver() {
        @Override public void onReceive(android.content.Context c, Intent i) {
            render(); // a new crossing (or status change) landed in the store
        }
    };

    /** Horizontal swipe anywhere pages the bib grid, mirroring the ‹ › buttons. */
    @Override
    public boolean dispatchTouchEvent(MotionEvent ev) {
        if (swipe != null) swipe.onTouchEvent(ev);
        return super.dispatchTouchEvent(ev);
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_race_timing);
        store = new RaceStore(this);
        prefs = new Prefs(this);

        clockText = findViewById(R.id.clockText);
        clockSub = findViewById(R.id.clockSub);
        grid = findViewById(R.id.bibGrid);
        resultsBox = findViewById(R.id.resultsBox);
        hint = findViewById(R.id.timingHint);

        findViewById(R.id.homeButton).setOnClickListener(v -> {
            Intent i = new Intent(this, MainActivity.class);
            i.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
            startActivity(i);
        });
        findViewById(R.id.finishButton).setOnClickListener(v -> finishRace());
        findViewById(R.id.clockButton).setOnClickListener(v -> onTimer());
        findViewById(R.id.prevPage).setOnClickListener(v -> { if (page > 0) { page--; render(); } });
        findViewById(R.id.nextPage).setOnClickListener(v -> { page++; render(); });

        swipe = new GestureDetector(this, new GestureDetector.SimpleOnGestureListener() {
            @Override
            public boolean onFling(MotionEvent e1, MotionEvent e2, float vx, float vy) {
                if (e1 == null || e2 == null) return false;
                float dx = e2.getX() - e1.getX(), dy = e2.getY() - e1.getY();
                if (Math.abs(dx) > Math.abs(dy) * 2 && Math.abs(dx) > dp(60) && Math.abs(vx) > 300) {
                    if (dx < 0) page++; else if (page > 0) page--;   // swipe left = next page
                    render();
                    return true;
                }
                return false;
            }
        });

        findViewById(R.id.aSplits).setOnClickListener(v -> { showSplits = true; render(); });
        findViewById(R.id.bHide).setOnClickListener(v -> { showSplits = false; render(); });
        findViewById(R.id.aControl).setOnClickListener(v -> raceControl());
        findViewById(R.id.aMoreT).setOnClickListener(v -> togglePage(true));
        findViewById(R.id.bMoreT).setOnClickListener(v -> togglePage(false));
        int[] stubs = {R.id.aNormal, R.id.aKeypad, R.id.bPause, R.id.bDist, R.id.bCat};
        for (int id : stubs) findViewById(id).setOnClickListener(v ->
                Toast.makeText(this, R.string.view_option_unsupported, Toast.LENGTH_SHORT).show());

        startReader(); // connect to the RFID reader and capture crossings for this race
    }

    /** Start the foreground bridge that reads the RFID reader into the store. */
    private void startReader() {
        Intent i = new Intent(this, BridgeService.class).setAction(BridgeService.ACTION_START);
        startForegroundService(i); // minSdk 26: always a foreground service
    }

    /** Stop capturing when the race is finished or reset. */
    private void stopReader() {
        Intent i = new Intent(this, BridgeService.class).setAction(BridgeService.ACTION_STOP);
        startService(i);
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

    // ---- tap flow: pre-enter a bib, or bank a time for the next bib ----

    private RaceStore.Pending oldestTimePending() {
        for (RaceStore.Pending p : store.pendingEntries()) if (p.hasTime() && !p.hasRacer()) return p;
        return null;
    }

    private RaceStore.Pending oldestRacerPending() {
        for (RaceStore.Pending p : store.pendingEntries()) if (p.hasRacer() && !p.hasTime()) return p;
        return null;
    }

    /** Timer press: fill the oldest waiting bib, else bank the time. */
    private void onTimer() {
        long now = System.currentTimeMillis();
        RaceStore.Pending waiting = oldestRacerPending();
        if (waiting != null) {
            store.recordPassing(waiting.epc, now);
            store.deletePending(waiting.id);
        } else {
            store.addPendingTime(now);
        }
        render();
    }

    /** No Bib tile: always banks an unassigned time ("Select a bib"). */
    private void recordNoBib() {
        store.addPendingTime(System.currentTimeMillis());
        render();
    }

    /** Racer tile: claim the oldest banked time, else pre-enter this bib. A
     *  second tap on an already pre-entered bib cancels it. */
    private void onRacerTap(RaceStore.Racer r) {
        for (RaceStore.Pending p : store.pendingEntries()) {
            if (!p.hasTime() && p.epc.equals(r.epc)) { store.deletePending(p.id); render(); return; }
        }
        RaceStore.Pending time = oldestTimePending();
        if (time != null) {
            store.recordPassing(r.epc, time.readAtMs);
            store.deletePending(time.id);
            Toast.makeText(this, "⏱ #" + r.bib + "  " + r.name, Toast.LENGTH_SHORT).show();
        } else {
            store.addPendingRacer(r.epc, r.bib, r.name);
        }
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

        List<RaceStore.Pending> pendingEntries = store.pendingEntries();
        java.util.Set<String> pendingBibs = new java.util.HashSet<>();
        for (RaceStore.Pending p : pendingEntries) if (p.hasRacer() && !p.hasTime()) pendingBibs.add(p.bib);

        // grid tiles: No Bib + racers not yet finished
        List<RaceStore.Racer> stillOut = new ArrayList<>();
        for (RaceStore.Racer r : store.startListEntries()) {
            if (!finishedBibs.contains(bibKey(r.bib, r.epc)) && r.status.isEmpty()) stillOut.add(r);
        }
        java.util.Collections.sort(stillOut, (a, b) -> Long.compare(bibNum(a.bib), bibNum(b.bib)));

        List<Object> tiles = new ArrayList<>();
        tiles.add(NO_BIB);
        tiles.addAll(stillOut);
        int pages = Math.max(1, (int) Math.ceil(tiles.size() / (double) PAGE_SIZE));
        if (page >= pages) page = pages - 1;
        if (page < 0) page = 0;
        renderGrid(tiles.subList(page * PAGE_SIZE, Math.min(tiles.size(), (page + 1) * PAGE_SIZE)), pendingBibs);

        renderResults(results, pendingEntries);

        int racerTotal = store.racerCount();
        boolean waitingBib = oldestRacerPending() != null;
        int banked = 0;
        for (RaceStore.Pending p : pendingEntries) if (p.hasTime() && !p.hasRacer()) banked++;
        clockSub.setText(waitingBib ? getString(R.string.tap_timer_for_bib)
                : banked > 0 ? getString(R.string.times_waiting, banked)
                : getString(R.string.tap_to_record));

        if (showSplits && lastSplitMs >= 0) {
            hint.setText(getString(R.string.finish_split, RaceEngine.formatElapsed(lastSplitMs, 1)));
        } else {
            hint.setText(getString(R.string.timing_hint, racerTotal, page + 1, pages));
        }
    }

    private void renderGrid(List<Object> tiles, java.util.Set<String> pendingBibs) {
        grid.removeAllViews();
        grid.setColumnCount(4);
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
                boolean waiting = pendingBibs.contains(r.bib);
                tile.setBackgroundColor(waiting ? 0xFFEDE023 : 0xFF8DC63F); // yellow when time pending
                top.setText(r.bib);
                top.setTextColor(0xFF1A1A1A);
                bottom.setText(waiting ? R.string.time_pending : R.string.tap_to_finish);
                bottom.setTextColor(0xFF1A3A0A);
                tile.setOnClickListener(v -> onRacerTap(r));
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

    private void renderResults(List<RaceEngine.Result> results, List<RaceStore.Pending> pendingEntries) {
        resultsBox.removeAllViews();
        int decimals = prefs.timingDecimals();
        int place = 1;
        long prevElapsed = -1;
        for (final RaceEngine.Result r : results) {
            if (!"finished".equals(r.status)) continue;
            String time = RaceEngine.formatElapsed(r.elapsedMs, decimals);
            resultsBox.addView(resultRow(String.valueOf(place++), r.bib, r.name, time, false,
                    () -> editTime(r), () -> openRacerInfo(r.bib)));
            if (prevElapsed >= 0) lastSplitMs = r.elapsedMs - prevElapsed;
            prevElapsed = r.elapsedMs;
        }
        // pending entries at the bottom: bib waiting for a time, or a time
        // waiting for a bib
        for (final RaceStore.Pending p : pendingEntries) {
            if (p.hasRacer() && !p.hasTime()) {
                resultsBox.addView(resultRow("—", p.bib, p.name, getString(R.string.tap_time), true,
                        () -> { store.recordPassing(p.epc, System.currentTimeMillis());
                                store.deletePending(p.id); render(); }, () -> openRacerInfo(p.bib)));
            } else if (p.hasTime() && !p.hasRacer()) {
                Long gun = gunTime();
                long elapsed = gun == null ? 0 : p.readAtMs - gun;
                resultsBox.addView(resultRow("—", "-", getString(R.string.select_a_bib),
                        RaceEngine.formatElapsed(Math.max(0, elapsed), decimals), true,
                        () -> assignTimePending(p), null));
            }
        }
    }

    private void openRacerInfo(String bib) {
        if (bib == null || bib.isEmpty()) return;
        Intent i = new Intent(this, RacerInfoActivity.class);
        i.putExtra(RacerInfoActivity.EXTRA_BIB, bib);
        startActivity(i);
    }

    private View resultRow(String place, String bib, String name, String time, boolean unassigned,
                           Runnable onTimeTap, Runnable onArrowTap) {
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
        if (onTimeTap != null) tv.setOnClickListener(v -> onTimeTap.run()); // tap the time to edit it

        row.addView(pl);
        row.addView(bibv);
        row.addView(nm);
        row.addView(tv);
        if (onArrowTap != null) {
            TextView chevron = new TextView(this);
            chevron.setText("❯");
            chevron.setTextColor(0xFF76B82A);
            chevron.setTextSize(15);
            chevron.setBackgroundResource(R.drawable.bg_chevron);
            chevron.setPadding(dp(9), dp(3), dp(9), dp(3));
            row.addView(chevron);
            chevron.setOnClickListener(v -> onArrowTap.run()); // arrow -> racer info
        } else if (onTimeTap != null) {
            row.setOnClickListener(v -> onTimeTap.run()); // pending rows: whole row acts
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

    /** A banked "Select a bib" time: pick the racer it belongs to. */
    private void assignTimePending(RaceStore.Pending p) {
        List<RaceStore.Racer> racers = store.startListEntries();
        java.util.Collections.sort(racers, (a, b) -> Long.compare(bibNum(a.bib), bibNum(b.bib)));
        final String[] labels = new String[racers.size()];
        for (int i = 0; i < racers.size(); i++) labels[i] = "#" + racers.get(i).bib + "  " + racers.get(i).name;
        new android.app.AlertDialog.Builder(this)
                .setTitle(R.string.assign_to_racer)
                .setItems(labels, (d, which) -> {
                    store.recordPassing(racers.get(which).epc, p.readAtMs);
                    store.deletePending(p.id);
                    render();
                })
                .setNegativeButton(android.R.string.cancel, null)
                .show();
    }

    // ---- edit a finished racer's time ----

    private java.util.List<String> epcsForBib(String bib) {
        java.util.List<String> epcs = new ArrayList<>();
        for (RaceStore.Racer r : store.racers()) if (r.bib.equals(bib)) epcs.add(r.epc);
        return epcs;
    }

    private void editTime(RaceEngine.Result r) {
        final EditText input = new EditText(this);
        input.setInputType(android.text.InputType.TYPE_CLASS_DATETIME);
        input.setText(RaceEngine.formatElapsed(r.elapsedMs, prefs.timingDecimals()));
        input.setSelection(input.getText().length());
        new android.app.AlertDialog.Builder(this)
                .setTitle(getString(R.string.edit_time_for, r.bib, r.name))
                .setView(input)
                .setPositiveButton(R.string.enter, (d, w) -> {
                    long ms = parseElapsed(input.getText().toString());
                    Long gun = gunTime();
                    if (gun == null) { Toast.makeText(this, R.string.not_started_wave, Toast.LENGTH_LONG).show(); return; }
                    setRacerFinish(r.bib, gun + ms);
                    render();
                })
                .setNeutralButton(R.string.dns_dnf_dsq, (d, w) ->
                        new android.app.AlertDialog.Builder(this)
                                .setTitle(R.string.racer_status)
                                .setItems(new String[]{"DNS", "DNF", "DSQ", getString(R.string.status_ok)}, (dd, which) -> {
                                    String[] st = {"DNS", "DNF", "DSQ", ""};
                                    clearRacerPassings(r.bib);
                                    store.setRacerStatus(r.bib, st[which]);
                                    render();
                                }).show())
                .setNegativeButton(R.string.cancel_popup, null)
                .show();
    }

    /** Replace a racer's crossings with one at the given finish time. */
    private void setRacerFinish(String bib, long finishAtMs) {
        clearRacerPassings(bib);
        java.util.List<String> epcs = epcsForBib(bib);
        if (!epcs.isEmpty()) store.recordPassing(epcs.get(0), finishAtMs);
    }

    private void clearRacerPassings(String bib) {
        for (String epc : epcsForBib(bib)) {
            for (RaceStore.Passing p : store.passingsForEpc(epc)) store.deletePassing(p.id);
        }
    }

    /** Parse h:mm:ss.t / mm:ss.t / ss.t into milliseconds. */
    private static long parseElapsed(String text) {
        text = text.trim();
        if (text.isEmpty()) return 0;
        double secs;
        String[] parts = text.split(":");
        try {
            if (parts.length == 3) secs = Integer.parseInt(parts[0]) * 3600 + Integer.parseInt(parts[1]) * 60 + Double.parseDouble(parts[2]);
            else if (parts.length == 2) secs = Integer.parseInt(parts[0]) * 60 + Double.parseDouble(parts[1]);
            else secs = Double.parseDouble(parts[0]);
        } catch (NumberFormatException e) {
            return 0;
        }
        return Math.round(secs * 1000);
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
                            startActivity(new Intent(this, LiveResultsActivity.class));
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

    /** Finish race: if racers are still out, ask whether to mark them DNS or
     *  DNF; either way (or when everyone finished) go to the results. */
    private void finishRace() {
        List<RaceEngine.Result> results = RaceEngine.compute(
                store.racers(), store.waves(), store.allPassings(),
                prefs.suppressSecs(), prefs.lapGapSecs(), prefs.recordLaps(), store.lapTargets(),
                prefs.raceFinalized());
        final List<RaceEngine.Result> onCourse = new ArrayList<>();
        for (RaceEngine.Result r : results) {
            if ("on_course".equals(r.status) || "not_started".equals(r.status)) onCourse.add(r);
        }
        if (onCourse.isEmpty()) {
            new android.app.AlertDialog.Builder(this)
                    .setTitle(R.string.rc_finish)
                    .setMessage(R.string.finish_race_confirm)
                    .setPositiveButton(R.string.finish_race_ok, (d, w) -> goToResults())
                    .setNegativeButton(R.string.cancel_popup, null)
                    .show();
            return;
        }
        // Racers still out: mark them DNS or DNF before showing results.
        new android.app.AlertDialog.Builder(this)
                .setTitle(R.string.still_on_course)
                .setItems(new String[]{getString(R.string.mark_dns), getString(R.string.mark_dnf)},
                        (d, which) -> {
                            String status = which == 0 ? "DNS" : "DNF";
                            for (RaceEngine.Result r : onCourse) {
                                if (!r.bib.isEmpty()) store.setRacerStatus(r.bib, status);
                            }
                            goToResults();
                        })
                .setNegativeButton(R.string.cancel_popup, null)
                .show();
    }

    private void goToResults() {
        stopReader(); // race over: stop capturing
        startActivity(new Intent(this, ViewResultsActivity.class));
    }

    /** Restart (false start): keep or discard recorded times, un-gun the race
     *  and return to Race Start so the organizer can start it again. */
    private void restartRace() {
        new android.app.AlertDialog.Builder(this)
                .setTitle(R.string.restart_results_prompt)
                .setItems(new String[]{getString(R.string.restart_save), getString(R.string.restart_discard)},
                        (d, which) -> {
                            if (which == 1) store.clearPassings(); // Discard recorded times
                            store.clearPending();
                            store.clearGunTimes();                 // un-start every wave
                            prefs.setRaceFinalized(false);
                            // keep the reader (and its WiFi) connected through the
                            // restart; clearing the gun re-arms the per-racer beeps
                            Intent i = new Intent(this, RaceStartActivity.class);
                            i.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
                            startActivity(i);
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
        int noBib = 0;
        for (RaceStore.Pending p : store.pendingEntries()) if (p.hasTime() && !p.hasRacer()) noBib++;
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
        registerReceiver(bridgeReceiver, new android.content.IntentFilter(BridgeService.ACTION_STATUS));
    }

    @Override
    protected void onPause() {
        super.onPause();
        handler.removeCallbacks(ticker);
        unregisterReceiver(bridgeReceiver);
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        store.close();
    }
}

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
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ScrollView;
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
public class RaceTimingActivity extends BaseActivity {

    private static final String NO_BIB = "NOBIB";
    private static final int PAGE_SIZE = 20;

    private RaceStore store;
    private Prefs prefs;
    private TextView clockText, clockSub, hint;
    private TextView syncStatus;
    private boolean online = true; // last sync state reported by BridgeService
    private String lastSyncError;  // why the last upload failed, shown on the strip
    private SnapScrollView pager;
    private LinearLayout pagerInner;
    private LinearLayout resultsBox;
    private int page;
    private int totalPages = 1, racerTotalCache;
    private String lastPagerSig = "";
    private boolean fastTap = false; // hide results, grid fills the screen
    private boolean showNames = false; // show racer name/category on the tiles
    // ---- wave race state (all inert for a mass start) ----
    private TextView startWaveLabel;
    private View startWaveButton, waveFilterScroll;
    private LinearLayout waveFilterRow;
    // wave name -> the clock TextView inside its chip, repainted every tick
    private final java.util.Map<String, TextView> waveChipClocks = new java.util.LinkedHashMap<>();
    private boolean multiWave;                 // wave-start race with named waves
    private String waveFilter;                 // null = show every wave
    private long lastGunAtMs;                  // guards the START bar against a double tap
    private static final long GUN_LOCKOUT_MS = 3000;
    // wave name -> gun time (null until that wave starts); "" is the mass marker
    private final java.util.Map<String, Long> gunByWave = new java.util.HashMap<>();
    private long lastSplitMs = -1;
    private String lastTapText;      // "13th 2:19:16.9 +…: name" for the hint strip
    private String scrollToBib;      // after a tap-finish, scroll the results to this racer
    // Pre-entry: a racer tapped first waits here for the next timer press.
    private RaceStore.Racer pendingRacer;
    // Swap: a finish whose bib was wrong, waiting for the correct racer's tile.
    private String swapBib;
    private long swapTimeMs;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Runnable ticker = new Runnable() {
        @Override public void run() { tickClock(); handler.postDelayed(this, 100); }
    };
    private final Runnable renderTask = this::render;
    // Fires once when the roll-call window next closes, so no-shows flip to DNS
    // even if no further reads arrive.
    private final Runnable rollCallTick = this::scheduleRender;

    private android.widget.Toast tapToast;

    /** A single, self-replacing toast so a burst of taps doesn't queue a backlog. */
    private void tapToast(String msg) {
        if (tapToast != null) tapToast.cancel();
        tapToast = Toast.makeText(this, msg, Toast.LENGTH_SHORT);
        tapToast.show();
    }

    /** Coalesce rapid taps: the passing is written to the store immediately, but
     *  the heavy recompute + redraw is debounced so a burst of fast taps runs a
     *  single render once it settles, instead of blocking the UI thread between
     *  each tap. */
    private void scheduleRender() {
        handler.removeCallbacks(renderTask);
        handler.postDelayed(renderTask, 55);
    }

    /** Reader reads arrive as passings written by BridgeService; refresh on each. */
    private final android.content.BroadcastReceiver bridgeReceiver = new android.content.BroadcastReceiver() {
        @Override public void onReceive(android.content.Context c, Intent i) {
            online = i.getBooleanExtra(BridgeService.EXTRA_ONLINE, online);
            // Keep WHY the last upload failed. "Offline" is the wrong words for a
            // server that is reachable and refusing, and the operator cannot act
            // on a reason they never see.
            String log = i.getStringExtra(BridgeService.EXTRA_LOG);
            if (online) lastSyncError = null;
            else if (log != null && !log.isEmpty()) lastSyncError = log;
            scheduleRender(); // a new crossing (or status change) landed in the store
        }
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_race_timing);
        store = new RaceStore(this);
        prefs = new Prefs(this);

        clockText = findViewById(R.id.clockText);
        clockSub = findViewById(R.id.clockSub);
        pager = findViewById(R.id.bibPager);
        pagerInner = findViewById(R.id.bibPagerInner);
        pager.setOnPage(p -> { page = p; updateHint(); });
        resultsBox = findViewById(R.id.resultsBox);
        hint = findViewById(R.id.timingHint);
        syncStatus = findViewById(R.id.syncStatus);
        startWaveLabel = findViewById(R.id.startWaveLabel);
        startWaveButton = findViewById(R.id.startWaveButton);
        startWaveButton.setBackground(roundedTile(0xFF4F9E27));
        startWaveButton.setOnClickListener(v -> startNextWave());
        waveFilterScroll = findViewById(R.id.waveFilterScroll);
        waveFilterRow = findViewById(R.id.waveFilterRow);

        findViewById(R.id.homeButton).setOnClickListener(v -> {
            Intent i = new Intent(this, MainActivity.class);
            i.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
            startActivity(i);
        });
        findViewById(R.id.finishButton).setOnClickListener(v -> finishRace());
        findViewById(R.id.clockButton).setOnClickListener(v -> onTimer());
        findViewById(R.id.prevPage).setOnClickListener(v -> pager.goToPage(pager.currentPage() - 1, true));
        findViewById(R.id.nextPage).setOnClickListener(v -> pager.goToPage(pager.currentPage() + 1, true));

        findViewById(R.id.aSplits).setOnClickListener(v -> { showNames = !showNames; applyNamesMode(); });
        findViewById(R.id.aControl).setOnClickListener(v -> raceControl());
        findViewById(R.id.aMoreT).setOnClickListener(v -> togglePage(true));
        findViewById(R.id.bMoreT).setOnClickListener(v -> togglePage(false));
        // Swipe the bottom bar sideways to flip between its two pages.
        ((SwipeBar) findViewById(R.id.tbarA)).setOnSwipe(() -> togglePage(true));
        ((SwipeBar) findViewById(R.id.tbarB)).setOnSwipe(() -> togglePage(false));
        findViewById(R.id.aNormal).setOnClickListener(v -> { fastTap = !fastTap; applyViewMode(); });
        findViewById(R.id.aStartList).setOnClickListener(v -> startActivity(
                new Intent(this, StartListActivity.class)
                        .putExtra(StartListActivity.EXTRA_NO_FORWARD, true)));
        findViewById(R.id.bPause).setOnClickListener(v ->
                startActivity(new Intent(this, RaceProgressActivity.class)));
        findViewById(R.id.bHide).setOnClickListener(v ->
                startActivity(new Intent(this, SettingsActivity.class)));

        startReader(); // connect to the RFID reader and capture crossings for this race
    }

    /** Start the foreground bridge that reads the RFID reader into the store.
     *  The reader is reached over the tablet's current network (default); the
     *  reader-WiFi specifier is only used when the organizer explicitly taps
     *  Connect in Settings, so no system WiFi-picker dialog appears here. */
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

    /** Fast-tap view hides the finish list so the bib grid fills the screen with
     *  as many boxes as fit; Normal view shows the finish list below the grid. */
    private void applyViewMode() {
        int vis = fastTap ? View.GONE : View.VISIBLE;
        findViewById(R.id.resultsHeader).setVisibility(vis);
        findViewById(R.id.resultsScroll).setVisibility(vis);
        LinearLayout.LayoutParams lp = (LinearLayout.LayoutParams) pager.getLayoutParams();
        lp.height = fastTap ? 0 : LinearLayout.LayoutParams.WRAP_CONTENT;
        lp.weight = fastTap ? 1 : 0;
        pager.setLayoutParams(lp);
        ((TextView) findViewById(R.id.aNormalLabel)).setText(fastTap ? R.string.fast_tap_view : R.string.normal_view);
        lastPagerSig = "";            // page size changed -> force a rebuild
        pager.post(this::render);     // after layout, the pager height is known
    }

    /** Show names uses wider tiles, so fewer columns. */
    private int cols() { return showNames ? 2 : 4; }

    private void applyNamesMode() {
        ((TextView) findViewById(R.id.aNamesLabel)).setText(showNames ? R.string.hide_name : R.string.show_names);
        lastPagerSig = "";        // column count / tile content changed -> rebuild
        pager.post(this::render);
    }

    /** One grid row's height (tile + its top/bottom margins). Fast-tap gives
     *  every tile exactly this height so the rows it counts actually fit. */
    private int rowHpx() { return dp(showNames ? 92 : 76); }

    // Tile colour per lap: lap 1 green, then blue, orange, purple, teal (cycling).
    private static final int[] LAP_COLORS =
            {0xFF8DC63F, 0xFF5BB8E8, 0xFFF2A93B, 0xFFB57BD6, 0xFF54C9C0};

    private int lapColor(int lap) {
        return LAP_COLORS[(Math.max(1, lap) - 1) % LAP_COLORS.length];
    }

    /** Boxes per page: fixed rows in Normal view; as many rows as fit in Fast-tap. */
    private int pageSize() {
        int c = cols();
        if (!fastTap) return 5 * c;            // ~5 rows
        int h = pager.getHeight();
        if (h <= 0) return 6 * c;              // fallback until the pager is measured
        return Math.max(1, h / rowHpx()) * c;
    }

    // ---- race clock ----

    private Long gunTime() {
        Long earliest = null;
        for (RaceStore.Wave w : store.waves()) {
            if (w.startedAtMs != null && (earliest == null || w.startedAtMs < earliest)) earliest = w.startedAtMs;
        }
        return earliest;
    }

    /** The gun the BIG clock counts from. With a wave selected it is that
     *  wave's own gun, so the headline number always matches the racers on
     *  screen; otherwise it is the first wave to start. */
    private Long displayGunTime() {
        if (multiWave && waveFilter != null) return gunByWave.get(waveFilter);
        return gunTime();
    }

    /** The gun a racer in this wave is timed from. Used when an entered elapsed
     *  has to be turned back into a wall-clock time. Takes the wave name so it
     *  serves both RaceStore.Racer and RaceEngine.Result. */
    private Long gunForWave(String wave) {
        if (!multiWave) return gunTime();
        Long g = gunByWave.get(wave == null ? "" : wave);
        return g != null ? g : gunTime();
    }

    private void tickClock() {
        Long gun = displayGunTime();
        long elapsed = gun == null ? 0 : System.currentTimeMillis() - gun;
        clockText.setText(RaceEngine.formatElapsed(Math.max(0, elapsed), 1));
        if (multiWave) {
            long now = System.currentTimeMillis();
            for (java.util.Map.Entry<String, TextView> e : waveChipClocks.entrySet()) {
                Long g = gunByWave.get(e.getKey());
                e.getValue().setText(g == null ? getString(R.string.not_started_wave)
                        : RaceEngine.formatElapsed(Math.max(0, now - g), 1));
            }
            // Dim the bar while it's locked out, so the operator can see it is
            // deliberately not armed rather than unresponsive.
            startWaveButton.setAlpha(
                    System.currentTimeMillis() - lastGunAtMs < GUN_LOCKOUT_MS ? 0.45f : 1f);
        }
    }

    // ---- wave races: own clock per wave, sequential gun, per-wave grid ----

    /** The next wave still waiting for its gun, in start-list order. */
    private RaceStore.Wave nextUnstartedWave() {
        for (RaceStore.Wave w : store.waves()) {
            if (!w.name.isEmpty() && w.startedAtMs == null) return w;
        }
        return null;
    }

    /** The big green bar: fires the next wave's gun. Tap once for wave 1, then
     *  again ten minutes later for wave 2 — no menu, no confirmation, because
     *  at the gun every second counts. Restarting a gun (the destructive one)
     *  stays behind a confirmation in Race control -> Start a wave. */
    private void startNextWave() {
        // The bar relabels to the NEXT wave the instant a gun fires, so a bounced
        // finger would otherwise gun wave 2 the moment wave 1 starts. Ignore a
        // second press for a few seconds; a real stagger is minutes apart.
        if (System.currentTimeMillis() - lastGunAtMs < GUN_LOCKOUT_MS) return;
        RaceStore.Wave next = nextUnstartedWave();
        if (next == null) return;
        lastGunAtMs = System.currentTimeMillis();
        fireGun(next.name, false);
    }

    /** A stable colour per wave, so the tile stripes and filter chips agree. */
    private int waveColor(String name) {
        final int[] palette = { 0xFF3F6FD1, 0xFFE39A2B, 0xFF159C93, 0xFFC0555A, 0xFF8E5BD0 };
        int i = 0;
        for (RaceStore.Wave w : store.waves()) {
            if (w.name.isEmpty()) continue;
            if (w.name.equals(name)) return palette[i % palette.length];
            i++;
        }
        return palette[0];
    }

    /** True when this racer's wave has had its gun — a racer can't finish
     *  before they have started. */
    private boolean waveStartedFor(RaceStore.Racer r) {
        if (!multiWave) return true;
        return gunByWave.get(r.wave == null ? "" : r.wave) != null;
    }

    /** Refresh the wave strip: per-wave clocks, the gun button and the filter.
     *  Everything stays hidden unless this is a wave race with named waves. */
    private void updateWaveUi() {
        gunByWave.clear();
        int named = 0;
        for (RaceStore.Wave w : store.waves()) {
            gunByWave.put(w.name, w.startedAtMs);
            if (!w.name.isEmpty()) named++;
        }
        multiWave = named > 0 && RaceSetupActivity.TYPE_WAVE.equals(prefs.startType());
        if (!multiWave) {
            waveFilter = null;
            waveChipClocks.clear();
            startWaveButton.setVisibility(View.GONE);
            waveFilterScroll.setVisibility(View.GONE);
            return;
        }

        RaceStore.Wave next = nextUnstartedWave();
        if (next == null) {
            startWaveButton.setVisibility(View.GONE); // all guns fired: give the grid its space back
        } else {
            startWaveButton.setVisibility(View.VISIBLE);
            startWaveLabel.setText(getString(R.string.start_wave_now, next.name));
        }

        waveFilterScroll.setVisibility(View.VISIBLE);
        waveFilterRow.removeAllViews();
        waveChipClocks.clear();
        waveFilterRow.addView(filterChip(getString(R.string.wave_filter_all), null));
        for (RaceStore.Wave w : store.waves()) {
            if (!w.name.isEmpty()) waveFilterRow.addView(filterChip(w.name, w.name));
        }
        tickClock(); // paint the new chips' clocks now, not on the next tick
    }

    /** A wave chip: its name, its OWN running clock, and tapping it points both
     *  the grid and the big clock at that wave. The "All waves" chip carries no
     *  clock — with several waves running there is no single race time. */
    private View filterChip(String label, final String value) {
        LinearLayout chip = new LinearLayout(this);
        chip.setOrientation(LinearLayout.HORIZONTAL);
        chip.setGravity(Gravity.CENTER_VERTICAL);
        chip.setPadding(dp(14), dp(6), dp(14), dp(6));
        boolean on = value == null ? waveFilter == null : value.equals(waveFilter);
        chip.setBackground(roundedTile(on ? (value == null ? 0xFF4F9E27 : waveColor(value)) : 0x33808080));
        final int fg = on ? 0xFFFFFFFF : getColor(R.color.text_muted);

        TextView name = new TextView(this);
        name.setText(label);
        name.setTextSize(13.5f);
        name.setTypeface(null, android.graphics.Typeface.BOLD);
        name.setTextColor(fg);
        chip.addView(name);

        if (value != null) {
            TextView clock = new TextView(this);
            clock.setTextSize(18);
            clock.setTypeface(android.graphics.Typeface.MONOSPACE, android.graphics.Typeface.BOLD);
            clock.setTextColor(fg);
            clock.setPadding(dp(9), 0, 0, 0);
            chip.addView(clock);
            waveChipClocks.put(value, clock);
        }

        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        lp.setMarginEnd(dp(7));
        chip.setLayoutParams(lp);
        chip.setOnClickListener(v -> { waveFilter = value; page = 0; scheduleRender(); });
        return chip;
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
            scrollToBib = waiting.bib; // show the new finish, same as time-then-racer
        } else {
            store.addPendingTime(now);
        }
        scheduleRender();
    }

    /** No Bib tile: always banks an unassigned time ("Select a bib"). */
    private void recordNoBib() {
        store.addPendingTime(System.currentTimeMillis());
        scheduleRender();
    }

    /** Racer tile: claim the oldest banked time, else pre-enter this bib. A
     *  second tap on an already pre-entered bib cancels it. */
    private void onRacerTap(RaceStore.Racer r) {
        // Swap mode: this tile is the correct racer — move the finish to them.
        if (swapBib != null) {
            clearRacerPassings(swapBib);
            store.recordPassing(r.epc, swapTimeMs);
            tapToast("⇄ #" + r.bib + "  " + r.name);
            swapBib = null;
            scrollToBib = r.bib;
            scheduleRender();
            return;
        }
        for (RaceStore.Pending p : store.pendingEntries()) {
            if (!p.hasTime() && p.epc.equals(r.epc)) { store.deletePending(p.id); scheduleRender(); return; }
        }
        RaceStore.Pending time = oldestTimePending();
        if (time != null) {
            store.recordPassing(r.epc, time.readAtMs);
            store.deletePending(time.id);
            tapToast("⏱ #" + r.bib + "  " + r.name);
            scrollToBib = r.bib;
        } else {
            store.addPendingRacer(r.epc, r.bib, r.name);
        }
        scheduleRender();
    }

    // ---- rendering ----

    // Show the upload/offline strip only when it matters: passes waiting to sync,
    // or the server unreachable. Hidden (and out of the way) when all is synced.
    private void updateSyncStatus() {
        if (syncStatus == null) return;
        long pending = store.pendingCount();
        if (pending == 0 && online) {
            syncStatus.setVisibility(android.view.View.GONE);
            return;
        }
        syncStatus.setVisibility(android.view.View.VISIBLE);
        if (!online) {
            syncStatus.setBackgroundColor(0xFFC0392B); // red: not getting through
            syncStatus.setText(lastSyncError != null
                    ? getString(R.string.sync_rejected, pending, lastSyncError)
                    : getString(R.string.sync_offline, pending));
        } else {
            syncStatus.setBackgroundColor(0xFFB9770E); // amber: catching up
            syncStatus.setText(getString(R.string.sync_uploading, pending));
        }
    }

    private void render() {
        updateSyncStatus();
        updateWaveUi();
        List<RaceEngine.Result> results = RaceEngine.compute(
                store.racers(), store.waves(), store.allPassings(),
                prefs.suppressSecs(), prefs.lapGapSecs(), prefs.recordLaps(), store.lapTargets(),
                prefs.raceFinalized(), System.currentTimeMillis(),
                prefs.rollCallSecs() * 1000L, prefs.rollCallClosedAt(), prefs.leaderEndsRaceActive());

        java.util.Set<String> finishedBibs = new java.util.HashSet<>();
        // Racers auto-marked DNS by the start-line roll call (computed, not stored).
        java.util.Set<String> rollCallDnsBibs = new java.util.HashSet<>();
        // Laps completed so far per bib, for the "On lap X/Y" tiles.
        java.util.Map<String, Integer> lapsByBib = new java.util.HashMap<>();
        int finishedCount = 0, outCount = 0; // out = DNS/DNF/DSQ, never going to finish
        for (RaceEngine.Result r : results) {
            if ("finished".equals(r.status)) { finishedBibs.add(bibKey(r.bib, "")); finishedCount++; }
            else if ("DNS".equals(r.status) || "DNF".equals(r.status) || "DSQ".equals(r.status)) {
                outCount++;
                if ("DNS".equals(r.status) && !r.bib.isEmpty()) rollCallDnsBibs.add(bibKey(r.bib, ""));
            } else if ("on_course".equals(r.status) && r.laps > 0 && !r.bib.isEmpty()) {
                lapsByBib.put(r.bib, r.laps);
            }
        }
        // Finish counter: finished so far / racers still expected to finish
        // (start list minus DNS — incl. roll-call no-shows — minus DNF/DSQ).
        ((TextView) findViewById(R.id.finishCounter)).setText(
                "✓ " + finishedCount + "/" + Math.max(0, results.size() - outCount));

        List<RaceStore.Pending> pendingEntries = store.pendingEntries();
        java.util.Set<String> pendingBibs = new java.util.HashSet<>();
        for (RaceStore.Pending p : pendingEntries) if (p.hasRacer() && !p.hasTime()) pendingBibs.add(p.bib);

        // grid tiles: No Bib + every racer in a FIXED slot; finished/DNS/DNF/DSQ
        // racers keep their spot but render blank, so bib positions never move.
        java.util.Set<String> doneBibs = new java.util.HashSet<>(finishedBibs);
        doneBibs.addAll(rollCallDnsBibs); // no-shows drop off the active grid
        List<RaceStore.Racer> allRacers = store.startListEntries();
        for (RaceStore.Racer r : allRacers) {
            if (!r.status.isEmpty()) doneBibs.add(bibKey(r.bib, r.epc));
        }
        java.util.Collections.sort(allRacers, (a, b) -> Long.compare(bibNum(a.bib), bibNum(b.bib)));
        // Wave filter: show only the wave being worked. Applied after the
        // done/status scan above so the counters still cover the whole field.
        if (multiWave && waveFilter != null) {
            List<RaceStore.Racer> only = new ArrayList<>();
            for (RaceStore.Racer r : allRacers) if (waveFilter.equals(r.wave)) only.add(r);
            allRacers = only;
        }

        List<Object> tiles = new ArrayList<>();
        tiles.add(NO_BIB);
        tiles.addAll(allRacers);
        totalPages = Math.max(1, (int) Math.ceil(tiles.size() / (double) pageSize()));
        if (page >= totalPages) page = totalPages - 1;
        if (page < 0) page = 0;
        renderPager(tiles, doneBibs, pendingBibs, lapsByBib);

        renderResults(results, pendingEntries);

        racerTotalCache = store.racerCount();
        boolean waitingBib = oldestRacerPending() != null;
        int banked = 0;
        for (RaceStore.Pending p : pendingEntries) if (p.hasTime() && !p.hasRacer()) banked++;
        String sub = waitingBib ? getString(R.string.tap_timer_for_bib)
                : banked > 0 ? getString(R.string.times_waiting, banked)
                : getString(R.string.tap_to_record);
        // Name the wave the big clock is counting, so the headline number can
        // never be mistaken for another wave's.
        clockSub.setText(multiWave && waveFilter != null ? waveFilter + " · " + sub : sub);

        updateHint();

        // Schedule a single re-render when the roll-call window next closes.
        handler.removeCallbacks(rollCallTick);
        long rcWin = prefs.rollCallSecs() * 1000L;
        if (rcWin > 0 && prefs.rollCallClosedAt() == 0) {
            long now = System.currentTimeMillis();
            long soonest = Long.MAX_VALUE;
            for (RaceStore.Wave w : store.waves()) {
                if (w.startedAtMs == null) continue;
                long boundary = w.startedAtMs + rcWin;
                if (boundary > now && boundary < soonest) soonest = boundary;
            }
            if (soonest != Long.MAX_VALUE) handler.postDelayed(rollCallTick, soonest - now + 200);
        }
    }

    private void updateHint() {
        // Bib-grid page position, shown under the ‹ › arrows.
        String pagePos = (page + 1) + "/" + totalPages;
        ((TextView) findViewById(R.id.prevPageSub)).setText(pagePos);
        ((TextView) findViewById(R.id.nextPageSub)).setText(pagePos);
        if (swapBib != null) {
            hint.setText(R.string.tap_correct_racer);
            return;
        }
        String pages = getString(R.string.page_counts, racerTotalCache, page + 1, totalPages);
        if (lastTapText != null) {
            hint.setText(lastTapText + "   " + pages);
        } else {
            hint.setText(getString(R.string.timing_hint, racerTotalCache, page + 1, totalPages));
        }
    }

    private String ordinal(int n) {
        int mod100 = n % 100;
        if (mod100 >= 11 && mod100 <= 13) return n + "th";
        switch (n % 10) {
            case 1: return n + "st";
            case 2: return n + "nd";
            case 3: return n + "rd";
            default: return n + "th";
        }
    }

    private TextView line(String text, int sizeSp, boolean bold, int color) {
        TextView t = new TextView(this);
        t.setText(text);
        t.setTextSize(sizeSp);
        t.setGravity(Gravity.CENTER);
        t.setTextColor(color);
        if (bold) t.setTypeface(null, android.graphics.Typeface.BOLD);
        return t;
    }

    /** Tap the seq number: confirm cancelling this recorded entry. */
    private void cancelEntry(int seq, RaceEngine.Result r) {
        String body = getString(R.string.cancel_entry_body, r.bib, r.name,
                RaceEngine.formatElapsed(r.elapsedMs, prefs.timingDecimals()), Math.max(1, r.laps));
        new android.app.AlertDialog.Builder(this)
                .setTitle(getString(R.string.cancel_entry_title, seq))
                .setMessage(body)
                .setPositiveButton(R.string.yes, (d, w) -> { clearRacerPassings(r.bib); render(); })
                .setNegativeButton(R.string.no, null)
                .show();
    }

    /** Tap the bib: swap the finish to the correct racer, or drop it to No Bib. */
    private void bibActions(int seq, RaceEngine.Result r) {
        String info = getString(R.string.tap_info, seq,
                RaceEngine.formatElapsed(r.elapsedMs, prefs.timingDecimals()));
        new android.app.AlertDialog.Builder(this)
                .setTitle(r.bib + " - " + r.name)
                .setMessage(info)
                .setPositiveButton(R.string.swap_bib, (d, w) -> {   // wrong racer -> tap the right one
                    swapBib = r.bib;
                    swapTimeMs = lastPassingMs(r.bib);
                    Toast.makeText(this, R.string.tap_correct_racer, Toast.LENGTH_SHORT).show();
                    render();
                })
                .setNeutralButton(R.string.no_bib, (d, w) -> {      // unknown bib -> unassigned time
                    long when = lastPassingMs(r.bib);
                    clearRacerPassings(r.bib);
                    if (when > 0) store.addPendingTime(when);
                    render();
                })
                .setNegativeButton(R.string.close, null)
                .show();
    }

    /** Latest recorded crossing time (ms) for a bib, across both chips. */
    private long lastPassingMs(String bib) {
        long last = 0;
        for (String epc : epcsForBib(bib)) {
            for (RaceStore.Passing p : store.passingsForEpc(epc)) last = Math.max(last, p.readAtMs);
        }
        return last;
    }

    /** Build one full-width GridLayout page per PAGE_SIZE tiles and lay them in
     *  a row inside the snapping pager. Deferred until the pager is measured. */
    private void renderPager(List<Object> tiles, java.util.Set<String> doneBibs,
                             java.util.Set<String> pendingBibs, java.util.Map<String, Integer> lapsByBib) {
        int w = pager.getWidth();
        if (w == 0) { // not laid out yet — retry once measured
            pager.post(() -> renderPager(tiles, doneBibs, pendingBibs, lapsByBib));
            return;
        }
        // Only rebuild when the grid actually changed — otherwise a read would
        // reflow the pages and yank the pager while the operator is swiping.
        StringBuilder sb = new StringBuilder().append(w).append('|').append(pageSize()).append('|');
        for (Object t : tiles) sb.append(t instanceof String ? "NB" : ((RaceStore.Racer) t).bib).append(',');
        sb.append('|').append(new java.util.TreeSet<>(doneBibs));
        sb.append('|').append(new java.util.TreeSet<>(pendingBibs));
        sb.append('|').append(new java.util.TreeMap<>(lapsByBib)); // lap progress -> rebuild on each new lap
        // Which waves have been gunned, and the active wave filter. Without this
        // the tiles keep their pre-gun look (grey, "not started") and their stale
        // tap handler after a wave starts, because the bib list alone is unchanged.
        sb.append('|').append(waveFilter).append('|');
        for (java.util.Map.Entry<String, Long> e : new java.util.TreeMap<>(gunByWave).entrySet()) {
            sb.append(e.getKey()).append(e.getValue() == null ? '0' : '1').append(',');
        }
        String sig = sb.toString();
        if (sig.equals(lastPagerSig) && pagerInner.getChildCount() > 0) return;
        lastPagerSig = sig;

        pagerInner.removeAllViews();
        int size = pageSize();
        int pages = Math.max(1, (int) Math.ceil(tiles.size() / (double) size));
        for (int pg = 0; pg < pages; pg++) {
            GridLayout g = new GridLayout(this);
            g.setColumnCount(cols());
            g.setLayoutParams(new LinearLayout.LayoutParams(w, LinearLayout.LayoutParams.WRAP_CONTENT));
            fillGrid(g, tiles.subList(pg * size, Math.min(tiles.size(), (pg + 1) * size)),
                    doneBibs, pendingBibs, lapsByBib);
            pagerInner.addView(g);
        }
        if (page >= pages) page = pages - 1;
        if (page < 0) page = 0;
        pager.goToPage(page, false); // keep position steady across re-renders
    }

    private void fillGrid(GridLayout grid, List<Object> tiles, java.util.Set<String> doneBibs,
                          java.util.Set<String> pendingBibs, java.util.Map<String, Integer> lapsByBib) {
        int margin = dp(4);
        boolean recordLaps = prefs.recordLaps();
        java.util.Map<String, Integer> lapTargets = store.lapTargets();
        // Every tile — No Bib, racer, and the blank slot left by a finished
        // racer — is pinned to the same height, so rows stay even (no gaps when
        // a box disappears) and the No Bib box matches the others. This is also
        // the height fast-tap bases its row count on, so the grid fills exactly.
        int tileH = rowHpx() - 2 * margin;
        int blankH = tileH;
        for (Object t : tiles) {
            // Finished / DNS-DNF-DSQ racer: keep the slot but render it blank so
            // the remaining bibs never shift position.
            if (t instanceof RaceStore.Racer && doneBibs.contains(bibKey(((RaceStore.Racer) t).bib,
                    ((RaceStore.Racer) t).epc))) {
                View blank = new View(this);
                GridLayout.LayoutParams blp = new GridLayout.LayoutParams();
                blp.width = 0;
                blp.height = blankH;
                blp.columnSpec = GridLayout.spec(GridLayout.UNDEFINED, 1f);
                blp.setMargins(margin, margin, margin, margin);
                blank.setLayoutParams(blp);
                grid.addView(blank);
                continue;
            }
            LinearLayout tile = new LinearLayout(this);
            tile.setOrientation(LinearLayout.VERTICAL);
            tile.setGravity(Gravity.CENTER);
            tile.setPadding(dp(8), dp(6), dp(8), dp(6));

            if (t instanceof String) { // No Bib / Unknown Racer
                tile.setBackground(roundedTile(0xFF8A8F98));
                tile.addView(line(getString(showNames ? R.string.unknown_racer : R.string.no_bib),
                        showNames ? 17 : 20, true, 0xFFFFFFFF));
                tile.setOnClickListener(v -> recordNoBib());
            } else {
                final RaceStore.Racer r = (RaceStore.Racer) t;
                boolean waiting = pendingBibs.contains(r.bib);
                // Multi-lap racers: show "On lap X/Y" and recolour each lap.
                int target = recordLaps && lapTargets != null
                        ? Math.max(1, lapTargets.getOrDefault(r.distance, 1)) : 1;
                Integer done = lapsByBib.get(r.bib);
                int currentLap = Math.min(target, (done == null ? 0 : done) + 1);
                boolean multiLap = target > 1;
                // A racer whose wave hasn't been gunned yet can't finish: grey
                // the tile out and say so, rather than banking a time that sits
                // before their start.
                final boolean started = waveStartedFor(r);
                int bg = !started ? 0xFF9AA0A6
                        : waiting ? 0xFFEDE023 : (multiLap ? lapColor(currentLap) : 0xFF8DC63F);
                tile.setBackground(roundedTile(bg));
                String status = !started ? getString(R.string.not_started_wave)
                        : waiting ? getString(R.string.time_pending)
                        : multiLap ? getString(R.string.on_lap, currentLap, target)
                        : getString(R.string.tap_to_finish);
                boolean tagWave = multiWave && r.wave != null && !r.wave.isEmpty();
                if (tagWave) {
                    // A thin colour bar so the wave reads at a glance; tile
                    // colour itself still means state, not wave.
                    View stripe = new View(this);
                    stripe.setBackground(roundedTile(waveColor(r.wave)));
                    LinearLayout.LayoutParams slp = new LinearLayout.LayoutParams(dp(30), dp(4));
                    slp.bottomMargin = dp(3);
                    stripe.setLayoutParams(slp);
                    tile.addView(stripe);
                    status = r.wave + " · " + status;
                }
                if (showNames) {
                    tile.addView(line(r.bib + " - " + r.name, 17, true, 0xFF1A1A1A));
                    String sub = r.distance
                            + (r.category.isEmpty() ? "" : (r.distance.isEmpty() ? "" : " - ") + r.category);
                    if (!sub.isEmpty()) tile.addView(line(sub, 13, false, 0xFF294715));
                    tile.addView(line(status, 12, false, 0xFF1A3A0A));
                } else {
                    tile.addView(line(r.bib, 20, true, 0xFF1A1A1A));
                    tile.addView(line(status, 13, false, 0xFF1A3A0A));
                }
                tile.setOnClickListener(v -> {
                    if (!started) {
                        Toast.makeText(this, getString(R.string.wave_not_started_yet, r.wave),
                                Toast.LENGTH_SHORT).show();
                        return;
                    }
                    onRacerTap(r);
                });
            }

            GridLayout.LayoutParams lp = new GridLayout.LayoutParams();
            lp.width = 0;
            lp.height = tileH;
            lp.columnSpec = GridLayout.spec(GridLayout.UNDEFINED, 1f);
            lp.setMargins(margin, margin, margin, margin);
            tile.setLayoutParams(lp);
            grid.addView(tile);
        }
    }

    private void renderResults(List<RaceEngine.Result> results, List<RaceStore.Pending> pendingEntries) {
        resultsBox.removeAllViews();
        int decimals = prefs.timingDecimals();
        final Long gun = gunTime();

        boolean recordLaps = prefs.recordLaps();
        java.util.Map<String, Integer> lapTargets = store.lapTargets();

        // One row per lap crossing for multi-lap racers, one row per finish for
        // single-lap racers, plus banked No-Bib times — all ranked by time.
        List<ResRow> rows = new ArrayList<>();
        for (RaceEngine.Result r : results) {
            int target = recordLaps && lapTargets != null
                    ? Math.max(1, lapTargets.getOrDefault(r.distance, 1)) : 1;
            if (target > 1) {
                for (int i = 0; i < r.lapElapsed.length; i++) rows.add(new ResRow(r.lapElapsed[i], r, i + 1));
            } else if ("finished".equals(r.status)) {
                rows.add(new ResRow(r.elapsedMs, r, 0));
            }
        }
        for (RaceStore.Pending p : pendingEntries) {
            if (p.hasTime() && !p.hasRacer()) rows.add(new ResRow(gun == null ? 0 : p.readAtMs - gun, p));
        }
        java.util.Collections.sort(rows, (a, b) -> Long.compare(a.elapsed, b.elapsed));

        int place = 1;
        long prevElapsed = -1;
        long leaderElapsed = -1;
        lastTapText = null;
        View scrollTarget = null;
        for (ResRow row : rows) {
            final int seq = place++;
            long elapsed = row.elapsed;
            String time = RaceEngine.formatElapsed(Math.max(0, elapsed), decimals);
            if (prevElapsed >= 0) lastSplitMs = elapsed - prevElapsed;
            prevElapsed = elapsed;
            if (leaderElapsed < 0) leaderElapsed = elapsed;
            String gap = RaceEngine.formatElapsed(Math.max(0, elapsed - leaderElapsed), 1);

            if (row.pending != null) {
                final RaceStore.Pending p = row.pending;
                // No-Bib finisher: place number deletes it, the row/arrow assigns
                // it a bib later.
                resultsBox.addView(resultRow(String.valueOf(seq), "-", getString(R.string.select_a_bib),
                        time, true, () -> assignTimePending(p), () -> assignTimePending(p),
                        () -> cancelNoBib(seq, p), () -> assignTimePending(p)));
                lastTapText = getString(R.string.last_tap, ordinal(seq), time, gap, getString(R.string.no_bib));
            } else {
                final RaceEngine.Result r = row.result;
                String label = row.lap > 0 ? r.name + " (" + row.lap + ")" : r.name;
                View rv;
                if (row.lap > 0) {
                    // multi-lap split row: view-only, arrow opens racer info
                    rv = resultRow(String.valueOf(seq), r.bib, label, time, false,
                            null, () -> openRacerInfo(r.bib));
                } else {
                    rv = resultRow(String.valueOf(seq), r.bib, label, time, false,
                            () -> editTime(r), () -> openRacerInfo(r.bib),
                            () -> cancelEntry(seq, r), () -> bibActions(seq, r));
                }
                resultsBox.addView(rv);
                if (scrollToBib != null && scrollToBib.equals(r.bib)) scrollTarget = rv;
                lastTapText = getString(R.string.last_tap, ordinal(seq), time, gap,
                        r.name == null || r.name.isEmpty() ? r.bib : r.name);
            }
        }
        // bib pre-entered, still waiting for a time
        for (final RaceStore.Pending p : pendingEntries) {
            if (p.hasRacer() && !p.hasTime()) {
                resultsBox.addView(resultRow("—", p.bib, p.name, getString(R.string.tap_time), true,
                        () -> { store.recordPassing(p.epc, System.currentTimeMillis());
                                store.deletePending(p.id); scrollToBib = p.bib; render(); },
                        () -> openRacerInfo(p.bib)));
            }
        }

        // After a tap-finish, bring that racer's row into view instead of making
        // the operator scroll the finish list down to find it.
        if (scrollTarget != null && !fastTap) {
            final View target = scrollTarget;
            final ScrollView sv = findViewById(R.id.resultsScroll);
            sv.post(() -> sv.smoothScrollTo(0, Math.max(0, target.getTop())));
        }
        scrollToBib = null;
    }

    /** A single finish-list row: a lap crossing / finish for a racer, or a
     *  banked No-Bib time. lap 0 = single-lap finish (no "(n)" label). */
    private static final class ResRow {
        final long elapsed;
        final RaceEngine.Result result;   // null for a No-Bib row
        final RaceStore.Pending pending;  // null for a racer row
        final int lap;
        ResRow(long elapsed, RaceEngine.Result result, int lap) {
            this.elapsed = elapsed; this.result = result; this.pending = null; this.lap = lap;
        }
        ResRow(long elapsed, RaceStore.Pending pending) {
            this.elapsed = elapsed; this.result = null; this.pending = pending; this.lap = 0;
        }
    }

    /** Tap a No-Bib finisher's place number: confirm removing the banked time. */
    private void cancelNoBib(int seq, RaceStore.Pending p) {
        new android.app.AlertDialog.Builder(this)
                .setTitle(getString(R.string.cancel_entry_title, seq))
                .setMessage(R.string.cancel_no_bib_body)
                .setPositiveButton(R.string.yes, (d, w) -> { store.deletePending(p.id); render(); })
                .setNegativeButton(R.string.no, null)
                .show();
    }

    private void openRacerInfo(String bib) {
        if (bib == null || bib.isEmpty()) return;
        Intent i = new Intent(this, RacerInfoActivity.class);
        i.putExtra(RacerInfoActivity.EXTRA_BIB, bib);
        startActivity(i);
    }

    private View resultRow(String place, String bib, String name, String time, boolean unassigned,
                           Runnable onTimeTap, Runnable onArrowTap) {
        return resultRow(place, bib, name, time, unassigned, onTimeTap, onArrowTap, null, null);
    }

    private View resultRow(String place, String bib, String name, String time, boolean unassigned,
                           Runnable onTimeTap, Runnable onArrowTap, Runnable onSeqTap, Runnable onBibTap) {
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL);
        row.setPadding(dp(10), dp(12), dp(10), dp(12));

        TextView pl = chip(place, dp(54), unassigned ? 0xFFEED202 : 0xFFF2E400); // fits 4 digits
        if (onSeqTap != null) pl.setOnClickListener(v -> onSeqTap.run());   // tap seq -> cancel entry
        TextView bibv = chip(bib, dp(48), 0xFFF2E400);
        if (onBibTap != null) bibv.setOnClickListener(v -> onBibTap.run()); // tap bib -> swap / no bib
        TextView nm = new TextView(this);
        nm.setText(name);
        nm.setTextSize(17);
        nm.setTextColor(getColor(R.color.text_primary));
        nm.setPadding(dp(8), 0, dp(8), 0);
        nm.setGravity(Gravity.LEFT | Gravity.CENTER_VERTICAL); // force left, even Hebrew names
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
            chevron.setTextColor(0xFFF5821F);
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

    private android.widget.NumberPicker wheel(int min, int max, int value,
                                              android.widget.NumberPicker.Formatter fmt) {
        android.widget.NumberPicker p = new android.widget.NumberPicker(this);
        p.setMinValue(min);
        p.setMaxValue(max);
        p.setValue(Math.max(min, Math.min(max, value)));
        if (fmt != null) p.setFormatter(fmt);
        return p;
    }

    private TextView sep(String s) {
        TextView t = new TextView(this);
        t.setText(s);
        t.setTextSize(22);
        t.setPadding(dp(3), 0, dp(3), 0);
        return t;
    }

    /** Rounded tile background (smooth edges, matching the clock button). */
    private android.graphics.drawable.GradientDrawable roundedTile(int color) {
        android.graphics.drawable.GradientDrawable d = new android.graphics.drawable.GradientDrawable();
        d.setColor(color);
        d.setCornerRadius(dp(10));
        return d;
    }

    private TextView chip(String text, int width, int bg) {
        TextView t = new TextView(this);
        t.setText(text);
        t.setTextSize(17);
        t.setTextColor(0xFF1A1A1A); // the chip backgrounds are bright yellow in both themes
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
        // Scroll-wheel time editor: h : mm : ss . t
        long tenths = Math.round(r.elapsedMs / 100.0);
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.HORIZONTAL);
        box.setGravity(Gravity.CENTER);
        int pad = dp(12);
        box.setPadding(pad, pad, pad, pad);

        final android.widget.NumberPicker hh = wheel(0, 23, (int) (tenths / 36000), null);
        final android.widget.NumberPicker mm = wheel(0, 59, (int) ((tenths / 600) % 60), i -> String.format(Locale.US, "%02d", i));
        final android.widget.NumberPicker ss = wheel(0, 59, (int) ((tenths / 10) % 60), i -> String.format(Locale.US, "%02d", i));
        final android.widget.NumberPicker tt = wheel(0, 9, (int) (tenths % 10), null);
        box.addView(hh); box.addView(sep(":")); box.addView(mm);
        box.addView(sep(":")); box.addView(ss); box.addView(sep("."));
        box.addView(tt);

        new android.app.AlertDialog.Builder(this)
                .setTitle(getString(R.string.edit_time_for, r.bib, r.name))
                .setView(box)
                .setPositiveButton(R.string.enter, (dlg, w) -> {
                    long ms = ((hh.getValue() * 3600L + mm.getValue() * 60L + ss.getValue()) * 1000L)
                            + tt.getValue() * 100L;
                    // An entered elapsed is measured from THIS racer's own wave
                    // gun; using the first wave's would misplace every racer in
                    // a later wave by the stagger between them.
                    Long gun = gunForWave(r.wave);
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
        LinearLayout content = controlSheetHeader(getString(R.string.race_control),
                getString(R.string.race_control_subtitle));
        ScrollView scroll = new ScrollView(this);
        scroll.addView(content);
        final android.app.AlertDialog dlg = new android.app.AlertDialog.Builder(this)
                .setView(scroll)
                .setNegativeButton(R.string.close, null)
                .create();

        // Wave races arm the gun per wave: offer it here, where the operator
        // already is at the gun. Hidden for a mass start (one gun, fired on the
        // Race start screen) and when the race has no named waves.
        if (hasNamedWaves()) {
            content.addView(controlRow(R.drawable.ic_ctrl_gun, 0xFF4F9E27, 0xFF1C3320,
                    R.string.rc_startwave_title, R.string.rc_startwave_sub,
                    () -> { dlg.dismiss(); startWaveSheet(); }));
            content.addView(controlDivider());
        }
        content.addView(controlRow(R.drawable.ic_ctrl_restart, 0xFFE39A2B, 0xFF3A2F18,
                R.string.rc_restart_title, R.string.rc_restart_sub,
                () -> { dlg.dismiss(); restartRace(); }));
        content.addView(controlDivider());
        content.addView(controlRow(R.drawable.ic_ctrl_flag, 0xFF4F9E27, 0xFF1C3320,
                R.string.rc_finish_title, R.string.rc_finish_sub,
                () -> { dlg.dismiss(); finishRace(); }));
        content.addView(controlDivider());
        content.addView(controlRow(R.drawable.ic_ctrl_list, 0xFF3F6FD1, 0xFF182A44,
                R.string.rc_live_title, R.string.rc_live_sub,
                () -> { dlg.dismiss(); startActivity(new Intent(this, LiveResultsActivity.class)); }));
        content.addView(controlDivider());
        content.addView(controlRow(R.drawable.ic_ctrl_bars, 0xFF159C93, 0xFF123230,
                R.string.rc_progress_title, R.string.rc_progress_sub,
                () -> { dlg.dismiss(); showRaceProgress(); }));
        content.addView(controlDivider());
        content.addView(controlRow(R.drawable.ic_ctrl_flag, 0xFFC0555A, 0xFF3A1F22,
                R.string.rc_rollcall_title, R.string.rc_rollcall_sub,
                () -> { dlg.dismiss(); closeRollCall(); }));

        dlg.show();
    }

    /** True when the race has at least one real (named) wave — the "" entry is
     *  the mass-start marker, not a wave the operator can gun separately. */
    private boolean hasNamedWaves() {
        for (RaceStore.Wave w : store.waves()) if (!w.name.isEmpty()) return true;
        return false;
    }

    /** Start (or restart) each wave's gun without leaving the timing console.
     *  Mirrors the race console's per-wave rows: tap wave 1 at its gun, then
     *  wave 2 at its own gun a few minutes later — each wave keeps its own
     *  start, so every racer is timed from the gun they actually started on. */
    private void startWaveSheet() {
        LinearLayout content = controlSheetHeader(getString(R.string.rc_startwave_title),
                getString(R.string.rc_startwave_sheet_sub));
        ScrollView scroll = new ScrollView(this);
        scroll.addView(content);
        final android.app.AlertDialog dlg = new android.app.AlertDialog.Builder(this)
                .setView(scroll)
                .setNegativeButton(R.string.close, null)
                .create();

        boolean first = true;
        for (final RaceStore.Wave wave : store.waves()) {
            if (wave.name.isEmpty()) continue; // mass-start marker
            if (!first) content.addView(controlDivider());
            first = false;

            LinearLayout row = new LinearLayout(this);
            row.setOrientation(LinearLayout.HORIZONTAL);
            row.setGravity(Gravity.CENTER_VERTICAL);
            row.setPadding(dp(22), dp(13), dp(22), dp(13));

            LinearLayout text = new LinearLayout(this);
            text.setOrientation(LinearLayout.VERTICAL);
            text.setLayoutParams(new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f));
            TextView name = new TextView(this);
            name.setText(wave.name);
            name.setTextSize(16.5f);
            name.setTextColor(getColor(R.color.text_primary));
            name.setTypeface(null, android.graphics.Typeface.BOLD);
            TextView sub = new TextView(this);
            sub.setTextSize(12.5f);
            sub.setTextColor(getColor(R.color.text_muted));
            sub.setPadding(0, dp(2), 0, 0);
            sub.setText(wave.startedAtMs == null
                    ? getString(R.string.not_started_wave)
                    : getString(R.string.wave_started_at, timeOfDay(wave.startedAtMs)));
            text.addView(name);
            text.addView(sub);

            android.widget.Button start = new android.widget.Button(this);
            start.setText(wave.startedAtMs == null
                    ? getString(R.string.start_gun) : getString(R.string.restart_gun));
            start.setOnClickListener(v -> {
                if (wave.startedAtMs != null) {
                    new android.app.AlertDialog.Builder(this)
                            .setMessage(R.string.restart_gun_confirm)
                            .setPositiveButton(android.R.string.ok, (d, w) -> {
                                fireGun(wave.name, true);
                                dlg.dismiss();
                            })
                            .setNegativeButton(android.R.string.cancel, null)
                            .show();
                } else {
                    fireGun(wave.name, false);
                    dlg.dismiss();
                }
            });

            row.addView(text);
            row.addView(start);
            content.addView(row);
        }
        dlg.show();
    }

    /** Record a wave's gun on the phone. The bridge service syncs it up to the
     *  server on its next pass; the race clock picks it up on the next tick. */
    private void fireGun(String waveName, boolean force) {
        store.startWave(waveName, System.currentTimeMillis(), force);
        Toast.makeText(this, getString(R.string.wave_gun_recorded, waveName), Toast.LENGTH_LONG).show();
        scheduleRender();
    }

    private String timeOfDay(long ms) {
        return new java.text.SimpleDateFormat("HH:mm:ss", Locale.US).format(new java.util.Date(ms));
    }

    /** One styled Race-control row: a rounded, tinted icon badge, a title and a
     *  one-line hint, and a chevron. */
    private View controlRow(int iconRes, int iconColor, int badgeBg,
                            int titleRes, int subRes, Runnable onTap) {
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL);
        row.setPadding(dp(22), dp(13), dp(22), dp(13));
        android.util.TypedValue tv = new android.util.TypedValue();
        getTheme().resolveAttribute(android.R.attr.selectableItemBackground, tv, true);
        row.setBackgroundResource(tv.resourceId);
        row.setClickable(true);

        ImageView badge = new ImageView(this);
        badge.setImageResource(iconRes);
        badge.setColorFilter(iconColor);
        badge.setScaleType(ImageView.ScaleType.CENTER_INSIDE);
        int pad = dp(11);
        badge.setPadding(pad, pad, pad, pad);
        android.graphics.drawable.GradientDrawable bg = new android.graphics.drawable.GradientDrawable();
        bg.setColor(badgeBg);
        bg.setCornerRadius(dp(14));
        badge.setBackground(bg);
        LinearLayout.LayoutParams blp = new LinearLayout.LayoutParams(dp(46), dp(46));
        blp.setMarginEnd(dp(15));
        badge.setLayoutParams(blp);

        LinearLayout text = new LinearLayout(this);
        text.setOrientation(LinearLayout.VERTICAL);
        text.setLayoutParams(new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f));
        TextView t = new TextView(this);
        t.setText(titleRes);
        t.setTextSize(16.5f);
        t.setTextColor(getColor(R.color.text_primary));
        t.setTypeface(null, android.graphics.Typeface.BOLD);
        TextView s = new TextView(this);
        s.setText(subRes);
        s.setTextSize(12.5f);
        s.setTextColor(getColor(R.color.text_muted));
        s.setPadding(0, dp(2), 0, 0);
        text.addView(t);
        text.addView(s);

        TextView chev = new TextView(this);
        chev.setText("❯");
        chev.setTextSize(15);
        chev.setTextColor(0x99555555);

        row.addView(badge);
        row.addView(text);
        row.addView(chev);
        row.setOnClickListener(v -> onTap.run());
        return row;
    }

    private View controlDivider() {
        View v = new View(this);
        v.setBackgroundColor(getColor(R.color.divider));
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, 1);
        lp.setMargins(dp(22 + 46 + 15), 0, 0, 0); // indent past the icon
        v.setLayoutParams(lp);
        return v;
    }

    /** Finish race: riders who completed at least one lap are finalised at their
     *  last crossing with the laps they did (ranked below full-distance
     *  finishers). Only riders who never crossed the line are still "out" — for
     *  those we ask whether to mark them DNS or DNF. Either way (or when nobody
     *  is left out) go to the results. */
    private void finishRace() {
        // Preview with laps-down finalisation so partial-lap riders count as
        // finished; the only ones left "out" are those with no crossings at all.
        List<RaceEngine.Result> results = RaceEngine.compute(
                store.racers(), store.waves(), store.allPassings(),
                prefs.suppressSecs(), prefs.lapGapSecs(), prefs.recordLaps(), store.lapTargets(),
                true, prefs.leaderEndsRaceActive());
        final List<RaceEngine.Result> onCourse = new ArrayList<>();
        for (RaceEngine.Result r : results) {
            if ("on_course".equals(r.status) || "not_started".equals(r.status)) onCourse.add(r);
        }
        if (onCourse.isEmpty()) {
            new android.app.AlertDialog.Builder(this)
                    .setTitle(R.string.rc_finish)
                    .setMessage(R.string.finish_race_confirm)
                    .setPositiveButton(R.string.finish_race_ok, (d, w) -> finalizeAndGoToResults())
                    .setNegativeButton(R.string.cancel_popup, null)
                    .show();
            return;
        }
        // Riders who never crossed the line: mark them DNS or DNF before results.
        new android.app.AlertDialog.Builder(this)
                .setTitle(R.string.still_on_course)
                .setItems(new String[]{getString(R.string.mark_dns), getString(R.string.mark_dnf)},
                        (d, which) -> {
                            String status = which == 0 ? "DNS" : "DNF";
                            for (RaceEngine.Result r : onCourse) {
                                if (!r.bib.isEmpty()) store.setRacerStatus(r.bib, status);
                            }
                            finalizeAndGoToResults();
                        })
                .setNegativeButton(R.string.cancel_popup, null)
                .show();
    }

    /** Commit the finish: persist laps-down finalisation so the results screen
     *  and the upload treat partial-lap riders as finished, then show results. */
    private void finalizeAndGoToResults() {
        prefs.setRaceFinalized(true);
        goToResults();
    }

    private void goToResults() {
        stopReader(); // race over: stop capturing
        startActivity(new Intent(this, ViewResultsActivity.class));
    }

    /** Close the start-line roll call now: racers not yet read since the gun are
     *  marked DNS immediately (a later read still clears them). */
    private void closeRollCall() {
        prefs.setRollCallClosedAt(System.currentTimeMillis());
        scheduleRender();
        tapToast(getString(R.string.rollcall_closed));
    }

    /** Restart (false start): keep or discard recorded times, un-gun the race
     *  and return to Race Start so the organizer can start it again. */
    private void restartRace() {
        LinearLayout content = controlSheetHeader(getString(R.string.rc_restart_title),
                getString(R.string.restart_results_prompt));
        ScrollView scroll = new ScrollView(this);
        scroll.addView(content);
        final android.app.AlertDialog dlg = new android.app.AlertDialog.Builder(this)
                .setView(scroll)
                .setNegativeButton(R.string.cancel_popup, null)
                .create();

        // clearReads mirrors Discard: the uploaded reads go too, not just the
        // local ones. Either way the server has to be told the race was
        // un-started, or the web keeps showing it live off the old gun times.
        final java.util.function.Consumer<Boolean> restart = (clearReads) -> {
            pushRaceReset(clearReads);
            store.clearPending();
            store.clearGunTimes();                 // un-start every wave
            // Remember WHEN we un-started, so the next start-list sync doesn't
            // pull the old gun times back down and re-run the wave clocks.
            prefs.setGunsClearedAt(System.currentTimeMillis());
            prefs.setRaceFinalized(false);
            prefs.setRollCallClosedAt(0);          // fresh race: roll call re-opens
            // keep the reader (and its WiFi) connected through the restart;
            // clearing the gun re-arms the per-racer beeps
            Intent i = new Intent(this, RaceStartActivity.class);
            i.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
            startActivity(i);
        };

        content.addView(controlRow(R.drawable.ic_ctrl_save, 0xFF4F9E27, 0xFF1C3320,
                R.string.restart_save, R.string.restart_save_sub,
                () -> { dlg.dismiss(); restart.accept(false); }));         // keep times
        content.addView(controlDivider());
        content.addView(controlRow(R.drawable.ic_ctrl_trash, 0xFFC0392B, 0xFFF7DDD9,
                R.string.restart_discard, R.string.restart_discard_sub,
                () -> { dlg.dismiss(); store.clearPassings(); restart.accept(true); })); // discard times

        dlg.show();
    }

    /** Tell the server the race was restarted. Off the UI thread, and a failure
     *  is reported rather than swallowed: if this does not land, the web keeps
     *  showing the race live off gun times the phone has already forgotten. */
    private void pushRaceReset(boolean clearReads) {
        final Prefs p = prefs;
        new Thread(() -> {
            String error = null;
            try {
                new com.velogrip.rfid.net.Uploader(p.serverUrl(), p.readerToken()).resetRace(clearReads);
            } catch (Exception e) {
                error = e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage();
            }
            final String failed = error;
            if (failed != null) {
                runOnUiThread(() -> Toast.makeText(this,
                        getString(R.string.reset_not_synced, failed), Toast.LENGTH_LONG).show());
            }
        }).start();
    }

    /** Header block (bold title + one-line subtitle) shared by the styled
     *  Race-control sheets. */
    private LinearLayout controlSheetHeader(String title, String subtitle) {
        LinearLayout content = new LinearLayout(this);
        content.setOrientation(LinearLayout.VERTICAL);
        content.setBackgroundColor(getColor(R.color.surface)); // a cohesive dark (or light) sheet
        LinearLayout head = new LinearLayout(this);
        head.setOrientation(LinearLayout.VERTICAL);
        head.setPadding(dp(22), dp(18), dp(22), dp(10));
        TextView t = new TextView(this);
        t.setText(title);
        t.setTextSize(21);
        t.setTextColor(getColor(R.color.text_primary));
        t.setTypeface(null, android.graphics.Typeface.BOLD);
        TextView s = new TextView(this);
        s.setText(subtitle);
        s.setTextSize(13);
        s.setTextColor(getColor(R.color.text_muted));
        s.setPadding(0, dp(2), 0, 0);
        head.addView(t);
        head.addView(s);
        content.addView(head);
        return content;
    }

    private void showRaceProgress() {
        List<RaceEngine.Result> results = RaceEngine.compute(
                store.racers(), store.waves(), store.allPassings(),
                prefs.suppressSecs(), prefs.lapGapSecs(), prefs.recordLaps(), store.lapTargets(),
                prefs.raceFinalized(), System.currentTimeMillis(),
                prefs.rollCallSecs() * 1000L, prefs.rollCallClosedAt(), prefs.leaderEndsRaceActive());
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
        handler.removeCallbacks(renderTask); // onResume re-renders fresh anyway
        handler.removeCallbacks(rollCallTick);
        unregisterReceiver(bridgeReceiver);
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        store.close();
    }
}

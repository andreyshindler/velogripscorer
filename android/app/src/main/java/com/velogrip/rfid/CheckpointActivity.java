package com.velogrip.rfid;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.graphics.Typeface;
import android.os.Bundle;
import android.text.Editable;
import android.text.TextUtils;
import android.text.TextWatcher;
import android.view.Gravity;
import android.view.View;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import com.velogrip.rfid.db.RaceStore;
import com.velogrip.rfid.net.StartListSync;
import com.velogrip.rfid.net.Uploader;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Checkpoint mode: a stripped-down screen for a marshal operating a checkpoint.
 * The marshal first picks how this checkpoint reads riders:
 *   • RFID reader — connect the reader hardware; tags upload automatically.
 *   • Manual entry — no reader; the marshal taps in each bib as riders pass.
 * Either way the reads upload as split times, and the screen shows only the pass
 * count and sync state — no finish button, race control, start list or results.
 */
public class CheckpointActivity extends BaseActivity {

    private static final int MODE_NONE = 0, MODE_READER = 1, MODE_MANUAL = 2;

    private Prefs prefs;
    private RaceStore store;
    private int mode = MODE_NONE;
    private String lastEpc = "";
    private boolean serviceStarted = false;
    // Passes already in the buffer when this checkpoint session started, so the
    // on-screen counter shows this session's passes — not the race's running total
    // (the buffer is kept for offline upload and survives a stop/re-join).
    private long sessionBase = -1;
    // When this checkpoint session began, so the per-lap tally only counts passes
    // recorded now (not any left over from a previous session on the same race).
    private long sessionStartMs = 0;

    private View chooser, readerPanel, manualPanel, lapCountersScroll;
    private TextView title, count, countLabel, sync, reader, last, manualStatus, recent;
    private Button connect;
    private EditText filter;
    private LinearLayout bibGrid, lapCounters;
    private List<RaceStore.Racer> racers = new ArrayList<>();
    private final Map<String, Integer> taps = new HashMap<>();
    private Map<String, Integer> lapCaps = new HashMap<>(); // distance -> laps (tap cap)

    private final BroadcastReceiver receiver = new BroadcastReceiver() {
        @Override public void onReceive(Context c, Intent i) {
            boolean readerConnected = i.getBooleanExtra(BridgeService.EXTRA_READER_CONNECTED, false);
            long pending = i.getLongExtra(BridgeService.EXTRA_PENDING, 0);
            boolean online = i.getBooleanExtra(BridgeService.EXTRA_ONLINE, true);
            String epc = i.getStringExtra(BridgeService.EXTRA_LAST_EPC);
            if (epc != null && !epc.isEmpty()) lastEpc = epc;
            render(readerConnected, pending, online);
        }
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_checkpoint);
        prefs = new Prefs(this);
        store = new RaceStore(this);

        chooser = findViewById(R.id.cpModeChooser);
        readerPanel = findViewById(R.id.cpReaderPanel);
        manualPanel = findViewById(R.id.cpManualPanel);
        title = findViewById(R.id.cpTitle);
        count = findViewById(R.id.cpCount);
        countLabel = findViewById(R.id.cpCountLabel);
        sync = findViewById(R.id.cpSync);
        reader = findViewById(R.id.cpReader);
        last = findViewById(R.id.cpLast);
        manualStatus = findViewById(R.id.cpManualStatus);
        recent = findViewById(R.id.cpRecent);
        lapCounters = findViewById(R.id.cpLapCounters);
        lapCountersScroll = findViewById(R.id.cpLapCountersScroll);
        connect = findViewById(R.id.cpConnect);
        filter = findViewById(R.id.cpFilter);
        bibGrid = findViewById(R.id.cpBibGrid);

        title.setText(prefs.contestTitle());
        findViewById(R.id.cpHome).setOnClickListener(v -> goHome());
        findViewById(R.id.cpModeReader).setOnClickListener(v -> pickReader());
        findViewById(R.id.cpModeManual).setOnClickListener(v -> pickManual());
        connect.setOnClickListener(v -> startActivity(new Intent(this, ScanReaderActivity.class)));
        findViewById(R.id.cpReaderSettings).setOnClickListener(v -> startActivity(new Intent(this, SettingsActivity.class)));
        findViewById(R.id.cpStop).setOnClickListener(v -> stopAndExit());
        filter.addTextChangedListener(new TextWatcher() {
            @Override public void afterTextChanged(Editable s) { buildGrid(s.toString().trim()); }
            @Override public void beforeTextChanged(CharSequence s, int a, int b, int c) { }
            @Override public void onTextChanged(CharSequence s, int a, int b, int c) { }
        });
    }

    @Override
    protected void onResume() {
        super.onResume();
        registerReceiver(receiver, new IntentFilter(BridgeService.ACTION_STATUS));
        // Re-arm the reader if a scan just set the address.
        if (mode == MODE_READER && !serviceStarted && !prefs.readerHost().isEmpty()) startBridge(false);
        render(false, store.pendingCount(), true);
    }

    @Override
    protected void onPause() {
        super.onPause();
        try { unregisterReceiver(receiver); } catch (IllegalArgumentException ignored) { }
    }

    // ---- Mode selection --------------------------------------------------------

    private void pickReader() {
        mode = MODE_READER;
        if (sessionBase < 0) { sessionBase = store.passingCount(); sessionStartMs = System.currentTimeMillis(); }
        chooser.setVisibility(View.GONE);
        showCounts();
        readerPanel.setVisibility(View.VISIBLE);
        findViewById(R.id.cpStop).setVisibility(View.VISIBLE);
        if (!prefs.readerHost().isEmpty()) startBridge(false);
    }

    private void pickManual() {
        mode = MODE_MANUAL;
        if (sessionBase < 0) { sessionBase = store.passingCount(); sessionStartMs = System.currentTimeMillis(); }
        chooser.setVisibility(View.GONE);
        showCounts();
        manualPanel.setVisibility(View.VISIBLE);
        findViewById(R.id.cpStop).setVisibility(View.VISIBLE);
        startBridge(true); // upload-only: no reader socket
        loadStartList();
    }

    private void showCounts() {
        count.setVisibility(View.VISIBLE);
        countLabel.setVisibility(View.VISIBLE);
        sync.setVisibility(View.VISIBLE);
    }

    private void startBridge(boolean manualOnly) {
        Intent i = new Intent(this, BridgeService.class).setAction(BridgeService.ACTION_START);
        i.putExtra(BridgeService.EXTRA_MANUAL_ONLY, manualOnly);
        startForegroundService(i);
        serviceStarted = true;
    }

    // ---- Manual entry ----------------------------------------------------------

    /** Pull the start list (bib -> chip) so manual taps map to the right racer. */
    private void loadStartList() {
        manualStatus.setText(R.string.loading_start_list);
        new Thread(() -> {
            String msg;
            try {
                StartListSync.Result r = StartListSync.download(prefs, store);
                msg = getString(R.string.start_list_loaded, r.racers);
            } catch (Exception e) {
                int have = store.racers().size();
                msg = have > 0 ? getString(R.string.start_list_cached, have)
                        : getString(R.string.start_list_failed);
            }
            final String text = msg;
            runOnUiThread(() -> {
                manualStatus.setText(text);
                racers = store.racers();
                lapCaps = store.lapTargets();
                filter.setVisibility(racers.isEmpty() ? View.GONE : View.VISIBLE);
                buildGrid("");
            });
        }).start();
    }

    /** A tappable tile per bib in the start list, laid out like the race console's
     *  timing grid: rounded, colour-coded tiles in a 4-column grid, bib order. */
    private void buildGrid(String q) {
        bibGrid.removeAllViews();
        final int cols = 4;
        List<RaceStore.Racer> shown = new ArrayList<>();
        for (RaceStore.Racer r : racers) {
            if (r.epc == null || r.epc.isEmpty()) continue;
            if (!q.isEmpty() && (r.bib == null || !r.bib.contains(q))) continue;
            if (isDone(r)) continue; // all laps recorded -> drop the tile off the grid
            shown.add(r);
        }
        java.util.Collections.sort(shown, (a, b) -> Long.compare(bibNum(a.bib), bibNum(b.bib)));
        LinearLayout row = null;
        for (int i = 0; i < shown.size(); i++) {
            if (i % cols == 0) {
                row = new LinearLayout(this);
                row.setOrientation(LinearLayout.HORIZONTAL);
                bibGrid.addView(row, new LinearLayout.LayoutParams(
                        LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT));
            }
            row.addView(makeTile(shown.get(i)));
        }
        if (row != null) for (int i = shown.size() % cols; i != 0 && i < cols; i++) row.addView(spacer());
        if (shown.isEmpty()) {
            TextView empty = new TextView(this);
            empty.setText(q.isEmpty() && !racers.isEmpty() ? R.string.all_riders_recorded : R.string.no_matching_bib);
            empty.setTextColor(getColor(R.color.text_muted));
            empty.setPadding(dp(8), dp(16), dp(8), dp(16));
            bibGrid.addView(empty);
        }
    }

    private View makeTile(RaceStore.Racer r) {
        LinearLayout tile = new LinearLayout(this);
        tile.setOrientation(LinearLayout.VERTICAL);
        tile.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(0, dp(72), 1f);
        lp.setMargins(dp(4), dp(4), dp(4), dp(4));
        tile.setLayoutParams(lp);
        tile.setPadding(dp(6), dp(6), dp(6), dp(6));
        tile.setClickable(true);

        TextView bibTv = new TextView(this);
        bibTv.setTextSize(22);
        bibTv.setTypeface(null, Typeface.BOLD);
        bibTv.setGravity(Gravity.CENTER);
        TextView nameTv = new TextView(this);
        nameTv.setText(r.name == null ? "" : r.name);
        nameTv.setTextSize(11);
        nameTv.setMaxLines(1);
        nameTv.setEllipsize(TextUtils.TruncateAt.END);
        nameTv.setGravity(Gravity.CENTER);
        tile.addView(bibTv);
        tile.addView(nameTv);

        styleTile(tile, bibTv, nameTv, r.bib, taps.getOrDefault(r.bib, 0), maxTaps(r));
        tile.setOnClickListener(v -> tapBib(r, tile, bibTv, nameTv));
        return tile;
    }

    // Numeric bib order (matches the race console), non-numeric bibs sort last.
    private static long bibNum(String bib) {
        if (bib == null) return Long.MAX_VALUE;
        try { return Long.parseLong(bib.trim()); } catch (NumberFormatException e) { return Long.MAX_VALUE; }
    }

    private android.graphics.drawable.GradientDrawable roundedTile(int color) {
        android.graphics.drawable.GradientDrawable d = new android.graphics.drawable.GradientDrawable();
        d.setColor(color);
        d.setCornerRadius(dp(10));
        return d;
    }

    // A rider passes a checkpoint once per lap, so cap taps at the race's lap
    // count for that distance. Unknown lap count -> no cap (or 1 if single-crossing).
    private int maxTaps(RaceStore.Racer r) {
        Integer laps = lapCaps.get(r.distance == null ? "" : r.distance);
        if (laps != null && laps > 0) return laps;          // per-distance override
        if (prefs.raceLaps() > 0) return prefs.raceLaps();  // race-wide cap
        return prefs.recordLaps() ? Integer.MAX_VALUE : 1;
    }

    // A rider is done once every lap is recorded (only when the lap count is known
    // — an unknown/uncapped rider never drops off).
    private boolean isDone(RaceStore.Racer r) {
        int max = maxTaps(r);
        return max != Integer.MAX_VALUE && taps.getOrDefault(r.bib, 0) >= max;
    }

    private void tapBib(RaceStore.Racer r, View tile, TextView bibTv, TextView nameTv) {
        final int max = maxTaps(r);
        final int cur = taps.getOrDefault(r.bib, 0);
        if (cur >= max) {
            Toast.makeText(this, getString(R.string.all_laps_recorded, max), Toast.LENGTH_SHORT).show();
            return;
        }
        store.recordPassing(r.epc, System.currentTimeMillis());
        int n = cur + 1;
        taps.put(r.bib, n);
        recent.setText(getString(R.string.recorded_bib, r.bib, r.name == null ? "" : r.name));
        render(false, store.pendingCount(), true);
        // Last lap recorded -> the tile leaves the grid; otherwise just update it.
        if (n >= max) buildGrid(filter.getText().toString().trim());
        else styleTile(tile, bibTv, nameTv, r.bib, n, max);
    }

    // Traffic-light tiles, matching the race console: green = available to record,
    // amber = a pass logged (still under the lap cap), grey = all laps recorded.
    private void styleTile(View tile, TextView bibTv, TextView nameTv, String bib, int count, int max) {
        boolean finite = max != Integer.MAX_VALUE;
        boolean full = count > 0 && count >= max;
        int bg = count == 0 ? 0xFF8DC63F : (full ? 0xFF8A8F98 : 0xFFEDE023);
        tile.setBackground(roundedTile(bg));
        int tc = full ? 0xFFFFFFFF : 0xFF1A1A1A;
        bibTv.setText(bib);
        bibTv.setTextColor(tc);
        nameTv.setTextColor(full ? 0xFFE8E8E8 : 0xFF294715);
        // Idle tiles keep the racer name (set in makeTile); once a pass is logged
        // the sub-line becomes the count, like the console's "On lap X/Y".
        if (count > 0) nameTv.setText(finite ? count + "/" + max : "×" + count);
    }

    private View spacer() {
        View s = new View(this);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(0, 1, 1f);
        lp.setMargins(dp(4), dp(4), dp(4), dp(4));
        s.setLayoutParams(lp);
        return s;
    }

    private int dp(int v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }

    // ---- Shared ----------------------------------------------------------------

    private void goHome() {
        Intent i = new Intent(this, MainActivity.class);
        i.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        startActivity(i);
    }

    // Confirm before stopping: it clears this checkpoint's readings (here and on
    // the server) so the next session starts from a clean count.
    private void stopAndExit() {
        new android.app.AlertDialog.Builder(this)
                .setTitle(R.string.stop_checkpoint)
                .setMessage(getString(R.string.stop_checkpoint_confirm, store.passingCount()))
                .setPositiveButton(R.string.stop_and_clear, (d, w) -> doStopAndReset())
                .setNegativeButton(android.R.string.cancel, null)
                .show();
    }

    private void doStopAndReset() {
        startService(new Intent(this, BridgeService.class).setAction(BridgeService.ACTION_STOP));
        final String server = prefs.serverUrl(), token = prefs.readerToken();
        new Thread(() -> {
            // Clear the server's read count for this checkpoint, then the local buffer.
            try { new Uploader(server, token).clearReads(); } catch (Exception ignored) { }
            try { store.clearPassings(); } catch (Exception ignored) { }
            runOnUiThread(() -> { goHome(); finish(); });
        }).start();
    }

    private void render(boolean readerConnected, long pending, boolean online) {
        long total = store.passingCount();
        count.setText(String.valueOf(sessionBase < 0 ? total : Math.max(0, total - sessionBase)));
        updateLapBreakdown();
        if (mode == MODE_READER) {
            if (readerConnected) {
                reader.setText(R.string.reader_connected);
                reader.setTextColor(0xFF2E7D32);
            } else if (prefs.readerHost().isEmpty()) {
                reader.setText(R.string.no_reader);
                reader.setTextColor(0xFFC0392B);
            } else {
                reader.setText(R.string.reader_connecting);
                reader.setTextColor(0xFFB9770E);
            }
            connect.setVisibility(readerConnected ? View.GONE : View.VISIBLE);
            last.setText(lastEpc.isEmpty() ? "" : getString(R.string.last_tag, lastEpc));
        }
        if (pending == 0) {
            sync.setText(online ? R.string.all_uploaded : R.string.sync_offline_short);
        } else {
            sync.setText(getString(online ? R.string.uploading_n : R.string.offline_n, pending));
        }
    }

    // A separate counter per lap: each shows how many riders reached that lap this
    // session (a rider with N passes counts toward every lap up to N). For a
    // single-lap race there's just the one total counter (the big number above).
    private void updateLapBreakdown() {
        if (sessionStartMs <= 0) { lapCountersScroll.setVisibility(View.GONE); return; }
        Map<String, Integer> counts = store.passCountsSince(sessionStartMs);
        int maxLap = 0;
        for (int v : counts.values()) if (v > maxLap) maxLap = v;
        // Show every expected lap (from the configured caps) even before anyone
        // has reached it, so the marshal sees all the lap counters up front.
        for (int cap : lapCaps.values()) if (cap > maxLap) maxLap = cap;
        if (prefs.raceLaps() > maxLap) maxLap = prefs.raceLaps();

        if (maxLap < 2) { // single-lap: keep just the big total counter
            lapCountersScroll.setVisibility(View.GONE);
            count.setVisibility(View.VISIBLE);
            countLabel.setVisibility(View.VISIBLE);
            return;
        }
        // Multi-lap: the per-lap counters replace the single total.
        count.setVisibility(View.GONE);
        countLabel.setVisibility(View.GONE);
        int[] tally = new int[maxLap + 1];
        for (int v : counts.values()) for (int l = 1; l <= Math.min(v, maxLap); l++) tally[l]++;
        lapCounters.removeAllViews();
        for (int l = 1; l <= maxLap; l++) lapCounters.addView(lapCounter(l, tally[l]));
        lapCountersScroll.setVisibility(View.VISIBLE);
    }

    /** One lap's counter tile: a big number over a "Lap N" label. */
    private View lapCounter(int lap, int value) {
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        lp.setMargins(dp(10), 0, dp(10), 0);
        box.setLayoutParams(lp);
        box.setMinimumWidth(dp(56));

        TextView num = new TextView(this);
        num.setText(String.valueOf(value));
        num.setTextSize(40);
        num.setTypeface(null, Typeface.BOLD);
        num.setTextColor(getColor(R.color.velogrip_green));
        num.setGravity(Gravity.CENTER);
        TextView lbl = new TextView(this);
        lbl.setText(getString(R.string.lap_label, lap));
        lbl.setTextSize(13);
        lbl.setTextColor(getColor(R.color.text_muted));
        lbl.setGravity(Gravity.CENTER);
        box.addView(num);
        box.addView(lbl);
        return box;
    }
}

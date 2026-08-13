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

    private View chooser, readerPanel, manualPanel;
    private TextView title, count, countLabel, sync, reader, last, manualStatus, recent;
    private Button connect;
    private EditText filter;
    private LinearLayout bibGrid;
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
        if (sessionBase < 0) sessionBase = store.passingCount();
        chooser.setVisibility(View.GONE);
        showCounts();
        readerPanel.setVisibility(View.VISIBLE);
        findViewById(R.id.cpStop).setVisibility(View.VISIBLE);
        if (!prefs.readerHost().isEmpty()) startBridge(false);
    }

    private void pickManual() {
        mode = MODE_MANUAL;
        if (sessionBase < 0) sessionBase = store.passingCount();
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

    /** A tappable tile per bib in the start list; tap = record that racer's pass. */
    private void buildGrid(String q) {
        bibGrid.removeAllViews();
        final int cols = 3;
        LinearLayout row = null;
        int shown = 0;
        for (RaceStore.Racer r : racers) {
            if (r.epc == null || r.epc.isEmpty()) continue;
            if (!q.isEmpty() && (r.bib == null || !r.bib.contains(q))) continue;
            if (shown % cols == 0) {
                row = new LinearLayout(this);
                row.setOrientation(LinearLayout.HORIZONTAL);
                bibGrid.addView(row, new LinearLayout.LayoutParams(
                        LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT));
            }
            row.addView(makeTile(r));
            shown++;
        }
        if (row != null) for (int i = shown % cols; i != 0 && i < cols; i++) row.addView(spacer());
        if (shown == 0) {
            TextView empty = new TextView(this);
            empty.setText(R.string.no_matching_bib);
            empty.setTextColor(getColor(R.color.text_muted));
            bibGrid.addView(empty);
        }
    }

    private View makeTile(RaceStore.Racer r) {
        LinearLayout tile = new LinearLayout(this);
        tile.setOrientation(LinearLayout.VERTICAL);
        tile.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f);
        lp.setMargins(dp(4), dp(4), dp(4), dp(4));
        tile.setLayoutParams(lp);
        tile.setPadding(dp(6), dp(12), dp(6), dp(12));
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

    // A rider passes a checkpoint once per lap, so cap taps at the race's lap
    // count for that distance. Unknown lap count -> no cap (or 1 if single-crossing).
    private int maxTaps(RaceStore.Racer r) {
        Integer laps = lapCaps.get(r.distance == null ? "" : r.distance);
        if (laps != null && laps > 0) return laps;
        return prefs.recordLaps() ? Integer.MAX_VALUE : 1;
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
        styleTile(tile, bibTv, nameTv, r.bib, n, max);
        recent.setText(getString(R.string.recorded_bib, r.bib, r.name == null ? "" : r.name));
        render(false, store.pendingCount(), true);
    }

    private void styleTile(View tile, TextView bibTv, TextView nameTv, String bib, int count, int max) {
        boolean on = count > 0;
        boolean full = on && count >= max;
        tile.setBackgroundColor(getColor(!on ? R.color.tile_idle_bg : (full ? R.color.velogrip_dark : R.color.velogrip_green)));
        int tc = getColor(on ? R.color.on_accent : R.color.tile_idle_text);
        bibTv.setTextColor(tc);
        nameTv.setTextColor(tc);
        boolean finite = max != Integer.MAX_VALUE;
        bibTv.setText(count == 0 ? bib : (finite ? bib + "  " + count + "/" + max : bib + "  ×" + count));
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

    private void stopAndExit() {
        // Context.startService(Intent) — stop the bridge.
        startService(new Intent(this, BridgeService.class).setAction(BridgeService.ACTION_STOP));
        goHome();
        finish();
    }

    private void render(boolean readerConnected, long pending, boolean online) {
        long total = store.passingCount();
        count.setText(String.valueOf(sessionBase < 0 ? total : Math.max(0, total - sessionBase)));
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
}

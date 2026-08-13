package com.velogrip.rfid;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.os.Bundle;
import android.view.View;
import android.widget.Button;
import android.widget.EditText;
import android.widget.TextView;
import android.widget.Toast;

import com.velogrip.rfid.db.RaceStore;
import com.velogrip.rfid.net.StartListSync;

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

    private View chooser, readerPanel, manualPanel;
    private TextView title, count, countLabel, sync, reader, last, manualStatus, recent;
    private Button connect;
    private EditText bib;

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
        bib = findViewById(R.id.cpBib);

        title.setText(prefs.contestTitle());
        findViewById(R.id.cpHome).setOnClickListener(v -> goHome());
        findViewById(R.id.cpModeReader).setOnClickListener(v -> pickReader());
        findViewById(R.id.cpModeManual).setOnClickListener(v -> pickManual());
        connect.setOnClickListener(v -> startActivity(new Intent(this, ScanReaderActivity.class)));
        findViewById(R.id.cpReaderSettings).setOnClickListener(v -> startActivity(new Intent(this, SettingsActivity.class)));
        findViewById(R.id.cpRecord).setOnClickListener(v -> recordManual());
        findViewById(R.id.cpStop).setOnClickListener(v -> stopAndExit());
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
        chooser.setVisibility(View.GONE);
        showCounts();
        readerPanel.setVisibility(View.VISIBLE);
        findViewById(R.id.cpStop).setVisibility(View.VISIBLE);
        if (!prefs.readerHost().isEmpty()) startBridge(false);
    }

    private void pickManual() {
        mode = MODE_MANUAL;
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
            runOnUiThread(() -> manualStatus.setText(text));
        }).start();
    }

    private void recordManual() {
        String b = bib.getText().toString().trim();
        if (b.isEmpty()) return;
        RaceStore.Racer racer = null;
        for (RaceStore.Racer r : store.racers()) {
            if (b.equals(r.bib)) { racer = r; break; }
        }
        if (racer == null || racer.epc.isEmpty()) {
            Toast.makeText(this, getString(R.string.bib_not_found, b), Toast.LENGTH_SHORT).show();
            return;
        }
        store.recordPassing(racer.epc, System.currentTimeMillis());
        recent.setText(getString(R.string.recorded_bib, racer.bib,
                racer.name == null ? "" : racer.name));
        bib.setText("");
        render(false, store.pendingCount(), true);
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
        count.setText(String.valueOf(store.passingCount()));
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

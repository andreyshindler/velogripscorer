package com.velogrip.rfid;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.os.Bundle;
import android.view.View;
import android.widget.Button;
import android.widget.TextView;

import com.velogrip.rfid.db.RaceStore;

/**
 * Checkpoint mode: a stripped-down screen for a marshal operating a checkpoint.
 * It starts the same reader bridge as the finish device but shows only what a
 * checkpoint needs — how many passes have been read and whether they've reached
 * the server — with no finish button, race control, start list or results. The
 * server records this device's reads as split times.
 */
public class CheckpointActivity extends BaseActivity {

    private Prefs prefs;
    private RaceStore store;
    private TextView title, count, reader, sync, last;
    private Button connect;
    private String lastEpc = "";
    private boolean started = false;

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

        title = findViewById(R.id.cpTitle);
        count = findViewById(R.id.cpCount);
        reader = findViewById(R.id.cpReader);
        sync = findViewById(R.id.cpSync);
        last = findViewById(R.id.cpLast);
        connect = findViewById(R.id.cpConnect);

        title.setText(prefs.contestTitle());
        findViewById(R.id.cpHome).setOnClickListener(v -> {
            Intent i = new Intent(this, MainActivity.class);
            i.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
            startActivity(i);
        });
        connect.setOnClickListener(v -> startActivity(new Intent(this, ScanReaderActivity.class)));
        findViewById(R.id.cpStop).setOnClickListener(v -> stopAndExit());

        render(false, store.pendingCount(), true);
    }

    @Override
    protected void onResume() {
        super.onResume();
        registerReceiver(receiver, new IntentFilter(BridgeService.ACTION_STATUS));
        // Start reading once a reader address is configured (Ethernet or a scan).
        if (!started && !prefs.readerHost().isEmpty()) {
            startForegroundService(new Intent(this, BridgeService.class).setAction(BridgeService.ACTION_START));
            started = true;
        }
        render(false, store.pendingCount(), true);
    }

    @Override
    protected void onPause() {
        super.onPause();
        try { unregisterReceiver(receiver); } catch (IllegalArgumentException ignored) { }
    }

    private void stopAndExit() {
        startService(new Intent(this, BridgeService.class).setAction(BridgeService.ACTION_STOP));
        Intent i = new Intent(this, MainActivity.class);
        i.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        startActivity(i);
        finish();
    }

    private void render(boolean readerConnected, long pending, boolean online) {
        count.setText(String.valueOf(store.passingCount()));
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
        if (pending == 0) {
            sync.setText(online ? R.string.all_uploaded : R.string.sync_offline_short);
        } else {
            sync.setText(getString(online ? R.string.uploading_n : R.string.offline_n, pending));
        }
        last.setText(lastEpc.isEmpty() ? "" : getString(R.string.last_tag, lastEpc));
    }
}

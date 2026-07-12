package com.velogrip.rfid;

import android.app.Activity;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
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

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * The race console — fully offline. Start waves (gun time is recorded on the
 * phone), watch live standings computed on-device from local passings, and
 * record manual bib entries for failed chips. The web platform is only used
 * to pull the start list down and (via the bridge service) push results up.
 */
public class RaceActivity extends Activity {

    private RaceStore store;
    private Prefs prefs;
    private LinearLayout wavesBox;
    private TextView resultsView;
    private TextView headerView;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Runnable ticker = new Runnable() {
        @Override
        public void run() {
            refresh();
            handler.postDelayed(this, 1000);
        }
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_race);
        if (getActionBar() != null) getActionBar().setDisplayHomeAsUpEnabled(true);
        store = new RaceStore(this);
        prefs = new Prefs(this);

        headerView = findViewById(R.id.raceHeader);
        wavesBox = findViewById(R.id.wavesBox);
        resultsView = findViewById(R.id.resultsView);

        EditText waveName = findViewById(R.id.newWaveName);
        Button addWave = findViewById(R.id.addWave);
        addWave.setOnClickListener(v -> {
            String name = waveName.getText().toString().trim();
            if (name.isEmpty()) return;
            store.upsertWave(name, null, false);
            waveName.setText("");
            rebuildWaves();
        });

        EditText manualBib = findViewById(R.id.manualBib);
        // keyboard matches the bib format chosen in Racer Setup
        manualBib.setInputType(prefs.bibAlphanumeric()
                ? android.text.InputType.TYPE_CLASS_TEXT | android.text.InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD
                : android.text.InputType.TYPE_CLASS_NUMBER);
        Button record = findViewById(R.id.recordManual);
        record.setOnClickListener(v -> {
            String bib = manualBib.getText().toString().trim();
            if (bib.isEmpty()) return;
            RaceStore.Racer racer = store.racerByBib(bib);
            String epc;
            if (racer != null) {
                epc = racer.epc;
            } else {
                epc = synthEpc(bib);
                store.upsertRacer(new RaceStore.Racer(epc, bib, getString(R.string.bib_n, bib), "", ""));
            }
            store.addPassing(new TagRead(epc, null, System.currentTimeMillis()));
            manualBib.setText("");
            Toast.makeText(this, "⏱ #" + bib, Toast.LENGTH_SHORT).show();
            refresh();
        });

        Button download = findViewById(R.id.downloadStartList);
        download.setOnClickListener(v -> downloadStartList(download));

        Button upload = findViewById(R.id.uploadRace);
        upload.setOnClickListener(v -> uploadRace(upload));

        readerStatus = findViewById(R.id.readerStatus);
        connectButton = findViewById(R.id.connectReader);
        // Hardware Setup can turn chip timing off -> manual-only, no reader row
        int readerVisibility = prefs.chipTiming() ? View.VISIBLE : View.GONE;
        readerStatus.setVisibility(readerVisibility);
        connectButton.setVisibility(readerVisibility);
        connectButton.setOnClickListener(v -> {
            if (!bridgeRunning && !prefs.isConfigured()) {
                Toast.makeText(this, R.string.reader_needs_config, Toast.LENGTH_LONG).show();
                startActivity(new android.content.Intent(this, SettingsActivity.class));
                return;
            }
            android.content.Intent intent = new android.content.Intent(this, BridgeService.class);
            intent.setAction(bridgeRunning ? BridgeService.ACTION_STOP : BridgeService.ACTION_START);
            if (!bridgeRunning) {
                startForegroundService(intent);
            } else {
                startService(intent);
            }
        });
    }

    // ---- reader connection (the bridge service owns the socket) ----

    private TextView readerStatus;
    private Button connectButton;
    private boolean bridgeRunning = false;
    private final android.content.BroadcastReceiver bridgeReceiver = new android.content.BroadcastReceiver() {
        @Override
        public void onReceive(android.content.Context context, android.content.Intent intent) {
            bridgeRunning = intent.getBooleanExtra(BridgeService.EXTRA_RUNNING, false);
            boolean connected = intent.getBooleanExtra(BridgeService.EXTRA_READER_CONNECTED, false);
            readerStatus.setText(getString(R.string.reader_line, getString(
                    connected ? R.string.connected : bridgeRunning ? R.string.disconnected : R.string.off)));
            connectButton.setText(bridgeRunning ? R.string.disconnect_reader : R.string.connect_reader);
            refresh();
        }
    };

    /** Deterministic synthetic chip code for a manually-entered bib with no
     *  chip: numeric bibs stay compatible with the server (AA + padded), while
     *  alphanumeric bibs hex-encode so re-entering the same bib merges. */
    private static String synthEpc(String bib) {
        if (bib.matches("\\d{1,10}")) {
            return "AA" + String.format(Locale.US, "%4s", bib).replace(' ', '0');
        }
        StringBuilder hex = new StringBuilder("AA");
        for (byte b : bib.getBytes(java.nio.charset.StandardCharsets.UTF_8)) {
            hex.append(String.format(Locale.US, "%02X", b));
        }
        return hex.toString();
    }

    /** Explicit "upload race to the web now": flushes gun times and every
     *  pending passing in one go, independent of the background bridge. */
    private void uploadRace(Button button) {
        if (prefs.serverUrl().isEmpty() || prefs.readerToken().isEmpty()) {
            Toast.makeText(this, R.string.sync_needs_config, Toast.LENGTH_LONG).show();
            return;
        }
        button.setEnabled(false);
        new Thread(() -> {
            String message;
            try {
                Uploader uploader = new Uploader(prefs.serverUrl(), prefs.readerToken());
                for (RaceStore.Wave wave : store.unsyncedStartedWaves()) {
                    if (wave.name.isEmpty()) continue; // local mass-start marker
                    if (uploader.uploadWaveStart(wave.name, wave.startedAtMs)) {
                        store.markWaveSynced(wave.name);
                    }
                }
                long uploaded = 0;
                while (true) {
                    List<RaceStore.Passing> batch = store.pendingUpload(200);
                    if (batch.isEmpty()) break;
                    if (!uploader.upload(batch)) break;
                    store.markUploaded(batch.get(batch.size() - 1).id);
                    uploaded += batch.size();
                }
                long pending = store.pendingCount();
                message = pending == 0
                        ? getString(R.string.upload_done, uploaded)
                        : getString(R.string.upload_partial, uploaded, pending);
            } catch (Exception e) {
                message = getString(R.string.sync_failed, e.getMessage());
            }
            final String toastText = message;
            runOnUiThread(() -> {
                button.setEnabled(true);
                Toast.makeText(this, toastText, Toast.LENGTH_LONG).show();
            });
        }).start();
    }

    private void downloadStartList(Button button) {
        if (prefs.serverUrl().isEmpty() || prefs.readerToken().isEmpty()) {
            Toast.makeText(this, R.string.sync_needs_config, Toast.LENGTH_LONG).show();
            return;
        }
        button.setEnabled(false);
        new Thread(() -> {
            String message;
            try {
                StartListSync.Result r = StartListSync.download(prefs, store);
                message = getString(R.string.sync_done, r.racers, r.waves);
            } catch (Exception e) {
                message = getString(R.string.sync_failed, e.getMessage());
            }
            final String toastText = message;
            runOnUiThread(() -> {
                button.setEnabled(true);
                Toast.makeText(this, toastText, Toast.LENGTH_LONG).show();
                rebuildWaves();
                refresh();
            });
        }).start();
    }

    private void rebuildWaves() {
        wavesBox.removeAllViews();
        boolean massMode = RaceSetupActivity.TYPE_MASS.equals(prefs.startType());
        findViewById(R.id.newWaveName).setVisibility(massMode ? View.GONE : View.VISIBLE);
        findViewById(R.id.addWave).setVisibility(massMode ? View.GONE : View.VISIBLE);
        if (massMode) {
            buildMassRow();
            return;
        }
        for (final RaceStore.Wave wave : store.waves()) {
            if (wave.name.isEmpty()) continue; // mass-start marker
            LinearLayout row = new LinearLayout(this);
            row.setOrientation(LinearLayout.HORIZONTAL);
            row.setGravity(Gravity.CENTER_VERTICAL);
            row.setPadding(0, 8, 0, 8);

            TextView name = new TextView(this);
            name.setText(wave.name);
            name.setTextSize(16);
            name.setTypeface(null, android.graphics.Typeface.BOLD);
            name.setLayoutParams(new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f));

            TextView clock = new TextView(this);
            clock.setTag("clock:" + wave.name);
            clock.setTextSize(16);
            clock.setTypeface(android.graphics.Typeface.MONOSPACE);
            clock.setPadding(12, 0, 12, 0);
            clock.setText(wave.startedAtMs == null ? getString(R.string.not_started_wave) : "");

            Button start = new Button(this);
            start.setText(wave.startedAtMs == null ? getString(R.string.start_gun) : getString(R.string.restart_gun));
            start.setOnClickListener(v -> {
                boolean force = wave.startedAtMs != null;
                if (force) {
                    new android.app.AlertDialog.Builder(this)
                            .setMessage(R.string.restart_gun_confirm)
                            .setPositiveButton(android.R.string.ok, (d, w) -> {
                                store.startWave(wave.name, System.currentTimeMillis(), true);
                                rebuildWaves();
                            })
                            .setNegativeButton(android.R.string.cancel, null)
                            .show();
                } else {
                    store.startWave(wave.name, System.currentTimeMillis(), false);
                    rebuildWaves();
                }
            });

            row.addView(name);
            row.addView(clock);
            row.addView(start);
            wavesBox.addView(row);
        }
    }

    /** Mass start: one gun for the whole field — every wave (and the racers
     *  with no wave, via the "" marker wave) gets the same start time. */
    private void buildMassRow() {
        Long startedAt = massStartedAt();
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL);
        row.setPadding(0, 8, 0, 8);

        TextView name = new TextView(this);
        name.setText(getString(R.string.mass_race_label));
        name.setTextSize(16);
        name.setTypeface(null, android.graphics.Typeface.BOLD);
        name.setLayoutParams(new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f));

        TextView clock = new TextView(this);
        clock.setTag("clock:__mass");
        clock.setTextSize(16);
        clock.setTypeface(android.graphics.Typeface.MONOSPACE);
        clock.setPadding(12, 0, 12, 0);
        clock.setText(startedAt == null ? getString(R.string.not_started_wave) : "");

        Button start = new Button(this);
        start.setText(startedAt == null ? getString(R.string.start_gun) : getString(R.string.restart_gun));
        start.setOnClickListener(v -> {
            if (massStartedAt() != null) {
                new android.app.AlertDialog.Builder(this)
                        .setMessage(R.string.restart_gun_confirm)
                        .setPositiveButton(android.R.string.ok, (d, w) -> {
                            startAll(true);
                            rebuildWaves();
                        })
                        .setNegativeButton(android.R.string.cancel, null)
                        .show();
            } else {
                startAll(false);
                rebuildWaves();
            }
        });

        row.addView(name);
        row.addView(clock);
        row.addView(start);
        wavesBox.addView(row);
    }

    private Long massStartedAt() {
        Long earliest = null;
        for (RaceStore.Wave w : store.waves()) {
            if (w.startedAtMs != null && (earliest == null || w.startedAtMs < earliest)) {
                earliest = w.startedAtMs;
            }
        }
        return earliest;
    }

    private void startAll(boolean force) {
        long now = System.currentTimeMillis();
        store.startWave("", now, force);
        for (RaceStore.Wave w : store.waves()) {
            if (!w.name.isEmpty()) store.startWave(w.name, now, force);
        }
    }

    private void refresh() {
        String title = prefs.contestTitle();
        headerView.setText(title.isEmpty() ? getString(R.string.race_title) : title);

        // tick wave clocks
        for (RaceStore.Wave wave : store.waves()) {
            View clock = wavesBox.findViewWithTag("clock:" + wave.name);
            if (clock instanceof TextView && wave.startedAtMs != null) {
                ((TextView) clock).setText(RaceEngine.formatClock(System.currentTimeMillis() - wave.startedAtMs));
            }
        }
        View massClock = wavesBox.findViewWithTag("clock:__mass");
        Long massStart = massClock == null ? null : massStartedAt();
        if (massClock instanceof TextView && massStart != null) {
            ((TextView) massClock).setText(RaceEngine.formatClock(System.currentTimeMillis() - massStart));
        }

        List<RaceEngine.Result> results = RaceEngine.compute(
                store.racers(), store.waves(), store.allPassings(),
                prefs.suppressSecs(), prefs.lapGapSecs(), prefs.recordLaps(),
                store.lapTargets());

        // Multiple distances: standings split per distance with its own places
        java.util.LinkedHashMap<String, List<RaceEngine.Result>> sections = new java.util.LinkedHashMap<>();
        java.util.TreeSet<String> distances = new java.util.TreeSet<>();
        for (RaceEngine.Result r : results) {
            if (!r.distance.isEmpty()) distances.add(r.distance);
        }
        if (distances.size() > 1 && prefs.multiDistance(true)) {
            for (String d : distances) sections.put(d, new ArrayList<>());
            sections.put("", new ArrayList<>());
            for (RaceEngine.Result r : results) sections.get(r.distance).add(r);
            if (sections.get("").isEmpty()) sections.remove("");
        } else {
            sections.put("", results);
        }

        StringBuilder sb = new StringBuilder();
        for (Map.Entry<String, List<RaceEngine.Result>> section : sections.entrySet()) {
            if (!section.getKey().isEmpty() || sections.size() > 1) {
                sb.append("── ").append(section.getKey().isEmpty()
                        ? getString(R.string.no_distance) : section.getKey()).append(" ──\n");
            }
            sb.append(String.format(Locale.US, "%-4s %-5s %-16s %-4s %-9s %s%n",
                    "#", getString(R.string.bib_col), getString(R.string.name_col),
                    getString(R.string.laps_col), getString(R.string.time_col), ""));
            int place = 1;
            for (RaceEngine.Result r : section.getValue()) {
                String status = "finished".equals(r.status) ? ""
                        : "on_course".equals(r.status) ? getString(R.string.on_course)
                        : getString(R.string.not_started_wave);
                boolean finished = "finished".equals(r.status);
                sb.append(String.format(Locale.US, "%-4s %-5s %-16s %-4d %-9s %s%n",
                        finished ? String.valueOf(place++) : "–",
                        r.bib,
                        r.name.length() > 16 ? r.name.substring(0, 16) : r.name,
                        r.laps,
                        finished ? RaceEngine.formatElapsed(r.elapsedMs) : "–",
                        status));
            }
            sb.append('\n');
        }
        if (results.isEmpty()) sb.append(getString(R.string.no_racers));
        resultsView.setText(sb.toString());
    }

    @Override
    protected void onResume() {
        super.onResume();
        rebuildWaves();
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
    public boolean onOptionsItemSelected(android.view.MenuItem item) {
        if (item.getItemId() == android.R.id.home) { finish(); return true; }
        return super.onOptionsItemSelected(item);
    }
}

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
import com.velogrip.rfid.net.Uploader;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.List;
import java.util.Locale;

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
        Button record = findViewById(R.id.recordManual);
        record.setOnClickListener(v -> {
            String bib = manualBib.getText().toString().trim();
            if (bib.isEmpty()) return;
            RaceStore.Racer racer = store.racerByBib(bib);
            String epc;
            if (racer != null) {
                epc = racer.epc;
            } else {
                epc = "AA" + String.format(Locale.US, "%4s", bib).replace(' ', '0');
                store.upsertRacer(new RaceStore.Racer(epc, bib, getString(R.string.bib_n, bib), "", ""));
            }
            store.addPassing(new TagRead(epc, null, System.currentTimeMillis()));
            manualBib.setText("");
            Toast.makeText(this, "⏱ #" + bib, Toast.LENGTH_SHORT).show();
            refresh();
        });

        Button download = findViewById(R.id.downloadStartList);
        download.setOnClickListener(v -> downloadStartList(download));
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
                String body = new Uploader(prefs.serverUrl(), prefs.readerToken()).downloadStartList();
                JSONObject json = new JSONObject(body);
                prefs.saveTimingSettings(
                        json.optInt("suppress_secs", 10),
                        json.optInt("min_lap_gap_secs", 30),
                        json.getJSONObject("contest").optString("title", ""));
                JSONArray waves = json.getJSONArray("waves");
                for (int i = 0; i < waves.length(); i++) {
                    JSONObject w = waves.getJSONObject(i);
                    RaceStore.Wave local = store.wave(w.getString("name"));
                    // a locally recorded gun time always wins over the server's
                    if (local == null || local.startedAtMs == null) {
                        String at = w.isNull("started_at") ? null : w.getString("started_at");
                        store.upsertWave(w.getString("name"),
                                at == null ? null : parseIso(at), at != null);
                    }
                }
                JSONArray racers = json.getJSONArray("racers");
                for (int i = 0; i < racers.length(); i++) {
                    JSONObject r = racers.getJSONObject(i);
                    store.upsertRacer(new RaceStore.Racer(
                            r.getString("epc"), r.optString("bib", ""), r.optString("participant", ""),
                            r.optString("category", ""), r.isNull("wave") ? "" : r.optString("wave", "")));
                }
                message = getString(R.string.sync_done, racers.length(), waves.length());
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

    private static long parseIso(String iso) {
        try {
            java.text.SimpleDateFormat fmt =
                    new java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US);
            fmt.setTimeZone(java.util.TimeZone.getTimeZone("UTC"));
            return fmt.parse(iso).getTime();
        } catch (Exception e) {
            return System.currentTimeMillis();
        }
    }

    private void rebuildWaves() {
        wavesBox.removeAllViews();
        for (final RaceStore.Wave wave : store.waves()) {
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

        List<RaceEngine.Result> results = RaceEngine.compute(
                store.racers(), store.waves(), store.allPassings(),
                prefs.suppressSecs(), prefs.lapGapSecs());
        StringBuilder sb = new StringBuilder();
        sb.append(String.format(Locale.US, "%-4s %-5s %-16s %-4s %-9s %s%n",
                "#", getString(R.string.bib_col), getString(R.string.name_col),
                getString(R.string.laps_col), getString(R.string.time_col), ""));
        for (RaceEngine.Result r : results) {
            String status = "finished".equals(r.status) ? ""
                    : "on_course".equals(r.status) ? getString(R.string.on_course)
                    : getString(R.string.not_started_wave);
            sb.append(String.format(Locale.US, "%-4s %-5s %-16s %-4d %-9s %s%n",
                    r.rank > 0 ? String.valueOf(r.rank) : "–",
                    r.bib,
                    r.name.length() > 16 ? r.name.substring(0, 16) : r.name,
                    r.laps,
                    "finished".equals(r.status) ? RaceEngine.formatElapsed(r.elapsedMs) : "–",
                    status));
        }
        if (results.isEmpty()) sb.append(getString(R.string.no_racers));
        resultsView.setText(sb.toString());
    }

    @Override
    protected void onResume() {
        super.onResume();
        rebuildWaves();
        handler.post(ticker);
    }

    @Override
    protected void onPause() {
        super.onPause();
        handler.removeCallbacks(ticker);
    }
}

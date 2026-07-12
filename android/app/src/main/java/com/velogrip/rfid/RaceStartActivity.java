package com.velogrip.rfid;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import android.view.Gravity;
import android.view.View;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import com.velogrip.rfid.db.RaceStore;

import java.util.List;

/**
 * Race Start: the final screen before the live race. Race-clock adjustment
 * offsets the recorded gun time; timing mode and live results are stored
 * options. "Start race" records the gun (mass or per-wave, honouring the Race
 * Setup choice) and opens the race console.
 */
public class RaceStartActivity extends Activity {

    private Prefs prefs;
    private RaceStore store;
    private TextView clockValue, modeValue, liveValue;
    private long clockAdjustMs;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_race_start);
        prefs = new Prefs(this);
        store = new RaceStore(this);

        WizardNav.attach(this, WizardNav.RACE_START);
        findViewById(R.id.backButton).setOnClickListener(v -> finish());
        findViewById(R.id.nextButton).setVisibility(View.GONE); // Start race button instead

        clockValue = findViewById(R.id.clockValue);
        modeValue = findViewById(R.id.modeValue);
        liveValue = findViewById(R.id.liveValue);
        clockAdjustMs = prefs.clockAdjustMs();
        clockValue.setText(formatAdjust(clockAdjustMs));
        modeValue.setText(getString(R.string.mode_normal));
        liveValue.setText(getString(prefs.liveResults() ? R.string.on : R.string.off));

        findViewById(R.id.clockBox).setOnClickListener(v -> pickClockAdjust());
        findViewById(R.id.modeBox).setOnClickListener(v ->
                Toast.makeText(this, R.string.mode_only_normal, Toast.LENGTH_LONG).show());
        findViewById(R.id.liveBox).setOnClickListener(v -> {
            boolean next = !prefs.liveResults();
            prefs.setLiveResults(next);
            liveValue.setText(getString(next ? R.string.on : R.string.off));
        });

        findViewById(R.id.startRace).setOnClickListener(v -> startRace());

        findViewById(R.id.navSettings).setOnClickListener(v ->
                startActivity(new Intent(this, SettingsActivity.class)));
        findViewById(R.id.navDns).setOnClickListener(v ->
                startActivity(new Intent(this, StartListActivity.class)));
        findViewById(R.id.navPost).setOnClickListener(v ->
                Toast.makeText(this, R.string.post_unsupported, Toast.LENGTH_LONG).show());
        findViewById(R.id.navTest).setOnClickListener(v ->
                startActivity(new Intent(this, ChipTimingActivity.class)));
    }

    @Override
    protected void onResume() {
        super.onResume();
        renderRacers();
    }

    private void startRace() {
        boolean mass = !RaceSetupActivity.TYPE_WAVE.equals(prefs.startType());
        long gun = System.currentTimeMillis() + clockAdjustMs;
        if (mass) {
            store.startWave("", gun, true);
            for (RaceStore.Wave w : store.waves()) {
                if (!w.name.isEmpty()) store.startWave(w.name, gun, true);
            }
            Toast.makeText(this, R.string.race_started_mass, Toast.LENGTH_LONG).show();
            startActivity(new Intent(this, RaceActivity.class));
        } else {
            // wave races arm the gun per wave inside the console
            Toast.makeText(this, R.string.race_started_wave, Toast.LENGTH_LONG).show();
            startActivity(new Intent(this, RaceActivity.class));
        }
    }

    private void pickClockAdjust() {
        final String[] labels = {"0:00:00", "-0:00:05", "-0:00:10", "-0:00:30", "-0:01:00"};
        final long[] values = {0, -5000, -10000, -30000, -60000};
        new android.app.AlertDialog.Builder(this)
                .setTitle(R.string.race_clock_adjust)
                .setItems(labels, (d, which) -> {
                    clockAdjustMs = values[which];
                    prefs.setClockAdjustMs(clockAdjustMs);
                    clockValue.setText(formatAdjust(clockAdjustMs));
                })
                .show();
    }

    private static String formatAdjust(long ms) {
        long secs = Math.abs(ms) / 1000;
        String body = String.format(java.util.Locale.US, "%d:%02d:%02d",
                secs / 3600, (secs % 3600) / 60, secs % 60);
        return ms < 0 ? "-" + body : body;
    }

    private void renderRacers() {
        LinearLayout box = findViewById(R.id.racersBox);
        box.removeAllViews();
        List<RaceStore.Racer> racers = store.startListEntries();
        java.util.Collections.sort(racers, (a, b) -> Long.compare(bibNum(a.bib), bibNum(b.bib)));
        for (RaceStore.Racer r : racers) {
            LinearLayout row = new LinearLayout(this);
            row.setOrientation(LinearLayout.HORIZONTAL);
            row.setGravity(Gravity.CENTER_VERTICAL);
            row.setPadding(dp(12), dp(15), dp(12), dp(15));

            TextView bib = new TextView(this);
            bib.setText(r.bib);
            bib.setTextColor(0xFF111111);
            bib.setTextSize(19);
            bib.setTypeface(null, android.graphics.Typeface.BOLD);
            bib.setLayoutParams(new LinearLayout.LayoutParams(dp(64), LinearLayout.LayoutParams.WRAP_CONTENT));

            TextView name = new TextView(this);
            name.setText(r.name + (r.status.isEmpty() ? "" : "  (" + r.status + ")"));
            name.setTextColor(r.status.isEmpty() ? 0xFF111111 : 0xFF999999);
            name.setTextSize(18);
            name.setLayoutParams(new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f));

            row.addView(bib);
            row.addView(name);
            box.addView(row);

            View divider = new View(this);
            divider.setBackgroundColor(0xFFDDDDDD);
            divider.setLayoutParams(new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 1));
            box.addView(divider);
        }
        ((TextView) findViewById(R.id.startHint)).setText(getString(R.string.start_race_hint, racers.size()));
    }

    private static long bibNum(String bib) {
        try { return Long.parseLong(bib.replaceAll("[^0-9]", "")); }
        catch (NumberFormatException e) { return Long.MAX_VALUE; }
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        store.close();
    }
}

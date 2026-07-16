package com.velogrip.rfid;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import android.widget.Switch;
import android.widget.TextView;
import android.widget.Toast;

import com.velogrip.rfid.db.RaceStore;

/**
 * Lap setup: results per distance and lap recording. "Multiple distances"
 * defaults to on when the start list actually carries more than one distance;
 * "Record lap times" defaults to on. The relay/exclude/skip/rename options
 * mirror the reference screen but are not implemented yet.
 */
public class LapSetupActivity extends BaseActivity {

    private Prefs prefs;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_lap_setup);
        findViewById(R.id.navSettings).setOnClickListener(v -> startActivity(new android.content.Intent(this, SettingsActivity.class)));
        prefs = new Prefs(this);

        WizardNav.attach(this, WizardNav.LAP_SETUP);
        findViewById(R.id.backButton).setOnClickListener(v -> finish());
        findViewById(R.id.nextButton).setVisibility(android.view.View.VISIBLE);
        findViewById(R.id.nextButton).setOnClickListener(v ->
                startActivity(new Intent(this, DistanceSetupActivity.class)));

        Switch multi = findViewById(R.id.swMultiDistance);
        multi.setChecked(prefs.multiDistance(hasMultipleDistances()));
        multi.setOnCheckedChangeListener((b, on) -> prefs.setMultiDistance(on));

        Switch laps = findViewById(R.id.swRecordLaps);
        laps.setChecked(prefs.recordLaps());
        laps.setOnCheckedChangeListener((b, on) -> prefs.setRecordLaps(on));

        int[] unsupported = {R.id.swFixedRelay, R.id.swFlexibleRelay,
                R.id.swExcludeLaps, R.id.swSkipLaps, R.id.swCustomLapNames};
        for (int id : unsupported) {
            Switch sw = findViewById(id);
            sw.setOnCheckedChangeListener((b, on) -> {
                if (on) {
                    b.setChecked(false);
                    Toast.makeText(this, R.string.lap_option_unsupported, Toast.LENGTH_LONG).show();
                }
            });
        }
    }

    private boolean hasMultipleDistances() {
        RaceStore store = new RaceStore(this);
        java.util.HashSet<String> distances = new java.util.HashSet<>();
        for (RaceStore.Racer r : store.racers()) {
            if (!r.distance.isEmpty()) distances.add(r.distance);
        }
        store.close();
        return distances.size() > 1;
    }
}

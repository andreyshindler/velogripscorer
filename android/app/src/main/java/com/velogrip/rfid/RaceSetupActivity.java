package com.velogrip.rfid;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import android.widget.EditText;
import android.widget.TextView;
import android.widget.Toast;

import com.velogrip.rfid.db.RaceStore;

/**
 * Race setup after a start list is selected: confirm the race name and pick
 * how the field starts. Mass = one gun for everyone; Wave = per-wave guns.
 */
public class RaceSetupActivity extends Activity {

    public static final String TYPE_MASS = "mass";
    public static final String TYPE_WAVE = "wave";

    private Prefs prefs;
    private TextView mass, wave, individual, interval, pursuit;
    private String selected = TYPE_MASS;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_race_setup);
        prefs = new Prefs(this);

        ((TextView) findViewById(R.id.headerTitle)).setText(R.string.race_setup_title);
        findViewById(R.id.backButton).setOnClickListener(v -> finish());
        findViewById(R.id.nextButton).setVisibility(android.view.View.VISIBLE);
        findViewById(R.id.nextButton).setOnClickListener(v -> {
            prefs.setStartType(selected);
            startActivity(new Intent(this, RaceActivity.class));
        });

        TextView name = findViewById(R.id.raceName);
        name.setText(prefs.contestTitle());
        findViewById(R.id.editName).setOnClickListener(v -> {
            EditText input = new EditText(this);
            input.setText(prefs.contestTitle());
            input.setSelection(input.getText().length());
            new android.app.AlertDialog.Builder(this)
                    .setTitle(R.string.race_name_label)
                    .setView(input)
                    .setPositiveButton(android.R.string.ok, (d, w) -> {
                        prefs.setContestTitle(input.getText().toString());
                        name.setText(prefs.contestTitle());
                    })
                    .setNegativeButton(android.R.string.cancel, null)
                    .show();
        });

        mass = findViewById(R.id.typeMass);
        wave = findViewById(R.id.typeWave);
        individual = findViewById(R.id.typeIndividual);
        interval = findViewById(R.id.typeInterval);
        pursuit = findViewById(R.id.typePursuit);

        // pre-select from saved choice, else from the start list's shape
        String saved = prefs.startType();
        if (saved.isEmpty()) {
            RaceStore store = new RaceStore(this);
            saved = store.waves().size() > 1 ? TYPE_WAVE : TYPE_MASS;
            store.close();
        }
        select(TYPE_WAVE.equals(saved) ? TYPE_WAVE : TYPE_MASS);

        mass.setOnClickListener(v -> select(TYPE_MASS));
        wave.setOnClickListener(v -> select(TYPE_WAVE));
        android.view.View.OnClickListener unsupported = v ->
                Toast.makeText(this, R.string.start_type_unsupported, Toast.LENGTH_LONG).show();
        individual.setOnClickListener(unsupported);
        interval.setOnClickListener(unsupported);
        pursuit.setOnClickListener(unsupported);
    }

    private void select(String type) {
        selected = type;
        prefs.setStartType(type);
        style(mass, TYPE_MASS.equals(type));
        style(wave, TYPE_WAVE.equals(type));
        style(individual, false);
        style(interval, false);
        style(pursuit, false);
    }

    private void style(TextView button, boolean on) {
        button.setBackgroundResource(on ? R.drawable.bg_segment_on : R.drawable.bg_segment);
        button.setTextColor(on ? 0xFFFFFFFF : 0xFF777777);
    }
}

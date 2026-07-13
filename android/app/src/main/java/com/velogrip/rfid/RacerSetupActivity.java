package com.velogrip.rfid;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import android.view.View;
import android.widget.Switch;
import android.widget.TextView;
import android.widget.Toast;

/**
 * Racer setup: which fields each racer requires and the bib format. Name /
 * Bib / Category / Gender and the Numeric-vs-Alphanumeric bib type are stored
 * and drive the standings columns and the manual-entry keyboard. Age / Year /
 * 3rd gender / check-in mirror the reference but are not wired up yet.
 */
public class RacerSetupActivity extends Activity {

    private Prefs prefs;
    private TextView numeric, alpha;
    private boolean alphaSelected;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_racer_setup);
        findViewById(R.id.navSettings).setOnClickListener(v -> startActivity(new android.content.Intent(this, SettingsActivity.class)));
        prefs = new Prefs(this);

        WizardNav.attach(this, WizardNav.RACER_SETUP);
        findViewById(R.id.backButton).setOnClickListener(v -> finish());
        findViewById(R.id.nextButton).setVisibility(View.VISIBLE);
        findViewById(R.id.nextButton).setOnClickListener(v -> {
            save();
            startActivity(new Intent(this, ResultsOptionsActivity.class));
        });

        ((Switch) findViewById(R.id.swName)).setChecked(prefs.requireName());
        ((Switch) findViewById(R.id.swBib)).setChecked(prefs.requireBib());
        ((Switch) findViewById(R.id.swCategory)).setChecked(prefs.requireCategory());
        ((Switch) findViewById(R.id.swGender)).setChecked(prefs.requireGender());

        numeric = findViewById(R.id.typeNumeric);
        alpha = findViewById(R.id.typeAlpha);
        setBibType(prefs.bibAlphanumeric());
        numeric.setOnClickListener(v -> setBibType(false));
        alpha.setOnClickListener(v -> setBibType(true));

        int[] unsupported = {R.id.swAge, R.id.swYear, R.id.swThirdGender, R.id.swCheckin};
        for (int id : unsupported) {
            Switch sw = findViewById(id);
            sw.setOnCheckedChangeListener((b, on) -> {
                if (on) {
                    b.setChecked(false);
                    Toast.makeText(this, R.string.racer_field_unsupported, Toast.LENGTH_LONG).show();
                }
            });
        }
    }

    private void setBibType(boolean useAlpha) {
        alphaSelected = useAlpha;
        style(numeric, !useAlpha);
        style(alpha, useAlpha);
    }

    private void style(TextView button, boolean on) {
        button.setBackgroundResource(on ? R.drawable.bg_segment_on : R.drawable.bg_segment);
        button.setTextColor(on ? 0xFFFFFFFF : 0xFF777777);
    }

    private void save() {
        prefs.setRacerSetup(
                ((Switch) findViewById(R.id.swName)).isChecked(),
                ((Switch) findViewById(R.id.swBib)).isChecked(),
                alphaSelected,
                ((Switch) findViewById(R.id.swCategory)).isChecked(),
                ((Switch) findViewById(R.id.swGender)).isChecked());
    }
}

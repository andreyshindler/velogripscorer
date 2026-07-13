package com.velogrip.rfid;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import android.view.View;
import android.widget.Switch;
import android.widget.TextView;
import android.widget.Toast;

/**
 * Results Options — how the standings are ordered and shown. Results-ordered-by
 * and timing precision drive the live standings; category / overall-by-distance
 * / overall-by-gender toggles are persisted and split the standings. Exclude
 * top-x, team scoring, penalties and handicaps mirror the reference but are not
 * implemented yet.
 */
public class ResultsOptionsActivity extends Activity {

    private Prefs prefs;
    private TextView orderValue, precisionValue;
    private String order;
    private int decimals;

    private static final String[] ORDER_KEYS = {Prefs.ORDER_TIME, Prefs.ORDER_BIB, Prefs.ORDER_NAME};

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_results_options);
        findViewById(R.id.navSettings).setOnClickListener(v -> startActivity(new android.content.Intent(this, SettingsActivity.class)));
        prefs = new Prefs(this);

        WizardNav.attach(this, WizardNav.RESULTS_OPTIONS);
        findViewById(R.id.backButton).setOnClickListener(v -> finish());
        findViewById(R.id.nextButton).setVisibility(View.VISIBLE);
        findViewById(R.id.nextButton).setOnClickListener(v -> {
            save();
            startActivity(new Intent(this, HardwareSetupActivity.class));
        });

        orderValue = findViewById(R.id.orderValue);
        precisionValue = findViewById(R.id.precisionValue);
        order = prefs.resultsOrder();
        decimals = prefs.timingDecimals();
        orderValue.setText(orderLabel(order));
        precisionValue.setText(precisionLabel(decimals));

        findViewById(R.id.orderBox).setOnClickListener(v -> {
            String[] labels = {getString(R.string.order_time), getString(R.string.order_bib),
                    getString(R.string.order_name)};
            int current = 0;
            for (int i = 0; i < ORDER_KEYS.length; i++) if (ORDER_KEYS[i].equals(order)) current = i;
            new android.app.AlertDialog.Builder(this)
                    .setTitle(R.string.results_ordered_by)
                    .setSingleChoiceItems(labels, current, (d, which) -> {
                        order = ORDER_KEYS[which];
                        orderValue.setText(labels[which]);
                        d.dismiss();
                    })
                    .setNegativeButton(android.R.string.cancel, null)
                    .show();
        });

        findViewById(R.id.precisionBox).setOnClickListener(v -> {
            String[] labels = {getString(R.string.precision_1s), getString(R.string.precision_01),
                    getString(R.string.precision_001), getString(R.string.precision_0001)};
            new android.app.AlertDialog.Builder(this)
                    .setTitle(R.string.timing_precision)
                    .setSingleChoiceItems(labels, decimals, (d, which) -> {
                        decimals = which;
                        precisionValue.setText(labels[which]);
                        d.dismiss();
                    })
                    .setNegativeButton(android.R.string.cancel, null)
                    .show();
        });

        ((Switch) findViewById(R.id.swCategory)).setChecked(prefs.categoryResults());
        ((Switch) findViewById(R.id.swByDistance)).setChecked(prefs.overallByDistance());
        ((Switch) findViewById(R.id.swByGender)).setChecked(prefs.overallByGender());
        ((Switch) findViewById(R.id.swAllDistances)).setChecked(prefs.overallAllDistances());

        int[] unsupported = {R.id.swExcludeTop, R.id.swTeamScoring, R.id.swPenalties, R.id.swHandicaps};
        for (int id : unsupported) {
            Switch sw = findViewById(id);
            sw.setOnCheckedChangeListener((b, on) -> {
                if (on) {
                    b.setChecked(false);
                    Toast.makeText(this, R.string.results_option_unsupported, Toast.LENGTH_LONG).show();
                }
            });
        }
    }

    private void save() {
        prefs.saveResultsOptions(order, decimals,
                ((Switch) findViewById(R.id.swCategory)).isChecked(),
                ((Switch) findViewById(R.id.swByDistance)).isChecked(),
                ((Switch) findViewById(R.id.swByGender)).isChecked(),
                ((Switch) findViewById(R.id.swAllDistances)).isChecked());
    }

    private String orderLabel(String key) {
        if (Prefs.ORDER_BIB.equals(key)) return getString(R.string.order_bib);
        if (Prefs.ORDER_NAME.equals(key)) return getString(R.string.order_name);
        return getString(R.string.order_time);
    }

    private String precisionLabel(int d) {
        switch (d) {
            case 0: return getString(R.string.precision_1s);
            case 2: return getString(R.string.precision_001);
            case 3: return getString(R.string.precision_0001);
            default: return getString(R.string.precision_01);
        }
    }
}

package com.velogrip.rfid;

import android.app.Activity;
import android.os.Bundle;
import android.view.Gravity;
import android.view.View;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import com.velogrip.rfid.db.RaceStore;

/**
 * Full-screen lap-count picker (Webscorer-style): X cancels, ✓ confirms.
 * "Time-limited" is shown to match the reference but not supported yet.
 */
public class SelectLapCountActivity extends Activity {

    public static final String EXTRA_DISTANCE = "distance";
    private static final int MAX_LAPS = 50;

    private int selected = 1;
    private LinearLayout box;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_select_lap_count);
        findViewById(R.id.navSettings).setOnClickListener(v -> startActivity(new android.content.Intent(this, SettingsActivity.class)));
        final String distance = getIntent().getStringExtra(EXTRA_DISTANCE) == null
                ? "" : getIntent().getStringExtra(EXTRA_DISTANCE);

        ((TextView) findViewById(R.id.headerTitle)).setText(R.string.select_lap_count);
        TextView cancel = findViewById(R.id.backButton);
        cancel.setText("✕");
        cancel.setOnClickListener(v -> finish());
        TextView confirm = findViewById(R.id.nextButton);
        confirm.setText("✓");
        confirm.setVisibility(View.VISIBLE);
        confirm.setOnClickListener(v -> {
            RaceStore store = new RaceStore(this);
            store.setLaps(distance, selected);
            store.close();
            finish();
        });

        RaceStore store = new RaceStore(this);
        selected = store.lapsFor(distance);
        store.close();

        box = findViewById(R.id.lapOptions);
        addOption(getString(R.string.time_limited), 0);
        for (int laps = 1; laps <= MAX_LAPS; laps++) {
            addOption(laps == 1 ? getString(R.string.lap_1) : getString(R.string.laps_n, laps), laps);
        }
        rebuildChecks();
    }

    private void addOption(String label, final int laps) {
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL);
        row.setPadding(dp(16), dp(16), dp(16), dp(16));
        android.util.TypedValue tv = new android.util.TypedValue();
        getTheme().resolveAttribute(android.R.attr.selectableItemBackground, tv, true);
        row.setBackgroundResource(tv.resourceId);

        TextView text = new TextView(this);
        text.setText(label);
        text.setTextColor(0xFF111111);
        text.setTextSize(18);
        text.setLayoutParams(new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f));

        TextView check = new TextView(this);
        check.setTag("check:" + laps);
        check.setText("✓");
        check.setTextColor(0xFF76B82A);
        check.setTextSize(18);
        check.setTypeface(null, android.graphics.Typeface.BOLD);

        row.addView(text);
        row.addView(check);
        row.setOnClickListener(v -> {
            if (laps == 0) {
                Toast.makeText(this, R.string.lap_option_unsupported, Toast.LENGTH_LONG).show();
                return;
            }
            selected = laps;
            rebuildChecks();
        });
        box.addView(row);

        View divider = new View(this);
        divider.setBackgroundColor(0xFFDDDDDD);
        divider.setLayoutParams(new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, 1));
        box.addView(divider);
    }

    private void rebuildChecks() {
        for (int laps = 0; laps <= MAX_LAPS; laps++) {
            View check = box.findViewWithTag("check:" + laps);
            if (check != null) check.setVisibility(laps == selected ? View.VISIBLE : View.INVISIBLE);
        }
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }
}

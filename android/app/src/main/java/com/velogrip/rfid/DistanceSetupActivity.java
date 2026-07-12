package com.velogrip.rfid;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import android.view.Gravity;
import android.view.View;
import android.widget.LinearLayout;
import android.widget.TextView;

import com.velogrip.rfid.db.RaceStore;

import java.util.LinkedHashSet;

/**
 * Distance setup: every distance in the start list with the lap count a
 * racer of that distance must complete. Tapping a row opens the lap-count
 * picker. Races without distances get a single row for the whole field.
 */
public class DistanceSetupActivity extends Activity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_distance_setup);

        WizardNav.attach(this, WizardNav.DISTANCE_SETUP);
        findViewById(R.id.backButton).setOnClickListener(v -> finish());
        findViewById(R.id.nextButton).setVisibility(View.VISIBLE);
        findViewById(R.id.nextButton).setOnClickListener(v ->
                startActivity(new Intent(this, CategorySetupActivity.class)));
    }

    @Override
    protected void onResume() {
        super.onResume();
        render();
    }

    private void render() {
        LinearLayout box = findViewById(R.id.distancesBox);
        box.removeAllViews();
        RaceStore store = new RaceStore(this);
        LinkedHashSet<String> distances = new LinkedHashSet<>();
        for (RaceStore.Racer r : store.racers()) {
            if (!r.distance.isEmpty()) distances.add(r.distance);
        }
        if (distances.isEmpty()) distances.add(""); // whole race, one lap target

        for (final String distance : distances) {
            int laps = store.lapsFor(distance);

            LinearLayout row = new LinearLayout(this);
            row.setOrientation(LinearLayout.HORIZONTAL);
            row.setGravity(Gravity.CENTER_VERTICAL);
            row.setPadding(dp(12), dp(16), dp(12), dp(16));
            android.util.TypedValue tv = new android.util.TypedValue();
            getTheme().resolveAttribute(android.R.attr.selectableItemBackground, tv, true);
            row.setBackgroundResource(tv.resourceId);

            TextView check = new TextView(this);
            check.setText("✓");
            check.setTextColor(0xFF76B82A);
            check.setTextSize(18);
            check.setTypeface(null, android.graphics.Typeface.BOLD);
            check.setLayoutParams(new LinearLayout.LayoutParams(dp(34), LinearLayout.LayoutParams.WRAP_CONTENT));

            TextView name = new TextView(this);
            name.setText(distance.isEmpty() ? getString(R.string.mass_race_label) : distance);
            name.setTextColor(0xFF111111);
            name.setTextSize(19);
            name.setTypeface(null, android.graphics.Typeface.BOLD);
            name.setLayoutParams(new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f));

            TextView lapCount = new TextView(this);
            lapCount.setText(String.valueOf(laps));
            lapCount.setTextColor(0xFF111111);
            lapCount.setTextSize(19);
            lapCount.setPadding(0, 0, dp(18), 0);

            TextView chevron = new TextView(this);
            chevron.setText("❯");
            chevron.setTextColor(0xFF76B82A);
            chevron.setTextSize(16);
            chevron.setTypeface(null, android.graphics.Typeface.BOLD);
            chevron.setBackgroundResource(R.drawable.bg_chevron);
            chevron.setPadding(dp(10), dp(4), dp(10), dp(4));

            row.addView(check);
            row.addView(name);
            row.addView(lapCount);
            row.addView(chevron);
            row.setOnClickListener(v -> {
                Intent pick = new Intent(this, SelectLapCountActivity.class);
                pick.putExtra(SelectLapCountActivity.EXTRA_DISTANCE, distance);
                startActivity(pick);
            });
            box.addView(row);

            View divider = new View(this);
            divider.setBackgroundColor(0xFFDDDDDD);
            divider.setLayoutParams(new LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.MATCH_PARENT, 1));
            box.addView(divider);
        }
        store.close();

        ((TextView) findViewById(R.id.distanceHint)).setText(
                getString(R.string.distances_hint, distances.size()));
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }
}

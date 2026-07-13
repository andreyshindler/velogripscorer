package com.velogrip.rfid;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import android.view.Gravity;
import android.view.View;
import android.widget.LinearLayout;
import android.widget.TextView;

import com.velogrip.rfid.db.RaceStore;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Race Progress: a per-distance breakdown of how the race is going — for each
 * distance (5k, 10k, …) the total racers, how many have finished, and how many
 * are still on course. Numbers are computed live from RFID reads and manual
 * taps. Tapping a Finished / On course row returns to the timing finish list.
 */
public class RaceProgressActivity extends Activity {

    private RaceStore store;
    private LinearLayout box;
    private Prefs prefs;

    private static final class Tally {
        int total, finished, onCourse;
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_race_progress);
        store = new RaceStore(this);
        prefs = new Prefs(this);
        box = findViewById(R.id.progressBox);

        findViewById(R.id.backButton).setOnClickListener(v -> finish());
        findViewById(R.id.pRefresh).setOnClickListener(v -> render());
        findViewById(R.id.pHelp).setOnClickListener(v ->
                new android.app.AlertDialog.Builder(this)
                        .setTitle(R.string.race_progress_title)
                        .setMessage(R.string.race_progress_help)
                        .setPositiveButton(android.R.string.ok, null)
                        .show());
    }

    @Override
    protected void onResume() {
        super.onResume();
        render();
    }

    private void render() {
        box.removeAllViews();
        List<RaceEngine.Result> results = RaceEngine.compute(
                store.racers(), store.waves(), store.allPassings(),
                prefs.suppressSecs(), prefs.lapGapSecs(), prefs.recordLaps(), store.lapTargets(),
                prefs.raceFinalized());

        // Tally per distance, keeping first-seen order then sorting by km.
        Map<String, Tally> byDist = new LinkedHashMap<>();
        for (RaceEngine.Result r : results) {
            String d = r.distance == null || r.distance.isEmpty()
                    ? getString(R.string.no_distance) : r.distance;
            Tally t = byDist.get(d);
            if (t == null) { t = new Tally(); byDist.put(d, t); }
            t.total++;
            if ("finished".equals(r.status)) t.finished++;
            else if ("on_course".equals(r.status)) t.onCourse++;
        }

        List<String> dists = new java.util.ArrayList<>(byDist.keySet());
        java.util.Collections.sort(dists, (a, b) -> Long.compare(km(a), km(b)));

        if (dists.isEmpty()) {
            TextView empty = new TextView(this);
            empty.setText(R.string.no_racers);
            empty.setPadding(dp(16), dp(24), dp(16), dp(24));
            empty.setTextColor(0xFF777777);
            empty.setTextSize(16);
            box.addView(empty);
            return;
        }

        String noDistance = getString(R.string.no_distance);
        for (String d : dists) {
            Tally t = byDist.get(d);
            // The tally key is the display label; the underlying racer distance
            // is "" when it was blank, so map it back for filtering.
            String rawDist = d.equals(noDistance) ? "" : d;
            box.addView(sectionHeader(d));
            box.addView(statRow(getString(R.string.total_racers), t.total, null, null));
            box.addView(divider());
            box.addView(statRow(getString(R.string.finished_label), t.finished, rawDist, "finished"));
            box.addView(divider());
            box.addView(statRow(getString(R.string.on_course_label), t.onCourse, rawDist, "on_course"));
        }
    }

    private void openList(String distance, String status) {
        startActivity(new Intent(this, ProgressListActivity.class)
                .putExtra(ProgressListActivity.EXTRA_DISTANCE, distance)
                .putExtra(ProgressListActivity.EXTRA_STATUS, status));
    }

    private View sectionHeader(String distance) {
        TextView h = new TextView(this);
        h.setText(distance);
        h.setBackgroundColor(0xFFBFBFBF);
        h.setTextColor(0xFF222222);
        h.setTextSize(18);
        h.setTypeface(null, android.graphics.Typeface.BOLD);
        h.setPadding(dp(14), dp(10), dp(14), dp(10));
        return h;
    }

    private View statRow(String label, int count, String distance, String status) {
        boolean chevron = status != null;
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL);
        row.setPadding(dp(16), dp(18), dp(16), dp(18));

        TextView num = new TextView(this);
        num.setText(String.valueOf(count));
        num.setTextColor(0xFF111111);
        num.setTextSize(22);
        num.setTypeface(null, android.graphics.Typeface.BOLD);
        num.setLayoutParams(new LinearLayout.LayoutParams(dp(56), LinearLayout.LayoutParams.WRAP_CONTENT));

        TextView name = new TextView(this);
        name.setText(label);
        name.setTextColor(0xFF333333);
        name.setTextSize(18);
        name.setLayoutParams(new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f));

        row.addView(num);
        row.addView(name);

        if (chevron) {
            TextView ch = new TextView(this);
            ch.setText("❯");
            ch.setTextColor(0xFF76B82A);
            ch.setTextSize(15);
            ch.setTypeface(null, android.graphics.Typeface.BOLD);
            ch.setBackgroundResource(R.drawable.bg_chevron);
            ch.setPadding(dp(9), dp(4), dp(9), dp(4));
            row.addView(ch);
            android.util.TypedValue tv = new android.util.TypedValue();
            getTheme().resolveAttribute(android.R.attr.selectableItemBackground, tv, true);
            row.setBackgroundResource(tv.resourceId);
            row.setOnClickListener(v -> openList(distance, status));
        }
        return row;
    }

    private View divider() {
        View v = new View(this);
        v.setBackgroundColor(0xFFEEEEEE);
        v.setLayoutParams(new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 1));
        return v;
    }

    /** Numeric km for sorting distances (e.g. "10k" -> 10). Non-numeric sinks last. */
    private static long km(String d) {
        java.util.regex.Matcher m = java.util.regex.Pattern.compile("\\d+").matcher(d);
        return m.find() ? Long.parseLong(m.group()) : Long.MAX_VALUE;
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

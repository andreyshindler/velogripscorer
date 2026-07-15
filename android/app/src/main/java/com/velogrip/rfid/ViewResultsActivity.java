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
import java.util.List;

/**
 * View Results — shown after the race is finished. Results are grouped by
 * distance; each distance offers an "Overall" ranking plus one ranking per
 * category. Tapping a row (❯) opens that segment's ranked finishers. The Share
 * button opens Post Results to publish to the web.
 */
public class ViewResultsActivity extends BaseActivity {

    private Prefs prefs;
    private RaceStore store;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_view_results);
        prefs = new Prefs(this);
        store = new RaceStore(this);

        String contest = prefs.contestTitle();
        ((TextView) findViewById(R.id.subTitle)).setText(
                contest.isEmpty() ? getString(R.string.race_title) : contest);

        findViewById(R.id.homeButton).setOnClickListener(v -> goHome());
        findViewById(R.id.shareButton).setOnClickListener(v -> openPostResults());
        findViewById(R.id.aShare).setOnClickListener(v -> openPostResults());
        findViewById(R.id.aResultsOpt).setOnClickListener(v ->
                startActivity(new Intent(this, ResultsOptionsActivity.class)));
        findViewById(R.id.aStartList).setOnClickListener(v ->
                startActivity(new Intent(this, StartListActivity.class)));
    }

    @Override
    protected void onResume() {
        super.onResume();
        render();
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        if (store != null) store.close();
    }

    private void goHome() {
        Intent i = new Intent(this, MainActivity.class);
        i.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        startActivity(i);
    }

    private void openPostResults() {
        startActivity(new Intent(this, PostResultsActivity.class));
    }

    private List<RaceEngine.Result> compute() {
        return RaceEngine.compute(
                store.racers(), store.waves(), store.allPassings(),
                prefs.suppressSecs(), prefs.lapGapSecs(), prefs.recordLaps(),
                store.lapTargets(), prefs.raceFinalized());
    }

    private void render() {
        LinearLayout list = findViewById(R.id.resultsList);
        list.removeAllViews();
        List<RaceEngine.Result> results = compute();

        if (results.isEmpty()) {
            TextView empty = new TextView(this);
            empty.setText(R.string.archive_empty);
            empty.setTextSize(16);
            empty.setPadding(dp(16), dp(16), dp(16), dp(16));
            list.addView(empty);
            return;
        }

        // Distances in the order they first appear (empty distance => single group).
        LinkedHashSet<String> distances = new LinkedHashSet<>();
        for (RaceEngine.Result r : results) distances.add(r.distance);

        for (String distance : distances) {
            String label = distance.isEmpty() ? getString(R.string.all_racers) : distance;
            list.addView(sectionHeader(label));

            // Overall for this distance.
            list.addView(segmentRow(getString(R.string.overall), () -> openSegment(distance, "", "")));

            // Female / Male overall, when the roster carries gender.
            boolean hasFemale = false, hasMale = false;
            for (RaceEngine.Result r : results) {
                if (!r.distance.equals(distance)) continue;
                if (isFemale(r.gender)) hasFemale = true;
                else if (isMale(r.gender)) hasMale = true;
            }
            if (hasFemale) list.addView(segmentRow(getString(R.string.gender_female), () -> openSegment(distance, "", "F")));
            if (hasMale) list.addView(segmentRow(getString(R.string.gender_male), () -> openSegment(distance, "", "M")));

            // One row per category present in this distance.
            LinkedHashSet<String> cats = new LinkedHashSet<>();
            for (RaceEngine.Result r : results) {
                if (r.distance.equals(distance) && !r.category.isEmpty()) cats.add(r.category);
            }
            for (String cat : cats) {
                list.addView(segmentRow(cat, () -> openSegment(distance, cat, "")));
            }
        }
    }

    static boolean isFemale(String g) {
        if (g == null) return false;
        String s = g.trim().toLowerCase(java.util.Locale.ROOT);
        return s.equals("f") || s.equals("female") || s.equals("נקבה") || s.equals("אישה");
    }

    static boolean isMale(String g) {
        if (g == null) return false;
        String s = g.trim().toLowerCase(java.util.Locale.ROOT);
        return s.equals("m") || s.equals("male") || s.equals("זכר") || s.equals("גבר");
    }

    /** Open the segment's ranked racers on their own screen (SegmentResults). */
    private void openSegment(String distance, String category, String gender) {
        Intent i = new Intent(this, SegmentResultsActivity.class);
        i.putExtra(SegmentResultsActivity.EXTRA_DISTANCE, distance);
        i.putExtra(SegmentResultsActivity.EXTRA_CATEGORY, category);
        i.putExtra(SegmentResultsActivity.EXTRA_GENDER, gender);
        startActivity(i);
    }

    private TextView sectionHeader(String label) {
        TextView tv = new TextView(this);
        tv.setText(label);
        tv.setTextSize(16);
        tv.setTextColor(getColor(R.color.text_primary));
        tv.setTypeface(null, android.graphics.Typeface.BOLD);
        tv.setBackgroundColor(0xFFBFBFBF);
        tv.setPadding(dp(12), dp(8), dp(12), dp(8));
        return tv;
    }

    /** Tappable row with a green ❯ chevron, matching the live console rows. */
    private View segmentRow(String label, Runnable onTap) {
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL);
        row.setPadding(dp(16), dp(14), dp(12), dp(14));
        row.setBackgroundColor(getColor(R.color.surface));

        TextView tv = new TextView(this);
        tv.setText(label);
        tv.setTextSize(17);
        tv.setTextColor(getColor(R.color.text_primary));
        // Align every label to the row's start edge so Hebrew categories
        // (e.g. "עד 44") line up in the same column as the English ones
        // instead of jumping to the right.
        tv.setTextAlignment(View.TEXT_ALIGNMENT_VIEW_START);
        tv.setLayoutParams(new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f));
        row.addView(tv);

        TextView chevron = new TextView(this);
        chevron.setText("❯");
        chevron.setTextColor(0xFF76B82A);
        chevron.setTextSize(15);
        chevron.setBackgroundResource(R.drawable.bg_chevron);
        chevron.setPadding(dp(9), dp(3), dp(9), dp(3));
        row.addView(chevron);

        row.setOnClickListener(v -> onTap.run());

        // hairline divider under each row
        LinearLayout wrap = new LinearLayout(this);
        wrap.setOrientation(LinearLayout.VERTICAL);
        wrap.addView(row);
        View div = new View(this);
        div.setLayoutParams(new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 1));
        div.setBackgroundColor(0xFFDDDDDD);
        wrap.addView(div);
        return wrap;
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }
}

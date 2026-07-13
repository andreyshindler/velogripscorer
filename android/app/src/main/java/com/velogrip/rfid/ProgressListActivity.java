package com.velogrip.rfid;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import android.view.Gravity;
import android.view.View;
import android.widget.LinearLayout;
import android.widget.TextView;

import com.velogrip.rfid.db.RaceStore;

import java.util.List;

/**
 * The racer list behind a Race Progress arrow: every racer of one distance
 * with one status (finished or on course), shown as bib + name. Reached by
 * tapping the ❯ on a distance's Finished / On course row.
 */
public class ProgressListActivity extends Activity {

    public static final String EXTRA_DISTANCE = "distance";
    public static final String EXTRA_STATUS = "status"; // "finished" | "on_course"

    private RaceStore store;
    private Prefs prefs;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_progress_list);
        store = new RaceStore(this);
        prefs = new Prefs(this);

        findViewById(R.id.backButton).setOnClickListener(v -> finish());
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
        Intent in = getIntent();
        String distance = in.getStringExtra(EXTRA_DISTANCE);
        String status = in.getStringExtra(EXTRA_STATUS);
        if (distance == null) distance = "";
        boolean finished = "finished".equals(status);

        String statusLabel = getString(finished ? R.string.finished_label : R.string.on_course_label);
        ((TextView) findViewById(R.id.listTitle)).setText(statusLabel);

        String distLabel = distance.isEmpty() ? getString(R.string.no_distance) : distance;

        LinearLayout box = findViewById(R.id.listBox);
        box.removeAllViews();

        List<RaceEngine.Result> results = RaceEngine.compute(
                store.racers(), store.waves(), store.allPassings(),
                prefs.suppressSecs(), prefs.lapGapSecs(), prefs.recordLaps(), store.lapTargets(),
                prefs.raceFinalized());

        int shown = 0;
        for (RaceEngine.Result r : results) {
            if (!status.equals(r.status)) continue;
            String d = r.distance == null ? "" : r.distance;
            if (!d.equals(distance)) continue;
            box.addView(row(r.bib, r.name));
            box.addView(divider());
            shown++;
        }

        if (shown == 0) {
            TextView empty = new TextView(this);
            empty.setText(finished ? R.string.no_finishers_yet : R.string.no_on_course);
            empty.setPadding(dp(16), dp(24), dp(16), dp(24));
            empty.setTextColor(0xFF777777);
            empty.setTextSize(16);
            box.addView(empty);
        }

        ((TextView) findViewById(R.id.listFooter))
                .setText(getString(R.string.progress_list_footer, distLabel, statusLabel));
    }

    private View row(String bib, String name) {
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL);
        row.setPadding(dp(12), dp(16), dp(12), dp(16));

        TextView b = new TextView(this);
        b.setText(bib);
        b.setTextColor(0xFF111111);
        b.setTextSize(19);
        b.setTypeface(null, android.graphics.Typeface.BOLD);
        b.setLayoutParams(new LinearLayout.LayoutParams(dp(64), LinearLayout.LayoutParams.WRAP_CONTENT));

        TextView n = new TextView(this);
        n.setText(name);
        n.setTextColor(0xFF111111);
        n.setTextSize(18);
        n.setLayoutParams(new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f));

        row.addView(b);
        row.addView(n);
        return row;
    }

    private View divider() {
        View v = new View(this);
        v.setBackgroundColor(0xFFDDDDDD);
        v.setLayoutParams(new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 1));
        return v;
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

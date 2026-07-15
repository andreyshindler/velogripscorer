package com.velogrip.rfid;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import android.view.View;
import android.widget.LinearLayout;
import android.widget.TextView;

import com.velogrip.rfid.db.RaceStore;

import java.util.List;
import java.util.Locale;

/**
 * Race archive: the race data stored on this phone. The store keeps one race
 * at a time (switching races in "Download races" clears it), so the archive
 * shows that race's summary and final standings.
 */
public class RaceArchiveActivity extends BaseActivity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_archive);
        if (getActionBar() != null) getActionBar().setDisplayHomeAsUpEnabled(true);
    }

    @Override
    public boolean onOptionsItemSelected(android.view.MenuItem item) {
        if (item.getItemId() == android.R.id.home) { finish(); return true; }
        return super.onOptionsItemSelected(item);
    }

    @Override
    protected void onResume() {
        super.onResume();
        render();
    }

    private void render() {
        LinearLayout box = findViewById(R.id.archiveBox);
        box.removeAllViews();
        Prefs prefs = new Prefs(this);
        RaceStore store = new RaceStore(this);
        List<RaceStore.Racer> racers = store.racers();
        long passings = store.passingCount();

        if (racers.isEmpty() && passings == 0) {
            TextView empty = new TextView(this);
            empty.setText(R.string.archive_empty);
            empty.setTextSize(16);
            box.addView(empty);
            store.close();
            return;
        }

        TextView title = new TextView(this);
        String contest = prefs.contestTitle();
        title.setText(contest.isEmpty() ? getString(R.string.race_title) : contest);
        title.setTextSize(20);
        title.setTypeface(null, android.graphics.Typeface.BOLD);
        box.addView(title);

        // people, not chips: rows sharing a bib are one racer
        java.util.HashSet<String> distinct = new java.util.HashSet<>();
        for (RaceStore.Racer r : racers) {
            distinct.add(r.bib.isEmpty() ? "e:" + r.epc : "b:" + r.bib);
        }
        TextView counts = new TextView(this);
        counts.setText(getString(R.string.archive_counts,
                distinct.size(), store.waves().size(), passings));
        counts.setTextSize(14);
        counts.setPadding(0, 4, 0, 12);
        box.addView(counts);

        TextView standingsHeader = new TextView(this);
        standingsHeader.setText(R.string.standings);
        standingsHeader.setTypeface(null, android.graphics.Typeface.BOLD);
        box.addView(standingsHeader);

        List<RaceEngine.Result> results = RaceEngine.compute(
                racers, store.waves(), store.allPassings(),
                prefs.suppressSecs(), prefs.lapGapSecs(), prefs.recordLaps(),
                store.lapTargets(), prefs.raceFinalized());
        TextView standings = new TextView(this);
        standings.setTypeface(android.graphics.Typeface.MONOSPACE);
        standings.setTextSize(13);
        StringBuilder sb = new StringBuilder();
        for (RaceEngine.Result r : results) {
            sb.append(String.format(Locale.US, "%-4s %-5s %-18s %s%n",
                    r.rank > 0 ? String.valueOf(r.rank) : "–",
                    r.bib,
                    r.name.length() > 18 ? r.name.substring(0, 18) : r.name,
                    "finished".equals(r.status) ? RaceEngine.formatElapsed(r.elapsedMs, prefs.timingDecimals()) : "–"));
        }
        standings.setText(sb.toString());
        box.addView(standings);

        android.widget.Button open = new android.widget.Button(this);
        open.setText(R.string.archive_open);
        open.setOnClickListener((View v) ->
                startActivity(new Intent(this, RaceActivity.class)));
        box.addView(open);
        store.close();
    }
}

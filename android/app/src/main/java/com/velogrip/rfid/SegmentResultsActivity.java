package com.velogrip.rfid;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import android.view.Gravity;
import android.view.View;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import com.velogrip.rfid.db.RaceStore;

import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.List;
import java.util.Locale;

/**
 * Segment results — the ranked racers of one distance + category, reached from
 * the ❯ arrow on View Results. Finishers are placed within the segment (ties
 * share a place); DNS/DNF/DSQ racers list below. The ❯ on a row opens that
 * racer's info.
 */
public class SegmentResultsActivity extends Activity {

    public static final String EXTRA_DISTANCE = "distance";
    public static final String EXTRA_CATEGORY = "category";
    public static final String EXTRA_GENDER = "gender";   // "", "F" or "M"

    private Prefs prefs;
    private RaceStore store;
    private String distance = "", category = "", gender = "";
    private boolean sortByBib = false;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_segment_results);
        prefs = new Prefs(this);
        store = new RaceStore(this);
        distance = orEmpty(getIntent().getStringExtra(EXTRA_DISTANCE));
        category = orEmpty(getIntent().getStringExtra(EXTRA_CATEGORY));
        gender = orEmpty(getIntent().getStringExtra(EXTRA_GENDER));

        String contest = prefs.contestTitle();
        ((TextView) findViewById(R.id.contestTitle)).setText(
                contest.isEmpty() ? getString(R.string.race_title) : contest);
        ((TextView) findViewById(R.id.contestDate)).setText(raceDate());

        findViewById(R.id.backButton).setOnClickListener(v -> finish());
        findViewById(R.id.aSort).setOnClickListener(v -> { sortByBib = !sortByBib; render(); });
        findViewById(R.id.aSearch).setOnClickListener(v -> searchRacer());
        findViewById(R.id.aShare).setOnClickListener(v -> shareLink());
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

    private static String orEmpty(String s) { return s == null ? "" : s; }

    private String raceDate() {
        long start = 0;
        for (RaceStore.Wave w : store.waves()) {
            if (w.startedAtMs != null && (start == 0 || w.startedAtMs < start)) start = w.startedAtMs;
        }
        long when = start > 0 ? start : System.currentTimeMillis();
        return new java.text.SimpleDateFormat("d MMM yyyy 'at' HH:mm", Locale.US)
                .format(new java.util.Date(when));
    }

    /** Results for this distance + category (category empty = Overall). */
    private List<RaceEngine.Result> segment() {
        List<RaceEngine.Result> all = RaceEngine.compute(
                store.racers(), store.waves(), store.allPassings(),
                prefs.suppressSecs(), prefs.lapGapSecs(), prefs.recordLaps(),
                store.lapTargets(), prefs.raceFinalized());
        List<RaceEngine.Result> out = new ArrayList<>();
        for (RaceEngine.Result r : all) {
            if (!r.distance.equals(distance)) continue;
            if (!category.isEmpty() && !r.category.equals(category)) continue;
            if (gender.equals("F") && !ViewResultsActivity.isFemale(r.gender)) continue;
            if (gender.equals("M") && !ViewResultsActivity.isMale(r.gender)) continue;
            out.add(r);
        }
        return out;
    }

    private void render() {
        LinearLayout rows = findViewById(R.id.rows);
        rows.removeAllViews();
        List<RaceEngine.Result> seg = segment();

        List<RaceEngine.Result> finishers = new ArrayList<>();
        List<RaceEngine.Result> rest = new ArrayList<>();
        for (RaceEngine.Result r : seg) {
            if ("finished".equals(r.status)) finishers.add(r); else rest.add(r);
        }
        // Rank finishers within the segment (fastest first), ties share a place.
        Collections.sort(finishers, new Comparator<RaceEngine.Result>() {
            @Override public int compare(RaceEngine.Result a, RaceEngine.Result b) {
                if (a.laps != b.laps) return b.laps - a.laps;
                return Long.compare(a.elapsedMs, b.elapsedMs);
            }
        });
        int dec = prefs.timingDecimals();
        int[] places = new int[finishers.size()];
        String prev = null;
        for (int i = 0; i < finishers.size(); i++) {
            String t = RaceEngine.formatElapsed(finishers.get(i).elapsedMs, dec);
            places[i] = (i > 0 && t.equals(prev)) ? places[i - 1] : i + 1;
            prev = t;
        }

        // Build the display list, optionally re-sorted by bib for the Sort toggle.
        List<Row> display = new ArrayList<>();
        for (int i = 0; i < finishers.size(); i++) {
            RaceEngine.Result r = finishers.get(i);
            display.add(new Row(String.valueOf(places[i]), r.bib, r.name,
                    RaceEngine.formatElapsed(r.elapsedMs, dec)));
        }
        for (RaceEngine.Result r : rest) {
            String tag = (r.status == null || r.status.isEmpty())
                    ? getString(R.string.status_dns) : r.status;
            display.add(new Row("–", r.bib, r.name, tag));
        }
        if (sortByBib) {
            Collections.sort(display, new Comparator<Row>() {
                @Override public int compare(Row a, Row b) { return Long.compare(bibNum(a.bib), bibNum(b.bib)); }
            });
        }

        if (display.isEmpty()) {
            TextView empty = new TextView(this);
            empty.setText(R.string.archive_empty);
            empty.setTextSize(16);
            empty.setPadding(dp(16), dp(16), dp(16), dp(16));
            rows.addView(empty);
        } else {
            boolean alt = false;
            for (Row row : display) {
                rows.addView(rowView(row, alt));
                alt = !alt;
            }
        }

        // Footer: "5k, 60+ Male | 6 racers" (distinct racers in the segment)
        String label = distance.isEmpty() ? getString(R.string.all_racers) : distance;
        if (gender.equals("F")) label += ", " + getString(R.string.gender_female);
        else if (gender.equals("M")) label += ", " + getString(R.string.gender_male);
        if (!category.isEmpty()) label += ", " + category;
        ((TextView) findViewById(R.id.segFooter)).setText(
                getString(R.string.segment_footer, label, seg.size()));
    }

    private static final class Row {
        final String place, bib, name, time;
        Row(String place, String bib, String name, String time) {
            this.place = place; this.bib = bib; this.name = name; this.time = time;
        }
    }

    private View rowView(Row row, boolean alt) {
        LinearLayout r = new LinearLayout(this);
        r.setOrientation(LinearLayout.HORIZONTAL);
        r.setGravity(Gravity.CENTER_VERTICAL);
        r.setBackgroundColor(alt ? 0xFFF2F2F2 : 0xFFFFFFFF);
        r.setPadding(dp(12), dp(14), dp(12), dp(14));

        r.addView(textCell(row.place, dp(36), false, Gravity.START));
        r.addView(textCell(row.bib, dp(52), true, Gravity.START));
        TextView nm = new TextView(this);
        nm.setText(row.name);
        nm.setTextSize(17);
        nm.setTextColor(0xFF111111);
        // Keep a gap on both sides so a right-aligned Hebrew name never touches
        // the bib on one side or the time on the other.
        nm.setPadding(dp(10), 0, dp(12), 0);
        nm.setLayoutParams(new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f));
        r.addView(nm);
        TextView tv = new TextView(this);
        tv.setText(row.time);
        tv.setTextSize(17);
        tv.setTextColor(0xFF111111);
        tv.setTypeface(null, android.graphics.Typeface.BOLD);
        tv.setGravity(Gravity.END);
        tv.setPadding(dp(6), 0, dp(8), 0);
        r.addView(tv);

        TextView chevron = new TextView(this);
        chevron.setText("❯");
        chevron.setTextColor(0xFF76B82A);
        chevron.setTextSize(15);
        chevron.setBackgroundResource(R.drawable.bg_chevron);
        chevron.setPadding(dp(9), dp(3), dp(9), dp(3));
        r.addView(chevron);

        Runnable open = () -> {
            if (row.bib == null || row.bib.isEmpty()) return;
            Intent i = new Intent(this, RacerInfoActivity.class);
            i.putExtra(RacerInfoActivity.EXTRA_BIB, row.bib);
            startActivity(i);
        };
        chevron.setOnClickListener(v -> open.run());
        r.setOnClickListener(v -> open.run());
        return r;
    }

    private TextView textCell(String text, int width, boolean bold, int gravity) {
        TextView t = new TextView(this);
        t.setText(text);
        t.setTextSize(17);
        t.setTextColor(0xFF111111);
        t.setGravity(gravity);
        if (bold) t.setTypeface(null, android.graphics.Typeface.BOLD);
        t.setLayoutParams(new LinearLayout.LayoutParams(width, LinearLayout.LayoutParams.WRAP_CONTENT));
        return t;
    }

    private void searchRacer() {
        final EditText input = new EditText(this);
        input.setHint(R.string.search_hint);
        new android.app.AlertDialog.Builder(this)
                .setTitle(R.string.search_racer)
                .setView(input)
                .setPositiveButton(android.R.string.ok, (d, w) -> {
                    String q = input.getText().toString().trim().toLowerCase(Locale.ROOT);
                    if (q.isEmpty()) return;
                    for (RaceEngine.Result r : segment()) {
                        if (r.bib.toLowerCase(Locale.ROOT).contains(q)
                                || r.name.toLowerCase(Locale.ROOT).contains(q)) {
                            Intent i = new Intent(this, RacerInfoActivity.class);
                            i.putExtra(RacerInfoActivity.EXTRA_BIB, r.bib);
                            startActivity(i);
                            return;
                        }
                    }
                    Toast.makeText(this, R.string.no_match, Toast.LENGTH_SHORT).show();
                })
                .setNegativeButton(R.string.cancel_popup, null)
                .show();
    }

    private void shareLink() {
        String url = prefs.publicResultsUrl();
        Intent share = new Intent(Intent.ACTION_SEND);
        share.setType("text/plain");
        share.putExtra(Intent.EXTRA_SUBJECT, prefs.contestTitle());
        share.putExtra(Intent.EXTRA_TEXT, url);
        startActivity(Intent.createChooser(share, getString(R.string.share_link)));
    }

    private static long bibNum(String bib) {
        try { return Long.parseLong(bib.replaceAll("[^0-9]", "")); }
        catch (NumberFormatException e) { return Long.MAX_VALUE; }
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }
}

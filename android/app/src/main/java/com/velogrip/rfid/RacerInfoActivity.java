package com.velogrip.rfid;

import android.app.Activity;
import android.os.Bundle;
import android.view.Gravity;
import android.widget.ArrayAdapter;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.Spinner;
import android.widget.TextView;

import com.velogrip.rfid.db.RaceStore;

/**
 * Racer Info — the details behind the ❯ arrow on a Race Timing row. Name,
 * distance, category, wave and the chip IDs are editable; age / gender / team /
 * email / info fields mirror the reference but are not part of the start-list
 * data, so they are shown read-only.
 */
public class RacerInfoActivity extends Activity {

    public static final String EXTRA_BIB = "bib";

    private RaceStore store;
    private String bib;
    private LinearLayout box;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_racer_info);
        findViewById(R.id.navSettings).setOnClickListener(v -> startActivity(new android.content.Intent(this, SettingsActivity.class)));
        store = new RaceStore(this);
        bib = getIntent().getStringExtra(EXTRA_BIB);
        box = findViewById(R.id.infoBox);
        findViewById(R.id.backButton).setOnClickListener(v -> finish());
        render();
    }

    private RaceStore.Racer racer() {
        for (RaceStore.Racer r : store.racers()) if (r.bib.equals(bib)) return r;
        return null;
    }

    private void render() {
        box.removeAllViews();
        RaceStore.Racer r = racer();
        if (r == null) { finish(); return; }

        TextView title = new TextView(this);
        title.setText(getString(R.string.bib_and_name, r.bib, r.name));
        title.setTextSize(22);
        title.setTypeface(null, android.graphics.Typeface.BOLD);
        title.setGravity(Gravity.CENTER);
        title.setPadding(0, 0, 0, dp(10));
        box.addView(title);
        box.addView(divider());

        // editable fields
        box.addView(editableRow(getString(R.string.racer_name), r.name, val ->
                store.editRacer(bib, val, r.category, r.wave)));
        box.addView(editableRow(getString(R.string.distance), r.distance, val ->
                store.setRacerDistance(bib, val)));
        box.addView(categoryRow(r.category, val ->
                store.editRacer(bib, r.name, val, r.wave)));
        box.addView(editableRow(getString(R.string.wave), r.wave, val ->
                store.editRacer(bib, r.name, r.category, val)));

        // chip ids (two-chip racers share a bib)
        java.util.List<String> chips = new java.util.ArrayList<>();
        for (RaceStore.Racer x : store.racers()) if (x.bib.equals(bib)) chips.add(x.epc);
        box.addView(readonlyRow(getString(R.string.chip_id), chips.size() > 0 ? chips.get(0) : "—"));
        box.addView(readonlyRow(getString(R.string.chip_id2), chips.size() > 1 ? chips.get(1) : "—"));

        // reference fields not stored by the start list
        box.addView(readonlyRow(getString(R.string.racer_age), getString(R.string.not_stored)));
        box.addView(readonlyRow(getString(R.string.racer_gender), getString(R.string.not_stored)));
        box.addView(readonlyRow(getString(R.string.team_name), getString(R.string.not_stored)));
    }

    private LinearLayout editableRow(String label, String value, java.util.function.Consumer<String> onSave) {
        LinearLayout row = baseRow(label);
        final EditText field = new EditText(this);
        field.setText(value);
        field.setTextSize(17);
        field.setLayoutParams(new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f));
        TextView edit = new TextView(this);
        edit.setText(R.string.edit);
        edit.setTextColor(0xFF1E6FBF);
        edit.setPadding(dp(10), dp(6), dp(4), dp(6));
        edit.setOnClickListener(v -> { onSave.accept(field.getText().toString().trim()); render(); });
        row.addView(field);
        row.addView(edit);
        return row;
    }

    /** Category as a dropdown of every category in the start list (plus a
     *  "none" option); saves the moment you pick a new one. */
    private LinearLayout categoryRow(String current, java.util.function.Consumer<String> onSave) {
        LinearLayout row = baseRow(getString(R.string.category));

        java.util.TreeSet<String> cats = new java.util.TreeSet<>();
        for (RaceStore.Racer x : store.startListEntries()) if (!x.category.isEmpty()) cats.add(x.category);
        if (current != null && !current.isEmpty()) cats.add(current);

        final java.util.List<String> values = new java.util.ArrayList<>();
        java.util.List<String> labels = new java.util.ArrayList<>();
        values.add(""); labels.add(getString(R.string.category_none));
        for (String c : cats) { values.add(c); labels.add(c); }

        Spinner sp = new Spinner(this);
        ArrayAdapter<String> ad = new ArrayAdapter<>(this, android.R.layout.simple_spinner_item, labels);
        ad.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item);
        sp.setAdapter(ad);
        final int initial = Math.max(0, values.indexOf(current == null ? "" : current));
        sp.setSelection(initial);
        sp.setLayoutParams(new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f));
        sp.setOnItemSelectedListener(new android.widget.AdapterView.OnItemSelectedListener() {
            @Override public void onItemSelected(android.widget.AdapterView<?> p, android.view.View v, int pos, long id) {
                if (pos == initial) return;            // skip the initial programmatic selection
                onSave.accept(values.get(pos));
                render();
            }
            @Override public void onNothingSelected(android.widget.AdapterView<?> p) { }
        });
        row.addView(sp);
        return row;
    }

    private LinearLayout readonlyRow(String label, String value) {
        LinearLayout row = baseRow(label);
        TextView v = new TextView(this);
        v.setText(value);
        v.setTextSize(17);
        v.setTextColor(0xFF555555);
        v.setLayoutParams(new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f));
        row.addView(v);
        return row;
    }

    private LinearLayout baseRow(String label) {
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL);
        row.setPadding(0, dp(10), 0, dp(10));
        TextView l = new TextView(this);
        l.setText(label);
        l.setTextSize(16);
        l.setTextColor(0xFF111111);
        l.setLayoutParams(new LinearLayout.LayoutParams(dp(110), LinearLayout.LayoutParams.WRAP_CONTENT));
        row.addView(l);
        return row;
    }

    private android.view.View divider() {
        android.view.View v = new android.view.View(this);
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

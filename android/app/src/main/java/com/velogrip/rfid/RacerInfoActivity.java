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
 * distance, category, wave, gender, team and the chip IDs are editable; age
 * and the other reference fields are not part of the start-list data, so they
 * are shown read-only.
 *
 * Edits here are local to this device: the app pulls the start list down and
 * sends up times and declared statuses, not roster changes. A correction made
 * on the tablet fixes what the tablet scores and prints; the website keeps its
 * own copy until the same change is made there.
 */
public class RacerInfoActivity extends BaseActivity {

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
        box.addView(dropdownRow(getString(R.string.category), r.category,
                distinctValues(false), val -> store.editRacer(bib, r.name, val, r.wave)));
        box.addView(editableRow(getString(R.string.wave), r.wave, val ->
                store.editRacer(bib, r.name, r.category, val)));

        // chip ids (two-chip racers share a bib) — editable
        java.util.List<String> chips = new java.util.ArrayList<>();
        for (RaceStore.Racer x : store.racers()) if (x.bib.equals(bib)) chips.add(x.epc);
        if (chips.size() > 0) {
            final String oldEpc = chips.get(0);
            box.addView(editableRow(getString(R.string.chip_id), oldEpc, val ->
                    store.setRacerEpc(oldEpc, padEpc(val))));
        } else {
            box.addView(readonlyRow(getString(R.string.chip_id), "—"));
        }
        if (chips.size() > 1) {
            final String oldEpc2 = chips.get(1);
            box.addView(editableRow(getString(R.string.chip_id2), oldEpc2, val ->
                    store.setRacerEpc(oldEpc2, padEpc(val))));
        } else {
            box.addView(readonlyRow(getString(R.string.chip_id2), "—"));
        }

        // team comes from the start list (XLSX/CSV column or web sync)
        box.addView(dropdownRow(getString(R.string.team_name), r.team,
                distinctValues(true), val -> store.setRacerTeam(bib, val)));

        // Gender decides which group a racer is scored in — results are ranked
        // by distance, gender and category — so it has to be fixable here. It
        // was shown as "not stored", which it never was: the column has been on
        // the racers table all along, filled by the start list and sent up with
        // it. A racer whose gender came over blank or wrong could only be put
        // right on the website.
        box.addView(genderRow(r.gender));

        // reference fields not stored by the start list
        box.addView(readonlyRow(getString(R.string.racer_age), getString(R.string.not_stored)));
    }

    /** Male / Female / unset, shown in the operator's language and stored in
     *  the canonical spelling the scoring reads. */
    private LinearLayout genderRow(String current) {
        final String[] values = {"", "Male", "Female"};
        String[] labels = {getString(R.string.category_none),
                getString(R.string.gender_male), getString(R.string.gender_female)};

        LinearLayout row = baseRow(getString(R.string.racer_gender));
        Spinner sp = new Spinner(this);
        ArrayAdapter<String> ad = new ArrayAdapter<>(this, android.R.layout.simple_spinner_item, labels);
        ad.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item);
        sp.setAdapter(ad);
        final int initial = genderIndex(current);
        sp.setSelection(initial);
        sp.setLayoutParams(new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f));
        sp.setOnItemSelectedListener(new android.widget.AdapterView.OnItemSelectedListener() {
            @Override public void onItemSelected(android.widget.AdapterView<?> p, android.view.View v, int pos, long id) {
                if (pos == initial) return;   // the initial programmatic selection
                store.setRacerGender(bib, values[pos]);
                render();
            }
            @Override public void onNothingSelected(android.widget.AdapterView<?> p) { }
        });
        row.addView(sp);
        return row;
    }

    /** Which of the three options a stored value is. Start lists spell gender
     *  in whatever way the office that typed them chose, so the same words the
     *  server knows are accepted here — see MALE_WORDS / FEMALE_WORDS in
     *  server/race-results.js, which this list mirrors. */
    private static int genderIndex(String raw) {
        String s = raw == null ? "" : raw.trim().toLowerCase(java.util.Locale.ROOT);
        for (String m : new String[]{"m", "male", "man", "men", "boy", "ז", "זכר", "גבר", "גברים", "בן", "בנים"}) {
            if (m.equals(s)) return 1;
        }
        for (String f : new String[]{"f", "female", "woman", "women", "girl", "נ", "נקבה", "אישה", "אשה", "נשים", "בת", "בנות"}) {
            if (f.equals(s)) return 2;
        }
        return 0;
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

    /** Distinct non-empty categories (or teams) across the start list, sorted. */
    private java.util.TreeSet<String> distinctValues(boolean team) {
        java.util.TreeSet<String> out = new java.util.TreeSet<>();
        for (RaceStore.Racer x : store.startListEntries()) {
            String v = team ? x.team : x.category;
            if (v != null && !v.isEmpty()) out.add(v);
        }
        return out;
    }

    /** A labelled dropdown of the given options (plus a "none" option) with the
     *  current value pre-selected; saves the moment you pick a new one. */
    private LinearLayout dropdownRow(String label, String current,
                                     java.util.Set<String> options,
                                     java.util.function.Consumer<String> onSave) {
        LinearLayout row = baseRow(label);

        java.util.TreeSet<String> opts = new java.util.TreeSet<>(options);
        if (current != null && !current.isEmpty()) opts.add(current);

        final java.util.List<String> values = new java.util.ArrayList<>();
        java.util.List<String> labels = new java.util.ArrayList<>();
        values.add(""); labels.add(getString(R.string.category_none));
        for (String c : opts) { values.add(c); labels.add(c); }

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
        v.setTextColor(getColor(R.color.text_muted));
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
        l.setTextColor(getColor(R.color.text_primary));
        l.setLayoutParams(new LinearLayout.LayoutParams(dp(110), LinearLayout.LayoutParams.WRAP_CONTENT));
        row.addView(l);
        return row;
    }

    private android.view.View divider() {
        android.view.View v = new android.view.View(this);
        v.setBackgroundColor(getColor(R.color.divider));
        v.setLayoutParams(new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 1));
        return v;
    }

    /** Left-pad a chip id to a full 24-char (96-bit) EPC, like the reader emits. */
    private static String padEpc(String raw) {
        String s = raw == null ? "" : raw.trim().toUpperCase();
        if (s.isEmpty() || s.length() >= 24) return s;
        StringBuilder sb = new StringBuilder();
        for (int i = s.length(); i < 24; i++) sb.append('0');
        return sb.append(s).toString();
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

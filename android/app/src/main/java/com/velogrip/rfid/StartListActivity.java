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

import java.util.List;
import java.util.Locale;

/**
 * Start List: the racer roster. Rows show bib + name with a green ✓ (grey +
 * "DNS/DNF/DSQ" once flagged); tapping a row edits the racer. The two-page
 * bottom bar (More toggles) offers search, DNS, delete, merge / add, sort,
 * share. Automate is not implemented yet.
 */
public class StartListActivity extends Activity {

    /** Set true to hide the wizard's forward button (e.g. opened mid-race). */
    public static final String EXTRA_NO_FORWARD = "no_forward";

    private RaceStore store;
    private LinearLayout box;
    private TextView countView;
    private String filter = "";
    private boolean sortByName;
    private int deleteMode;   // 0 none, 1 delete, 2 DNS

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_start_list);
        store = new RaceStore(this);

        WizardNav.attach(this, WizardNav.START_LIST);
        findViewById(R.id.backButton).setOnClickListener(v -> finish());
        // Opened from Race Timing the wizard's forward step is off-limits — the
        // race is already running, so only Back is offered.
        boolean noForward = getIntent().getBooleanExtra(EXTRA_NO_FORWARD, false);
        View next = findViewById(R.id.nextButton);
        next.setVisibility(noForward ? View.GONE : View.VISIBLE);
        if (!noForward) next.setOnClickListener(v ->
                startActivity(new Intent(this, RaceStartActivity.class)));

        box = findViewById(R.id.racersBox);
        countView = findViewById(R.id.racerCount);

        // page A
        findViewById(R.id.aSearch).setOnClickListener(v -> searchDialog());
        findViewById(R.id.aDns).setOnClickListener(v -> setMode(2, R.string.dns_tap_racer));
        findViewById(R.id.aDelete).setOnClickListener(v -> setMode(1, R.string.delete_tap_racer));
        findViewById(R.id.aMerge).setOnClickListener(v -> mergeStartList());
        findViewById(R.id.aMore).setOnClickListener(v -> togglePage(true));
        // page B
        findViewById(R.id.bAdd).setOnClickListener(v -> addRacer());
        findViewById(R.id.bAutomate).setOnClickListener(v ->
                Toast.makeText(this, R.string.automate_unsupported, Toast.LENGTH_LONG).show());
        findViewById(R.id.bSort).setOnClickListener(v -> { sortByName = !sortByName; render(); });
        findViewById(R.id.bShare).setOnClickListener(v -> shareStartList());
        findViewById(R.id.bMore).setOnClickListener(v -> togglePage(false));
    }

    @Override
    protected void onResume() {
        super.onResume();
        render();
    }

    private void togglePage(boolean showB) {
        findViewById(R.id.barA).setVisibility(showB ? View.GONE : View.VISIBLE);
        findViewById(R.id.barB).setVisibility(showB ? View.VISIBLE : View.GONE);
    }

    private void setMode(int mode, int hintRes) {
        deleteMode = deleteMode == mode ? 0 : mode;
        if (deleteMode != 0) Toast.makeText(this, hintRes, Toast.LENGTH_SHORT).show();
        render();
    }

    private void render() {
        box.removeAllViews();
        List<RaceStore.Racer> racers = store.startListEntries();
        if (sortByName) {
            java.util.Collections.sort(racers, (a, b) -> a.name.compareToIgnoreCase(b.name));
        } else {
            java.util.Collections.sort(racers, (a, b) -> Long.compare(bibNum(a.bib), bibNum(b.bib)));
        }
        String f = filter.toLowerCase(Locale.US);
        int shown = 0;
        for (final RaceStore.Racer r : racers) {
            if (!f.isEmpty() && !r.bib.toLowerCase(Locale.US).contains(f)
                    && !r.name.toLowerCase(Locale.US).contains(f)) continue;
            shown++;
            LinearLayout row = new LinearLayout(this);
            row.setOrientation(LinearLayout.HORIZONTAL);
            row.setGravity(Gravity.CENTER_VERTICAL);
            row.setPadding(dp(12), dp(16), dp(12), dp(16));
            android.util.TypedValue tv = new android.util.TypedValue();
            getTheme().resolveAttribute(android.R.attr.selectableItemBackground, tv, true);
            row.setBackgroundResource(tv.resourceId);

            boolean flagged = !r.status.isEmpty();
            TextView check = new TextView(this);
            check.setText(deleteMode == 1 ? "🗑" : flagged ? "✕" : "✓");
            check.setTextColor(deleteMode == 1 ? 0xFFC0392B : flagged ? 0xFF999999 : 0xFF76B82A);
            check.setTextSize(18);
            check.setTypeface(null, android.graphics.Typeface.BOLD);
            check.setLayoutParams(new LinearLayout.LayoutParams(dp(30), LinearLayout.LayoutParams.WRAP_CONTENT));

            TextView bib = new TextView(this);
            bib.setText(r.bib);
            bib.setTextColor(0xFF111111);
            bib.setTextSize(19);
            bib.setTypeface(null, android.graphics.Typeface.BOLD);
            bib.setLayoutParams(new LinearLayout.LayoutParams(dp(64), LinearLayout.LayoutParams.WRAP_CONTENT));

            TextView name = new TextView(this);
            name.setText(r.name + (flagged ? "  (" + r.status + ")" : ""));
            name.setTextColor(flagged ? 0xFF999999 : 0xFF111111);
            name.setTextSize(18);
            name.setLayoutParams(new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f));

            TextView chevron = new TextView(this);
            chevron.setText("❯");
            chevron.setTextColor(0xFF76B82A);
            chevron.setTextSize(15);
            chevron.setTypeface(null, android.graphics.Typeface.BOLD);
            chevron.setBackgroundResource(R.drawable.bg_chevron);
            chevron.setPadding(dp(9), dp(4), dp(9), dp(4));

            row.addView(check);
            row.addView(bib);
            row.addView(name);
            row.addView(chevron);
            row.setOnClickListener(v -> onRowTap(r));
            box.addView(row);

            View divider = new View(this);
            divider.setBackgroundColor(0xFFDDDDDD);
            divider.setLayoutParams(new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 1));
            box.addView(divider);
        }
        countView.setText(getString(R.string.number_of_racers, shown));
    }

    private void onRowTap(RaceStore.Racer r) {
        if (deleteMode == 1) {
            new android.app.AlertDialog.Builder(this)
                    .setMessage(getString(R.string.delete_racer_confirm, r.bib, r.name))
                    .setPositiveButton(android.R.string.ok, (d, w) -> {
                        if (!r.bib.isEmpty()) store.deleteRacerByBib(r.bib); else store.deleteRacerByEpc(r.epc);
                        deleteMode = 0;
                        render();
                    })
                    .setNegativeButton(android.R.string.cancel, null)
                    .show();
        } else if (deleteMode == 2) {
            store.setRacerStatus(r.bib, r.status.isEmpty() ? "DNS" : "");
            deleteMode = 0;
            render();
        } else {
            editRacer(r);
        }
    }

    private void editRacer(RaceStore.Racer r) {
        LinearLayout form = new LinearLayout(this);
        form.setOrientation(LinearLayout.VERTICAL);
        form.setPadding(dp(20), dp(8), dp(20), dp(8));
        final EditText name = field(form, getString(R.string.racer_name), r.name);
        final EditText category = field(form, getString(R.string.racer_category), r.category);
        final EditText wave = field(form, getString(R.string.wave), r.wave);
        final String[] statuses = {"", "DNS", "DNF", "DSQ"};
        new android.app.AlertDialog.Builder(this)
                .setTitle("#" + r.bib)
                .setView(form)
                .setPositiveButton(android.R.string.ok, (d, w) -> {
                    store.editRacer(r.bib, name.getText().toString().trim(),
                            category.getText().toString().trim(), wave.getText().toString().trim());
                    render();
                })
                .setNeutralButton(R.string.set_status, (d, w) ->
                        new android.app.AlertDialog.Builder(this)
                                .setTitle(R.string.racer_status)
                                .setItems(new String[]{getString(R.string.status_ok), "DNS", "DNF", "DSQ"},
                                        (dd, which) -> { store.setRacerStatus(r.bib, statuses[which]); render(); })
                                .show())
                .setNegativeButton(android.R.string.cancel, null)
                .show();
    }

    private EditText field(LinearLayout parent, String label, String value) {
        TextView t = new TextView(this);
        t.setText(label);
        t.setPadding(0, dp(8), 0, 0);
        parent.addView(t);
        EditText e = new EditText(this);
        e.setText(value);
        parent.addView(e);
        return e;
    }

    private void addRacer() {
        LinearLayout form = new LinearLayout(this);
        form.setOrientation(LinearLayout.VERTICAL);
        form.setPadding(dp(20), dp(8), dp(20), dp(8));
        final EditText bib = field(form, getString(R.string.bib), "");
        bib.setInputType(new Prefs(this).bibAlphanumeric()
                ? android.text.InputType.TYPE_CLASS_TEXT : android.text.InputType.TYPE_CLASS_NUMBER);
        final EditText name = field(form, getString(R.string.participant), "");
        final EditText category = field(form, getString(R.string.racer_category), "");
        new android.app.AlertDialog.Builder(this)
                .setTitle(R.string.add_racer)
                .setView(form)
                .setPositiveButton(android.R.string.ok, (d, w) -> {
                    String b = bib.getText().toString().trim();
                    String nm = name.getText().toString().trim();
                    if (b.isEmpty() || nm.isEmpty()) {
                        Toast.makeText(this, R.string.add_racer_needs_fields, Toast.LENGTH_LONG).show();
                        return;
                    }
                    String epc = b.matches("\\d{1,10}")
                            ? "AA" + String.format(Locale.US, "%4s", b).replace(' ', '0')
                            : "AA" + b.toUpperCase(Locale.US);
                    store.upsertRacer(new RaceStore.Racer(epc, b, nm, category.getText().toString().trim(), ""));
                    render();
                })
                .setNegativeButton(android.R.string.cancel, null)
                .show();
    }

    private void searchDialog() {
        final EditText input = new EditText(this);
        input.setText(filter);
        input.setHint(R.string.search_hint);
        new android.app.AlertDialog.Builder(this)
                .setTitle(R.string.search_racer)
                .setView(input)
                .setPositiveButton(android.R.string.ok, (d, w) -> { filter = input.getText().toString().trim(); render(); })
                .setNeutralButton(R.string.clear_search, (d, w) -> { filter = ""; render(); })
                .setNegativeButton(android.R.string.cancel, null)
                .show();
    }

    private void mergeStartList() {
        Intent pick = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        pick.addCategory(Intent.CATEGORY_OPENABLE);
        pick.setType("*/*");
        pick.putExtra(Intent.EXTRA_MIME_TYPES, new String[]{
                "text/csv", "text/plain",
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                "application/vnd.ms-excel", "application/octet-stream"});
        startActivityForResult(pick, 51);
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != 51 || resultCode != RESULT_OK || data == null || data.getData() == null) return;
        final android.net.Uri uri = data.getData();
        new Thread(() -> {
            String message;
            try {
                java.io.InputStream in = getContentResolver().openInputStream(uri);
                List<StartListFile.Row> rows = StartListFile.parse(in);
                if (in != null) in.close();
                StartListFile.ImportResult r = StartListFile.importInto(store, rows); // merge, no clear
                message = getString(R.string.merged_racers, r.racers);
            } catch (Exception e) {
                message = getString(R.string.file_import_failed, e.getMessage());
            }
            final String text = message;
            runOnUiThread(() -> { Toast.makeText(this, text, Toast.LENGTH_LONG).show(); render(); });
        }).start();
    }

    private void shareStartList() {
        StringBuilder csv = new StringBuilder("Bib,Name,Category,Wave,Distance,Status\n");
        for (RaceStore.Racer r : store.startListEntries()) {
            csv.append(csvCell(r.bib)).append(',').append(csvCell(r.name)).append(',')
                    .append(csvCell(r.category)).append(',').append(csvCell(r.wave)).append(',')
                    .append(csvCell(r.distance)).append(',').append(csvCell(r.status)).append('\n');
        }
        Intent share = new Intent(Intent.ACTION_SEND);
        share.setType("text/csv");
        share.putExtra(Intent.EXTRA_SUBJECT, new Prefs(this).contestTitle());
        share.putExtra(Intent.EXTRA_TEXT, csv.toString());
        startActivity(Intent.createChooser(share, getString(R.string.share_print)));
    }

    private static String csvCell(String v) {
        if (v == null) return "";
        return v.matches(".*[,\"\n].*") ? "\"" + v.replace("\"", "\"\"") + "\"" : v;
    }

    private static long bibNum(String bib) {
        try { return Long.parseLong(bib.replaceAll("[^0-9]", "")); }
        catch (NumberFormatException e) { return Long.MAX_VALUE; }
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

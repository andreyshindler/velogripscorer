package com.velogrip.rfid;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.widget.TextView;
import android.widget.Toast;

import com.velogrip.rfid.db.RaceStore;

import java.io.InputStream;
import java.util.List;

/**
 * "Race with start list" chooser: pull the start list from the website, or
 * import a .xlsx/.csv file already copied to the phone.
 */
public class SelectStartListActivity extends Activity {

    private static final int PICK_FILE = 41;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_select_startlist);

        findViewById(R.id.backButton).setOnClickListener(v -> finish());

        Prefs prefs = new Prefs(this);
        String host = prefs.serverUrl().replaceFirst("^https?://", "");
        TextView webLabel = findViewById(R.id.downloadWebLabel);
        webLabel.setText(getString(R.string.option_download_from, host));

        findViewById(R.id.rowDownloadWeb).setOnClickListener(v ->
                startActivity(new Intent(this, DownloadRacesActivity.class)));

        findViewById(R.id.rowFile).setOnClickListener(v -> {
            Intent pick = new Intent(Intent.ACTION_OPEN_DOCUMENT);
            pick.addCategory(Intent.CATEGORY_OPENABLE);
            pick.setType("*/*");
            pick.putExtra(Intent.EXTRA_MIME_TYPES, new String[]{
                    "text/csv", "text/comma-separated-values", "text/plain",
                    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                    "application/vnd.ms-excel", "application/octet-stream"});
            startActivityForResult(pick, PICK_FILE);
        });
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != PICK_FILE || resultCode != RESULT_OK || data == null) return;
        Uri uri = data.getData();
        if (uri == null) return;

        RaceStore store = new RaceStore(this);
        boolean hasData = !store.racers().isEmpty() || store.passingCount() > 0;
        store.close();
        if (hasData) {
            new android.app.AlertDialog.Builder(this)
                    .setMessage(R.string.replace_startlist_confirm)
                    .setPositiveButton(android.R.string.ok, (d, w) -> importFile(uri, true))
                    .setNegativeButton(android.R.string.cancel, null)
                    .show();
        } else {
            importFile(uri, false);
        }
    }

    private void importFile(Uri uri, boolean clearFirst) {
        new Thread(() -> {
            String message;
            boolean ok = false;
            try {
                InputStream in = getContentResolver().openInputStream(uri);
                List<StartListFile.Row> rows = StartListFile.parse(in);
                if (in != null) in.close();
                RaceStore store = new RaceStore(this);
                if (clearFirst) store.clearRace();
                StartListFile.ImportResult r = StartListFile.importInto(store, rows);
                store.close();
                new Prefs(this).saveTimingSettings(
                        new Prefs(this).suppressSecs(), new Prefs(this).lapGapSecs(),
                        fileTitle(uri));
                message = getString(R.string.sync_done, r.racers, r.waves)
                        + (r.skipped > 0 ? " (" + getString(R.string.rows_skipped, r.skipped) + ")" : "");
                ok = r.racers > 0;
            } catch (Exception e) {
                message = getString(R.string.file_import_failed, e.getMessage());
            }
            final String toastText = message;
            final boolean openRace = ok;
            runOnUiThread(() -> {
                Toast.makeText(this, toastText, Toast.LENGTH_LONG).show();
                // stay on the stack: back from the race returns here
                if (openRace) {
                    startActivity(new Intent(this, RaceActivity.class));
                }
            });
        }).start();
    }

    /** Race title from the file name, without its extension. */
    private String fileTitle(Uri uri) {
        String name = "";
        android.database.Cursor c = getContentResolver().query(uri, null, null, null, null);
        if (c != null) {
            try {
                int idx = c.getColumnIndex(android.provider.OpenableColumns.DISPLAY_NAME);
                if (idx >= 0 && c.moveToFirst()) name = c.getString(idx);
            } finally {
                c.close();
            }
        }
        return name == null ? "" : name.replaceFirst("\\.[A-Za-z0-9]+$", "");
    }
}

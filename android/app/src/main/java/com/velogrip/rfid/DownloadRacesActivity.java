package com.velogrip.rfid;

import android.app.Activity;
import android.os.Bundle;
import android.view.View;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import com.velogrip.rfid.db.RaceStore;
import com.velogrip.rfid.net.StartListSync;
import com.velogrip.rfid.net.Uploader;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * "Download races": log in with the website account, list the account's
 * races, and tap one to pair this phone and pull its start list.
 */
public class DownloadRacesActivity extends Activity {

    private Prefs prefs;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_download);
        prefs = new Prefs(this);

        EditText email = findViewById(R.id.dlEmail);
        EditText password = findViewById(R.id.dlPassword);
        email.setText(prefs.accountEmail());

        Button login = findViewById(R.id.dlLogin);
        login.setOnClickListener(v -> {
            String mail = email.getText().toString().trim();
            String pass = password.getText().toString();
            if (prefs.serverUrl().isEmpty() || mail.isEmpty() || pass.isEmpty()) {
                Toast.makeText(this, R.string.login_needs_fields, Toast.LENGTH_LONG).show();
                return;
            }
            login.setEnabled(false);
            new Thread(() -> {
                try {
                    JSONObject session = new JSONObject(Uploader.login(prefs.serverUrl(), mail, pass));
                    String jwt = session.getString("token");
                    JSONArray races = new JSONObject(Uploader.myRaces(prefs.serverUrl(), jwt))
                            .getJSONArray("races");
                    runOnUiThread(() -> {
                        login.setEnabled(true);
                        showRaces(races, mail);
                    });
                } catch (Exception e) {
                    final String msg = getString(R.string.test_failed) + " " + e.getMessage();
                    runOnUiThread(() -> {
                        login.setEnabled(true);
                        Toast.makeText(this, msg, Toast.LENGTH_LONG).show();
                    });
                }
            }).start();
        });
    }

    private void showRaces(JSONArray races, String email) {
        LinearLayout box = findViewById(R.id.dlRaces);
        TextView header = findViewById(R.id.dlRacesHeader);
        box.removeAllViews();
        if (races.length() == 0) {
            Toast.makeText(this, R.string.no_races_on_account, Toast.LENGTH_LONG).show();
            return;
        }
        header.setVisibility(View.VISIBLE);
        for (int i = 0; i < races.length(); i++) {
            final JSONObject race = races.optJSONObject(i);
            LinearLayout row = new LinearLayout(this);
            row.setOrientation(LinearLayout.VERTICAL);
            row.setPadding(8, 24, 8, 24);
            android.util.TypedValue tv = new android.util.TypedValue();
            getTheme().resolveAttribute(android.R.attr.selectableItemBackground, tv, true);
            row.setBackgroundResource(tv.resourceId);

            TextView title = new TextView(this);
            title.setText(race.optString("title"));
            title.setTextSize(18);
            title.setTypeface(null, android.graphics.Typeface.BOLD);
            TextView sub = new TextView(this);
            String location = race.optString("location");
            sub.setText((location.isEmpty() ? "" : location + " · ")
                    + getString(R.string.racers_n, race.optInt("racer_count")));
            sub.setTextSize(14);
            row.addView(title);
            row.addView(sub);
            row.setOnClickListener(v -> pickRace(race, email));
            box.addView(row);

            View divider = new View(this);
            divider.setBackgroundColor(0xFFDDDDDD);
            divider.setLayoutParams(new LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.MATCH_PARENT, 1));
            box.addView(divider);
        }
    }

    private void pickRace(JSONObject race, String email) {
        String title = race.optString("title");
        // Switching races wipes the previous race's local data, so the old
        // start list and its passings never bleed into the new race.
        if (!prefs.contestTitle().isEmpty() && !prefs.contestTitle().equals(title)) {
            new android.app.AlertDialog.Builder(this)
                    .setMessage(getString(R.string.switch_race_confirm, title))
                    .setPositiveButton(android.R.string.ok, (d, w) -> pairAndDownload(race, email, true))
                    .setNegativeButton(android.R.string.cancel, null)
                    .show();
        } else {
            pairAndDownload(race, email, false);
        }
    }

    private void pairAndDownload(JSONObject race, String email, boolean clearFirst) {
        prefs.savePairing(race.optString("app_token"), race.optString("title"), email);
        new Thread(() -> {
            String message;
            boolean ok = false;
            try {
                RaceStore store = new RaceStore(this);
                if (clearFirst) store.clearRace();
                StartListSync.Result r = StartListSync.download(prefs, store);
                store.close();
                message = getString(R.string.sync_done, r.racers, r.waves);
                ok = true;
            } catch (Exception e) {
                message = getString(R.string.sync_failed, e.getMessage());
            }
            final String toastText = message;
            final boolean openRace = ok;
            runOnUiThread(() -> {
                Toast.makeText(this, toastText, Toast.LENGTH_LONG).show();
                if (openRace) {
                    startActivity(new android.content.Intent(this, RaceActivity.class));
                    finish();
                }
            });
        }).start();
    }
}

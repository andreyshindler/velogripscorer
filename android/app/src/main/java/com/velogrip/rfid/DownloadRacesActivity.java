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

import java.util.Locale;

/**
 * "Download races": connects with the saved website account automatically and
 * lists the account's start lists; tap one to pair this phone and pull it.
 * The login form only appears on first use or when the saved login fails.
 */
public class DownloadRacesActivity extends BaseActivity {

    private Prefs prefs;
    private LinearLayout form;
    private TextView connectedAs;
    private EditText email, password;
    private Button login;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_download);
        prefs = new Prefs(this);

        ((TextView) findViewById(R.id.headerTitle)).setText(R.string.download_title);
        findViewById(R.id.backButton).setOnClickListener(v -> finish());
        findViewById(R.id.nextButton).setOnClickListener(v ->
                startActivity(new android.content.Intent(this, RaceSetupActivity.class)));

        form = findViewById(R.id.dlForm);
        connectedAs = findViewById(R.id.dlConnectedAs);
        email = findViewById(R.id.dlEmail);
        password = findViewById(R.id.dlPassword);
        PasswordReveal.attach(findViewById(R.id.dlPasswordShow), password);
        login = findViewById(R.id.dlLogin);

        email.setText(prefs.accountEmail());
        login.setOnClickListener(v ->
                connect(email.getText().toString().trim(), password.getText().toString(), true));

        // saved account -> connect without asking
        if (!prefs.serverUrl().isEmpty() && !prefs.accountEmail().isEmpty()
                && !prefs.accountPass().isEmpty()) {
            form.setVisibility(View.GONE);
            connect(prefs.accountEmail(), prefs.accountPass(), false);
        }
    }

    private void connect(String mail, String pass, boolean fromForm) {
        if (prefs.serverUrl().isEmpty() || mail.isEmpty() || pass.isEmpty()) {
            Toast.makeText(this, R.string.login_needs_fields, Toast.LENGTH_LONG).show();
            return;
        }
        login.setEnabled(false);
        connectedAs.setText(getString(R.string.connecting));
        connectedAs.setVisibility(View.VISIBLE);
        new Thread(() -> {
            try {
                JSONObject session = new JSONObject(Uploader.login(prefs.serverUrl(), mail, pass));
                String jwt = session.getString("token");
                JSONArray races = new JSONObject(Uploader.myRaces(prefs.serverUrl(), jwt))
                        .getJSONArray("races");
                runOnUiThread(() -> {
                    login.setEnabled(true);
                    prefs.saveAccount(mail, pass);
                    form.setVisibility(View.GONE);
                    connectedAs.setText(getString(R.string.connected_as, mail));
                    showRaces(races, mail);
                });
            } catch (Exception e) {
                final String msg = getString(R.string.test_failed) + " " + e.getMessage();
                runOnUiThread(() -> {
                    login.setEnabled(true);
                    // saved login failed -> fall back to the form
                    connectedAs.setVisibility(View.GONE);
                    form.setVisibility(View.VISIBLE);
                    if (fromForm || !prefs.accountPass().isEmpty()) {
                        Toast.makeText(this, msg, Toast.LENGTH_LONG).show();
                    }
                });
            }
        }).start();
    }

    private void showRaces(JSONArray allRaces, String email) {
        LinearLayout box = findViewById(R.id.dlRaces);
        TextView header = findViewById(R.id.dlRacesHeader);
        box.removeAllViews();
        if (allRaces.length() == 0) {
            Toast.makeText(this, R.string.no_races_on_account, Toast.LENGTH_LONG).show();
            return;
        }
        // Only offer start lists still to be timed — hide races already finished
        // or archived so the picker isn't cluttered with completed events.
        JSONArray races = new JSONArray();
        for (int i = 0; i < allRaces.length(); i++) {
            JSONObject r = allRaces.optJSONObject(i);
            String status = r == null ? "" : r.optString("status");
            if (!"finished".equals(status) && !"archived".equals(status)) races.put(r);
        }
        if (races.length() == 0) {
            Toast.makeText(this, R.string.no_unraced_startlists, Toast.LENGTH_LONG).show();
            return;
        }
        header.setText(getString(R.string.races_found, races.length()));
        header.setVisibility(View.VISIBLE);

        // Group by league membership: races with no league first, then one
        // section per league (sorted by name). league_names comes from the
        // server (GROUP_CONCAT of the leagues a race is attached to).
        java.util.LinkedHashMap<String, java.util.List<JSONObject>> groups = new java.util.LinkedHashMap<>();
        String noLeague = getString(R.string.no_league_group);
        groups.put(noLeague, new java.util.ArrayList<>());
        java.util.TreeMap<String, java.util.List<JSONObject>> leagueGroups = new java.util.TreeMap<>();
        for (int i = 0; i < races.length(); i++) {
            JSONObject r = races.optJSONObject(i);
            String league = r.optString("league_names").trim();
            if (league.isEmpty()) groups.get(noLeague).add(r);
            else leagueGroups.computeIfAbsent(league, k -> new java.util.ArrayList<>()).add(r);
        }
        groups.putAll(leagueGroups);

        for (java.util.Map.Entry<String, java.util.List<JSONObject>> group : groups.entrySet()) {
            if (group.getValue().isEmpty()) continue;
            box.addView(groupHeader(group.getKey()));
            for (JSONObject race : group.getValue()) {
                box.addView(raceRow(race, email));
                View divider = new View(this);
                divider.setBackgroundColor(getColor(R.color.divider));
                divider.setLayoutParams(new LinearLayout.LayoutParams(
                        LinearLayout.LayoutParams.MATCH_PARENT, 1));
                box.addView(divider);
            }
        }
    }

    /** A section header naming the league a group of races belongs to. */
    private TextView groupHeader(String label) {
        TextView h = new TextView(this);
        h.setText(label);
        h.setTextSize(13);
        h.setTypeface(null, android.graphics.Typeface.BOLD);
        h.setAllCaps(true);
        h.setTextColor(getColor(R.color.text_muted));
        h.setBackgroundColor(getColor(R.color.menu_section_bg));
        h.setPadding(12, 14, 12, 6);
        return h;
    }

    /** One tappable race row (title + date/location/sport/racers). */
    private LinearLayout raceRow(final JSONObject race, final String email) {
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.VERTICAL);
        row.setPadding(8, 24, 8, 24);
        android.util.TypedValue tv = new android.util.TypedValue();
        getTheme().resolveAttribute(android.R.attr.selectableItemBackground, tv, true);
        row.setBackgroundResource(tv.resourceId);

        TextView title = new TextView(this);
        title.setText(race.optString("title"));
        title.setTextSize(18);
        title.setTextColor(0xFF76B82A);
        title.setTypeface(null, android.graphics.Typeface.BOLD);
        TextView sub = new TextView(this);
        StringBuilder line = new StringBuilder(fmtDate(race.optString("start_at")));
        if (!race.optString("location").isEmpty()) line.append(" · ").append(race.optString("location"));
        if (!race.optString("sport").isEmpty()) line.append(" · ").append(race.optString("sport"));
        line.append(" · ").append(getString(R.string.racers_n, race.optInt("racer_count")));
        sub.setText(line);
        sub.setTextSize(14);
        row.addView(title);
        row.addView(sub);
        row.setOnClickListener(v -> pickRace(race, email));
        return row;
    }

    private static String fmtDate(String iso) {
        try {
            java.text.SimpleDateFormat in =
                    new java.text.SimpleDateFormat("yyyy-MM-dd", Locale.US);
            java.util.Date d = in.parse(iso.substring(0, 10));
            return java.text.DateFormat.getDateInstance(java.text.DateFormat.MEDIUM).format(d);
        } catch (Exception e) {
            return iso;
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
        prefs.savePairing(race.optString("app_token"), race.optString("title"), email, race.optInt("id"));
        new Thread(() -> {
            String message;
            boolean ok = false;
            try {
                RaceStore store = new RaceStore(this);
                if (clearFirst) {
                    store.clearRace();
                    prefs.resetRaceSetup(); // new race starts from the defaults
                }
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
                // stay on the stack: back from race setup returns here
                if (openRace) {
                    startActivity(new android.content.Intent(this, RaceSetupActivity.class));
                }
            });
        }).start();
    }

    @Override
    protected void onResume() {
        super.onResume();
        // a race is already picked -> offer to continue forward
        boolean hasChoice = !prefs.readerToken().isEmpty() && !prefs.contestTitle().isEmpty();
        findViewById(R.id.nextButton).setVisibility(
                hasChoice ? View.VISIBLE : View.GONE);
    }
}

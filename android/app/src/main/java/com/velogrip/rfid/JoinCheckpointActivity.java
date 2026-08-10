package com.velogrip.rfid;

import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.view.View;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import com.velogrip.rfid.net.Uploader;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.Locale;

/**
 * "Join as checkpoint": turns a secondary phone into a checkpoint reader for a
 * race. Two ways in:
 *   1. Sign in with the account the organizer shared the race with, then tap the
 *      race from the list — no code to type (the primary path).
 *   2. Enter the short join code, or open the QR deep link (which pre-fills the
 *      code + server URL) — for a marshal without an account.
 * Either way the server mints a checkpoint reader token, the phone pairs to it,
 * and from then on it uploads reads that the server records as split times.
 */
public class JoinCheckpointActivity extends BaseActivity {

    private Prefs prefs;
    private EditText email, password, code, name;
    private Button signIn, join;
    private TextView racesHeader, status;
    private LinearLayout signInForm, racesBox;
    private String jwt;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_join_checkpoint);
        prefs = new Prefs(this);

        ((TextView) findViewById(R.id.headerTitle)).setText(R.string.join_checkpoint);
        findViewById(R.id.backButton).setOnClickListener(v -> finish());
        findViewById(R.id.nextButton).setOnClickListener(v ->
                startActivity(new Intent(this, RaceSetupActivity.class)));

        email = findViewById(R.id.jcEmail);
        password = findViewById(R.id.jcPassword);
        PasswordReveal.attach(findViewById(R.id.jcPasswordShow), password);
        signIn = findViewById(R.id.jcSignIn);
        signInForm = findViewById(R.id.jcSignInForm);
        racesHeader = findViewById(R.id.jcRacesHeader);
        racesBox = findViewById(R.id.jcRaces);
        code = findViewById(R.id.jcCode);
        name = findViewById(R.id.jcName);
        join = findViewById(R.id.jcJoin);
        status = findViewById(R.id.jcStatus);

        email.setText(prefs.accountEmail());
        signIn.setOnClickListener(v ->
                connect(email.getText().toString().trim(), password.getText().toString(), true));
        join.setOnClickListener(v -> submitCode());

        prefillFromDeepLink(getIntent());

        // Saved account -> list shared races without asking again.
        if (!prefs.serverUrl().isEmpty() && !prefs.accountEmail().isEmpty()
                && !prefs.accountPass().isEmpty()) {
            connect(prefs.accountEmail(), prefs.accountPass(), false);
        }
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        prefillFromDeepLink(intent);
    }

    private void prefillFromDeepLink(Intent intent) {
        Uri data = intent == null ? null : intent.getData();
        if (data == null) return;
        String c = data.getQueryParameter("code");
        if (c != null && !c.isEmpty()) code.setText(c.toUpperCase(Locale.US));
        String base = data.getQueryParameter("base");
        if (base != null && !base.isEmpty()) {
            prefs.setServerUrl(base);
        } else if (data.getScheme() != null && data.getScheme().startsWith("http")) {
            String path = data.getPath() == null ? "" : data.getPath();
            String trimmed = path.replaceAll("/join/?$", "");
            prefs.setServerUrl(data.getScheme() + "://" + data.getAuthority() + trimmed);
        }
    }

    // ---- Path 1: sign in and pick a shared race --------------------------------

    private void connect(String mail, String pass, boolean fromForm) {
        if (prefs.serverUrl().isEmpty() || mail.isEmpty() || pass.isEmpty()) {
            if (fromForm) Toast.makeText(this, R.string.login_needs_fields, Toast.LENGTH_LONG).show();
            return;
        }
        signIn.setEnabled(false);
        status.setVisibility(View.VISIBLE);
        status.setText(R.string.connecting);
        new Thread(() -> {
            try {
                JSONObject session = new JSONObject(Uploader.login(prefs.serverUrl(), mail, pass));
                jwt = session.getString("token");
                JSONArray races = new JSONObject(Uploader.myCheckpoints(prefs.serverUrl(), jwt))
                        .getJSONArray("races");
                runOnUiThread(() -> {
                    signIn.setEnabled(true);
                    status.setVisibility(View.GONE);
                    prefs.saveAccount(mail, pass);
                    signInForm.setVisibility(View.GONE);
                    showRaces(races);
                });
            } catch (Exception e) {
                final String msg = e.getMessage();
                runOnUiThread(() -> {
                    signIn.setEnabled(true);
                    if (fromForm || !prefs.accountPass().isEmpty()) {
                        status.setVisibility(View.VISIBLE);
                        status.setText(getString(R.string.join_failed, msg));
                        signInForm.setVisibility(View.VISIBLE);
                    } else {
                        status.setVisibility(View.GONE);
                    }
                });
            }
        }).start();
    }

    private void showRaces(JSONArray races) {
        racesBox.removeAllViews();
        if (races.length() == 0) {
            racesHeader.setVisibility(View.VISIBLE);
            racesHeader.setText(R.string.join_no_shared_races);
            return;
        }
        racesHeader.setVisibility(View.VISIBLE);
        racesHeader.setText(R.string.join_pick_race);
        for (int i = 0; i < races.length(); i++) {
            JSONObject race = races.optJSONObject(i);
            if (race != null) racesBox.addView(raceRow(race));
        }
    }

    private LinearLayout raceRow(final JSONObject race) {
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
        if (!race.optString("organizer_name").isEmpty()) line.append(" · ").append(race.optString("organizer_name"));
        sub.setText(line);
        sub.setTextSize(14);
        row.addView(title);
        row.addView(sub);
        row.setOnClickListener(v -> pickRace(race.optInt("id"), race.optString("title")));
        return row;
    }

    private void pickRace(final int contestId, final String title) {
        status.setVisibility(View.VISIBLE);
        status.setText(R.string.joining);
        new Thread(() -> {
            try {
                JSONObject res = new JSONObject(
                        Uploader.checkpointToken(prefs.serverUrl(), jwt, contestId, ""));
                final String token = res.getString("token");
                final String cpName = res.optString("name", "");
                runOnUiThread(() -> pairAndContinue(token, title, contestId, cpName));
            } catch (Exception e) {
                final String msg = e.getMessage();
                runOnUiThread(() -> status.setText(getString(R.string.join_failed, msg)));
            }
        }).start();
    }

    // ---- Path 2: type the short join code --------------------------------------

    private void submitCode() {
        final String c = code.getText().toString().toUpperCase(Locale.US).replaceAll("[^0-9A-Z]", "");
        final String nm = name.getText().toString().trim();
        if (c.isEmpty()) {
            Toast.makeText(this, R.string.join_needs_code, Toast.LENGTH_LONG).show();
            return;
        }
        join.setEnabled(false);
        status.setVisibility(View.VISIBLE);
        status.setText(R.string.joining);
        final String server = prefs.serverUrl();
        new Thread(() -> {
            try {
                JSONObject res = new JSONObject(Uploader.joinCheckpoint(server, c, nm));
                final String token = res.getString("token");
                final String title = res.optString("contest_title", "");
                final String cpName = res.optString("name", nm);
                final int contestId = res.optInt("contest_id", 0);
                runOnUiThread(() -> pairAndContinue(token, title, contestId, cpName));
            } catch (Exception e) {
                final String msg = e.getMessage();
                runOnUiThread(() -> {
                    join.setEnabled(true);
                    status.setText(getString(R.string.join_failed, msg));
                });
            }
        }).start();
    }

    // ---- Shared: store the checkpoint token and move on to reader setup --------

    private void pairAndContinue(String token, String title, int contestId, String cpName) {
        // Switching races wipes any previous race's local buffer so old passings
        // never bleed into this one.
        if (!prefs.contestTitle().isEmpty() && !prefs.contestTitle().equals(title)) {
            try { new com.velogrip.rfid.db.RaceStore(this).clearRace(); } catch (Exception ignored) { }
        }
        prefs.savePairing(token, title, prefs.accountEmail(), contestId);
        prefs.setContestTitle(title);
        Toast.makeText(this, getString(R.string.joined_as, cpName.isEmpty() ? title : cpName),
                Toast.LENGTH_LONG).show();
        startActivity(new Intent(this, RaceSetupActivity.class));
        finish();
    }

    private static String fmtDate(String iso) {
        try {
            java.text.SimpleDateFormat in = new java.text.SimpleDateFormat("yyyy-MM-dd", Locale.US);
            java.util.Date d = in.parse(iso.substring(0, 10));
            return java.text.DateFormat.getDateInstance(java.text.DateFormat.MEDIUM).format(d);
        } catch (Exception e) {
            return iso;
        }
    }
}

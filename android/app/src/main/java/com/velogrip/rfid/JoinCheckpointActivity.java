package com.velogrip.rfid;

import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.view.View;
import android.widget.Button;
import android.widget.EditText;
import android.widget.TextView;
import android.widget.Toast;

import com.velogrip.rfid.net.Uploader;

import org.json.JSONObject;

/**
 * "Join as checkpoint": a secondary phone becomes a checkpoint reader for a race
 * by entering the short join code shown on the web Manage tab (or by opening the
 * QR deep link, which pre-fills the code and the server URL). The server mints a
 * checkpoint reader token and returns it — no login, no long token to copy. On
 * success the phone is paired to that checkpoint token and moves on to reader
 * setup; from then on it uploads reads exactly like the finish device, and the
 * server records them as split times.
 */
public class JoinCheckpointActivity extends BaseActivity {

    private Prefs prefs;
    private EditText code, name;
    private Button join;
    private TextView status;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_join_checkpoint);
        prefs = new Prefs(this);

        ((TextView) findViewById(R.id.headerTitle)).setText(R.string.join_checkpoint);
        findViewById(R.id.backButton).setOnClickListener(v -> finish());
        findViewById(R.id.nextButton).setOnClickListener(v ->
                startActivity(new Intent(this, RaceSetupActivity.class)));

        code = findViewById(R.id.jcCode);
        name = findViewById(R.id.jcName);
        join = findViewById(R.id.jcJoin);
        status = findViewById(R.id.jcStatus);
        join.setOnClickListener(v -> submit());

        // Opened from a QR deep link (velogrip://join?code=...&base=... or an
        // https .../join?code=... link): pre-fill the code and point at the
        // server the QR came from.
        prefillFromDeepLink(getIntent());
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
        if (c != null && !c.isEmpty()) code.setText(c.toUpperCase());
        String base = data.getQueryParameter("base");
        if (base != null && !base.isEmpty()) {
            prefs.setServerUrl(base);
        } else if (data.getScheme() != null && data.getScheme().startsWith("http")) {
            // Derive the server URL from an https deep link by dropping /join...
            String path = data.getPath() == null ? "" : data.getPath();
            String trimmed = path.replaceAll("/join/?$", "");
            prefs.setServerUrl(data.getScheme() + "://" + data.getAuthority() + trimmed);
        }
    }

    private void submit() {
        final String c = code.getText().toString().toUpperCase().replaceAll("[^0-9A-Z]", "");
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
                runOnUiThread(() -> {
                    // Pair this phone to the checkpoint token. Switching races wipes
                    // any previous race's local buffer so old passings never bleed in.
                    if (!prefs.contestTitle().isEmpty() && !prefs.contestTitle().equals(title)) {
                        try { new com.velogrip.rfid.db.RaceStore(this).clearRace(); } catch (Exception ignored) { }
                    }
                    prefs.savePairing(token, title, prefs.accountEmail(), contestId);
                    prefs.setContestTitle(title);
                    status.setText(getString(R.string.joined_as, cpName));
                    Toast.makeText(this, getString(R.string.joined_as, cpName), Toast.LENGTH_LONG).show();
                    // On to reader setup — the checkpoint still connects to its RFID
                    // reader and streams reads like any timing device.
                    startActivity(new Intent(this, RaceSetupActivity.class));
                    finish();
                });
            } catch (Exception e) {
                runOnUiThread(() -> {
                    join.setEnabled(true);
                    status.setText(getString(R.string.join_failed, e.getMessage()));
                });
            }
        }).start();
    }
}

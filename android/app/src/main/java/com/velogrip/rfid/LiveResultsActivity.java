package com.velogrip.rfid;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import android.view.View;
import android.widget.Switch;
import android.widget.TextView;
import android.widget.Toast;

/**
 * Live Results: posts standings to the web during the race and shows the
 * public results link (…/race-results/<id>) spectators can open. Every race
 * gets a link whether posting is on or off; when off, the page simply shows
 * whatever was last uploaded.
 */
public class LiveResultsActivity extends BaseActivity {

    private Prefs prefs;
    private TextView sportValue;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_live_results);
        findViewById(R.id.navSettings).setOnClickListener(v -> startActivity(new android.content.Intent(this, SettingsActivity.class)));
        prefs = new Prefs(this);

        ((TextView) findViewById(R.id.headerTitle)).setText(R.string.live_results_title);
        findViewById(R.id.backButton).setOnClickListener(v -> finish());
        findViewById(R.id.nextButton).setVisibility(View.GONE);

        Switch post = findViewById(R.id.swPost);
        post.setChecked(prefs.liveResults());
        post.setOnCheckedChangeListener((b, on) -> prefs.setLiveResults(on));

        Switch priv = findViewById(R.id.swPrivate);
        priv.setChecked(prefs.resultsPrivate());
        priv.setOnCheckedChangeListener((b, on) -> prefs.setResultsPrivate(on));

        Switch email = findViewById(R.id.swEmail);
        email.setChecked(prefs.emailParticipants());
        email.setOnCheckedChangeListener((b, on) -> {
            if (on) {
                b.setChecked(false);
                Toast.makeText(this, R.string.email_unsupported, Toast.LENGTH_LONG).show();
            }
        });

        sportValue = findViewById(R.id.sportValue);
        sportValue.setText(prefs.sport().isEmpty() ? getString(R.string.sport_running) : prefs.sport());
        findViewById(R.id.sportBox).setOnClickListener(v -> pickSport());

        String url = prefs.publicResultsUrl();
        ((TextView) findViewById(R.id.urlValue)).setText(url);
        ((TextView) findViewById(R.id.lastUpdate)).setText(
                prefs.contestId() > 0 ? getString(R.string.last_update_none) : getString(R.string.pair_race_first));

        findViewById(R.id.copyUrl).setOnClickListener(v -> {
            android.content.ClipboardManager cb =
                    (android.content.ClipboardManager) getSystemService(CLIPBOARD_SERVICE);
            cb.setPrimaryClip(android.content.ClipData.newPlainText("results", url));
            Toast.makeText(this, R.string.copied, Toast.LENGTH_SHORT).show();
        });
        findViewById(R.id.shareUrl).setOnClickListener(v -> {
            Intent share = new Intent(Intent.ACTION_SEND);
            share.setType("text/plain");
            share.putExtra(Intent.EXTRA_SUBJECT, prefs.contestTitle());
            share.putExtra(Intent.EXTRA_TEXT, url);
            startActivity(Intent.createChooser(share, getString(R.string.share_link)));
        });
        findViewById(R.id.openUrl).setOnClickListener(v -> {
            try {
                startActivity(new Intent(Intent.ACTION_VIEW, android.net.Uri.parse(url)));
            } catch (Exception e) {
                Toast.makeText(this, R.string.no_browser, Toast.LENGTH_LONG).show();
            }
        });
    }

    private void pickSport() {
        final String[] sports = getResources().getStringArray(R.array.sports);
        new android.app.AlertDialog.Builder(this)
                .setTitle(R.string.sport_label)
                .setItems(sports, (d, which) -> {
                    prefs.setSport(sports[which]);
                    sportValue.setText(sports[which]);
                })
                .show();
    }
}

package com.velogrip.rfid;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.View;
import android.widget.TextView;
import android.widget.Toast;

import com.velogrip.rfid.db.RaceStore;
import com.velogrip.rfid.net.Uploader;

import java.util.List;

/**
 * Post Results — publish the finished race to the web. One destination only:
 * the VeloGripScorer deployment. Tapping "Post to the web" uploads any
 * outstanding gun times and passings, enables the public results page, and
 * surfaces its shareable link (…/race-results/&lt;id&gt;).
 */
public class PostResultsActivity extends Activity {

    private Prefs prefs;
    private RaceStore store;
    private TextView sportValue, postStatus;
    private final Handler ui = new Handler(Looper.getMainLooper());

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_post_results);
        prefs = new Prefs(this);
        store = new RaceStore(this);

        ((TextView) findViewById(R.id.headerTitle)).setText(R.string.post_results_title);
        findViewById(R.id.backButton).setOnClickListener(v -> finish());
        findViewById(R.id.nextButton).setVisibility(View.GONE);

        sportValue = findViewById(R.id.sportValue);
        sportValue.setText(prefs.sport().isEmpty() ? getString(R.string.sport_running) : prefs.sport());
        findViewById(R.id.sportBox).setOnClickListener(v -> pickSport());

        postStatus = findViewById(R.id.postStatus);

        String url = prefs.publicResultsUrl();
        ((TextView) findViewById(R.id.urlValue)).setText(url);

        findViewById(R.id.postWeb).setOnClickListener(v -> postToWeb());
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

    @Override
    protected void onDestroy() {
        super.onDestroy();
        if (store != null) store.close();
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

    /** Push outstanding gun times + passings to the deployment on a worker thread. */
    private void postToWeb() {
        if (prefs.readerToken().isEmpty() || prefs.contestId() <= 0) {
            new android.app.AlertDialog.Builder(this)
                    .setTitle(R.string.post_results_title)
                    .setMessage(R.string.pair_race_first)
                    .setPositiveButton(android.R.string.ok, null)
                    .show();
            return;
        }
        prefs.setLiveResults(true);
        postStatus.setText(R.string.posting);
        new Thread(() -> {
            String result;
            try {
                Uploader uploader = new Uploader(prefs.serverUrl(), prefs.readerToken());
                // Re-send every gun time (force) so the web clock matches the app,
                // even for waves already synced with an out-of-date start.
                for (RaceStore.Wave wave : store.waves()) {
                    if (wave.name.isEmpty() || wave.startedAtMs == null) continue;
                    if (uploader.uploadWaveStart(wave.name, wave.startedAtMs)) store.markWaveSynced(wave.name);
                }
                int sent = 0;
                List<RaceStore.Passing> batch;
                while (!(batch = store.pendingUpload(200)).isEmpty()) {
                    if (!uploader.upload(batch)) break;
                    store.markUploaded(batch.get(batch.size() - 1).id);
                    sent += batch.size();
                }
                result = getString(R.string.posted_ok, sent);
            } catch (Exception e) {
                result = getString(R.string.post_failed, e.getMessage() == null ? "" : e.getMessage());
            }
            final String msg = result;
            ui.post(() -> postStatus.setText(msg));
        }).start();
    }
}

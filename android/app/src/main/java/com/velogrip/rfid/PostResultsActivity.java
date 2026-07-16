package com.velogrip.rfid;

import android.app.Activity;
import android.content.ContentValues;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.MediaStore;
import android.util.Base64;
import android.view.View;
import android.widget.ImageView;
import android.widget.TextView;
import android.widget.Toast;

import com.velogrip.rfid.db.RaceStore;
import com.velogrip.rfid.net.Uploader;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.util.List;

/**
 * Post Results — publish the finished race to the web. One destination only:
 * the VeloGripScorer deployment. Tapping "Post to the web" uploads any
 * outstanding gun times and passings, enables the public results page, and
 * surfaces its shareable link (…/race-results/&lt;id&gt;).
 */
public class PostResultsActivity extends BaseActivity {

    private static final int REQ_GALLERY = 71, REQ_CAMERA = 72;

    private Prefs prefs;
    private RaceStore store;
    private TextView sportValue, postStatus;
    private ImageView photoPreview;
    private String photoDataUrl;       // data:image/jpeg;base64,… to publish with the results
    private Uri pendingCameraUri;      // MediaStore target the camera app writes to
    private final Handler ui = new Handler(Looper.getMainLooper());

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_post_results);
        findViewById(R.id.navSettings).setOnClickListener(v -> startActivity(new android.content.Intent(this, SettingsActivity.class)));
        prefs = new Prefs(this);
        store = new RaceStore(this);

        ((TextView) findViewById(R.id.headerTitle)).setText(R.string.post_results_title);
        findViewById(R.id.backButton).setOnClickListener(v -> finish());
        findViewById(R.id.nextButton).setVisibility(View.GONE);

        sportValue = findViewById(R.id.sportValue);
        sportValue.setText(prefs.sport().isEmpty() ? getString(R.string.sport_running) : prefs.sport());
        findViewById(R.id.sportBox).setOnClickListener(v -> pickSport());

        postStatus = findViewById(R.id.postStatus);

        photoPreview = findViewById(R.id.photoPreview);
        findViewById(R.id.addPhoto).setOnClickListener(v -> pickFromGallery());
        findViewById(R.id.takePhoto).setOnClickListener(v -> takePhoto());
        findViewById(R.id.clearPhoto).setOnClickListener(v -> setPhoto(null, null));

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

    // ---- race photo ----

    private void pickFromGallery() {
        Intent pick = new Intent(Intent.ACTION_GET_CONTENT);
        pick.setType("image/*");
        pick.addCategory(Intent.CATEGORY_OPENABLE);
        try {
            startActivityForResult(Intent.createChooser(pick, getString(R.string.add_photo)), REQ_GALLERY);
        } catch (Exception e) {
            Toast.makeText(this, R.string.no_photo_app, Toast.LENGTH_LONG).show();
        }
    }

    private void takePhoto() {
        ContentValues values = new ContentValues();
        values.put(MediaStore.Images.Media.DISPLAY_NAME, "velogrip_" + System.currentTimeMillis() + ".jpg");
        values.put(MediaStore.Images.Media.MIME_TYPE, "image/jpeg");
        pendingCameraUri = getContentResolver().insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values);
        if (pendingCameraUri == null) { Toast.makeText(this, R.string.no_photo_app, Toast.LENGTH_LONG).show(); return; }
        Intent cam = new Intent(MediaStore.ACTION_IMAGE_CAPTURE);
        cam.putExtra(MediaStore.EXTRA_OUTPUT, pendingCameraUri);
        try {
            startActivityForResult(cam, REQ_CAMERA);
        } catch (Exception e) {
            Toast.makeText(this, R.string.no_photo_app, Toast.LENGTH_LONG).show();
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (resultCode != RESULT_OK) return;
        Uri uri = requestCode == REQ_CAMERA ? pendingCameraUri
                : (data != null ? data.getData() : null);
        if (uri == null) return;
        new Thread(() -> {
            String encoded = encodePhoto(uri);
            Bitmap thumb = null;
            if (encoded != null) {
                byte[] jpeg = Base64.decode(encoded.substring(encoded.indexOf(',') + 1), Base64.DEFAULT);
                thumb = BitmapFactory.decodeByteArray(jpeg, 0, jpeg.length);
            }
            final String enc = encoded;
            final Bitmap preview = thumb;
            ui.post(() -> {
                if (enc == null) { Toast.makeText(this, R.string.photo_failed, Toast.LENGTH_LONG).show(); return; }
                setPhoto(enc, preview);
            });
        }).start();
    }

    private void setPhoto(String dataUrl, Bitmap preview) {
        photoDataUrl = dataUrl;
        boolean has = dataUrl != null;
        photoPreview.setVisibility(has ? View.VISIBLE : View.GONE);
        findViewById(R.id.clearPhoto).setVisibility(has ? View.VISIBLE : View.GONE);
        if (has && preview != null) photoPreview.setImageBitmap(preview);
        else photoPreview.setImageDrawable(null);
    }

    /** Decode, downscale (max 1000px) and JPEG-encode the picked image to a
     *  data URL small enough to publish with the results. */
    private String encodePhoto(Uri uri) {
        try {
            BitmapFactory.Options bounds = new BitmapFactory.Options();
            bounds.inJustDecodeBounds = true;
            InputStream in = getContentResolver().openInputStream(uri);
            BitmapFactory.decodeStream(in, null, bounds);
            if (in != null) in.close();

            int max = 1000, sample = 1;
            while (bounds.outWidth / sample > max * 2 || bounds.outHeight / sample > max * 2) sample *= 2;
            BitmapFactory.Options opts = new BitmapFactory.Options();
            opts.inSampleSize = sample;
            InputStream in2 = getContentResolver().openInputStream(uri);
            Bitmap bmp = BitmapFactory.decodeStream(in2, null, opts);
            if (in2 != null) in2.close();
            if (bmp == null) return null;

            int w = bmp.getWidth(), h = bmp.getHeight();
            if (w > max || h > max) {
                float scale = w >= h ? (float) max / w : (float) max / h;
                Bitmap scaled = Bitmap.createScaledBitmap(bmp, Math.round(w * scale), Math.round(h * scale), true);
                if (scaled != bmp) bmp.recycle();
                bmp = scaled;
            }
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            bmp.compress(Bitmap.CompressFormat.JPEG, 82, out);
            bmp.recycle();
            return "data:image/jpeg;base64," + Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP);
        } catch (Exception e) {
            return null;
        }
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
                if (photoDataUrl != null) uploader.uploadPhoto(photoDataUrl); // publish the race photo
                uploader.finishRace(); // list it under the web's Finished races
                result = getString(R.string.posted_ok, sent);
            } catch (Exception e) {
                result = getString(R.string.post_failed, e.getMessage() == null ? "" : e.getMessage());
            }
            final String msg = result;
            ui.post(() -> postStatus.setText(msg));
        }).start();
    }
}

package com.velogrip.rfid;

import android.app.Activity;
import android.os.Bundle;
import android.view.Gravity;
import android.view.View;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

/**
 * "Scan for Reader": sweeps the WiFi subnet, showing the address being probed
 * and listing every reader found. The first reader found is saved to the RFID
 * readers field straight away (and tapping a listed address re-selects it), so
 * returning to Chip Timing shows the reader as the default.
 */
public class ScanReaderActivity extends Activity {

    private Prefs prefs;
    private TextView status;
    private LinearLayout foundBox;
    private Button scanBtn, stopBtn;
    private ReaderScanner.Handle handle;
    private String selected;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_scan_reader);
        findViewById(R.id.navSettings).setOnClickListener(v -> startActivity(new android.content.Intent(this, SettingsActivity.class)));
        prefs = new Prefs(this);

        ((TextView) findViewById(R.id.headerTitle)).setText(R.string.scan_reader_title);
        // Header ❮ acts as the X (cancel); ❯ confirms the selection.
        ((TextView) findViewById(R.id.backButton)).setText("✕");
        findViewById(R.id.backButton).setOnClickListener(v -> { cancelScan(); finish(); });
        View next = findViewById(R.id.nextButton);
        ((TextView) next).setText("✓");
        next.setVisibility(View.VISIBLE);
        next.setOnClickListener(v -> {
            if (selected != null) prefs.saveReaderHostPort(selected, prefs.readerPort());
            cancelScan();
            finish();
        });

        status = findViewById(R.id.scanStatus);
        foundBox = findViewById(R.id.foundBox);
        scanBtn = findViewById(R.id.scanBtn);
        stopBtn = findViewById(R.id.stopBtn);

        scanBtn.setOnClickListener(v -> startScan());
        stopBtn.setOnClickListener(v -> cancelScan());
    }

    private void startScan() {
        foundBox.removeAllViews();
        selected = null;
        scanBtn.setEnabled(false);
        stopBtn.setEnabled(true);
        status.setText(getString(R.string.scanning_address, "…"));
        final int port = prefs.readerPort();
        handle = ReaderScanner.scanProgressive(this, prefs.readerHost(), port, 250,
                new ReaderScanner.ScanListener() {
                    @Override
                    public void onProgress(String ip) {
                        runOnUiThread(() -> status.setText(getString(R.string.scanning_address, ip)));
                    }

                    @Override
                    public void onFound(String ip) {
                        runOnUiThread(() -> addFound(ip));
                    }

                    @Override
                    public void onFinished(boolean cancelled, boolean noSubnet) {
                        runOnUiThread(() -> {
                            scanBtn.setEnabled(true);
                            stopBtn.setEnabled(false);
                            if (noSubnet) {
                                status.setText(R.string.scan_no_wifi);
                            } else if (cancelled) {
                                status.setText(R.string.scan_stopped);
                            } else if (foundBox.getChildCount() == 0) {
                                status.setText(R.string.scan_none_found);
                            } else {
                                status.setText(R.string.scan_complete);
                            }
                        });
                    }
                });
    }

    private void addFound(String ip) {
        // first reader found becomes the default straight away
        if (selected == null) {
            selected = ip;
            prefs.saveReaderHostPort(ip, prefs.readerPort());
            Toast.makeText(this, getString(R.string.reader_saved, ip), Toast.LENGTH_LONG).show();
        }
        TextView row = new TextView(this);
        row.setText(ip);
        row.setTextSize(19);
        row.setPadding(8, 28, 8, 28);
        row.setGravity(Gravity.CENTER_VERTICAL);
        row.setOnClickListener(v -> select(ip));
        foundBox.addView(row);
        View divider = new View(this);
        divider.setBackgroundColor(0xFFDDDDDD);
        divider.setLayoutParams(new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, 1));
        foundBox.addView(divider);
        highlight();
    }

    private void select(String ip) {
        selected = ip;
        prefs.saveReaderHostPort(ip, prefs.readerPort());
        Toast.makeText(this, getString(R.string.reader_saved, ip), Toast.LENGTH_SHORT).show();
        highlight();
    }

    private void highlight() {
        for (int i = 0; i < foundBox.getChildCount(); i++) {
            View child = foundBox.getChildAt(i);
            if (child instanceof TextView) {
                boolean on = ((TextView) child).getText().toString().equals(selected);
                child.setBackgroundColor(on ? 0xFFE6F4D8 : 0x00000000);
                ((TextView) child).setTextColor(on ? 0xFF3F7A16 : 0xFF111111);
                ((TextView) child).setTypeface(null,
                        on ? android.graphics.Typeface.BOLD : android.graphics.Typeface.NORMAL);
            }
        }
    }

    private void cancelScan() {
        if (handle != null) handle.cancel();
        scanBtn.setEnabled(true);
        stopBtn.setEnabled(false);
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        cancelScan();
    }
}

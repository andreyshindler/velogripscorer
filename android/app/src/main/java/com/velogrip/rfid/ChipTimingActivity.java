package com.velogrip.rfid;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import android.view.View;
import android.widget.Button;
import android.widget.EditText;
import android.widget.Switch;
import android.widget.TextView;
import android.widget.Toast;

import java.net.InetSocketAddress;
import java.net.Socket;
import java.util.Locale;

/**
 * Chip Timing — the reader configuration reached from Hardware Setup. Sets the
 * reader IP, scans for readers, and holds the chip-detection settings. The two
 * mm:ss timers drive the on-device results (start suppression and minimum lap
 * gap); "Test connection" opens a socket to the reader to confirm it answers.
 */
public class ChipTimingActivity extends Activity {

    private Prefs prefs;
    private TextView systemValue;
    private EditText readerHost, chipsPerRacer, suppress, lapGap, antennaPower;
    private Switch chipIdBib, beepUnknown;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_chip_timing);
        prefs = new Prefs(this);

        ((TextView) findViewById(R.id.headerTitle)).setText(R.string.chip_timing_title);
        findViewById(R.id.backButton).setOnClickListener(v -> finish());
        findViewById(R.id.nextButton).setVisibility(View.VISIBLE);
        findViewById(R.id.nextButton).setOnClickListener(v -> {
            save();
            startActivity(new Intent(this, RaceActivity.class));
        });

        systemValue = findViewById(R.id.systemValue);
        readerHost = findViewById(R.id.readerHost);
        chipsPerRacer = findViewById(R.id.chipsPerRacer);
        suppress = findViewById(R.id.suppress);
        lapGap = findViewById(R.id.lapGap);
        antennaPower = findViewById(R.id.antennaPower);
        chipIdBib = findViewById(R.id.swChipIdBib);
        beepUnknown = findViewById(R.id.swBeepUnknown);

        readerHost.setText(prefs.readerHost());
        chipsPerRacer.setText(String.valueOf(prefs.chipsPerRacer()));
        suppress.setText(mmss(prefs.suppressSecs()));
        lapGap.setText(mmss(prefs.lapGapSecs()));
        antennaPower.setText(String.valueOf(prefs.antennaPower()));
        chipIdBib.setChecked(prefs.chipIdEqualsBib());
        beepUnknown.setChecked(prefs.beepUnknownChip());

        Button scan = findViewById(R.id.scanReader);
        scan.setOnClickListener(v -> {
            save();
            scan.setEnabled(false);
            Toast.makeText(this, R.string.scan_started, Toast.LENGTH_SHORT).show();
            int port = prefs.readerPort();
            new Thread(() -> {
                String found = ReaderScanner.scan(this, readerHost.getText().toString().trim(), port);
                runOnUiThread(() -> {
                    scan.setEnabled(true);
                    if (found != null) {
                        readerHost.setText(found);
                        prefs.saveReaderHostPort(found, port);
                        Toast.makeText(this, getString(R.string.scan_found, found), Toast.LENGTH_LONG).show();
                    } else {
                        Toast.makeText(this, R.string.scan_not_found, Toast.LENGTH_LONG).show();
                    }
                });
            }).start();
        });

        int[] unsupported = {R.id.swPartialChip, R.id.swChipStartTime,
                R.id.swChipCheckin, R.id.swShowPopup};
        for (int id : unsupported) {
            Switch sw = findViewById(id);
            sw.setOnCheckedChangeListener((b, on) -> {
                if (on) {
                    b.setChecked(false);
                    Toast.makeText(this, R.string.chip_option_unsupported, Toast.LENGTH_LONG).show();
                }
            });
        }
        findViewById(R.id.rowProgramChips).setOnClickListener(v ->
                Toast.makeText(this, R.string.chip_option_unsupported, Toast.LENGTH_LONG).show());

        findViewById(R.id.navSettings).setOnClickListener(v -> {
            save();
            startActivity(new Intent(this, SettingsActivity.class));
        });
        findViewById(R.id.navTest).setOnClickListener(v -> testConnection());
    }

    @Override
    protected void onResume() {
        super.onResume();
        systemValue.setText(protocolLabel(prefs.protocol()));
        readerHost.setText(prefs.readerHost());
    }

    private void testConnection() {
        save();
        String host = readerHost.getText().toString().trim();
        if (Prefs.PROTOCOL_DEMO.equals(prefs.protocol())) {
            Toast.makeText(this, R.string.test_demo_ok, Toast.LENGTH_LONG).show();
            return;
        }
        if (host.isEmpty()) {
            Toast.makeText(this, R.string.reader_needs_config, Toast.LENGTH_LONG).show();
            return;
        }
        final int port = prefs.readerPort();
        Toast.makeText(this, R.string.test_connecting, Toast.LENGTH_SHORT).show();
        new Thread(() -> {
            String message;
            try (Socket socket = new Socket()) {
                socket.connect(new InetSocketAddress(host, port), 4000);
                message = getString(R.string.test_reader_ok, host, port);
            } catch (Exception e) {
                message = getString(R.string.test_reader_failed, e.getMessage());
            }
            final String text = message;
            runOnUiThread(() -> Toast.makeText(this, text, Toast.LENGTH_LONG).show());
        }).start();
    }

    private void save() {
        prefs.saveReaderHostPort(readerHost.getText().toString().trim(), prefs.readerPort());
        prefs.saveChipTiming(
                chipIdBib.isChecked(),
                intOf(chipsPerRacer.getText().toString(), 2),
                parseMmss(suppress.getText().toString()),
                parseMmss(lapGap.getText().toString()),
                intOf(antennaPower.getText().toString(), 100),
                beepUnknown.isChecked());
    }

    private String protocolLabel(String protocol) {
        if (Prefs.PROTOCOL_LLRP.equals(protocol)) return getString(R.string.proto_llrp);
        if (Prefs.PROTOCOL_UHF.equals(protocol)) return getString(R.string.proto_uhf);
        if (Prefs.PROTOCOL_DEMO.equals(protocol)) return getString(R.string.proto_demo);
        return getString(R.string.proto_ascii);
    }

    private static String mmss(int totalSeconds) {
        return String.format(Locale.US, "%02d:%02d", totalSeconds / 60, totalSeconds % 60);
    }

    private static int parseMmss(String text) {
        text = text.trim();
        try {
            if (text.contains(":")) {
                String[] parts = text.split(":");
                int m = Integer.parseInt(parts[0].trim());
                int s = parts.length > 1 ? Integer.parseInt(parts[1].trim()) : 0;
                return Math.max(0, m * 60 + s);
            }
            return Math.max(0, Integer.parseInt(text));
        } catch (NumberFormatException e) {
            return 0;
        }
    }

    private static int intOf(String value, int fallback) {
        try {
            return Integer.parseInt(value.trim());
        } catch (NumberFormatException e) {
            return fallback;
        }
    }
}

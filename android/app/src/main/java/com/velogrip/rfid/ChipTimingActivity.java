package com.velogrip.rfid;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import android.view.Gravity;
import android.view.View;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.NumberPicker;
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

        WizardNav.attach(this, WizardNav.CHIP_TIMING);
        findViewById(R.id.backButton).setOnClickListener(v -> finish());
        findViewById(R.id.nextButton).setVisibility(View.VISIBLE);
        findViewById(R.id.nextButton).setOnClickListener(v -> {
            save();
            startActivity(new Intent(this, StartListActivity.class));
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
        // Set these two timers with a scroll-wheel picker instead of typing.
        makeScrollable(suppress, R.string.no_detect_after_start);
        makeScrollable(lapGap, R.string.no_redetect_after_lap);
        antennaPower.setText(String.valueOf(prefs.antennaPower()));
        chipIdBib.setChecked(prefs.chipIdEqualsBib());
        beepUnknown.setChecked(prefs.beepUnknownChip());

        Button scan = findViewById(R.id.scanReader);
        scan.setOnClickListener(v -> {
            save(); // persist the typed IP/port before scanning
            startActivity(new Intent(this, ScanReaderActivity.class));
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
        findViewById(R.id.rowProgramChips).setOnClickListener(v -> {
            save();
            startActivity(new Intent(this, ProgramChipsActivity.class));
        });

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

    /** Turn a time field into a tap-to-open mm:ss scroll-wheel picker. */
    private void makeScrollable(EditText field, int titleRes) {
        field.setFocusable(false);
        field.setClickable(true);
        field.setOnClickListener(v -> showMmssPicker(field, titleRes));
    }

    private void showMmssPicker(EditText field, int titleRes) {
        int total = parseMmss(field.getText().toString());
        float d = getResources().getDisplayMetrics().density;
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.HORIZONTAL);
        box.setGravity(Gravity.CENTER);
        int pad = Math.round(16 * d);
        box.setPadding(pad, pad, pad, pad);

        NumberPicker min = new NumberPicker(this);
        min.setMinValue(0);
        min.setMaxValue(59);
        min.setValue(total / 60);
        NumberPicker sec = new NumberPicker(this);
        sec.setMinValue(0);
        sec.setMaxValue(59);
        sec.setValue(total % 60);
        sec.setFormatter(i -> String.format(Locale.US, "%02d", i));

        TextView colon = new TextView(this);
        colon.setText(":");
        colon.setTextSize(26);
        colon.setPadding(pad / 2, 0, pad / 2, 0);

        box.addView(min);
        box.addView(colon);
        box.addView(sec);

        new android.app.AlertDialog.Builder(this)
                .setTitle(titleRes)
                .setView(box)
                .setPositiveButton(android.R.string.ok,
                        (dlg, w) -> field.setText(mmss(min.getValue() * 60 + sec.getValue())))
                .setNegativeButton(android.R.string.cancel, null)
                .show();
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

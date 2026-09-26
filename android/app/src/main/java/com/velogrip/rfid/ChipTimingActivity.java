package com.velogrip.rfid;

import android.app.Activity;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
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

import java.util.Locale;

/**
 * Chip Timing — the reader configuration reached from Hardware Setup. Sets the
 * reader IP, scans for readers, and holds the chip-detection settings. The two
 * mm:ss timers drive the on-device results (start suppression and minimum lap
 * gap); "Test connection" opens a socket to the reader to confirm it answers.
 */
public class ChipTimingActivity extends BaseActivity {

    private Prefs prefs;
    private TextView systemValue;
    private EditText readerHost, chipsPerRacer, suppress, lapGap, antennaPower, rollCall;
    private android.widget.Switch rollCallOn;
    private Switch chipIdBib, beepUnknown, startBeepLong;
    private TextView readerStatus;
    // Set as soon as BridgeService tells us the reader state, so a race in
    // progress is never probed behind its back — see onResume.
    private boolean heardFromService;
    private final android.os.Handler ui = new android.os.Handler(android.os.Looper.getMainLooper());

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
        readerStatus = findViewById(R.id.readerStatus);
        readerStatus.setOnClickListener(v -> checkReader());   // tap to re-check
        // Re-check when the operator finishes typing a new IP, not on every
        // keystroke — each check opens a real connection to the reader.
        readerHost.setOnFocusChangeListener((v, hasFocus) -> {
            if (hasFocus) return;
            String typed = readerHost.getText().toString().trim();
            if (typed.equals(prefs.readerHost())) return;
            prefs.saveReaderHostPort(typed, prefs.readerPort());
            checkReader();
        });
        chipsPerRacer = findViewById(R.id.chipsPerRacer);
        suppress = findViewById(R.id.suppress);
        lapGap = findViewById(R.id.lapGap);
        antennaPower = findViewById(R.id.antennaPower);
        chipIdBib = findViewById(R.id.swChipIdBib);
        beepUnknown = findViewById(R.id.swBeepUnknown);
        startBeepLong = findViewById(R.id.swStartBeepLong);

        readerHost.setText(prefs.readerHost());
        chipsPerRacer.setText(String.valueOf(prefs.chipsPerRacer()));
        suppress.setText(mmss(prefs.suppressSecs()));
        lapGap.setText(mmss(prefs.lapGapSecs()));
        rollCall = findViewById(R.id.rollCall);
        rollCallOn = findViewById(R.id.rollCallOn);
        boolean rollCallEnabled = prefs.rollCallSecs() > 0;
        rollCallOn.setChecked(rollCallEnabled);
        rollCall.setText(mmss(rollCallEnabled ? prefs.rollCallSecs() : 120)); // default 2:00 when re-enabled
        rollCall.setEnabled(rollCallEnabled);
        rollCall.setAlpha(rollCallEnabled ? 1f : 0.4f); // grayed out while the toggle is off
        final View rollCallHint = findViewById(R.id.rollCallHint);
        rollCallHint.setVisibility(rollCallEnabled ? View.VISIBLE : View.GONE);
        rollCallOn.setOnCheckedChangeListener((b, checked) -> {
            rollCall.setEnabled(checked);
            rollCall.setAlpha(checked ? 1f : 0.4f);
            rollCallHint.setVisibility(checked ? View.VISIBLE : View.GONE);
        });
        // Start suppression and the minimum lap gap belong to the race, not the
        // tablet: the start-list sync overwrites them here on every download and
        // never sends them back, and the published results are scored with the
        // server's copy. Editing them here only ever looked like it worked, so
        // show them read-only and point the operator at the website.
        makeServerOwned(suppress);
        makeServerOwned(lapGap);
        // Set these timers with a scroll-wheel picker instead of typing.
        makeScrollable(rollCall, R.string.rollcall_window_hint);
        // Chips per racer is 1 or 2 (single chip, or two chips merged by bib).
        makeNumberScrollable(chipsPerRacer, 1, 2, R.string.chips_per_racer);
        antennaPower.setText(String.valueOf(prefs.antennaPower()));
        chipIdBib.setChecked(prefs.chipIdEqualsBib());
        beepUnknown.setChecked(prefs.beepUnknownChip());
        startBeepLong.setChecked(prefs.startBeepLong());

        final android.widget.SeekBar beepVolume = findViewById(R.id.beepVolume);
        final TextView beepVolumeLabel = findViewById(R.id.beepVolumeLabel);
        beepVolume.setProgress(prefs.beepVolume());
        beepVolumeLabel.setText(prefs.beepVolume() + "%");
        beepVolume.setOnSeekBarChangeListener(new android.widget.SeekBar.OnSeekBarChangeListener() {
            @Override public void onProgressChanged(android.widget.SeekBar sb, int p, boolean fromUser) {
                beepVolumeLabel.setText(p + "%");
            }
            @Override public void onStartTrackingTouch(android.widget.SeekBar sb) { }
            @Override public void onStopTrackingTouch(android.widget.SeekBar sb) {
                previewBeep(sb.getProgress()); // hear the chosen loudness
            }
        });

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

    /** While a race is running BridgeService owns the reader and publishes its
     *  state; reflect that instead of connecting, so this screen can never take
     *  the reader's single client slot out from under a live race. */
    private final BroadcastReceiver bridgeReceiver = new BroadcastReceiver() {
        @Override public void onReceive(Context c, Intent i) {
            heardFromService = true;
            showReader(i.getBooleanExtra(BridgeService.EXTRA_READER_CONNECTED, false),
                    prefs.readerHost() + ":" + prefs.readerPort());
        }
    };

    @Override
    protected void onResume() {
        super.onResume();
        systemValue.setText(protocolLabel(prefs.protocol()));
        readerHost.setText(prefs.readerHost());

        heardFromService = false;
        registerReceiver(bridgeReceiver, new IntentFilter(BridgeService.ACTION_STATUS));
        readerStatus.setText(R.string.connecting);
        readerStatus.setTextColor(getColor(R.color.text_muted));
        // Give the service a moment to answer. Only if it doesn't — the normal
        // setup case, where it isn't running at all — do we connect ourselves.
        ui.postDelayed(() -> { if (!heardFromService) checkReader(); }, 900);
    }

    @Override
    protected void onPause() {
        super.onPause();
        ui.removeCallbacksAndMessages(null);
        try { unregisterReceiver(bridgeReceiver); } catch (IllegalArgumentException ignored) { }
    }

    /** Ask the reader whether it is there, and say so on screen. Connects,
     *  reports, and releases at once: an LLRP reader takes one client, so
     *  holding it would lock out Program Chips and the race service. */
    private void checkReader() {
        if (heardFromService) return;   // a running race already owns the answer
        readerStatus.setText(R.string.connecting);
        readerStatus.setTextColor(getColor(R.color.text_muted));
        final ChipProgrammer probe = new ChipProgrammer(this, prefs,
                (message, connected) -> runOnUiThread(() -> showReader(connected, message)));
        new Thread(() -> {
            try { probe.connect(); } finally { probe.close(); }
        }).start();
    }

    private void showReader(boolean connected, String message) {
        readerStatus.setText(connected ? getString(R.string.connected_reader, message) : message);
        readerStatus.setTextColor(connected ? 0xFF3F7A16 : 0xFFC0392B);
    }

    /** The same check the indicator runs, with the reason spelled out in a toast.
     *
     *  This used to open a bare `new Socket()`, which rides Android's default
     *  network. With the reader on a router that has no internet uplink, the
     *  tablet keeps WiFi as default and the connection leaves on the wrong
     *  interface — so a reader that was plugged in and working reported a
     *  failure every time. ChipProgrammer binds to the interface on the
     *  reader's own subnet (ReaderNet.pickForHost) and speaks LLRP, so a pass
     *  here means a reader actually answered. */
    private void testConnection() {
        save();
        if (Prefs.PROTOCOL_DEMO.equals(prefs.protocol())) {
            Toast.makeText(this, R.string.test_demo_ok, Toast.LENGTH_LONG).show();
            checkReader();
            return;
        }
        if (prefs.readerHost().isEmpty()) {
            Toast.makeText(this, R.string.reader_needs_config, Toast.LENGTH_LONG).show();
            return;
        }
        Toast.makeText(this, R.string.test_connecting, Toast.LENGTH_SHORT).show();
        final int port = prefs.readerPort();
        final ChipProgrammer probe = new ChipProgrammer(this, prefs, (message, connected) ->
                runOnUiThread(() -> {
                    showReader(connected, message);
                    Toast.makeText(this, connected
                            ? getString(R.string.test_reader_ok, prefs.readerHost(), port)
                            : getString(R.string.test_reader_failed, message),
                            Toast.LENGTH_LONG).show();
                }));
        new Thread(() -> {
            try { probe.connect(); } finally { probe.close(); }
        }).start();
    }

    /** A value the website owns: visible here, but not editable, and tapping it
     *  says where to change it. */
    private void makeServerOwned(EditText field) {
        field.setFocusable(false);
        field.setFocusableInTouchMode(false);
        field.setCursorVisible(false);
        field.setLongClickable(false);
        field.setAlpha(0.55f);
        field.setOnClickListener(v ->
                Toast.makeText(this, R.string.timing_set_on_web, Toast.LENGTH_LONG).show());
    }

    private void save() {
        prefs.saveReaderHostPort(readerHost.getText().toString().trim(), prefs.readerPort());
        prefs.saveChipTiming(
                chipIdBib.isChecked(),
                intOf(chipsPerRacer.getText().toString(), 2),
                // Keep whatever the last start-list sync wrote — these two are
                // the server's, and saving the on-screen text would fight it.
                prefs.suppressSecs(),
                prefs.lapGapSecs(),
                intOf(antennaPower.getText().toString(), 100),
                beepUnknown.isChecked(),
                rollCallOn.isChecked() ? parseMmss(rollCall.getText().toString()) : 0);
        prefs.setStartBeepLong(startBeepLong.isChecked());
        prefs.setBeepVolume(((android.widget.SeekBar) findViewById(R.id.beepVolume)).getProgress());
    }

    /** Short beep at the given loudness so the operator can hear the setting. */
    private void previewBeep(int volume) {
        prefs.setBeepVolume(volume); // persist so a Back-out keeps the choice
        try {
            final android.media.ToneGenerator tg = new android.media.ToneGenerator(
                    android.media.AudioManager.STREAM_NOTIFICATION, Math.max(1, volume));
            tg.startTone(android.media.ToneGenerator.TONE_PROP_BEEP, 150);
            new android.os.Handler(android.os.Looper.getMainLooper()).postDelayed(tg::release, 300);
        } catch (RuntimeException ignored) { }
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

    /** Turn a whole-number field into a tap-to-open scroll-wheel [min..max]. */
    private void makeNumberScrollable(EditText field, int min, int max, int titleRes) {
        field.setFocusable(false);
        field.setClickable(true);
        field.setOnClickListener(v -> {
            float d = getResources().getDisplayMetrics().density;
            NumberPicker picker = new NumberPicker(this);
            picker.setMinValue(min);
            picker.setMaxValue(max);
            picker.setValue(Math.max(min, Math.min(max, intOf(field.getText().toString(), min))));
            LinearLayout box = new LinearLayout(this);
            box.setGravity(Gravity.CENTER);
            int pad = Math.round(16 * d);
            box.setPadding(pad, pad, pad, pad);
            box.addView(picker);
            new android.app.AlertDialog.Builder(this)
                    .setTitle(titleRes)
                    .setView(box)
                    .setPositiveButton(android.R.string.ok,
                            (dlg, w) -> field.setText(String.valueOf(picker.getValue())))
                    .setNegativeButton(android.R.string.cancel, null)
                    .show();
        });
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

package com.velogrip.rfid;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import android.view.View;
import android.widget.CompoundButton;
import android.widget.Switch;
import android.widget.TextView;
import android.widget.Toast;

/**
 * Hardware setup — the last wizard step before the race console. Chip timing
 * on/off gates the reader connection in the race console; the chip-timing
 * system row opens the reader configuration (protocol, IP, scan). The other
 * external-hardware options mirror the reference but are not wired up yet.
 */
public class HardwareSetupActivity extends Activity {

    private Prefs prefs;
    private TextView systemValue;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_hardware_setup);
        prefs = new Prefs(this);

        WizardNav.attach(this, WizardNav.HARDWARE_SETUP);
        findViewById(R.id.backButton).setOnClickListener(v -> finish());
        findViewById(R.id.nextButton).setVisibility(View.VISIBLE);
        findViewById(R.id.nextButton).setOnClickListener(v -> {
            // chip timing on -> configure the reader next; off -> straight to the start list
            startActivity(new Intent(this, prefs.chipTiming()
                    ? ChipTimingActivity.class : StartListActivity.class));
        });

        Switch chip = findViewById(R.id.swChipTiming);
        chip.setChecked(prefs.chipTiming());
        View systemRow = findViewById(R.id.rowChipSystem);
        chip.setOnCheckedChangeListener((CompoundButton b, boolean on) -> {
            prefs.setChipTiming(on);
            systemRow.setAlpha(on ? 1f : 0.4f);
            systemRow.setEnabled(on);
        });
        systemRow.setAlpha(prefs.chipTiming() ? 1f : 0.4f);

        // "Chip timing system" is a dropdown of the supported protocols.
        systemValue = findViewById(R.id.chipSystemValue);
        findViewById(R.id.chipSystemBox).setOnClickListener(v -> {
            if (!prefs.chipTiming()) return;
            final String[] keys = {Prefs.PROTOCOL_ASCII, Prefs.PROTOCOL_LLRP,
                    Prefs.PROTOCOL_UHF, Prefs.PROTOCOL_DEMO};
            final String[] labels = {
                    getString(R.string.proto_ascii), getString(R.string.proto_llrp),
                    getString(R.string.proto_uhf), getString(R.string.proto_demo)};
            int current = 1; // RFID-LLRP default
            for (int i = 0; i < keys.length; i++) if (keys[i].equals(prefs.protocol())) current = i;
            new android.app.AlertDialog.Builder(this)
                    .setTitle(R.string.chip_timing_system)
                    .setSingleChoiceItems(labels, current, (dialog, which) -> {
                        prefs.setProtocol(keys[which]);
                        if (Prefs.PROTOCOL_LLRP.equals(keys[which])
                                && (prefs.readerPort() == 6000)) {
                            prefs.saveReaderHostPort(prefs.readerHost(), 5084);
                        }
                        systemValue.setText(labels[which]);
                        dialog.dismiss();
                    })
                    .setNegativeButton(android.R.string.cancel, null)
                    .show();
        });

        int[] unsupported = {R.id.swExternalTimer, R.id.swQrScanner, R.id.swTimeTrigger};
        for (int id : unsupported) {
            Switch sw = findViewById(id);
            sw.setOnCheckedChangeListener((b, on) -> {
                if (on) {
                    b.setChecked(false);
                    Toast.makeText(this, R.string.hardware_option_unsupported, Toast.LENGTH_LONG).show();
                }
            });
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        systemValue.setText(protocolLabel(prefs.protocol()));
    }

    private String protocolLabel(String protocol) {
        if (Prefs.PROTOCOL_LLRP.equals(protocol)) return getString(R.string.proto_llrp);
        if (Prefs.PROTOCOL_UHF.equals(protocol)) return getString(R.string.proto_uhf);
        if (Prefs.PROTOCOL_DEMO.equals(protocol)) return getString(R.string.proto_demo);
        return getString(R.string.proto_ascii);
    }
}

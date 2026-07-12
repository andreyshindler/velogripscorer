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

        ((TextView) findViewById(R.id.headerTitle)).setText(R.string.hardware_setup_title);
        findViewById(R.id.backButton).setOnClickListener(v -> finish());
        findViewById(R.id.nextButton).setVisibility(View.VISIBLE);
        findViewById(R.id.nextButton).setOnClickListener(v ->
                startActivity(new Intent(this, RaceActivity.class)));

        Switch chip = findViewById(R.id.swChipTiming);
        chip.setChecked(prefs.chipTiming());
        View systemRow = findViewById(R.id.rowChipSystem);
        chip.setOnCheckedChangeListener((CompoundButton b, boolean on) -> {
            prefs.setChipTiming(on);
            systemRow.setAlpha(on ? 1f : 0.4f);
            systemRow.setEnabled(on);
        });
        systemRow.setAlpha(prefs.chipTiming() ? 1f : 0.4f);

        systemValue = findViewById(R.id.chipSystemValue);
        findViewById(R.id.chipSystemBox).setOnClickListener(v -> {
            if (!prefs.chipTiming()) return;
            startActivity(new Intent(this, SettingsActivity.class));
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

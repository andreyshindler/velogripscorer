package com.velogrip.rfid;

import android.app.Activity;
import android.os.Bundle;
import android.view.View;
import android.widget.Button;
import android.widget.EditText;
import android.widget.TextView;
import android.widget.Toast;

/**
 * Program RFID Chips: connects to the reader on open, reads the EPC of the tag
 * in front of the antenna, and writes a new EPC. The new ID is padded with
 * leading zeros and, for a decimal existing ID, auto-incremented as a
 * convenience. Verify a write by tapping Read again.
 */
public class ProgramChipsActivity extends Activity {

    private Prefs prefs;
    private TextView status, oneChip, twoChip;
    private EditText existingId, newId;
    private Button readBtn, writeBtn;
    private ChipProgrammer programmer;
    private boolean twoPerId;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_program_chips);
        findViewById(R.id.navSettings).setOnClickListener(v -> startActivity(new android.content.Intent(this, SettingsActivity.class)));
        prefs = new Prefs(this);

        ((TextView) findViewById(R.id.headerTitle)).setText(R.string.program_chips_title);
        findViewById(R.id.backButton).setOnClickListener(v -> finish());
        findViewById(R.id.nextButton).setVisibility(View.GONE); // no forward from here

        status = findViewById(R.id.readerStatus);
        existingId = findViewById(R.id.existingId);
        newId = findViewById(R.id.newId);
        readBtn = findViewById(R.id.readBtn);
        writeBtn = findViewById(R.id.writeBtn);
        oneChip = findViewById(R.id.oneChip);
        twoChip = findViewById(R.id.twoChip);

        twoPerId = prefs.chipsPerRacer() >= 2;
        styleSegments();
        oneChip.setOnClickListener(v -> { twoPerId = false; prefs.saveChipsPerRacer(1); styleSegments(); });
        twoChip.setOnClickListener(v -> { twoPerId = true; prefs.saveChipsPerRacer(2); styleSegments(); });

        readBtn.setEnabled(false);
        writeBtn.setEnabled(false);
        readBtn.setOnClickListener(v -> readChip());
        writeBtn.setOnClickListener(v -> writeChip());

        connect();
    }

    private void connect() {
        status.setText(R.string.connecting);
        status.setTextColor(0xFFC0392B);
        programmer = new ChipProgrammer(prefs, (message, connected) -> runOnUiThread(() -> {
            status.setText(connected ? getString(R.string.connected_reader, message) : message);
            status.setTextColor(connected ? 0xFF3F7A16 : 0xFFC0392B);
            readBtn.setEnabled(connected);
            writeBtn.setEnabled(connected);
        }));
        new Thread(() -> programmer.connect()).start();
    }

    private void readChip() {
        readBtn.setEnabled(false);
        Toast.makeText(this, R.string.place_chip, Toast.LENGTH_SHORT).show();
        new Thread(() -> {
            String epc = programmer.readEpc(6000);
            runOnUiThread(() -> {
                readBtn.setEnabled(true);
                if (epc != null) {
                    existingId.setText(epc);
                    if (newId.getText().toString().trim().isEmpty()) newId.setText(nextId(epc));
                } else {
                    Toast.makeText(this, R.string.read_no_chip, Toast.LENGTH_LONG).show();
                }
            });
        }).start();
    }

    private void writeChip() {
        final String target = newId.getText().toString().trim().toUpperCase(java.util.Locale.US);
        if (target.isEmpty()) {
            Toast.makeText(this, R.string.enter_new_id, Toast.LENGTH_LONG).show();
            return;
        }
        new android.app.AlertDialog.Builder(this)
                .setTitle(R.string.write_chip)
                .setMessage(getString(R.string.write_confirm, target))
                .setPositiveButton(android.R.string.ok, (d, w) -> {
                    writeBtn.setEnabled(false);
                    new Thread(() -> {
                        boolean sent = programmer.writeEpc(target);
                        runOnUiThread(() -> {
                            writeBtn.setEnabled(true);
                            Toast.makeText(this, sent ? R.string.write_sent : R.string.write_failed,
                                    Toast.LENGTH_LONG).show();
                        });
                    }).start();
                })
                .setNegativeButton(android.R.string.cancel, null)
                .show();
    }

    /** Decimal EPCs auto-increment; hex is left to the user (padded on write). */
    private String nextId(String epc) {
        if (epc.matches("\\d+")) {
            try {
                java.math.BigInteger next = new java.math.BigInteger(epc).add(java.math.BigInteger.ONE);
                String s = next.toString();
                while (s.length() < epc.length()) s = "0" + s;
                return s;
            } catch (NumberFormatException ignored) { }
        }
        return epc;
    }

    private void styleSegments() {
        oneChip.setBackgroundResource(twoPerId ? R.drawable.bg_segment : R.drawable.bg_segment_on);
        oneChip.setTextColor(twoPerId ? 0xFF777777 : 0xFFFFFFFF);
        twoChip.setBackgroundResource(twoPerId ? R.drawable.bg_segment_on : R.drawable.bg_segment);
        twoChip.setTextColor(twoPerId ? 0xFFFFFFFF : 0xFF777777);
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        if (programmer != null) programmer.close();
    }
}

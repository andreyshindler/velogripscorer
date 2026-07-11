package com.velogrip.rfid;

import android.app.Activity;
import android.os.Bundle;
import android.widget.ArrayAdapter;
import android.widget.Button;
import android.widget.EditText;
import android.widget.Spinner;
import android.widget.Toast;

import com.velogrip.rfid.net.Uploader;

/** Configuration form: server, reader connection, protocol, reader WiFi. */
public class SettingsActivity extends Activity {

    private EditText serverUrl, readerToken, readerHost, readerPort;
    private EditText onConnectHex, pollHex, pollInterval, wifiSsid, wifiPass, dedupeWindow;
    private Spinner protocol;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_settings);

        serverUrl = findViewById(R.id.serverUrl);
        readerToken = findViewById(R.id.readerToken);
        readerHost = findViewById(R.id.readerHost);
        readerPort = findViewById(R.id.readerPort);
        protocol = findViewById(R.id.protocol);
        onConnectHex = findViewById(R.id.onConnectHex);
        pollHex = findViewById(R.id.pollHex);
        pollInterval = findViewById(R.id.pollInterval);
        wifiSsid = findViewById(R.id.wifiSsid);
        wifiPass = findViewById(R.id.wifiPass);
        dedupeWindow = findViewById(R.id.dedupeWindow);

        ArrayAdapter<CharSequence> adapter = ArrayAdapter.createFromResource(
                this, R.array.protocols, android.R.layout.simple_spinner_item);
        adapter.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item);
        protocol.setAdapter(adapter);

        Prefs prefs = new Prefs(this);
        serverUrl.setText(prefs.serverUrl());
        readerToken.setText(prefs.readerToken());
        readerHost.setText(prefs.readerHost());
        readerPort.setText(String.valueOf(prefs.readerPort()));
        protocol.setSelection(indexOfProtocol(prefs.protocol()));
        onConnectHex.setText(prefs.onConnectHex());
        pollHex.setText(prefs.pollHex());
        pollInterval.setText(String.valueOf(prefs.pollIntervalMs()));
        wifiSsid.setText(prefs.wifiSsid());
        wifiPass.setText(prefs.wifiPass());
        dedupeWindow.setText(String.valueOf(prefs.dedupeWindowMs()));

        Button save = findViewById(R.id.save);
        save.setOnClickListener(v -> {
            save(prefs);
            Toast.makeText(this, R.string.saved, Toast.LENGTH_SHORT).show();
            finish();
        });

        Button testServer = findViewById(R.id.testServer);
        testServer.setOnClickListener(v -> {
            save(prefs);
            testServer.setEnabled(false);
            new Thread(() -> {
                String result;
                try {
                    result = getString(R.string.test_ok) + " " +
                            new Uploader(prefs.serverUrl(), prefs.readerToken()).ping();
                } catch (Exception e) {
                    result = getString(R.string.test_failed) + " " + e.getMessage();
                }
                final String message = result;
                runOnUiThread(() -> {
                    testServer.setEnabled(true);
                    Toast.makeText(this, message, Toast.LENGTH_LONG).show();
                });
            }).start();
        });
    }

    private void save(Prefs prefs) {
        prefs.save(
                text(serverUrl), text(readerToken), text(readerHost),
                intOf(text(readerPort), 6000),
                protocolValue(protocol.getSelectedItemPosition()),
                text(onConnectHex), text(pollHex),
                intOf(text(pollInterval), 1000),
                text(wifiSsid), wifiPass.getText().toString(),
                intOf(text(dedupeWindow), 2000));
    }

    private String text(EditText field) {
        return field.getText().toString().trim();
    }

    private static int intOf(String value, int fallback) {
        try {
            return Integer.parseInt(value);
        } catch (NumberFormatException e) {
            return fallback;
        }
    }

    private static int indexOfProtocol(String value) {
        if (Prefs.PROTOCOL_UHF.equals(value)) return 1;
        if (Prefs.PROTOCOL_DEMO.equals(value)) return 2;
        return 0;
    }

    private static String protocolValue(int index) {
        if (index == 1) return Prefs.PROTOCOL_UHF;
        if (index == 2) return Prefs.PROTOCOL_DEMO;
        return Prefs.PROTOCOL_ASCII;
    }
}

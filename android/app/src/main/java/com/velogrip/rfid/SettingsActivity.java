package com.velogrip.rfid;

import android.app.Activity;
import android.os.Build;
import android.os.Bundle;
import android.widget.ArrayAdapter;
import android.widget.Button;
import android.widget.EditText;
import android.widget.Spinner;
import android.widget.TextView;
import android.widget.Toast;

import com.velogrip.rfid.net.Uploader;

import org.json.JSONArray;
import org.json.JSONObject;

/** Configuration form: server, reader connection, protocol, reader WiFi. */
public class SettingsActivity extends BaseActivity {

    private EditText serverUrl, readerToken, readerHost, readerPort;
    private EditText onConnectHex, pollHex, pollInterval, wifiSsid, wifiPass, dedupeWindow;
    private Spinner protocol;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_settings);
        if (getActionBar() != null) getActionBar().setDisplayHomeAsUpEnabled(true);

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
        EditText accountEmail = findViewById(R.id.accountEmail);
        accountEmail.setText(prefs.accountEmail());
        android.widget.TextView selectedRace = findViewById(R.id.selectedRace);
        selectedRace.setText(prefs.contestTitle());
        readerHost.setText(prefs.readerHost());
        readerPort.setText(String.valueOf(prefs.readerPort()));
        protocol.setSelection(indexOfProtocol(prefs.protocol()));
        onConnectHex.setText(prefs.onConnectHex());
        pollHex.setText(prefs.pollHex());
        pollInterval.setText(String.valueOf(prefs.pollIntervalMs()));
        wifiSsid.setText(prefs.wifiSsid());
        wifiPass.setText(prefs.wifiPass());
        dedupeWindow.setText(String.valueOf(prefs.dedupeWindowMs()));
        android.widget.Switch beepSwitch = findViewById(R.id.beepOnRead);
        beepSwitch.setChecked(prefs.beepOnRead());

        Button themeMode = findViewById(R.id.themeMode);
        themeMode.setText(themeLabel(prefs.themeMode()));
        themeMode.setOnClickListener(v -> {
            final String[] modes = { ThemeUtil.SYSTEM, ThemeUtil.LIGHT, ThemeUtil.DARK };
            String[] labels = { getString(R.string.appearance_system),
                    getString(R.string.appearance_light), getString(R.string.appearance_dark) };
            int current = java.util.Arrays.asList(modes).indexOf(prefs.themeMode());
            new android.app.AlertDialog.Builder(this)
                    .setTitle(R.string.label_appearance)
                    .setSingleChoiceItems(labels, current < 0 ? 0 : current, (d, which) -> {
                        prefs.setThemeMode(modes[which]);
                        d.dismiss();
                        recreate(); // re-apply the theme immediately
                    })
                    .setNegativeButton(android.R.string.cancel, null)
                    .show();
        });

        Button save = findViewById(R.id.save);
        save.setOnClickListener(v -> {
            save(prefs);
            prefs.setBeepOnRead(beepSwitch.isChecked());
            Toast.makeText(this, R.string.saved, Toast.LENGTH_SHORT).show();
            finish();
        });

        // Selecting LLRP defaults the port to the standard 5084 (like the
        // "RFID-LLRP" option in commercial timing apps).
        protocol.setOnItemSelectedListener(new android.widget.AdapterView.OnItemSelectedListener() {
            @Override
            public void onItemSelected(android.widget.AdapterView<?> parent, android.view.View view,
                                       int position, long id) {
                String port = readerPort.getText().toString().trim();
                if (position == 1 && (port.isEmpty() || "6000".equals(port))) readerPort.setText("5084");
            }

            @Override
            public void onNothingSelected(android.widget.AdapterView<?> parent) { }
        });

        Button loginPick = findViewById(R.id.loginPickRace);
        loginPick.setOnClickListener(v -> {
            save(prefs); // persist the server URL typed above
            String email = accountEmail.getText().toString().trim();
            String password = ((EditText) findViewById(R.id.accountPassword)).getText().toString();
            if (prefs.serverUrl().isEmpty() || email.isEmpty() || password.isEmpty()) {
                Toast.makeText(this, R.string.login_needs_fields, Toast.LENGTH_LONG).show();
                return;
            }
            loginPick.setEnabled(false);
            new Thread(() -> {
                try {
                    JSONObject session = new JSONObject(Uploader.login(prefs.serverUrl(), email, password));
                    String jwt = session.getString("token");
                    JSONObject my = new JSONObject(Uploader.myRaces(prefs.serverUrl(), jwt));
                    JSONArray races = my.getJSONArray("races");
                    // Reader WiFi credentials come from the server env; store and prefill.
                    JSONObject wifi = my.optJSONObject("reader_wifi");
                    if (wifi != null) {
                        String ws = wifi.optString("ssid", "");
                        String wp = wifi.optString("password", "");
                        // keep any existing value the server didn't provide
                        prefs.setWifi(ws.isEmpty() ? prefs.wifiSsid() : ws,
                                wp.isEmpty() ? prefs.wifiPass() : wp);
                    }
                    runOnUiThread(() -> {
                        loginPick.setEnabled(true);
                        if (wifi != null) {
                            wifiSsid.setText(prefs.wifiSsid());
                            wifiPass.setText(prefs.wifiPass());
                        }
                        if (races.length() == 0) {
                            Toast.makeText(this, R.string.no_races_on_account, Toast.LENGTH_LONG).show();
                            return;
                        }
                        // One race on the account -> pair straight to it, no picker.
                        if (races.length() == 1) {
                            pairRace(prefs, races.optJSONObject(0), email, readerToken, selectedRace);
                            return;
                        }
                        String[] titles = new String[races.length()];
                        for (int i = 0; i < races.length(); i++) {
                            JSONObject race = races.optJSONObject(i);
                            titles[i] = race.optString("title")
                                    + (race.optString("location").isEmpty() ? "" : " — " + race.optString("location"))
                                    + " (" + race.optInt("racer_count") + ")";
                        }
                        new android.app.AlertDialog.Builder(this)
                                .setTitle(R.string.choose_race)
                                .setItems(titles, (dialog, which) ->
                                        pairRace(prefs, races.optJSONObject(which), email, readerToken, selectedRace))
                                .setNegativeButton(android.R.string.cancel, null)
                                .show();
                    });
                } catch (Exception e) {
                    final String msg = getString(R.string.test_failed) + " " + e.getMessage();
                    runOnUiThread(() -> {
                        loginPick.setEnabled(true);
                        Toast.makeText(this, msg, Toast.LENGTH_LONG).show();
                    });
                }
            }).start();
        });

        findViewById(R.id.wifiConnect).setOnClickListener(v -> connectReaderWifi());

        Button scanReader = findViewById(R.id.scanReader);
        scanReader.setOnClickListener(v -> {
            scanReader.setEnabled(false);
            Toast.makeText(this, R.string.scan_started, Toast.LENGTH_SHORT).show();
            int port = intOf(text(readerPort), 5084);
            new Thread(() -> {
                String found = ReaderScanner.scan(this, text(readerHost), port);
                runOnUiThread(() -> {
                    scanReader.setEnabled(true);
                    if (found != null) {
                        readerHost.setText(found);
                        Toast.makeText(this, getString(R.string.scan_found, found), Toast.LENGTH_LONG).show();
                    } else {
                        Toast.makeText(this, R.string.scan_not_found, Toast.LENGTH_LONG).show();
                    }
                });
            }).start();
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

    /** Connect/Disconnect the reader WiFi. The hold lives in ReaderWifi (process
     *  scope) so it survives leaving Settings — going back no longer drops it. */
    private void connectReaderWifi() {
        if (ReaderWifi.isActive()) {           // toggle off
            ReaderWifi.disconnect(this);
            refreshWifiStatus();
            return;
        }
        String ssid = text(wifiSsid);
        if (ssid.isEmpty()) {
            Toast.makeText(this, R.string.wifi_needs_ssid, Toast.LENGTH_LONG).show();
            return;
        }
        new Prefs(this).setWifi(ssid, wifiPass.getText().toString());
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            // Pre-Android 10 cannot join programmatically; open system WiFi.
            ((TextView) findViewById(R.id.wifiStatus)).setText(R.string.wifi_join_manually);
            try {
                startActivity(new android.content.Intent(android.provider.Settings.ACTION_WIFI_SETTINGS));
            } catch (Exception ignored) { }
            return;
        }
        ReaderWifi.connect(this, ssid, wifiPass.getText().toString());
        refreshWifiStatus();
    }

    /** Mirror the process-wide ReaderWifi state into the label + button. */
    private void refreshWifiStatus() {
        TextView status = findViewById(R.id.wifiStatus);
        Button connect = findViewById(R.id.wifiConnect);
        String s = ReaderWifi.state();
        connect.setText(ReaderWifi.isActive() ? R.string.wifi_disconnect : R.string.wifi_connect);
        switch (s) {
            case ReaderWifi.CONNECTED:
                status.setTextColor(0xFF2E7D32); // green
                status.setText(getString(R.string.wifi_connected_to, ReaderWifi.ssid()));
                break;
            case ReaderWifi.CONNECTING:
                status.setTextColor(getColor(R.color.text_muted));
                status.setText(getString(R.string.wifi_connecting, ReaderWifi.ssid()));
                break;
            case ReaderWifi.FAILED:
                status.setTextColor(0xFFC62828); // red
                status.setText(R.string.wifi_connect_failed);
                break;
            case ReaderWifi.LOST:
                status.setTextColor(0xFFC62828);
                status.setText(R.string.wifi_lost);
                break;
            default:
                status.setText("");
        }
    }

    private final android.os.Handler wifiPoll = new android.os.Handler(android.os.Looper.getMainLooper());
    private final Runnable wifiTick = new Runnable() {
        @Override public void run() { refreshWifiStatus(); wifiPoll.postDelayed(this, 800); }
    };

    @Override
    protected void onResume() {
        super.onResume();
        wifiPoll.post(wifiTick);
    }

    @Override
    protected void onPause() {
        super.onPause();
        wifiPoll.removeCallbacks(wifiTick);
    }

    /** Store the selected race's per-race reader token + contest, and reflect it in the UI. */
    private void pairRace(Prefs prefs, JSONObject race, String email,
                          EditText readerToken, android.widget.TextView selectedRace) {
        prefs.savePairing(race.optString("app_token"), race.optString("title"), email, race.optInt("id"));
        readerToken.setText(race.optString("app_token"));
        selectedRace.setText(race.optString("title"));
        Toast.makeText(this, getString(R.string.race_paired, race.optString("title")), Toast.LENGTH_LONG).show();
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

    private String themeLabel(String mode) {
        if (ThemeUtil.LIGHT.equals(mode)) return getString(R.string.appearance_light);
        if (ThemeUtil.DARK.equals(mode)) return getString(R.string.appearance_dark);
        return getString(R.string.appearance_system);
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
        if (Prefs.PROTOCOL_LLRP.equals(value)) return 1;
        if (Prefs.PROTOCOL_UHF.equals(value)) return 2;
        if (Prefs.PROTOCOL_DEMO.equals(value)) return 3;
        return 0;
    }

    private static String protocolValue(int index) {
        if (index == 1) return Prefs.PROTOCOL_LLRP;
        if (index == 2) return Prefs.PROTOCOL_UHF;
        if (index == 3) return Prefs.PROTOCOL_DEMO;
        return Prefs.PROTOCOL_ASCII;
    }

    @Override
    public boolean onOptionsItemSelected(android.view.MenuItem item) {
        if (item.getItemId() == android.R.id.home) { finish(); return true; }
        return super.onOptionsItemSelected(item);
    }
}

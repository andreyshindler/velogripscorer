package com.velogrip.rfid;

import android.Manifest;
import android.app.Activity;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import android.text.method.ScrollingMovementMethod;
import android.widget.Button;
import android.widget.TextView;

import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

/** Dashboard: bridge status, live tag feed, start/stop controls. */
public class MainActivity extends Activity {

    private TextView statusView;
    private TextView countersView;
    private TextView logView;
    private Button toggleButton;
    private boolean running = false;
    private final StringBuilder log = new StringBuilder();
    private final SimpleDateFormat timeFormat = new SimpleDateFormat("HH:mm:ss", Locale.US);

    private final BroadcastReceiver statusReceiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            running = intent.getBooleanExtra(BridgeService.EXTRA_RUNNING, false);
            boolean reader = intent.getBooleanExtra(BridgeService.EXTRA_READER_CONNECTED, false);
            String wifi = intent.getStringExtra(BridgeService.EXTRA_WIFI_STATE);
            long pending = intent.getLongExtra(BridgeService.EXTRA_PENDING, 0);
            long uploaded = intent.getLongExtra(BridgeService.EXTRA_UPLOADED, 0);

            statusView.setText(getString(R.string.status_line,
                    getString(running ? R.string.on : R.string.off),
                    getString(reader ? R.string.connected : R.string.disconnected),
                    wifi == null ? "default" : wifi));
            countersView.setText(getString(R.string.counters_line, uploaded, pending));

            String epc = intent.getStringExtra(BridgeService.EXTRA_LAST_EPC);
            if (epc != null) appendLog("🏷 " + epc);
            String message = intent.getStringExtra(BridgeService.EXTRA_LOG);
            if (message != null) appendLog(message);
            toggleButton.setText(getString(running ? R.string.stop_bridge : R.string.start_bridge));
        }
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        statusView = findViewById(R.id.status);
        countersView = findViewById(R.id.counters);
        logView = findViewById(R.id.log);
        logView.setMovementMethod(new ScrollingMovementMethod());
        toggleButton = findViewById(R.id.toggle);
        Button settingsButton = findViewById(R.id.settings);

        toggleButton.setOnClickListener(v -> {
            Prefs prefs = new Prefs(this);
            if (!running && !prefs.isConfigured()) {
                startActivity(new Intent(this, SettingsActivity.class));
                return;
            }
            Intent intent = new Intent(this, BridgeService.class);
            intent.setAction(running ? BridgeService.ACTION_STOP : BridgeService.ACTION_START);
            if (!running) {
                startForegroundService(intent);
            } else {
                startService(intent);
            }
        });
        settingsButton.setOnClickListener(v ->
                startActivity(new Intent(this, SettingsActivity.class)));

        requestNeededPermissions();
        appendLog(getString(R.string.log_welcome));
    }

    private void requestNeededPermissions() {
        java.util.ArrayList<String> wanted = new java.util.ArrayList<>();
        if (checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION)
                != PackageManager.PERMISSION_GRANTED) {
            wanted.add(Manifest.permission.ACCESS_FINE_LOCATION);
        }
        if (Build.VERSION.SDK_INT >= 33
                && checkSelfPermission("android.permission.POST_NOTIFICATIONS")
                != PackageManager.PERMISSION_GRANTED) {
            wanted.add("android.permission.POST_NOTIFICATIONS");
        }
        if (!wanted.isEmpty()) {
            requestPermissions(wanted.toArray(new String[0]), 1);
        }
    }

    private void appendLog(String line) {
        log.insert(0, timeFormat.format(new Date()) + "  " + line + "\n");
        if (log.length() > 20_000) log.setLength(20_000);
        logView.setText(log);
    }

    @Override
    protected void onResume() {
        super.onResume();
        registerReceiver(statusReceiver, new IntentFilter(BridgeService.ACTION_STATUS));
    }

    @Override
    protected void onPause() {
        super.onPause();
        unregisterReceiver(statusReceiver);
    }
}

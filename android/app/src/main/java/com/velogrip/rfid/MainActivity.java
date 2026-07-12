package com.velogrip.rfid;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import android.widget.TextView;
import android.widget.Toast;

import com.velogrip.rfid.db.RaceStore;

/** Home menu (Webscorer-style): time a race, race data, settings, account. */
public class MainActivity extends Activity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        TextView version = findViewById(R.id.versionLabel);
        String name = "";
        try {
            name = getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
        } catch (PackageManager.NameNotFoundException ignored) { }
        version.setText(getString(R.string.chip_timing_version, name));

        findViewById(R.id.rowRaceWithList).setOnClickListener(v ->
                startActivity(new Intent(this, SelectStartListActivity.class)));
        findViewById(R.id.rowRaceNoList).setOnClickListener(v ->
                startActivity(new Intent(this, RaceSetupActivity.class)));
        findViewById(R.id.rowArchive).setOnClickListener(v ->
                startActivity(new Intent(this, RaceArchiveActivity.class)));
        findViewById(R.id.rowDownload).setOnClickListener(v ->
                startActivity(new Intent(this, DownloadRacesActivity.class)));
        findViewById(R.id.navSettings).setOnClickListener(v ->
                startActivity(new Intent(this, SettingsActivity.class)));
        findViewById(R.id.navAccount).setOnClickListener(v ->
                startActivity(new Intent(this, DownloadRacesActivity.class)));

        requestNeededPermissions();
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
}

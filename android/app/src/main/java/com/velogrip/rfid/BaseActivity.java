package com.velogrip.rfid;

import android.app.Activity;
import android.content.Context;

/**
 * Every screen extends this so the appearance choice (System / Light / Dark) is
 * applied via attachBaseContext. When the choice changes, revisiting a screen
 * re-applies it (recreate on resume if the applied mode is stale).
 */
public class BaseActivity extends Activity {
    private String appliedMode;

    @Override
    protected void attachBaseContext(Context base) {
        appliedMode = new Prefs(base).themeMode();
        super.attachBaseContext(ThemeUtil.wrap(base));
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (appliedMode != null && !appliedMode.equals(new Prefs(this).themeMode())) {
            recreate();
        }
    }
}

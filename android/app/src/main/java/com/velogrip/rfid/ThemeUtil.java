package com.velogrip.rfid;

import android.content.Context;
import android.content.res.Configuration;

/**
 * Applies the in-app appearance choice (System / Light / Dark) without AppCompat.
 * For an explicit Light/Dark choice it returns a context whose configuration has
 * the night-mode bit overridden, so the -night resources (and the dark base
 * theme) load regardless of the phone's system setting. "System" is a no-op —
 * the framework already reflects the OS dark setting.
 */
public final class ThemeUtil {
    public static final String SYSTEM = "system";
    public static final String LIGHT = "light";
    public static final String DARK = "dark";

    private ThemeUtil() { }

    public static Context wrap(Context base) {
        String mode = new Prefs(base).themeMode();
        if (!LIGHT.equals(mode) && !DARK.equals(mode)) return base; // system
        Configuration cfg = new Configuration(base.getResources().getConfiguration());
        int night = DARK.equals(mode) ? Configuration.UI_MODE_NIGHT_YES : Configuration.UI_MODE_NIGHT_NO;
        cfg.uiMode = (cfg.uiMode & ~Configuration.UI_MODE_NIGHT_MASK) | night;
        return base.createConfigurationContext(cfg);
    }
}

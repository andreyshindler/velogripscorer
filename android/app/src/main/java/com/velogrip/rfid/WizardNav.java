package com.velogrip.rfid;

import android.app.Activity;
import android.content.Intent;
import android.view.Menu;
import android.view.MenuItem;
import android.widget.PopupMenu;
import android.widget.TextView;

/**
 * The setup wizard's shared header navigation. Each step's title carries a ▾;
 * tapping it drops down a "Navigate back to" list of every earlier step, so the
 * organizer can jump straight to any of them. Jumping brings the existing
 * screen forward (and closes the ones above it) rather than stacking a copy.
 */
public final class WizardNav {

    // The wizard order. Index = position; earlier steps have lower indices.
    static final Class<?>[] ACTIVITIES = {
            MainActivity.class,
            SelectStartListActivity.class,
            RaceSetupActivity.class,
            LapSetupActivity.class,
            DistanceSetupActivity.class,
            RacerSetupActivity.class,
            ResultsOptionsActivity.class,
            HardwareSetupActivity.class,
            ChipTimingActivity.class,
    };
    static final int[] TITLES = {
            R.string.nav_home,
            R.string.select_startlist_title,
            R.string.race_setup_title,
            R.string.lap_setup_title,
            R.string.distance_setup_title,
            R.string.racer_setup_title,
            R.string.results_options_title,
            R.string.hardware_setup_title,
            R.string.chip_timing_title,
    };

    public static final int SELECT_START_LIST = 1;
    public static final int RACE_SETUP = 2;
    public static final int LAP_SETUP = 3;
    public static final int DISTANCE_SETUP = 4;
    public static final int RACER_SETUP = 5;
    public static final int RESULTS_OPTIONS = 6;
    public static final int HARDWARE_SETUP = 7;
    public static final int CHIP_TIMING = 8;

    private WizardNav() { }

    /** Sets the header title (with a ▾) and its "navigate back to" dropdown. */
    public static void attach(final Activity activity, final int currentIndex) {
        TextView title = activity.findViewById(R.id.headerTitle);
        title.setText(activity.getString(TITLES[currentIndex]) + "  ▾");
        title.setOnClickListener(v -> {
            PopupMenu menu = new PopupMenu(activity, title);
            MenuItem header = menu.getMenu().add(Menu.NONE, -1, 0, activity.getString(R.string.navigate_back_to));
            header.setEnabled(false);
            for (int i = currentIndex - 1; i >= 0; i--) {
                menu.getMenu().add(Menu.NONE, i, currentIndex - i, activity.getString(TITLES[i]));
            }
            menu.setOnMenuItemClickListener(item -> {
                int idx = item.getItemId();
                if (idx < 0) return false;
                Intent intent = new Intent(activity, ACTIVITIES[idx]);
                intent.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
                activity.startActivity(intent);
                return true;
            });
            menu.show();
        });
    }
}

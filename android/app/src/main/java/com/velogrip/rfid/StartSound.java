package com.velogrip.rfid;

import android.content.Context;
import android.media.AudioManager;
import android.media.MediaPlayer;
import android.media.ToneGenerator;
import android.os.Handler;
import android.os.Looper;

/**
 * The go signal for a gun: a tone, then a spoken line.
 *
 * Both screens that fire a gun need the same two sounds in the same order —
 * Race Start for a mass start, the timing console for each wave — so the
 * sequence lives here once instead of being copied with its own timings.
 *
 * The spoken clips are looked up by NAME rather than as R.raw.* constants, so
 * the app builds and runs with none of them present and simply stays quiet.
 * A recording is content, not code: dropping res/raw/wave_3.mp3 in gives a
 * third wave its announcement with nothing to recompile, and deleting a clip
 * turns that announcement off again rather than breaking the build.
 */
final class StartSound {

    /** Mass start: one gun for the whole field. */
    static final String RACE_STARTED = "race_started";

    private StartSound() {}

    /** The clip for the n-th wave of a wave race, counting from 1 in start-list
     *  order: wave_1 says the race has begun and the first wave is away, wave_2
     *  announces the second, and so on. */
    static String waveClip(int oneBased) {
        return "wave_" + oneBased;
    }

    /**
     * Tone now, clip once the tone has finished.
     *
     * The caller stamps the gun at the tone's onset, so the riders' instant
     * stays a sharp attack they can react to. A sentence has no such instant:
     * whoever waited to understand the words would be leaving a second late
     * with the clock already running. Arriving afterwards also makes the past
     * tense true — by then the wave really has gone.
     *
     * @param clipName a res/raw name, or null for the tone alone.
     */
    static void fire(Context ctx, Prefs prefs, String clipName) {
        if (!prefs.beepOnRead()) return;
        try {
            final ToneGenerator tg =
                    new ToneGenerator(AudioManager.STREAM_NOTIFICATION, prefs.beepVolume());
            Handler h = new Handler(Looper.getMainLooper());
            if (prefs.startBeepLong()) {
                // TONE_PROP_BEEP has a short fixed length; use a continuous tone
                // so it actually sustains for ~1.5 seconds (a "go" horn).
                tg.startTone(ToneGenerator.TONE_SUP_DIAL, 1500);
                h.postDelayed(tg::release, 1700);
            } else {
                tg.startTone(ToneGenerator.TONE_PROP_BEEP, 180);
                h.postDelayed(() -> tg.startTone(ToneGenerator.TONE_PROP_BEEP, 180), 350);
                h.postDelayed(() -> tg.startTone(ToneGenerator.TONE_PROP_BEEP, 400), 700);
                h.postDelayed(tg::release, 1400);
            }
            if (clipName != null) {
                final Context app = ctx.getApplicationContext();
                final int volume = prefs.beepVolume();
                h.postDelayed(() -> say(app, volume, clipName),
                        prefs.startBeepLong() ? 1800 : 1500);
            }
        } catch (RuntimeException ignored) {
            // some devices refuse the tone generator; the race still starts
        }
    }

    /** Play one spoken clip. Confirmation only: nothing is timed off it, so its
     *  latency does not matter and a failure is silent. */
    private static void say(Context app, int beepVolume, String clipName) {
        try {
            int clip = app.getResources().getIdentifier(clipName, "raw", app.getPackageName());
            if (clip == 0) return; // no recording installed for this wave
            // The application context, never the Activity: the screen that
            // fired the gun has usually moved on by the time this plays, and a
            // player scoped to a destroyed Activity would be torn down with it.
            MediaPlayer mp = MediaPlayer.create(app, clip);
            if (mp == null) return; // device could not open the clip
            float v = Math.max(0f, Math.min(1f, beepVolume / 100f));
            mp.setVolume(v, v);
            mp.setOnCompletionListener(MediaPlayer::release);
            mp.start();
        } catch (RuntimeException ignored) {
            // the wave is already running; a missing announcement changes nothing
        }
    }
}

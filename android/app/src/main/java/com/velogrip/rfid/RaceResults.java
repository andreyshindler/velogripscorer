package com.velogrip.rfid;

import com.velogrip.rfid.db.RaceStore;

import java.util.List;

/**
 * The one place a screen gets the current standings from.
 *
 * Every screen was calling RaceEngine.compute itself with the same long
 * argument list, and they drifted: the timing list passed the start-line roll
 * call, while six other screens used a shorter overload that fills those three
 * arguments in as zeros — which switches the roll call off. A racer the timing
 * screen showed as DNS was therefore still "on course" on the progress screen,
 * in the on-course list, and in the segment results, and Finish race asked
 * whether to mark riders who had never turned up.
 *
 * The arguments are the same for every caller except whether laps are finalised
 * down, so that is the only one left to pass. A new argument to the engine is
 * added here once and reaches every screen, instead of reaching whichever
 * call sites someone remembered.
 */
final class RaceResults {

    private RaceResults() {}

    /**
     * @param finalizeLapsDown true once the race is declared over, so a rider
     *                         with some laps is finished at their last crossing
     *                         rather than left out on course.
     */
    static List<RaceEngine.Result> compute(RaceStore store, Prefs prefs, boolean finalizeLapsDown) {
        return RaceEngine.compute(
                store.racers(), store.waves(), store.allPassings(),
                prefs.suppressSecs(), prefs.lapGapSecs(), prefs.recordLaps(),
                store.lapTargets(), prefs.raceLaps(), finalizeLapsDown,
                System.currentTimeMillis(), prefs.rollCallSecs() * 1000L, prefs.rollCallClosedAt(),
                prefs.leaderEndsRaceActive());
    }
}

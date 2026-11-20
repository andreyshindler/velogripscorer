# Working on VeloGripScorer

## Releasing

`main` is production (**Deploy to VPS**). `staging` is the test copy
(**Deploy to Staging**); it has no commits of its own and is only ever
fast-forwarded to `main`.

Never merge to `main` without being asked to in that turn — "merge to main"
or the equivalent. Development happens on a branch.

**When a merge to `main` is asked for, push `main` to `staging` in the same
step, without asking.** Standing instruction from the owner (2026-11-20):

```bash
git checkout main && git merge --ff-only <branch>
npm test                      # must be green before either push
git push origin main
git push origin main:staging  # same commit, no force needed
```

Both deploy workflows have `paths` filters (`server/**`, `public/**`, …), so a
commit touching only `android/**` deploys nothing — that is expected, not a
failure. The APK comes from the **Android APK** workflow and has to be
installed on the device by hand.

## Scoring

Two engines must agree: `RaceEngine.compute` in the Android app and
`computeRaceResults` in `server/race-results.js`. A change to ranking,
lap counting or the leader rule belongs in both, with tests on both sides.

## Telegram bot

`callback_data` is capped at **64 bytes** and Telegram rejects the whole
message above it — which reaches the operator as nothing but "Something went
wrong". Never put free text in it; use an id and look the text up. The fake
transport in `test/telegram.test.js` enforces the limit, so a new button that
embeds text fails in CI rather than at a start line.

Chip ids are stored left-padded to 24 characters (`EPC_LEN`), so the short
number an operator reads off the band *is* the chip: `9866` →
`000000000000000000009866`. `shortEpc()` strips the padding for display and
`padEpc()` puts it back.

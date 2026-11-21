'use strict';

// Ranking rules that decide a published result:
//  - running races rank on elapsed time ALONE (a stray double read must never
//    outrank a faster runner);
//  - lap sports (MTB XCO) still rank laps-first, where a lap is a real place.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = process.env.DATA_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'vgs-rank-'));

const { db } = require('../server/db');
const { computeRaceResults } = require('../server/race-results');

const gun = Date.now() - 600_000;
const iso = (offsetSecs) => new Date(gun + offsetSecs * 1000).toISOString();

// An organizer to own the test contests (contests.organizer_id is a FK).
const organizerId = db.prepare(
  `INSERT INTO users (email, password_hash, name, role) VALUES (?,?,?,'admin')`
).run('rank-org@test.local', 'x', 'Rank Organizer').lastInsertRowid;

// One contest, one wave, two racers:
//   LAPPER  crosses twice (2 laps) and is SLOWER  -> elapsed 5:00
//   SPRINTER crosses once (1 lap)  and is FASTER  -> elapsed 2:00
// The lap gap is 30s, so both of LAPPER's crossings count as separate laps.
function seedRace(sport) {
  const contestId = db.prepare(
    `INSERT INTO contests (organizer_id, title, description, category, tags, visibility,
       start_at, end_at, kind, sport, status, suppress_secs, min_lap_gap_secs, record_laps)
     VALUES (?,?,'','other','[]','public',?,?, 'race', ?, 'finished', 10, 30, 1)`
  ).run(organizerId, `Rank ${sport}`, iso(-60), iso(3600), sport).lastInsertRowid;

  const readerId = db.prepare(
    'INSERT INTO readers (contest_id, name, token, location) VALUES (?,?,?,?)'
  ).run(contestId, 'Timing app', `tok_${contestId}_${Math.random()}`, '').lastInsertRowid;

  const waveId = db.prepare(
    'INSERT INTO waves (contest_id, name, started_at) VALUES (?,?,?)'
  ).run(contestId, 'wave1', new Date(gun).toISOString()).lastInsertRowid;

  const addRacer = (epc, bib, name) => db.prepare(
    'INSERT INTO tag_assignments (contest_id, epc, bib, participant, wave_id) VALUES (?,?,?,?,?)'
  ).run(contestId, epc, bib, name, waveId);
  addRacer('EPC_LAP', '1', 'Lapper');
  addRacer('EPC_SPR', '2', 'Sprinter');

  const read = (epc, secs) => db.prepare(
    'INSERT INTO tag_reads (reader_id, contest_id, epc, read_at) VALUES (?,?,?,?)'
  ).run(readerId, contestId, epc, iso(secs));
  read('EPC_LAP', 120);  // lap 1
  read('EPC_LAP', 300);  // lap 2 -> 2 laps, elapsed 5:00
  read('EPC_SPR', 120);  // 1 lap, elapsed 2:00

  return db.prepare('SELECT * FROM contests WHERE id = ?').get(contestId);
}

test('running race: the faster runner wins even with fewer laps', () => {
  const results = computeRaceResults(seedRace('Running'));
  const byBib = Object.fromEntries(results.map((r) => [r.bib, r]));
  assert.equal(byBib['2'].laps, 1, 'sprinter crossed once');
  assert.equal(byBib['1'].laps, 2, 'lapper crossed twice');
  assert.equal(byBib['2'].rank, 1, 'the faster time ranks first in a running race');
  assert.equal(byBib['1'].rank, 2);
  // Gap is a time gap, never "-1 lap", because laps carry no place here.
  assert.match(byBib['1'].behind, /^\+/, `expected a time gap, got ${byBib['1'].behind}`);
});

test('MTB XCO: more laps still beats a faster time', () => {
  const results = computeRaceResults(seedRace('MTB — Cross-country (XCO)'));
  const byBib = Object.fromEntries(results.map((r) => [r.bib, r]));
  assert.equal(byBib['1'].rank, 1, 'the extra lap wins a lap race');
  assert.equal(byBib['2'].rank, 2);
  assert.equal(byBib['2'].behind, '-1 lap', 'the lapped racer reads as laps down');
});

test('running race: a racer with fewer laps still gets a TIME gap, never "-1 lap"', () => {
  const results = computeRaceResults(seedRace('Running'));
  for (const r of results) {
    if (r.status !== 'finished' || r.rank === 1) continue;
    assert.doesNotMatch(r.behind, /lap/i,
      `running gaps must be times, got "${r.behind}" for bib ${r.bib}`);
  }
});

test('a manual tap from before the gun is not a crossing', () => {
  const contest = seedRace('Running');
  // An operator tap 5 minutes BEFORE this wave's gun — a mis-tap, or a leftover
  // from a previous run of the same race. It used to survive (manual taps skip
  // the suppression window), landing as a negative split that read "0:00.0" and
  // inflated the following lap past the finish time.
  db.prepare(
    'INSERT INTO tag_reads (reader_id, contest_id, epc, read_at, manual) VALUES (?,?,?,?,1)'
  ).run(
    db.prepare('SELECT id FROM readers WHERE contest_id = ?').get(contest.id).id,
    contest.id, 'EPC_SPR', iso(-300)
  );

  const sprinter = computeRaceResults(contest).find((r) => r.bib === '2');
  assert.equal(sprinter.laps, 1, 'the pre-gun tap must not add a lap');
  assert.ok(sprinter.elapsed_ms > 0, 'elapsed stays positive');
  for (const ms of sprinter.lap_ms) {
    assert.ok(ms >= 0, `every split is at or after the gun, got ${ms}`);
  }
  // The last split IS the finish — the invariant the lap-times table relies on.
  assert.equal(sprinter.lap_ms[sprinter.lap_ms.length - 1], sprinter.elapsed_ms);
});

test('a blank sport keeps the lap-first default', () => {
  const results = computeRaceResults(seedRace(''));
  const byBib = Object.fromEntries(results.map((r) => [r.bib, r]));
  assert.equal(byBib['1'].rank, 1);
});

// A running race is scored on one crossing, so lap recording must start OFF:
// left on, a stray re-read past the lap gap becomes "lap 2" and drags the
// finish time out to that later crossing.
test('a new running race is created with lap recording off', async () => {
  const request = require('supertest');
  process.env.OPEN_REGISTRATION = '1';
  const { app } = require('../server/index');
  const reg = await request(app).post('/api/auth/register')
    .send({ email: `rl-${Date.now()}@test.co`, password: 'password123', name: 'RL' });
  const auth = { Authorization: `Bearer ${reg.body.token}` };
  const mk = (sport) => request(app).post('/api/contests').set(auth).send({
    title: 'RL ' + sport, kind: 'race', sport,
    start_at: iso(-60), end_at: iso(3600),
  });

  const running = await mk('Running');
  assert.equal(running.status, 201);
  assert.equal(running.body.record_laps, 0, 'running starts with laps off');

  const xco = await mk('MTB — Cross-country (XCO)');
  assert.equal(xco.body.record_laps, 1, 'a lap sport keeps lap recording on');
  // XCO is not "laps happen to be allowed" — the format IS a fixed lap count
  // ended by the leader. leader_ends_race defaults to 0, so an XCO race used
  // to be created scored as if the first crossing were a finish, and nothing
  // said so.
  assert.equal(xco.body.leader_ends_race, 1, 'XCO starts with the leader rule on');
  assert.equal(running.body.leader_ends_race, 0, 'a running race does not get the leader rule');
});

// The sport is editable, and the usual way an XCO race appears is as a copy of
// last season's event with the sport changed over.
test('switching a race to XCO turns the two XCO rules on', async () => {
  const request = require('supertest');
  process.env.OPEN_REGISTRATION = '1';
  const { app } = require('../server/index');
  const reg = await request(app).post('/api/auth/register')
    .send({ email: `sw-${Date.now()}@test.co`, password: 'password123', name: 'Sw' });
  const auth = { Authorization: `Bearer ${reg.body.token}` };

  const made = await request(app).post('/api/contests').set(auth).send({
    title: 'Was a run', kind: 'race', sport: 'Running',
    start_at: iso(-60), end_at: iso(3600),
  });
  assert.equal(made.body.record_laps, 0);
  assert.equal(made.body.leader_ends_race, 0);

  const moved = await request(app).patch(`/api/contests/${made.body.id}`).set(auth)
    .send({ sport: 'MTB — Cross-country (XCO)' });
  assert.equal(moved.status, 200);
  assert.equal(moved.body.record_laps, 1, 'lap recording comes back on');
  assert.equal(moved.body.leader_ends_race, 1, 'and so does the leader rule');
});

// A combined running + MTB event needs the leader rule OFF, because the cutoff
// is field-wide: the first runner home on their single lap would end the MTB
// race too. That choice has to survive editing the title.
test('an XCO race keeps the organizer\'s leader-rule choice across later edits', async () => {
  const request = require('supertest');
  process.env.OPEN_REGISTRATION = '1';
  const { app } = require('../server/index');
  const reg = await request(app).post('/api/auth/register')
    .send({ email: `keep-${Date.now()}@test.co`, password: 'password123', name: 'Keep' });
  const auth = { Authorization: `Bearer ${reg.body.token}` };

  const made = await request(app).post('/api/contests').set(auth).send({
    title: 'Combined', kind: 'race', sport: 'MTB — Cross-country (XCO)',
    start_at: iso(-60), end_at: iso(3600),
  });
  assert.equal(made.body.leader_ends_race, 1);
  // The organizer turns it off for the combined event.
  db.prepare('UPDATE contests SET leader_ends_race = 0 WHERE id = ?').run(made.body.id);

  const renamed = await request(app).patch(`/api/contests/${made.body.id}`).set(auth)
    .send({ title: 'Combined run + MTB' });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.body.leader_ends_race, 0, 'an unrelated edit must not re-tick it');
});

// Duplicating is how a series reuses a start list, so the copy has to be the
// same race. It cloned only the two debounce windows: race_laps and lap_targets
// are nullable with no default, so the copy of a 3-lap XCO race had no lap
// count at all and the leader rule off.
test('duplicating an XCO race carries its lap settings', async () => {
  const request = require('supertest');
  process.env.OPEN_REGISTRATION = '1';
  const { app } = require('../server/index');
  const reg = await request(app).post('/api/auth/register')
    .send({ email: `dup-${Date.now()}@test.co`, password: 'password123', name: 'Dup' });
  const auth = { Authorization: `Bearer ${reg.body.token}` };

  const made = await request(app).post('/api/contests').set(auth).send({
    title: 'Season opener', kind: 'race', sport: 'MTB — Cross-country (XCO)',
    start_at: iso(-60), end_at: iso(3600),
  });
  db.prepare('UPDATE contests SET race_laps = 4, lap_targets = ? WHERE id = ?')
    .run(JSON.stringify({ Elite: 5, Sport: 3 }), made.body.id);

  const copy = await request(app).post(`/api/contests/${made.body.id}/duplicate`).set(auth)
    .send({ title: 'Round 2' });
  assert.equal(copy.status, 201);
  const row = db.prepare('SELECT * FROM contests WHERE id = ?').get(copy.body.id);
  assert.equal(row.record_laps, 1);
  assert.equal(row.leader_ends_race, 1, 'the copy keeps the leader rule');
  assert.equal(row.race_laps, 4, 'the copy keeps the race-wide lap count');
  assert.deepEqual(JSON.parse(row.lap_targets), { Elite: 5, Sport: 3 }, 'and the per-distance targets');
});

// A rider who finishes and then lingers near the mat gets read again. Past the
// target lap that is not a lap, and their finish must not move to it — the
// on-device RaceEngine has always capped at the target, so the server has to
// agree or the tablet and the website score the same race differently.
test('a read after the target lap is not a lap, and does not move the finish', () => {
  const contestId = db.prepare(
    `INSERT INTO contests (organizer_id, title, description, category, tags, visibility,
       start_at, end_at, kind, sport, status, suppress_secs, min_lap_gap_secs, record_laps, race_laps)
     VALUES (?,?,'','other','[]','public',?,?, 'race', 'MTB — Cross-country (XCO)', 'finished', 10, 30, 1, 3)`
  ).run(organizerId, 'Lap cap', iso(-60), iso(3600)).lastInsertRowid;
  const readerId = db.prepare('INSERT INTO readers (contest_id, name, token, location) VALUES (?,?,?,?)')
    .run(contestId, 'Timing app', `tok_cap_${contestId}`, '').lastInsertRowid;
  const waveId = db.prepare('INSERT INTO waves (contest_id, name, started_at) VALUES (?,?,?)')
    .run(contestId, 'wave1', new Date(gun).toISOString()).lastInsertRowid;
  db.prepare('INSERT INTO tag_assignments (contest_id, epc, bib, participant, wave_id) VALUES (?,?,?,?,?)')
    .run(contestId, 'EPC_CAP', '9', 'Loiterer', waveId);
  const read = (secs) => db.prepare(
    'INSERT INTO tag_reads (reader_id, contest_id, epc, read_at) VALUES (?,?,?,?)'
  ).run(readerId, contestId, 'EPC_CAP', iso(secs));
  read(60); read(120); read(180);   // 3 laps = the target, finish at 3:00
  read(400);                        // loiters past the mat well after the lap gap

  const r = computeRaceResults(db.prepare('SELECT * FROM contests WHERE id = ?').get(contestId))
    .find((x) => x.bib === '9');
  assert.equal(r.laps, 3, 'the race ends at the target lap');
  assert.equal(r.elapsed, '3:00.0', 'the finish stays on the target lap, not the loiter read');
});

// A duplicated race inherits the original's venue, and location/sport used to
// be write-once — so the copy was stuck there and a typo was permanent.
test('a race location and sport can be edited after creation', async () => {
  const request = require('supertest');
  process.env.OPEN_REGISTRATION = '1';
  const { app } = require('../server/index');
  const reg = await request(app).post('/api/auth/register')
    .send({ email: `loc-${Date.now()}@test.co`, password: 'password123', name: 'Loc' });
  const auth = { Authorization: `Bearer ${reg.body.token}` };

  const made = await request(app).post('/api/contests').set(auth).send({
    title: 'Venue A race', kind: 'race', sport: 'Running',
    location: 'Kiryat Gat', start_at: iso(-60), end_at: iso(3600),
  });
  assert.equal(made.status, 201);
  assert.equal(made.body.location, 'Kiryat Gat');

  const dup = await request(app).post(`/api/contests/${made.body.id}/duplicate`).set(auth).send({});
  assert.equal(dup.status, 201, 'the race duplicates');
  assert.equal(dup.body.location, 'Kiryat Gat', 'the copy inherits the venue');

  const moved = await request(app).patch(`/api/contests/${dup.body.id}`).set(auth)
    .send({ location: 'Lachish Regional Council', sport: 'Gravel' });
  assert.equal(moved.status, 200);
  assert.equal(moved.body.location, 'Lachish Regional Council', 'the copy can be moved');
  assert.equal(moved.body.sport, 'Gravel');

  // and it persisted, rather than only echoing back
  const fresh = await request(app).get(`/api/contests/${dup.body.id}`).set(auth);
  assert.equal(fresh.body.location, 'Lachish Regional Council');
  assert.equal(made.body.location, 'Kiryat Gat'); // original untouched
});

// Re-importing a corrected roster used to MERGE, leaving anyone dropped from
// the new file still on the start list. Replace makes the race match the file.
test('start list: import merges, replace makes the list match the file', async () => {
  const request = require('supertest');
  process.env.OPEN_REGISTRATION = '1';
  const { app } = require('../server/index');
  const reg = await request(app).post('/api/auth/register')
    .send({ email: `csv-${Date.now()}@test.co`, password: 'password123', name: 'CSV' });
  const auth = { Authorization: `Bearer ${reg.body.token}` };
  const c = (await request(app).post('/api/contests').set(auth).send({
    title: 'Roster race', kind: 'race', sport: 'Running', start_at: iso(-60), end_at: iso(3600),
  })).body;
  const bulk = (racers, replace) => request(app)
    .post(`/api/contests/${c.id}/tags/bulk`).set(auth).send({ racers, ...(replace ? { replace: true } : {}) });
  const bibs = async () => (await request(app).get(`/api/contests/${c.id}/startlist`).set(auth))
    .body.racers.map((r) => r.bib).sort();

  // bib + name with no chip is the common CSV: the server synthesises the EPC.
  await bulk([{ bib: '1', participant: 'A' }, { bib: '2', participant: 'B' }]);
  assert.deepEqual(await bibs(), ['1', '2']);

  // merge: C is added, A and B stay even though the file lists only C
  await bulk([{ bib: '3', participant: 'C' }]);
  assert.deepEqual(await bibs(), ['1', '2', '3'], 'a plain import merges');

  // replace: the list becomes exactly the file
  const res = await bulk([{ bib: '9', participant: 'Z' }], true);
  assert.equal(res.status, 200);
  assert.equal(res.body.replaced, true);
  assert.equal(res.body.removed, 3, 'the three previous racers were cleared');
  assert.deepEqual(await bibs(), ['9'], 'replace leaves only the file');
});

test('replace keeps recorded chip times, which are keyed by chip not by roster', () => {
  const contestId = db.prepare(
    `INSERT INTO contests (organizer_id, title, description, category, tags, visibility,
       start_at, end_at, kind, sport, status, suppress_secs, min_lap_gap_secs, record_laps)
     VALUES (?,?,'','other','[]','public',?,?, 'race', 'Running', 'finished', 10, 30, 0)`
  ).run(organizerId, 'Keep times', iso(-60), iso(3600)).lastInsertRowid;
  const readerId = db.prepare('INSERT INTO readers (contest_id, name, token, location) VALUES (?,?,?,?)')
    .run(contestId, 'Timing app', `tok_keep_${contestId}`, '').lastInsertRowid;
  db.prepare('INSERT INTO waves (contest_id, name, started_at) VALUES (?,?,?)')
    .run(contestId, 'wave1', new Date(gun).toISOString());
  db.prepare('INSERT INTO tag_reads (reader_id, contest_id, epc, read_at) VALUES (?,?,?,?)')
    .run(readerId, contestId, 'EPC_KEEP', iso(120));

  const before = db.prepare('SELECT COUNT(*) n FROM tag_reads WHERE contest_id = ?').get(contestId).n;
  db.prepare('DELETE FROM tag_assignments WHERE contest_id = ?').run(contestId); // what replace does
  const after = db.prepare('SELECT COUNT(*) n FROM tag_reads WHERE contest_id = ?').get(contestId).n;
  assert.equal(after, before, 'clearing the roster must not delete recorded reads');
});

// Restarting on the tablet only ever cleared the tablet, so the web kept
// showing the race live off gun times the phone had already forgotten.
test('race-reset un-starts the waves so the web stops calling the race live', async () => {
  const request = require('supertest');
  process.env.OPEN_REGISTRATION = '1';
  const { app } = require('../server/index');
  const reg = await request(app).post('/api/auth/register')
    .send({ email: `rst-${Date.now()}@test.co`, password: 'password123', name: 'RST' });
  const auth = { Authorization: `Bearer ${reg.body.token}` };
  const c = (await request(app).post('/api/contests').set(auth).send({
    title: 'Reset race', kind: 'race', sport: 'Running', start_at: iso(-60), end_at: iso(3600),
  })).body;
  const rdr = (await request(app).post(`/api/contests/${c.id}/readers`).set(auth)
    .send({ name: 'Finish', location: 'finish' })).body;
  const w = (await request(app).post(`/api/contests/${c.id}/waves`).set(auth).send({ name: 'w1' })).body;
  await request(app).post(`/api/contests/${c.id}/waves/${w.id}/start`).set(auth)
    .send({ at: new Date(gun).toISOString() });
  await request(app).post('/api/ingest/reads').set('X-Reader-Token', rdr.token)
    .send({ reads: [{ epc: 'AA0001', read_at: iso(120) }] });

  const live = async () => (await request(app).get(`/api/contests/${c.id}`).set(auth)).body.started;
  const reads = () => db.prepare('SELECT COUNT(*) n FROM tag_reads WHERE contest_id = ?').get(c.id).n;
  assert.equal(await live(), true, 'gunned race reads as live');
  assert.equal(reads(), 1);

  // Restart keeping times: un-started, reads retained.
  let r = await request(app).post('/api/ingest/race-reset').set('X-Reader-Token', rdr.token)
    .send({ clear_reads: false });
  assert.equal(r.status, 200);
  assert.equal(await live(), false, 'no longer live after a reset');
  assert.equal(reads(), 1, 'keeping times leaves the reads alone');

  // Restart discarding times: reads go too.
  r = await request(app).post('/api/ingest/race-reset').set('X-Reader-Token', rdr.token)
    .send({ clear_reads: true });
  assert.equal(r.body.cleared, 1);
  assert.equal(reads(), 0, 'discard clears the uploaded reads');
});

// ---------------------------------------------------------------------------
// Category places are per DISTANCE + category, and the PDF knows about laps.
// ---------------------------------------------------------------------------

// Age bands repeat across fields: an XCO race with Elite and Sport has a 43-45
// in both. Keyed on the category alone, the two fields were ranked against each
// other and one podium came out for what are two separate races.
test('category places are counted within each distance, not across the race', () => {
  const contestId = db.prepare(
    `INSERT INTO contests (organizer_id, title, description, category, tags, visibility,
       start_at, end_at, kind, sport, status, suppress_secs, min_lap_gap_secs, record_laps)
     VALUES (?,?,'','other','[]','public',?,?, 'race', 'MTB — Cross-country (XCO)', 'finished', 10, 30, 1)`
  ).run(organizerId, 'Two fields', iso(-60), iso(3600)).lastInsertRowid;
  const readerId = db.prepare('INSERT INTO readers (contest_id, name, token, location) VALUES (?,?,?,?)')
    .run(contestId, 'Timing app', `tok_cat_${contestId}`, '').lastInsertRowid;
  const waveId = db.prepare('INSERT INTO waves (contest_id, name, started_at) VALUES (?,?,?)')
    .run(contestId, 'wave1', new Date(gun).toISOString()).lastInsertRowid;

  // Interleaved on the clock, so a race-wide count would read 1,2,3,4.
  const field = [
    ['EPC_E1', '1', 'Elite fast', 'Elite', 100],
    ['EPC_S1', '2', 'Sport fast', 'Sport', 110],
    ['EPC_E2', '3', 'Elite slow', 'Elite', 120],
    ['EPC_S2', '4', 'Sport slow', 'Sport', 130],
  ];
  for (const [epc, bib, name, distance, at] of field) {
    db.prepare(`INSERT INTO tag_assignments (contest_id, epc, bib, participant, wave_id, category, distance)
                VALUES (?,?,?,?,?,?,?)`).run(contestId, epc, bib, name, waveId, '43-45', distance);
    db.prepare('INSERT INTO tag_reads (reader_id, contest_id, epc, read_at) VALUES (?,?,?,?)')
      .run(readerId, contestId, epc, iso(at));
  }

  const out = computeRaceResults(db.prepare('SELECT * FROM contests WHERE id = ?').get(contestId));
  const by = Object.fromEntries(out.map((r) => [r.bib, r]));
  assert.equal(by['1'].rank, 1, 'overall order is unchanged');
  assert.equal(by['2'].rank, 2);
  assert.equal(by['3'].rank, 3);
  assert.equal(by['4'].rank, 4);
  // Each field has its own 43-45 podium.
  assert.equal(by['1'].category_rank, 1, 'Elite 43-45 winner');
  assert.equal(by['3'].category_rank, 2, 'Elite 43-45 runner-up');
  assert.equal(by['2'].category_rank, 1, 'Sport 43-45 winner, not 2nd behind an Elite');
  assert.equal(by['4'].category_rank, 2, 'Sport 43-45 runner-up, not 4th');
});

// The PDF is what gets handed out, and it rendered a rider a whole lap down as
// a small "+time" gap - on a one-lap running field that never came up, on a
// multi-lap MTB field it is simply wrong.
const { raceSectionRows } = require('../server/results-pdf');
const mk = (bib, laps, elapsedMs) => ({
  bib, laps, elapsed_ms: elapsedMs, participant: 'R' + bib, team: '', category: '', gender: '',
  elapsed: String(elapsedMs),
});

test('PDF: a lap race places on laps first and reads the gap in laps', () => {
  // The 2-lap rider is QUICKER on the clock, and still finishes behind.
  const rows = raceSectionRows([mk('b', 2, 29 * 60_000), mk('a', 3, 30 * 60_000)], false);
  assert.deepEqual(rows.map((r) => r.bib), ['a', 'b'], 'more laps beats a faster time');
  assert.deepEqual(rows.map((r) => r.place), [1, 2]);
  assert.equal(rows[0].behind, '', 'the leader has no gap');
  assert.equal(rows[1].behind, '-1 הקפה', 'not a time gap to someone who rode further');
  assert.deepEqual(rows.map((r) => r.laps), [3, 2], 'laps reach the renderer');
});

test('PDF: two laps down is plural, and the gap stays a time within a lap', () => {
  const rows = raceSectionRows(
    [mk('a', 5, 60_000), mk('b', 5, 72_400), mk('c', 3, 50_000)], false);
  assert.equal(rows[1].behind, '+0:12.4', 'same lap count -> a time gap');
  assert.equal(rows[2].behind, '-2 הקפות', 'two laps down reads plural');
});

// Equal elapsed time was enough to share a place, whatever the laps said.
test('PDF: equal time is only a tie when the laps match too', () => {
  const same = raceSectionRows([mk('a', 3, 60_000), mk('b', 3, 60_000)], false);
  assert.deepEqual(same.map((r) => r.place), [1, 1], 'same laps and time really is a tie');

  const split = raceSectionRows([mk('a', 3, 60_000), mk('b', 2, 60_000)], false);
  assert.deepEqual(split.map((r) => r.place), [1, 2], 'a lap down is not a tie');
  assert.equal(split[1].behind, '-1 הקפה');
});

// A running race is scored on one crossing: an extra "lap" is a stray double
// read, so it must not sort, break a tie, or print as "-1 הקפה".
test('PDF: a running race ignores laps entirely', () => {
  const rows = raceSectionRows([mk('slow', 2, 70_000), mk('fast', 1, 60_000)], true);
  assert.deepEqual(rows.map((r) => r.bib), ['fast', 'slow'], 'the faster runner wins');
  assert.equal(rows[1].behind, '+0:10.0', 'a time gap, never a lap gap');
  const tie = raceSectionRows([mk('a', 1, 60_000), mk('b', 2, 60_000)], true);
  assert.deepEqual(tie.map((r) => r.place), [1, 1], 'equal time ties regardless of laps');
});

// ---------------------------------------------------------------------------
// The race info panel states only what actually happened.
// ---------------------------------------------------------------------------

// Reported from the details page: a race that had not started yet announced
// "Timed on: Android tablet / Chip timing: RFID - LLRP / RFID reader: Timing
// app / Updated from: App" to everyone looking at it. Those four lines were
// hardcoded, so they were never derived from anything - a race timed by hand
// or imported from a file said exactly the same.
test('a race that has not been timed claims nothing about how it was timed', async () => {
  const request = require('supertest');
  process.env.OPEN_REGISTRATION = '1';
  const { app } = require('../server/index');
  const reg = await request(app).post('/api/auth/register')
    .send({ email: `tim-${Date.now()}@test.co`, password: 'password123', name: 'Tim' });
  const auth = { Authorization: `Bearer ${reg.body.token}` };

  const made = await request(app).post('/api/contests').set(auth).send({
    title: 'Untimed', kind: 'race', sport: 'MTB — Cross-country (XCO)',
    start_at: iso(-60), end_at: iso(3600),
  });
  // The reader row is created up front so the organizer has a token to paste,
  // so "a reader exists" must not be read as "a reader reported".
  assert.ok(made.body.app_token, 'the token exists from the start');
  assert.deepEqual(made.body.timing.readers, [], 'nothing has reported in');
  assert.deepEqual(made.body.timing.sources, [], 'no reads at all');
  assert.equal(made.body.timing.chip_read, false, 'no chip has been read');
});

test('a chip read through the app is what makes the timing lines appear', async () => {
  const request = require('supertest');
  process.env.OPEN_REGISTRATION = '1';
  const { app } = require('../server/index');
  const reg = await request(app).post('/api/auth/register')
    .send({ email: `chip-${Date.now()}@test.co`, password: 'password123', name: 'Chip' });
  const auth = { Authorization: `Bearer ${reg.body.token}` };

  const made = await request(app).post('/api/contests').set(auth).send({
    title: 'Timed', kind: 'race', sport: 'MTB — Cross-country (XCO)',
    start_at: iso(-60), end_at: iso(3600),
  });
  const wave = await request(app).post(`/api/contests/${made.body.id}/waves`).set(auth)
    .send({ name: 'wave1' });
  await request(app).post(`/api/contests/${made.body.id}/tags`).set(auth)
    .send({ epc: 'FA110001', bib: '1', participant: 'Rider', wave_id: wave.body.id });
  await request(app).post('/api/ingest/reads').set('X-Reader-Token', made.body.app_token)
    .send({ reads: [{ epc: 'FA110001', read_at: iso(60) }] });

  const after = await request(app).get(`/api/contests/${made.body.id}`).set(auth);
  assert.deepEqual(after.body.timing.readers, ['Timing app'], 'the reader has now reported');
  assert.deepEqual(after.body.timing.sources, ['app']);
  assert.equal(after.body.timing.chip_read, true);
});

// A marshal tapping bibs goes through the same app and the same reader row, so
// taps alone must not be presented as a chip reader on the mat.
test('a hand-entered race is not credited to a chip reader', async () => {
  const request = require('supertest');
  process.env.OPEN_REGISTRATION = '1';
  const { app } = require('../server/index');
  const reg = await request(app).post('/api/auth/register')
    .send({ email: `man-${Date.now()}@test.co`, password: 'password123', name: 'Man' });
  const auth = { Authorization: `Bearer ${reg.body.token}` };

  const made = await request(app).post('/api/contests').set(auth).send({
    title: 'By hand', kind: 'race', sport: 'Running',
    start_at: iso(-60), end_at: iso(3600),
  });
  const wave = await request(app).post(`/api/contests/${made.body.id}/waves`).set(auth)
    .send({ name: 'wave1' });
  await request(app).post(`/api/contests/${made.body.id}/waves/${wave.body.id}/start`).set(auth)
    .send({ at: new Date(gun).toISOString() });
  await request(app).post(`/api/contests/${made.body.id}/tags`).set(auth)
    .send({ epc: 'FB220001', bib: '7', participant: 'Walker', wave_id: wave.body.id });
  const tap = await request(app).post(`/api/contests/${made.body.id}/manual-read`).set(auth)
    .send({ bib: '7', at: iso(300) });
  assert.equal(tap.status, 201, JSON.stringify(tap.body));

  const after = await request(app).get(`/api/contests/${made.body.id}`).set(auth);
  assert.deepEqual(after.body.timing.sources, ['manual'], 'the read is marked hand-entered');
  assert.equal(after.body.timing.chip_read, false, 'no chip crossing happened');
  assert.deepEqual(after.body.timing.readers, [], 'the Manual entry reader is not an RFID reader');
});

// The app is the only side that knows how it is talking to the reader, so it
// reports it; the panel used to state "RFID - LLRP" for everyone.
test('the reader protocol is taken from the app, and only known ones', async () => {
  const request = require('supertest');
  process.env.OPEN_REGISTRATION = '1';
  const { app } = require('../server/index');
  const reg = await request(app).post('/api/auth/register')
    .send({ email: `proto-${Date.now()}@test.co`, password: 'password123', name: 'Proto' });
  const auth = { Authorization: `Bearer ${reg.body.token}` };
  let n = 0;
  const race = async () => {
    n++;
    const epc = `FD0000${n}0`;
    const made = await request(app).post('/api/contests').set(auth).send({
      title: 'Proto ' + n, kind: 'race', sport: 'MTB — Cross-country (XCO)',
      start_at: iso(-60), end_at: iso(3600),
    });
    const wave = await request(app).post(`/api/contests/${made.body.id}/waves`).set(auth)
      .send({ name: 'w' });
    await request(app).post(`/api/contests/${made.body.id}/tags`).set(auth)
      .send({ epc, bib: '1', participant: 'R', wave_id: wave.body.id });
    return { id: made.body.id, token: made.body.app_token, epc };
  };
  const send = (r, body) => request(app).post('/api/ingest/reads')
    .set('X-Reader-Token', r.token).send({ reads: [{ epc: r.epc, read_at: iso(60) }], ...body });
  const timing = async (id) => (await request(app).get(`/api/contests/${id}`).set(auth)).body.timing;

  for (const proto of ['llrp', 'ascii', 'uhf', 'demo']) {
    const r = await race();
    await send(r, { reader: proto });
    assert.equal((await timing(r.id)).protocol, proto, `${proto} round-trips`);
  }

  // An older build says nothing: the panel falls back to plain "RFID" rather
  // than naming a protocol nobody reported.
  const quiet = await race();
  await send(quiet, {});
  assert.equal((await timing(quiet.id)).protocol, null);

  // It is rendered on a public page, so anything unrecognised is dropped.
  const junk = await race();
  await send(junk, { reader: '<script>alert(1)</script>' });
  assert.equal((await timing(junk.id)).protocol, null, 'unknown protocols are not stored');

  // Uppercase is the same protocol.
  const shouty = await race();
  await send(shouty, { reader: 'LLRP' });
  assert.equal((await timing(shouty.id)).protocol, 'llrp');
});

// ---------------------------------------------------------------------------
// Timing settings can come from the device, but only when it says so.
// ---------------------------------------------------------------------------

test('the device can set the timing numbers, and silence leaves them alone', async () => {
  const request = require('supertest');
  process.env.OPEN_REGISTRATION = '1';
  const { app } = require('../server/index');
  const reg = await request(app).post('/api/auth/register')
    .send({ email: `ts-${Date.now()}@test.co`, password: 'password123', name: 'TS' });
  const auth = { Authorization: `Bearer ${reg.body.token}` };
  const made = await request(app).post('/api/contests').set(auth).send({
    title: 'Timing', kind: 'race', sport: 'MTB — Cross-country (XCO)',
    start_at: iso(-60), end_at: iso(3600),
  });
  const id = made.body.id, token = made.body.app_token;
  const row = () => db.prepare('SELECT suppress_secs, min_lap_gap_secs, record_laps, leader_ends_race FROM contests WHERE id = ?').get(id);
  const push = (body) => request(app).post('/api/ingest/lap-targets').set('X-Reader-Token', token).send(body);

  // The organizer's settings, as the website would leave them.
  await request(app).patch(`/api/contests/${id}/timing-settings`).set(auth)
    .send({ suppress_secs: 45, min_lap_gap_secs: 90, record_laps: false, leader_ends_race: false });
  assert.deepEqual(row(), { suppress_secs: 45, min_lap_gap_secs: 90, record_laps: 0, leader_ends_race: 0 });

  // A device with nothing of its own to say must not disturb any of it. This is
  // the regression that mattered: the app used to send record_laps on every run
  // of its upload loop, so a tablet that had not re-synced pushed its stale copy
  // over a change the organizer had just made.
  await push({ lap_targets: { Elite: 4 } });
  assert.deepEqual(row(), { suppress_secs: 45, min_lap_gap_secs: 90, record_laps: 0, leader_ends_race: 0 },
    'a silent device changes nothing');
  assert.deepEqual(JSON.parse(db.prepare('SELECT lap_targets FROM contests WHERE id = ?').get(id).lap_targets),
    { Elite: 4 }, 'lap targets still merge-fill');

  // Now the operator changed them at the mat.
  await push({ suppress_secs: 20, min_lap_gap_secs: 60, record_laps: true, leader_ends_race: true });
  assert.deepEqual(row(), { suppress_secs: 20, min_lap_gap_secs: 60, record_laps: 1, leader_ends_race: 1 });

  // Each field stands alone: sending only one leaves the rest.
  await push({ suppress_secs: 5 });
  assert.deepEqual(row(), { suppress_secs: 5, min_lap_gap_secs: 60, record_laps: 1, leader_ends_race: 1 });
});

test('a nonsense timing value from a device is ignored, not stored', async () => {
  const request = require('supertest');
  process.env.OPEN_REGISTRATION = '1';
  const { app } = require('../server/index');
  const reg = await request(app).post('/api/auth/register')
    .send({ email: `tsx-${Date.now()}@test.co`, password: 'password123', name: 'TSX' });
  const auth = { Authorization: `Bearer ${reg.body.token}` };
  const made = await request(app).post('/api/contests').set(auth).send({
    title: 'Bad timing', kind: 'race', sport: 'Running', start_at: iso(-60), end_at: iso(3600),
  });
  const id = made.body.id;
  const before = db.prepare('SELECT suppress_secs, min_lap_gap_secs FROM contests WHERE id = ?').get(id);
  for (const body of [
    { suppress_secs: -1 }, { suppress_secs: 'soon' }, { suppress_secs: null },
    { suppress_secs: '' }, { suppress_secs: [] }, { suppress_secs: {} },
    { min_lap_gap_secs: 99999 }, { min_lap_gap_secs: NaN }, { min_lap_gap_secs: true },
  ]) {
    await request(app).post('/api/ingest/lap-targets').set('X-Reader-Token', made.body.app_token).send(body);
  }
  assert.deepEqual(db.prepare('SELECT suppress_secs, min_lap_gap_secs FROM contests WHERE id = ?').get(id), before,
    'none of those reached the column');
});

// ---------------------------------------------------------------------------
// Swapping a chip in the field: atomic, and it will not take someone else's.
// ---------------------------------------------------------------------------

const chipSetup = async () => {
  const request = require('supertest');
  process.env.OPEN_REGISTRATION = '1';
  const { app } = require('../server/index');
  const reg = await request(app).post('/api/auth/register')
    .send({ email: `chp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@test.co`,
            password: 'password123', name: 'Chp' });
  const auth = { Authorization: `Bearer ${reg.body.token}` };
  const made = await request(app).post('/api/contests').set(auth).send({
    title: 'Chips', kind: 'race', sport: 'MTB — Cross-country (XCO)',
    start_at: iso(-60), end_at: iso(3600),
  });
  const id = made.body.id;
  const add = (epc, bib, name) => request(app).post(`/api/contests/${id}/tags`).set(auth)
    .send({ epc, bib, participant: name, category: '43-45', distance: 'Elite', team: 'Aces' });
  await add('AAAA0001', '101', 'Yossi');
  await add('AAAA0002', '205', 'Dana');
  const chips = (bib) => db.prepare(
    'SELECT epc FROM tag_assignments WHERE contest_id = ? AND bib = ? ORDER BY epc').all(id, bib).map((r) => r.epc);
  return { request, app, auth, id, chips };
};

test('a chip swap keeps the racer and carries their details over', async () => {
  const { request, app, auth, id, chips } = await chipSetup();
  const res = await request(app).post(`/api/contests/${id}/chips`).set(auth)
    .send({ bib: '101', epc: 'BBBB0001' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(chips('101'), ['BBBB0001'], 'old chip gone, new one in');
  const row = db.prepare('SELECT * FROM tag_assignments WHERE contest_id = ? AND epc = ?').get(id, 'BBBB0001');
  assert.equal(row.participant, 'Yossi');
  assert.equal(row.category, '43-45', 'details follow the racer to the new chip');
  assert.equal(row.team, 'Aces');
});

// The old path upserted ON CONFLICT DO UPDATE SET bib = excluded.bib, so a chip
// out of the spares box that was already in the list moved to the new racer and
// deleted the old one, without a word.
test('a chip that belongs to another racer is refused, not taken', async () => {
  const { request, app, auth, id, chips } = await chipSetup();
  const res = await request(app).post(`/api/contests/${id}/chips`).set(auth)
    .send({ bib: '101', epc: 'AAAA0002' }); // Dana's chip
  assert.equal(res.status, 409);
  assert.equal(res.body.held_by_bib, '205');
  assert.equal(res.body.held_by, 'Dana');
  assert.deepEqual(chips('101'), ['AAAA0001'], 'Yossi keeps his chip');
  assert.deepEqual(chips('205'), ['AAAA0002'], 'and Dana still exists');
});

test('a second chip is added without disturbing the first', async () => {
  const { request, app, auth, id, chips } = await chipSetup();
  const res = await request(app).post(`/api/contests/${id}/chips`).set(auth)
    .send({ bib: '101', epc: 'BBBB0002', mode: 'add' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(chips('101'), ['AAAA0001', 'BBBB0002'], 'either read now counts');

  // Replacing on a two-chip racer used to be refused outright, because the
  // delete was bib-wide and would have taken both rows.
  const swap = await request(app).post(`/api/contests/${id}/chips`).set(auth)
    .send({ bib: '101', epc: 'CCCC0003' });
  assert.equal(swap.status, 200, JSON.stringify(swap.body));
  assert.deepEqual(chips('101'), ['BBBB0002', 'CCCC0003'], 'only the primary was swapped');

  const third = await request(app).post(`/api/contests/${id}/chips`).set(auth)
    .send({ bib: '101', epc: 'DDDD0004', mode: 'add' });
  assert.equal(third.status, 409, 'a third chip is refused');
});

test('a chip swap is rejected whole when anything about it is wrong', async () => {
  const { request, app, auth, id, chips } = await chipSetup();
  for (const [body, code] of [
    [{ bib: '999', epc: 'BBBB0009' }, 404],   // no such racer
    [{ bib: '101', epc: 'nothex!' }, 400],    // not an EPC
    [{ bib: '', epc: 'BBBB0009' }, 400],      // no bib
  ]) {
    const res = await request(app).post(`/api/contests/${id}/chips`).set(auth).send(body);
    assert.equal(res.status, code, JSON.stringify(body));
  }
  assert.deepEqual(chips('101'), ['AAAA0001'], 'the racer still has exactly their chip');

  // Re-sending the chip they already hold is a no-op, not a failure: at the mat
  // a second tap must not look like something went wrong.
  const same = await request(app).post(`/api/contests/${id}/chips`).set(auth)
    .send({ bib: '101', epc: 'AAAA0001' });
  assert.equal(same.status, 200);
  assert.equal(same.body.unchanged, true);
  assert.deepEqual(chips('101'), ['AAAA0001']);
});

// ---- a racer who set off late ----------------------------------------------
// Rolling over the start mat minutes after the gun is them STARTING, not a lap.
// Without a late start recorded, that read is their first crossing — and in a
// single-crossing race it is their finish, at a time they never rode.

function seedLateStarter({ recordLaps, raceLaps }) {
  const contestId = db.prepare(
    `INSERT INTO contests (organizer_id, title, description, category, tags, visibility,
       start_at, end_at, kind, sport, status, suppress_secs, min_lap_gap_secs, record_laps, race_laps)
     VALUES (?,?,'','other','[]','public',?,?, 'race', 'MTB XCO', 'active', 10, 30, ?, ?)`
  ).run(organizerId, `Late ${recordLaps}-${raceLaps}-${Math.random()}`, iso(-60), iso(3600),
    recordLaps, raceLaps).lastInsertRowid;
  const readerId = db.prepare(
    'INSERT INTO readers (contest_id, name, token, location) VALUES (?,?,?,?)'
  ).run(contestId, 'Timing app', `tok_late_${contestId}_${Math.random()}`, '').lastInsertRowid;
  const waveId = db.prepare(
    'INSERT INTO waves (contest_id, name, started_at) VALUES (?,?,?)'
  ).run(contestId, 'wave1', new Date(gun).toISOString()).lastInsertRowid;
  db.prepare(
    'INSERT INTO tag_assignments (contest_id, epc, bib, participant, wave_id) VALUES (?,?,?,?,?)'
  ).run(contestId, 'EPC_LATE', '31', 'Late Starter', waveId);
  const read = (secs) => db.prepare(
    'INSERT INTO tag_reads (reader_id, contest_id, epc, read_at) VALUES (?,?,?,?)'
  ).run(readerId, contestId, 'EPC_LATE', iso(secs));
  read(192);   // 3:12 — rolling over the mat, setting off
  read(900);   // 15:00 — a real lap
  read(1620);  // 27:00 — a real lap
  return {
    contest: () => db.prepare('SELECT * FROM contests WHERE id = ?').get(contestId),
    setLate: (secs) => db.prepare(
      'UPDATE tag_assignments SET late_start_at = ? WHERE contest_id = ? AND bib = ?'
    ).run(secs === null ? null : gun + secs * 1000, contestId, '31'),
  };
}

test('without a late start, leaving the start line counts as a lap', () => {
  const race = seedLateStarter({ recordLaps: 1, raceLaps: 3 });
  const r = computeRaceResults(race.contest()).find((x) => x.bib === '31');
  assert.equal(r.laps, 3, 'the roll-out is counted as lap 1 — the behaviour being fixed');
  assert.equal(r.status, 'finished', 'so three laps arrive one lap early');
});

test('a late start makes the roll-out stop counting as a lap', () => {
  const race = seedLateStarter({ recordLaps: 1, raceLaps: 3 });
  race.setLate(192);
  const r = computeRaceResults(race.contest()).find((x) => x.bib === '31');
  assert.equal(r.laps, 2, 'only the two real laps count');
  // The server has no "on course with N laps" state — anyone with a crossing
  // carries a time here, and the tablet is what shows a rider mid-race.
  assert.equal(r.status, 'finished');
});

test('a late start never moves the clock: elapsed still runs from the gun', () => {
  const race = seedLateStarter({ recordLaps: 1, raceLaps: 2 });
  race.setLate(192);
  const r = computeRaceResults(race.contest()).find((x) => x.bib === '31');
  assert.equal(r.status, 'finished');
  assert.equal(r.laps, 2);
  // 27:00 from the gun, not 27:00 minus the 3:12 spent getting to the line.
  assert.equal(r.elapsed_ms, 1620_000, 'the lateness is the racer\'s own loss');
});

test('in a single-crossing race a late start saves the real finish', () => {
  const unfixed = seedLateStarter({ recordLaps: 0, raceLaps: 0 });
  const before = computeRaceResults(unfixed.contest()).find((x) => x.bib === '31');
  assert.equal(before.elapsed_ms, 192_000, 'the roll-out was recorded as the finish');

  const race = seedLateStarter({ recordLaps: 0, raceLaps: 0 });
  race.setLate(192);
  const after = computeRaceResults(race.contest()).find((x) => x.bib === '31');
  assert.equal(after.elapsed_ms, 900_000, 'the first real crossing is the finish');
});

test('clearing a late start puts the racer back as they were', () => {
  const race = seedLateStarter({ recordLaps: 1, raceLaps: 3 });
  race.setLate(192);
  race.setLate(null);
  const r = computeRaceResults(race.contest()).find((x) => x.bib === '31');
  assert.equal(r.laps, 3, 'the operator can undo the call');
});

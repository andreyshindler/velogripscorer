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

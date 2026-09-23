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

test('a blank sport keeps the lap-first default', () => {
  const results = computeRaceResults(seedRace(''));
  const byBib = Object.fromEntries(results.map((r) => [r.bib, r]));
  assert.equal(byBib['1'].rank, 1);
});

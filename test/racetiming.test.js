'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = process.env.DATA_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'vgs-race-'));
process.env.DISABLE_RATE_LIMIT = '1';

const request = require('supertest');
const { app } = require('../server/index');

const past = new Date(Date.now() - 3600_000).toISOString();
const future = new Date(Date.now() + 86400_000).toISOString();

async function register(email, name) {
  const res = await request(app).post('/api/auth/register').send({ email, password: 'password123', name });
  assert.equal(res.status, 201);
  return res.body;
}
const auth = (s) => ({ Authorization: `Bearer ${s.token}` });

let org, contest, reader, wave1, wave2;
// Gun time 10 minutes ago so test reads land comfortably after it.
const gunTime = new Date(Date.now() - 600_000);
const atOffset = (secs) => new Date(gunTime.getTime() + secs * 1000).toISOString();

test('setup: contest, reader, waves, assignments', async () => {
  org = await register('gun-org@test.co', 'Gun Organizer');
  contest = (await request(app).post('/api/contests').set(auth(org)).send({
    title: 'Crit race with waves', category: 'other', start_at: past, end_at: future,
    criteria: [{ name: 'Overall', weight: 100 }],
  })).body;
  reader = (await request(app).post(`/api/contests/${contest.id}/readers`).set(auth(org))
    .send({ name: 'Finish', location: 'finish' })).body;

  wave1 = (await request(app).post(`/api/contests/${contest.id}/waves`).set(auth(org)).send({ name: 'wave1' })).body;
  wave2 = (await request(app).post(`/api/contests/${contest.id}/waves`).set(auth(org)).send({ name: 'wave2' })).body;
  const dup = await request(app).post(`/api/contests/${contest.id}/waves`).set(auth(org)).send({ name: 'wave1' });
  assert.equal(dup.status, 409);

  // riders: 100/101 in wave1, 102 in wave2 (never started), 103 in wave1 but never reads
  for (const [epc, bib, name, wave] of [
    ['AAAA0100', '100', 'Rider Hundred', wave1.id],
    ['AAAA0101', '101', 'Rider One-Oh-One', wave1.id],
    ['AAAA0102', '102', 'Rider One-Oh-Two', wave2.id],
    ['AAAA0103', '103', 'Rider DNS', wave1.id],
  ]) {
    const r = await request(app).post(`/api/contests/${contest.id}/tags`).set(auth(org))
      .send({ epc, bib, participant: name, wave_id: wave, category: 'עד 44' });
    assert.equal(r.status, 201);
  }
});

test('starting a wave records gun time; double start needs force', async () => {
  const start = await request(app).post(`/api/contests/${contest.id}/waves/${wave1.id}/start`).set(auth(org))
    .send({ at: gunTime.toISOString() });
  assert.equal(start.status, 200);
  assert.equal(new Date(start.body.started_at).getTime(), gunTime.getTime());

  const again = await request(app).post(`/api/contests/${contest.id}/waves/${wave1.id}/start`).set(auth(org)).send({});
  assert.equal(again.status, 409);
  const forced = await request(app).post(`/api/contests/${contest.id}/waves/${wave1.id}/start`).set(auth(org))
    .send({ at: gunTime.toISOString(), force: true });
  assert.equal(forced.status, 200);
});

test('race results apply the suppression window, laps and ranking', async () => {
  // suppression default is 10s; min lap gap default 30s
  await request(app).post('/api/ingest/reads').set('X-Reader-Token', reader.token).send({
    reads: [
      // Rider 100: read at +5s is inside the suppression window and must be ignored;
      // crossings at +65s and +125s => 2 laps, finish elapsed 2:05.0
      { epc: 'AAAA0100', read_at: atOffset(5) },
      { epc: 'AAAA0100', read_at: atOffset(65) },
      { epc: 'AAAA0100', read_at: atOffset(66) },   // antenna re-read, within lap gap: same crossing
      { epc: 'AAAA0100', read_at: atOffset(125) },
      // Rider 101: single crossing at +90s => 1:30.0 — but only 1 lap so ranks below 100
      { epc: 'AAAA0101', read_at: atOffset(90) },
      // Rider 102: wave2 never started; reads must not produce a result
      { epc: 'AAAA0102', read_at: atOffset(70) },
    ],
  });

  const res = await request(app).get(`/api/contests/${contest.id}/race-results`).set(auth(org));
  assert.equal(res.status, 200);
  const byBib = Object.fromEntries(res.body.results.map((r) => [r.bib, r]));

  assert.equal(byBib['100'].status, 'finished');
  assert.equal(byBib['100'].laps, 2, 'suppressed + deduped reads leave 2 crossings');
  assert.equal(byBib['100'].elapsed, '2:05.0');
  assert.equal(byBib['100'].rank, 1, 'more laps ranks first');

  assert.equal(byBib['101'].status, 'finished');
  assert.equal(byBib['101'].laps, 1);
  assert.equal(byBib['101'].elapsed, '1:30.0');
  assert.equal(byBib['101'].rank, 2);

  assert.equal(byBib['102'].status, 'not_started', 'wave never started');
  assert.equal(byBib['103'].status, 'on_course', 'no reads yet');

  // category filter + csv
  const csv = await request(app).get(`/api/contests/${contest.id}/race-results?format=csv`).set(auth(org));
  assert.match(csv.text, /Rider Hundred/);
  assert.match(csv.headers['content-type'], /text\/csv/);
});

test('manual bib entry records a passing, synthesizing assignments when needed', async () => {
  // known bib uses its assigned EPC
  const known = await request(app).post(`/api/contests/${contest.id}/manual-read`).set(auth(org))
    .send({ bib: '103', at: atOffset(200) });
  assert.equal(known.status, 201);
  assert.equal(known.body.epc, 'AAAA0103');

  // unknown numeric bib gets a synthetic assignment
  const unknown = await request(app).post(`/api/contests/${contest.id}/manual-read`).set(auth(org))
    .send({ bib: '999', at: atOffset(210) });
  assert.equal(unknown.status, 201);
  assert.equal(unknown.body.epc, 'AA0999');

  const res = await request(app).get(`/api/contests/${contest.id}/race-results`).set(auth(org));
  const rider103 = res.body.results.find((r) => r.bib === '103');
  assert.equal(rider103.status, 'finished');
  assert.equal(rider103.elapsed, '3:20.0');
});

test('manual taps count even inside the start-suppression window', async () => {
  // A racer tapped manually 5s after the gun (suppress window is 10s).
  const tagged = await request(app).post(`/api/contests/${contest.id}/tags`).set(auth(org))
    .send({ epc: 'AAAA0104', bib: '104', participant: 'Early Tap', wave_id: wave1.id });
  assert.equal(tagged.status, 201);

  // An RFID read at +5s is suppressed (start-line noise)...
  await request(app).post('/api/ingest/reads').set('X-Reader-Token', reader.token).send({
    reads: [{ epc: 'AAAA0104', read_at: atOffset(5) }],
  });
  let res = await request(app).get(`/api/contests/${contest.id}/race-results`).set(auth(org));
  assert.equal(res.body.results.find((r) => r.bib === '104').status, 'on_course',
    'RFID read inside the window stays suppressed');

  // ...but the same moment tapped by the operator is a deliberate finish.
  await request(app).post('/api/ingest/reads').set('X-Reader-Token', reader.token).send({
    reads: [{ epc: 'AAAA0104', read_at: atOffset(5), manual: true }],
  });
  res = await request(app).get(`/api/contests/${contest.id}/race-results`).set(auth(org));
  const rider = res.body.results.find((r) => r.bib === '104');
  assert.equal(rider.status, 'finished');
  assert.equal(rider.elapsed, '0:05.0');

  // The web Manual-entry endpoint is manual too, even inside the window.
  await request(app).post(`/api/contests/${contest.id}/tags`).set(auth(org))
    .send({ epc: 'AAAA0105', bib: '105', participant: 'Web Tap', wave_id: wave1.id });
  const tap = await request(app).post(`/api/contests/${contest.id}/manual-read`).set(auth(org))
    .send({ bib: '105', at: atOffset(6) });
  assert.equal(tap.status, 201);
  res = await request(app).get(`/api/contests/${contest.id}/race-results`).set(auth(org));
  assert.equal(res.body.results.find((r) => r.bib === '105').status, 'finished');
});

test('racer statuses sync from the app and record_laps disables lap counting', async () => {
  // no-read racer marked DNS on the phone -> synced -> web shows DNS
  await request(app).post(`/api/contests/${contest.id}/tags`).set(auth(org))
    .send({ epc: 'AAAA0106', bib: '106', participant: 'No Show', wave_id: wave1.id });
  const noToken = await request(app).post('/api/ingest/racer-statuses').send({ statuses: [] });
  assert.equal(noToken.status, 401);

  const sync = await request(app).post('/api/ingest/racer-statuses').set('X-Reader-Token', reader.token)
    .send({ statuses: [{ bib: '106', status: 'dns' }, { bib: 'nope', status: 'DNF' }, { bib: '106', status: 'XX' }] });
  assert.equal(sync.status, 200);
  assert.equal(sync.body.applied, 1, 'only the valid known-bib status applies');
  let res = await request(app).get(`/api/contests/${contest.id}/race-results`).set(auth(org));
  assert.equal(res.body.results.find((r) => r.bib === '106').status, 'DNS');

  // clearing the status puts the racer back on course
  await request(app).post('/api/ingest/racer-statuses').set('X-Reader-Token', reader.token)
    .send({ statuses: [{ bib: '106', status: '' }] });
  res = await request(app).get(`/api/contests/${contest.id}/race-results`).set(auth(org));
  assert.equal(res.body.results.find((r) => r.bib === '106').status, 'on_course');

  // record_laps off: rider 100's two crossings collapse to a single finish
  // at the FIRST crossing (+65s), instead of 2 laps ending at +125s.
  await request(app).patch(`/api/contests/${contest.id}/timing-settings`).set(auth(org))
    .send({ record_laps: false });
  res = await request(app).get(`/api/contests/${contest.id}/race-results`).set(auth(org));
  const r100 = res.body.results.find((r) => r.bib === '100');
  assert.equal(r100.laps, 1);
  assert.equal(r100.elapsed, '1:05.0');

  // the app pushes its lap mode when finishing the race
  const fin = await request(app).post('/api/ingest/finish').set('X-Reader-Token', reader.token)
    .send({ record_laps: true });
  assert.equal(fin.status, 200);
  const c = await request(app).get(`/api/contests/${contest.id}`).set(auth(org));
  assert.equal(c.body.record_laps, 1, 'finish restored lap recording');
});

test('timing settings are adjustable and affect results', async () => {
  const patch = await request(app).patch(`/api/contests/${contest.id}/timing-settings`).set(auth(org))
    .send({ suppress_secs: 100, min_lap_gap_secs: 30 });
  assert.equal(patch.status, 200);
  const res = await request(app).get(`/api/contests/${contest.id}/race-results`).set(auth(org));
  const rider101 = res.body.results.find((r) => r.bib === '101');
  assert.equal(rider101.status, 'on_course', '+90s read now falls inside the 100s suppression window');
  // restore
  await request(app).patch(`/api/contests/${contest.id}/timing-settings`).set(auth(org))
    .send({ suppress_secs: 10, min_lap_gap_secs: 30 });
});

test('race kind: creation without criteria; results and start list are public', async () => {
  const raceOrg = await register('race-kind@test.co', 'Race Kind Org');
  const race = await request(app).post('/api/contests').set(auth(raceOrg)).send({
    kind: 'race', title: 'Public XCO race', sport: 'Cycling — MTB XCO', location: 'Kiryat Gat',
    start_at: past, end_at: future,
  });
  assert.equal(race.status, 201, JSON.stringify(race.body));
  assert.equal(race.body.kind, 'race');
  assert.equal(race.body.sport, 'Cycling — MTB XCO');
  assert.equal(race.body.criteria.length, 0);

  // anonymous visitors can read results and start list of a public race
  const anonResults = await request(app).get(`/api/contests/${race.body.id}/race-results`);
  assert.equal(anonResults.status, 200);
  const anonStartlist = await request(app).get(`/api/contests/${race.body.id}/startlist`);
  assert.equal(anonStartlist.status, 200);

  // voting kind still validates criteria
  const badVoting = await request(app).post('/api/contests').set(auth(raceOrg)).send({
    kind: 'voting', title: 'needs criteria', start_at: past, end_at: future,
  });
  assert.equal(badVoting.status, 400);
});

test('DNS/DNF/DSQ statuses override results and sink below finishers', async () => {
  const gun2 = new Date(Date.now() - 500_000);
  const at2 = (secs) => new Date(gun2.getTime() + secs * 1000).toISOString();
  const w = (await request(app).post(`/api/contests/${contest.id}/waves`).set(auth(org)).send({ name: 'statuswave' })).body;
  await request(app).post(`/api/contests/${contest.id}/waves/${w.id}/start`).set(auth(org))
    .send({ at: gun2.toISOString() });

  for (const [epc, bib, name, status] of [
    ['BBBB0200', '200', 'Finisher', ''],
    ['BBBB0201', '201', 'Second Finisher', ''],
    ['BBBB0202', '202', 'Did Not Start', 'DNS'],
    ['BBBB0203', '203', 'Did Not Finish', 'DNF'],
  ]) {
    await request(app).post(`/api/contests/${contest.id}/tags`).set(auth(org))
      .send({ epc, bib, participant: name, wave_id: w.id, category: 'M40', racer_status: status });
  }
  const reader2 = (await request(app).post(`/api/contests/${contest.id}/readers`).set(auth(org))
    .send({ name: 'Status reader' })).body;
  await request(app).post('/api/ingest/reads').set('X-Reader-Token', reader2.token).send({
    reads: [
      { epc: 'BBBB0200', read_at: at2(100) },
      { epc: 'BBBB0201', read_at: at2(130) },
      { epc: 'BBBB0203', read_at: at2(90) },  // read exists but organizer marked DNF
    ],
  });

  const res = await request(app).get(`/api/contests/${contest.id}/race-results?category=M40`).set(auth(org));
  const rows = res.body.results;
  assert.equal(rows[0].bib, '200');
  assert.equal(rows[0].behind, '', 'leader has no gap');
  assert.equal(rows[0].category_rank, 1);
  assert.equal(rows[1].bib, '201');
  assert.equal(rows[1].behind, '+0:30.0', 'gap behind leader');
  assert.equal(rows[1].category_rank, 2);
  const dnf = rows.find((r) => r.bib === '203');
  assert.equal(dnf.status, 'DNF', 'organizer status overrides reads');
  assert.equal(dnf.rank, undefined);
  const dns = rows.find((r) => r.bib === '202');
  assert.equal(dns.status, 'DNS');
  assert.ok(rows.indexOf(dnf) > 1 && rows.indexOf(dns) > 1, 'statuses sink below finishers');
});

test('bulk start-list import creates racers, waves, and synthetic EPCs', async () => {
  const bulkOrg = await register('bulk-org@test.co', 'Bulk Org');
  const race = (await request(app).post('/api/contests').set(auth(bulkOrg)).send({
    kind: 'race', title: 'Bulk import race', start_at: past, end_at: future,
  })).body;

  const res = await request(app).post(`/api/contests/${race.id}/tags/bulk`).set(auth(bulkOrg)).send({
    racers: [
      { bib: '100', participant: 'עידן אדמון', category: 'עד 44', wave: 'wave1', epc: 'E28011606000020100000100' },
      { bib: '101', participant: 'ניר לוי', category: 'עד 44', wave: 'wave1', epc: '' },   // synthetic EPC
      { bib: '102', participant: 'זהר גנאטק', category: '45+', wave: 'wave2' },            // new wave
      { bib: '', participant: '' },                                                        // bad row skipped
      { bib: 'X9', participant: 'No Epc NonNumeric' },                                     // bad row skipped
    ],
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.imported, 3);
  assert.equal(res.body.skipped, 2);
  assert.equal(res.body.errors.length, 2);

  const tags = (await request(app).get(`/api/contests/${race.id}/tags`).set(auth(bulkOrg))).body.tags;
  assert.equal(tags.length, 3);
  const r101 = tags.find((a) => a.bib === '101');
  assert.equal(r101.epc, 'AA0101', 'synthetic EPC from bib');
  assert.equal(r101.wave_name, 'wave1');

  const waves = (await request(app).get(`/api/contests/${race.id}/waves`).set(auth(bulkOrg))).body.waves;
  assert.deepEqual(waves.map((w) => w.name).sort(), ['wave1', 'wave2'], 'waves auto-created');

  // re-import updates rather than duplicates
  const again = await request(app).post(`/api/contests/${race.id}/tags/bulk`).set(auth(bulkOrg)).send({
    racers: [{ bib: '100', participant: 'עידן אדמון (עודכן)', category: 'עד 44', wave: 'wave1', epc: 'E28011606000020100000100' }],
  });
  assert.equal(again.body.imported, 1);
  const after = (await request(app).get(`/api/contests/${race.id}/tags`).set(auth(bulkOrg))).body.tags;
  assert.equal(after.length, 3, 'no duplicates on re-import');
  assert.ok(after.some((a) => a.participant.includes('עודכן')));

  // organizer-only
  const outsider = await register('bulk-outsider@test.co', 'Bulk Outsider');
  const denied = await request(app).post(`/api/contests/${race.id}/tags/bulk`).set(auth(outsider))
    .send({ racers: [{ bib: '1', participant: 'x' }] });
  assert.equal(denied.status, 403);
});

test('xlsx cell parsing: a self-closing empty cell must not eat the next cell', () => {
  const { parseSheetRows } = require('../server/xlsx');
  const shared = ['name', '5k'];               // shared-string table
  // Row: A=name, B is an empty *self-closing* styled cell (like an empty Age),
  // C carries the distance as shared string #1. The C value must survive.
  const sheet =
    '<row r="2">' +
    '<c r="A2" t="s"><v>0</v></c>' +
    '<c r="B2" s="15"/>' +
    '<c r="C2" s="16" t="s"><v>1</v></c>' +
    '</row>';
  const rows = parseSheetRows(sheet, shared);
  assert.equal(rows.length, 1);
  assert.equal(rows[0][0], 'name');
  assert.equal(rows[0][1], undefined, 'empty self-closing cell stays empty');
  assert.equal(rows[0][2], '5k', 'distance beside the empty cell is not swallowed');
});

test('xlsx start-list upload: Webscorer format, two chips per racer, delete race', async () => {
  const xlOrg = await register('xlsx-org@test.co', 'Xlsx Org');
  const race = (await request(app).post('/api/contests').set(auth(xlOrg)).send({
    kind: 'race', title: 'Excel race', start_at: past, end_at: future,
  })).body;

  const up = await request(app).post(`/api/contests/${race.id}/startlist-file`).set(auth(xlOrg))
    .attach('file', 'test/fixtures/startlist.xlsx');
  assert.equal(up.status, 200, JSON.stringify(up.body));
  assert.equal(up.body.imported, 3);
  assert.equal(up.body.errors.length, 0);

  const tags = (await request(app).get(`/api/contests/${race.id}/tags`).set(auth(xlOrg))).body.tags;
  assert.equal(tags.length, 3, 'tags list counts racers, not chips');
  // racer 1 has two chips -> ONE entry listing both EPCs
  const bib100 = tags.filter((a) => a.bib === '100');
  assert.equal(bib100.length, 1, 'two-chip racer appears once in the start list');
  assert.deepEqual([...bib100[0].epcs].sort(),
    ['000000000000000000009901', 'E28011700000021B236F9C4C']);
  // racer 3 had no chip -> synthetic EPC
  assert.ok(tags.some((a) => a.bib === '102' && a.epc === 'AA0102'));

  // waves auto-created from the sheet; per-wave counts are racers, not chips
  const waves = (await request(app).get(`/api/contests/${race.id}/waves`).set(auth(xlOrg))).body.waves;
  assert.deepEqual(waves.map((w) => w.name).sort(), ['wave1', 'wave2']);
  assert.equal(waves.find((w) => w.name === 'wave1').racer_count, 2,
    'two-chip racer counted once in wave');

  // race card / app picker count is racers too
  const myRaces = (await request(app).get('/api/my/races').set(auth(xlOrg))).body.races;
  assert.equal(myRaces.find((r) => r.id === race.id).racer_count, 3);

  // deleting the two-chip racer removes BOTH assignments
  const spare = (await request(app).post('/api/contests').set(auth(xlOrg)).send({
    kind: 'race', title: 'Delete-racer check', start_at: past, end_at: future,
  })).body;
  await request(app).post(`/api/contests/${spare.id}/tags`).set(auth(xlOrg))
    .send({ epc: 'ABCD0001', epc2: 'ABCD0002', bib: '7', participant: 'Dual Chip' });
  let spareTags = (await request(app).get(`/api/contests/${spare.id}/tags`).set(auth(xlOrg))).body.tags;
  assert.equal(spareTags.length, 1);
  assert.deepEqual([...spareTags[0].epcs].sort(), ['ABCD0001', 'ABCD0002']);
  await request(app).delete(`/api/contests/${spare.id}/tags/ABCD0002`).set(auth(xlOrg));
  spareTags = (await request(app).get(`/api/contests/${spare.id}/tags`).set(auth(xlOrg))).body.tags;
  assert.equal(spareTags.length, 0, 'deleting either chip removes the whole racer');

  // start the wave; a read on EITHER chip finishes the racer exactly once
  const gun3 = new Date(Date.now() - 400_000);
  const wave1 = waves.find((w) => w.name === 'wave1');
  await request(app).post(`/api/contests/${race.id}/waves/${wave1.id}/start`).set(auth(xlOrg))
    .send({ at: gun3.toISOString() });
  const readers = (await request(app).get(`/api/contests/${race.id}/readers`).set(auth(xlOrg))).body.readers;
  await request(app).post('/api/ingest/reads').set('X-Reader-Token', readers[0].token).send({
    reads: [
      { epc: 'E28011700000021B236F9C4C', read_at: new Date(gun3.getTime() + 70_000).toISOString() }, // chip 2
      { epc: '000000000000000000009901', read_at: new Date(gun3.getTime() + 71_000).toISOString() }, // chip 1 re-read
    ],
  });
  const results = (await request(app).get(`/api/contests/${race.id}/race-results`).set(auth(xlOrg))).body.results;
  const dual = results.filter((r) => r.bib === '100');
  assert.equal(dual.length, 1, 'two-chip racer appears once in results');
  assert.equal(dual[0].status, 'finished');
  assert.equal(dual[0].laps, 1, 'both chip reads collapse into one crossing');
  assert.equal(dual[0].elapsed, '1:10.0', 'earliest chip read wins');
  assert.equal(dual[0].distance, '5k');
  assert.equal(dual[0].team, 'Team A');

  // public start list is deduped and carries distance/team
  const startlist = (await request(app).get(`/api/contests/${race.id}/startlist`)).body;
  assert.equal(startlist.racers.filter((r) => r.bib === '100').length, 1);
  assert.equal(startlist.racers.find((r) => r.bib === '101').distance, '10k');

  // delete race: non-organizer denied, organizer wipes everything
  const outsider2 = await register('xlsx-outsider@test.co', 'Xlsx Outsider');
  const denied = await request(app).delete(`/api/contests/${race.id}`).set(auth(outsider2));
  assert.equal(denied.status, 403);
  const del = await request(app).delete(`/api/contests/${race.id}`).set(auth(xlOrg));
  assert.equal(del.status, 200);
  const gone = await request(app).get(`/api/contests/${race.id}`);
  assert.equal(gone.status, 404);
  const tokenDead = await request(app).get('/api/ingest/ping').set('X-Reader-Token', readers[0].token);
  assert.equal(tokenDead.status, 401, 'pairing token dies with the race');
});

test('finished status: create + duplicate stay active; finished race can be reopened', async () => {
  const o = await register('reopen-org@test.co', 'Reopen Org');
  // A freshly created race is NOT finished.
  const src = (await request(app).post('/api/contests').set(auth(o)).send({
    title: 'Round 1', kind: 'race', start_at: past, end_at: future,
  })).body;
  assert.equal(src.status, 'active', 'new race starts active');

  // Its pairing token (auto-created), used to post results / finish.
  const token = (await request(app).get('/api/my/races').set(auth(o))).body.races
    .find((r) => r.id === src.id).app_token;

  // Finish it via the app -> now it shows on the public Finished page.
  const fin = await request(app).post('/api/ingest/finish').set('X-Reader-Token', token).send({});
  assert.equal(fin.status, 200);
  let src2 = (await request(app).get(`/api/contests/${src.id}`)).body;
  assert.equal(src2.status, 'finished');
  let finished = (await request(app).get('/api/contests?status=finished')).body.contests.map((c) => c.id);
  assert.ok(finished.includes(src.id), 'finished race listed on Finished page');

  // Duplicating a FINISHED race yields an ACTIVE copy (not finished).
  const dup = (await request(app).post(`/api/contests/${src.id}/duplicate`).set(auth(o))
    .send({ title: 'Round 2' })).body;
  const dupFull = (await request(app).get(`/api/contests/${dup.id}`)).body;
  assert.equal(dupFull.status, 'active', 'duplicated start list is not finished');
  finished = (await request(app).get('/api/contests?status=finished')).body.contests.map((c) => c.id);
  assert.ok(!finished.includes(dup.id), 'duplicate does not appear on Finished page');

  // Reopen: only the organizer, races only, moves it back to active.
  const outsider = await register('reopen-outsider@test.co', 'Outsider');
  const denied = await request(app).post(`/api/contests/${src.id}/reopen`).set(auth(outsider));
  assert.equal(denied.status, 403, 'non-organizer cannot reopen');
  const reopened = await request(app).post(`/api/contests/${src.id}/reopen`).set(auth(o));
  assert.equal(reopened.status, 200);
  src2 = (await request(app).get(`/api/contests/${src.id}`)).body;
  assert.equal(src2.status, 'active', 'reopened race is active again');
  finished = (await request(app).get('/api/contests?status=finished')).body.contests.map((c) => c.id);
  assert.ok(!finished.includes(src.id), 'reopened race drops off Finished page');

  // Editable status from "My start lists": flip active <-> finished directly.
  const bad = await request(app).patch(`/api/contests/${src.id}/status`).set(auth(o)).send({ status: 'nope' });
  assert.equal(bad.status, 400, 'invalid status rejected');
  const outDenied = await request(app).patch(`/api/contests/${src.id}/status`).set(auth(outsider)).send({ status: 'finished' });
  assert.equal(outDenied.status, 403, 'non-organizer cannot set status');
  const toFinished = await request(app).patch(`/api/contests/${src.id}/status`).set(auth(o)).send({ status: 'finished' });
  assert.equal(toFinished.status, 200);
  assert.equal((await request(app).get(`/api/contests/${src.id}`)).body.status, 'finished');
  const toActive = await request(app).patch(`/api/contests/${src.id}/status`).set(auth(o)).send({ status: 'active' });
  assert.equal(toActive.status, 200);
  assert.equal((await request(app).get(`/api/contests/${src.id}`)).body.status, 'active');

  // The auto-finish sweep must NOT re-finish a past-dated race. Create a race
  // whose end_at is already in the past, then run the sweep: it should stay
  // active. Only voting contests are swept; races finish explicitly. (Without
  // the kind='voting' filter this race would flip back to finished.)
  const older = new Date(Date.now() - 7200_000).toISOString();
  const pastEnd = new Date(Date.now() - 60_000).toISOString();
  const pastRace = (await request(app).post('/api/contests').set(auth(o)).send({
    title: 'Yesterday race', kind: 'race', start_at: older, end_at: pastEnd,
  })).body;
  assert.equal(pastRace.status, 'active');
  const { sweepEndedContests } = require('../server/routes/contests');
  sweepEndedContests();
  assert.equal((await request(app).get(`/api/contests/${pastRace.id}`)).body.status, 'active',
    'sweep leaves an active past-dated race alone');
});

test('edit schedule: PATCH updates start_at/end_at with validation', async () => {
  const o = await register('sched-org@test.co', 'Sched Org');
  const c = (await request(app).post('/api/contests').set(auth(o)).send({
    title: 'Schedule me', kind: 'race', start_at: past, end_at: future,
  })).body;
  const newStart = new Date(Date.now() + 3600_000).toISOString();
  const newEnd = new Date(Date.now() + 7200_000).toISOString();
  const ok = await request(app).patch(`/api/contests/${c.id}`).set(auth(o))
    .send({ start_at: newStart, end_at: newEnd });
  assert.equal(ok.status, 200);
  const got = (await request(app).get(`/api/contests/${c.id}`)).body;
  assert.equal(new Date(got.start_at).toISOString(), newStart);
  assert.equal(new Date(got.end_at).toISOString(), newEnd);

  // end must be after start
  const bad = await request(app).patch(`/api/contests/${c.id}`).set(auth(o))
    .send({ start_at: newEnd, end_at: newStart });
  assert.equal(bad.status, 400);

  // organizer only
  const outsider = await register('sched-out@test.co', 'Out');
  const denied = await request(app).patch(`/api/contests/${c.id}`).set(auth(outsider))
    .send({ start_at: newStart, end_at: newEnd });
  assert.equal(denied.status, 403);
});

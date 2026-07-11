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

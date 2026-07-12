'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = process.env.DATA_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'vgs-sync-'));
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

let org, contest, reader, wave;

test('setup: contest with start list on the web', async () => {
  org = await register('sync-org@test.co', 'Sync Organizer');
  contest = (await request(app).post('/api/contests').set(auth(org)).send({
    title: 'Offline-first race', category: 'other', start_at: past, end_at: future,
    criteria: [{ name: 'Overall', weight: 100 }],
  })).body;
  reader = (await request(app).post(`/api/contests/${contest.id}/readers`).set(auth(org))
    .send({ name: 'Phone at finish' })).body;
  wave = (await request(app).post(`/api/contests/${contest.id}/waves`).set(auth(org)).send({ name: 'elite' })).body;
  await request(app).post(`/api/contests/${contest.id}/tags`).set(auth(org))
    .send({ epc: 'AAAA0500', bib: '500', participant: 'Offline Rider', category: 'עד 44', wave_id: wave.id });
});

test('app downloads the start list with only its reader token', async () => {
  const res = await request(app).get('/api/ingest/startlist').set('X-Reader-Token', reader.token);
  assert.equal(res.status, 200);
  assert.equal(res.body.contest.title, 'Offline-first race');
  assert.equal(res.body.suppress_secs, 10);
  assert.equal(res.body.racers.length, 1);
  assert.deepEqual(res.body.racers[0], {
    epc: 'AAAA0500', bib: '500', participant: 'Offline Rider', category: 'עד 44', wave: 'elite',
    distance: '', gender: '',
  });
  assert.equal(res.body.waves[0].name, 'elite');
  assert.equal(res.body.waves[0].started_at, null);

  const denied = await request(app).get('/api/ingest/startlist').set('X-Reader-Token', 'vgr_bogus');
  assert.equal(denied.status, 401);
});

test('app uploads gun times; existing server gun time is kept unless forced', async () => {
  const gun = new Date(Date.now() - 300_000).toISOString();
  const up = await request(app).post('/api/ingest/wave-start').set('X-Reader-Token', reader.token)
    .send({ name: 'elite', started_at: gun });
  assert.equal(up.status, 200);
  assert.equal(new Date(up.body.started_at).getTime(), Date.parse(gun));

  // second upload without force keeps the first gun time
  const later = new Date(Date.now() - 100_000).toISOString();
  const again = await request(app).post('/api/ingest/wave-start').set('X-Reader-Token', reader.token)
    .send({ name: 'elite', started_at: later });
  assert.equal(again.body.kept_existing, true);
  assert.equal(new Date(again.body.started_at).getTime(), Date.parse(gun));

  // unknown wave names are created (start list born on the phone)
  const created = await request(app).post('/api/ingest/wave-start').set('X-Reader-Token', reader.token)
    .send({ name: 'sport', started_at: gun });
  assert.equal(created.status, 200);
  const waves = await request(app).get(`/api/contests/${contest.id}/waves`).set(auth(org));
  assert.ok(waves.body.waves.some((w) => w.name === 'sport' && w.started_at));
});

test('offline race round-trip: gun time + queued reads produce server results', async () => {
  const gun = new Date(Date.now() - 300_000).toISOString();
  // phone already uploaded wave start above (gun); now its outbox flushes reads
  const res = await request(app).post('/api/ingest/reads').set('X-Reader-Token', reader.token).send({
    reads: [
      { epc: 'AAAA0500', rssi: -60, read_at: new Date(Date.parse(gun) + 5000).toISOString() },   // suppressed
      { epc: 'AAAA0500', rssi: -58, read_at: new Date(Date.parse(gun) + 84200).toISOString() },  // finish
    ],
  });
  assert.equal(res.body.accepted, 2);

  const results = await request(app).get(`/api/contests/${contest.id}/race-results`).set(auth(org));
  const rider = results.body.results.find((r) => r.bib === '500');
  assert.equal(rider.status, 'finished');
  assert.equal(rider.laps, 1);
  assert.equal(rider.elapsed, '1:24.2');
  assert.equal(rider.rank, 1);
});

test('app login flow: /my/races lists own races with pairing tokens', async () => {
  const owner = await register('myraces@test.co', 'My Races Org');
  const other = await register('other-races@test.co', 'Other Org');
  const race = await request(app).post('/api/contests').set(auth(owner)).send({
    kind: 'race', title: 'Login-flow race', sport: 'Running', start_at: past, end_at: future,
  });
  assert.equal(race.status, 201);
  await request(app).post('/api/contests').set(auth(other)).send({
    kind: 'race', title: 'Someone else race', start_at: past, end_at: future,
  });

  const mine = await request(app).get('/api/my/races').set(auth(owner));
  assert.equal(mine.status, 200);
  assert.equal(mine.body.races.length, 1, 'only own races listed');
  assert.equal(mine.body.races[0].title, 'Login-flow race');
  assert.match(mine.body.races[0].app_token, /^vgr_[0-9a-f]{48}$/);

  // the listed token actually works for app sync
  const sl = await request(app).get('/api/ingest/startlist').set('X-Reader-Token', mine.body.races[0].app_token);
  assert.equal(sl.status, 200);
  assert.equal(sl.body.contest.title, 'Login-flow race');

  const anon = await request(app).get('/api/my/races');
  assert.equal(anon.status, 401);
});

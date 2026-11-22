'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = process.env.DATA_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'vgs-sync-'));
process.env.DISABLE_RATE_LIMIT = '1';
process.env.OPEN_REGISTRATION = '1'; // tests use self-service accounts; approval flow covered in approval.test.js

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

let org, contest, reader, wave, gunElite;

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
    distance: '', team: '', gender: '',
  });
  assert.equal(res.body.waves[0].name, 'elite');
  assert.equal(res.body.waves[0].started_at, null);

  const denied = await request(app).get('/api/ingest/startlist').set('X-Reader-Token', 'vgr_bogus');
  assert.equal(denied.status, 401);
});

test('app uploads gun times; existing server gun time is kept unless forced', async () => {
  const gun = gunElite = new Date(Date.now() - 300_000).toISOString();
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
  const gun = gunElite; // the exact gun the 'elite' wave was started with above
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

test('duplicating a race clones the start list into a new unique id, source untouched', async () => {
  const dup = await request(app).post(`/api/contests/${contest.id}/duplicate`).set(auth(org)).send({ title: 'Second event' });
  assert.equal(dup.status, 201);
  assert.notEqual(dup.body.id, contest.id);            // a brand-new id
  assert.equal(dup.body.title, 'Second event');
  assert.ok(dup.body.app_token && dup.body.app_token !== reader.token); // fresh pairing token

  // the clone carries the start list (with its wave), on its own token
  const sl = await request(app).get('/api/ingest/startlist').set('X-Reader-Token', dup.body.app_token);
  assert.equal(sl.status, 200);
  assert.equal(sl.body.racers.length, 1);
  assert.equal(sl.body.racers[0].bib, '500');
  assert.equal(sl.body.racers[0].wave, 'elite');
  assert.equal(sl.body.waves[0].started_at, null);     // no gun times carried over

  // the original race still resolves to its own id and roster
  const orig = await request(app).get('/api/ingest/startlist').set('X-Reader-Token', reader.token);
  assert.equal(orig.status, 200);
  assert.equal(orig.body.contest.id, contest.id);
  assert.equal(orig.body.racers.length, 1);
});

test('CSV and taps exports are organizer-only; JSON results stay public', async () => {
  // anonymous viewers (shared link) cannot export
  assert.equal((await request(app).get(`/api/contests/${contest.id}/race-results?format=csv`)).status, 403);
  assert.equal((await request(app).get(`/api/contests/${contest.id}/taps`)).status, 403);
  // but the public results JSON still works for everyone
  assert.equal((await request(app).get(`/api/contests/${contest.id}/race-results`)).status, 200);
  // the organizer can export both
  assert.equal((await request(app).get(`/api/contests/${contest.id}/race-results?format=csv`).set(auth(org))).status, 200);
  assert.equal((await request(app).get(`/api/contests/${contest.id}/taps`).set(auth(org))).status, 200);
});

test('results CSV is sectioned with per-lap durations', async () => {
  const o = await register('csvfmt@test.co', 'CSV Org');
  const c = (await request(app).post('/api/contests').set(auth(o))
    .send({ kind: 'race', title: 'CSV fmt', start_at: past, end_at: future })).body;
  const wv = (await request(app).post(`/api/contests/${c.id}/waves`).set(auth(o)).send({ name: 'e' })).body;
  await request(app).post(`/api/contests/${c.id}/tags`).set(auth(o))
    .send({ epc: 'AAAA9001', bib: '1', participant: 'Alpha Bravo', distance: '10k', gender: 'Male', wave_id: wv.id });
  const gun = Date.now() - 600000;
  await request(app).post('/api/ingest/wave-start').set('X-Reader-Token', c.app_token)
    .send({ name: 'e', started_at: new Date(gun).toISOString(), force: true });
  await request(app).post('/api/ingest/reads').set('X-Reader-Token', c.app_token).send({
    reads: [
      { epc: 'AAAA9001', read_at: new Date(gun + 120000).toISOString() }, // lap 1: 2:00
      { epc: 'AAAA9001', read_at: new Date(gun + 250000).toISOString() }, // lap 2: +2:10
    ],
  });
  const csv = (await request(app).get(`/api/contests/${c.id}/race-results?format=csv`).set(auth(o))).text;
  assert.ok(csv.includes('10k - Overall'), 'has a distance section');
  assert.ok(csv.includes('Place,Bib,Name,First name,Last name,Team name'), 'has the Webscorer header');
  const line = csv.split('\n').find((l) => l.startsWith('1,1,'));
  assert.ok(line.includes('2:00.0') && line.includes('2:10.0'), 'lap columns are durations, not cumulative');
});

test('editing a racer updates every column and GET tags returns them', async () => {
  const o = await register('editcols@test.co', 'Edit Org');
  const c = (await request(app).post('/api/contests').set(auth(o))
    .send({ kind: 'race', title: 'Edit race', start_at: past, end_at: future })).body;
  await request(app).post(`/api/contests/${c.id}/tags`).set(auth(o))
    .send({ epc: 'AAAA7001', bib: '7', participant: 'Old Name' });
  // edit every column via upsert on the same chip
  await request(app).post(`/api/contests/${c.id}/tags`).set(auth(o)).send({
    epc: 'AAAA7001', bib: '8', participant: 'New Name', category: 'M40',
    distance: '10k', team: 'Team X', gender: 'Female', racer_status: 'DNF',
  });
  const { body } = await request(app).get(`/api/contests/${c.id}/tags`).set(auth(o));
  const r = body.tags.find((x) => x.epc === 'AAAA7001');
  assert.equal(r.bib, '8');
  assert.equal(r.participant, 'New Name');
  assert.equal(r.category, 'M40');
  assert.equal(r.distance, '10k');
  assert.equal(r.team, 'Team X');
  assert.equal(r.gender, 'Female');
  assert.equal(r.racer_status, 'DNF');
});

// ---- corrections made on the device reach the server ----
//
// /ingest/reads only ever adds, so the app's own edits and deletes could never
// land: a time corrected on the tablet left the website publishing the original,
// and re-uploading the corrected read would have added a lap instead of moving
// one. The device restates the chip's whole set and the server swaps its rows.

test('the app replaces one chip\'s crossings, and only that chip on its own reader', async () => {
  const o = await register('replace@test.co', 'Replace Org');
  const c = (await request(app).post('/api/contests').set(auth(o)).send({
    kind: 'race', title: 'Photo finish', sport: 'Running', start_at: past, end_at: future,
  })).body;
  const phone = (await request(app).post(`/api/contests/${c.id}/readers`).set(auth(o))
    .send({ name: 'Phone at finish' })).body;
  const mat = (await request(app).post(`/api/contests/${c.id}/readers`).set(auth(o))
    .send({ name: 'Halfway', role: 'checkpoint' })).body;
  const w = (await request(app).post(`/api/contests/${c.id}/waves`).set(auth(o)).send({ name: 'open' })).body;
  for (const [epc, bib, who] of [['AAAA0801', '801', 'Rider A'], ['AAAA0802', '802', 'Rider B']]) {
    await request(app).post(`/api/contests/${c.id}/tags`).set(auth(o))
      .send({ epc, bib, participant: who, wave_id: w.id });
  }
  const gun = new Date(Date.now() - 600_000).toISOString();
  await request(app).post('/api/ingest/wave-start').set('X-Reader-Token', phone.token)
    .send({ name: 'open', started_at: gun });
  const at = (ms) => new Date(Date.parse(gun) + ms).toISOString();

  // The antenna read B a tenth before A, so B is published ahead of A.
  await request(app).post('/api/ingest/reads').set('X-Reader-Token', phone.token).send({
    reads: [{ epc: 'AAAA0801', read_at: at(600_100) }, { epc: 'AAAA0802', read_at: at(600_000) }],
  });
  // The checkpoint has its own split for A — another device's row, never ours.
  await request(app).post('/api/ingest/reads').set('X-Reader-Token', mat.token)
    .send({ reads: [{ epc: 'AAAA0801', read_at: at(300_000) }], pre_reconciled: true });

  let res = await request(app).get(`/api/contests/${c.id}/race-results`).set(auth(o));
  assert.equal(res.body.results.find((r) => r.bib === '802').rank, 1, 'B leads on the raw reads');

  // The operator swaps the two times on the tablet: each keeps a real time and
  // only whose it is changes. The device restates both chips.
  const swapA = await request(app).post('/api/ingest/replace-reads').set('X-Reader-Token', phone.token)
    .send({ epc: 'AAAA0801', reads: [{ read_at: at(600_000), manual: true }] });
  assert.equal(swapA.status, 200);
  assert.equal(swapA.body.removed, 1);
  assert.equal(swapA.body.inserted, 1);
  await request(app).post('/api/ingest/replace-reads').set('X-Reader-Token', phone.token)
    .send({ epc: 'AAAA0802', reads: [{ read_at: at(600_100), manual: true }] });

  res = await request(app).get(`/api/contests/${c.id}/race-results`).set(auth(o));
  const a = res.body.results.find((r) => r.bib === '801');
  const b = res.body.results.find((r) => r.bib === '802');
  assert.equal(a.rank, 1, 'A now leads');
  assert.equal(b.rank, 2);
  assert.equal(a.elapsed, '10:00.0');
  assert.equal(b.elapsed, '10:00.1');

  // One row per chip on this reader — a replace must not leave the old one
  // behind and double the lap.
  const reads = await request(app).get(`/api/contests/${c.id}/reads`).set(auth(o));
  const forA = (name) => reads.body.reads.filter((r) => r.epc === 'AAAA0801' && r.reader_name === name);
  assert.equal(forA('Phone at finish').length, 1);
  // The checkpoint's own split for the same chip survived untouched.
  assert.equal(forA('Halfway').length, 1);

  // An empty set is meaningful: a cancelled entry removes the published time.
  const cancel = await request(app).post('/api/ingest/replace-reads').set('X-Reader-Token', phone.token)
    .send({ epc: 'AAAA0802', reads: [] });
  assert.equal(cancel.body.removed, 1);
  assert.equal(cancel.body.inserted, 0);
  res = await request(app).get(`/api/contests/${c.id}/race-results`).set(auth(o));
  assert.notEqual(res.body.results.find((r) => r.bib === '802').status, 'finished');

  // A checkpoint cannot restate anything, and a bad token / epc is refused.
  assert.equal((await request(app).post('/api/ingest/replace-reads').set('X-Reader-Token', mat.token)
    .send({ epc: 'AAAA0801', reads: [] })).status, 403);
  assert.equal((await request(app).post('/api/ingest/replace-reads').set('X-Reader-Token', 'vgr_bogus')
    .send({ epc: 'AAAA0801', reads: [] })).status, 401);
  assert.equal((await request(app).post('/api/ingest/replace-reads').set('X-Reader-Token', phone.token)
    .send({ epc: 'nothex', reads: [] })).status, 400);
  assert.equal((await request(app).post('/api/ingest/replace-reads').set('X-Reader-Token', phone.token)
    .send({ epc: 'AAAA0801' })).status, 400);
});

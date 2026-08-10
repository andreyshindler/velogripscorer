'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = process.env.DATA_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'vgs-cp-'));
process.env.DISABLE_RATE_LIMIT = '1';
process.env.OPEN_REGISTRATION = '1';
process.env.ADMIN_EMAIL = 'cp-admin@test.local';
process.env.ADMIN_PASSWORD = 'cp-admin-secret';

const request = require('supertest');
const { app, seedAdmin } = require('../server/index');
seedAdmin();

const auth = (s) => ({ Authorization: `Bearer ${s.token}` });
const gun = new Date(Date.now() - 600_000); // 10 min ago
const at = (secs) => new Date(gun.getTime() + secs * 1000).toISOString();

let org, contest, finishTok, cpTok, cp1, wave;

test('setup: race, finish + checkpoint readers, one racer, wave started', async () => {
  org = (await request(app).post('/api/auth/register')
    .send({ email: 'cp-org@test.co', password: 'password123', name: 'CP Org' })).body;

  contest = (await request(app).post('/api/contests').set(auth(org)).send({
    title: 'Checkpoint race', kind: 'race', category: 'other',
    start_at: new Date(Date.now() - 3600_000).toISOString(),
    end_at: new Date(Date.now() + 3600_000).toISOString(),
  })).body;

  // Finish (primary) + checkpoint readers, each with its own token.
  const finish = (await request(app).post(`/api/contests/${contest.id}/readers`).set(auth(org))
    .send({ name: 'Finish', role: 'primary' })).body;
  finishTok = finish.token;
  assert.equal(finish.role, 'primary');

  cp1 = (await request(app).post(`/api/contests/${contest.id}/readers`).set(auth(org))
    .send({ name: 'Checkpoint 1', role: 'checkpoint', location: 'KM 5' })).body;
  cpTok = cp1.token;
  assert.equal(cp1.role, 'checkpoint');

  wave = (await request(app).post(`/api/contests/${contest.id}/waves`).set(auth(org)).send({ name: 'A' })).body;
  const tag = await request(app).post(`/api/contests/${contest.id}/tags`).set(auth(org))
    .send({ epc: 'AAAA0100', bib: '100', participant: 'Racer 100', wave_id: wave.id, category: 'A' });
  assert.equal(tag.status, 201);
  const start = await request(app).post(`/api/contests/${contest.id}/waves/${wave.id}/start`).set(auth(org))
    .send({ at: gun.toISOString() });
  assert.equal(start.status, 200);
});

test('adding a checkpoint never repoints the app token to the checkpoint', async () => {
  const c = (await request(app).get(`/api/contests/${contest.id}`).set(auth(org))).body;
  const readers = (await request(app).get(`/api/contests/${contest.id}/readers`).set(auth(org))).body.readers;
  const tokenReader = readers.find((r) => r.token === c.app_token);
  assert.ok(c.app_token, 'app_token is set');
  assert.notEqual(c.app_token, cpTok, 'app_token is not the checkpoint token');
  assert.equal(tokenReader.role, 'primary', 'app_token maps to a primary reader');
});

test('checkpoint reads are split times, not finish crossings', async () => {
  // Racer 100 crosses the checkpoint at +60s and finishes at +120s.
  await request(app).post('/api/ingest/reads').set('X-Reader-Token', cpTok)
    .send({ reads: [{ epc: 'AAAA0100', read_at: at(60) }] });
  await request(app).post('/api/ingest/reads').set('X-Reader-Token', finishTok)
    .send({ reads: [{ epc: 'AAAA0100', read_at: at(120) }] });

  const res = await request(app).get(`/api/contests/${contest.id}/race-results`).set(auth(org));
  assert.equal(res.status, 200);
  assert.equal(res.body.checkpoints.length, 1);
  assert.equal(res.body.checkpoints[0].id, cp1.id);

  const r = res.body.results.find((x) => x.bib === '100');
  assert.equal(r.status, 'finished');
  assert.equal(r.laps, 1, 'the checkpoint read did NOT add a lap');
  assert.equal(r.elapsed, '2:00.0', 'finish elapsed = the finish read (+120s), not the checkpoint');
  assert.ok(r.splits[cp1.id], 'a split for the checkpoint is present');
  assert.equal(r.splits[cp1.id].elapsed, '1:00.0', 'split = checkpoint pass at +60s');
});

test('import-reads merges an offline checkpoint file (elapsed seconds)', async () => {
  const cp2 = (await request(app).post(`/api/contests/${contest.id}/readers`).set(auth(org))
    .send({ name: 'Checkpoint 2', role: 'checkpoint' })).body;
  const readers = (await request(app).get(`/api/contests/${contest.id}/readers`).set(auth(org))).body.readers;
  const finishId = readers.find((r) => r.role === 'primary' && r.name === 'Finish').id;

  // reject import into the finish (non-checkpoint) reader
  const bad = await request(app).post(`/api/contests/${contest.id}/readers/${finishId}/import-reads`).set(auth(org))
    .attach('file', Buffer.from('bib,time\n100,90\n'), 'reads.csv');
  assert.equal(bad.status, 400);

  const ok = await request(app).post(`/api/contests/${contest.id}/readers/${cp2.id}/import-reads`).set(auth(org))
    .attach('file', Buffer.from('bib,time\n100,90\n999,90\n'), 'reads.csv');
  assert.equal(ok.status, 200);
  assert.equal(ok.body.imported, 1, 'the known bib imported');
  assert.equal(ok.body.skipped, 1, 'the unknown bib (999) skipped');

  const res = await request(app).get(`/api/contests/${contest.id}/race-results`).set(auth(org));
  const r = res.body.results.find((x) => x.bib === '100');
  assert.equal(r.splits[cp2.id].elapsed, '1:30.0', 'imported split = gun + 90s');
  // finish still unchanged by the import
  assert.equal(r.laps, 1);
  assert.equal(r.elapsed, '2:00.0');
});

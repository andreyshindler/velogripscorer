'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = process.env.DATA_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'vgs-rfid-'));
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

let org, outsider, contest, reader;

test('setup: organizer creates a race contest', async () => {
  org = await register('race-org@test.co', 'Race Organizer');
  outsider = await register('race-outsider@test.co', 'Race Outsider');
  const res = await request(app).post('/api/contests').set(auth(org)).send({
    title: 'Gravel GP timing', category: 'other', start_at: past, end_at: future,
    criteria: [{ name: 'Overall', weight: 100 }],
  });
  assert.equal(res.status, 201);
  contest = res.body;
});

test('organizer registers an RFID reader and gets a device token', async () => {
  const res = await request(app).post(`/api/contests/${contest.id}/readers`).set(auth(org))
    .send({ name: 'Finish line reader', location: 'finish' });
  assert.equal(res.status, 201);
  assert.match(res.body.token, /^vgr_[0-9a-f]{48}$/);
  reader = res.body;

  // non-organizers cannot manage readers
  const denied = await request(app).post(`/api/contests/${contest.id}/readers`).set(auth(outsider))
    .send({ name: 'Rogue reader' });
  assert.equal(denied.status, 403);
});

test('reader token authenticates ping and ingestion; bad tokens are rejected', async () => {
  const ping = await request(app).get('/api/ingest/ping').set('X-Reader-Token', reader.token);
  assert.equal(ping.status, 200);
  assert.equal(ping.body.contest.id, contest.id);

  const badPing = await request(app).get('/api/ingest/ping').set('X-Reader-Token', 'vgr_nope');
  assert.equal(badPing.status, 401);

  const noToken = await request(app).post('/api/ingest/reads').send({ reads: [] });
  assert.equal(noToken.status, 401);
});

test('batch ingestion accepts valid EPCs, rejects garbage, records reads', async () => {
  const t0 = new Date(Date.now() - 60_000).toISOString();
  const t1 = new Date(Date.now() - 30_000).toISOString();
  const res = await request(app).post('/api/ingest/reads').set('X-Reader-Token', reader.token).send({
    reads: [
      { epc: 'e2801160600002012345678a', rssi: -52.5, read_at: t0 },
      { epc: 'E2801160600002012345678A', rssi: -60, read_at: t1 }, // same tag, second pass
      { epc: 'AABBCCDD', read_at: t1 },
      { epc: 'not-hex!!', read_at: t1 },
      { epc: '' },
    ],
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.accepted, 3);
  assert.equal(res.body.rejected, 2);

  const reads = await request(app).get(`/api/contests/${contest.id}/reads`).set(auth(org));
  assert.equal(reads.status, 200);
  assert.equal(reads.body.reads.length, 3);
  assert.ok(reads.body.reads.every((r) => r.reader_name === 'Finish line reader'));
  // EPCs normalized to uppercase
  assert.ok(reads.body.reads.some((r) => r.epc === 'E2801160600002012345678A'));

  // reads endpoint is organizer-only
  const denied = await request(app).get(`/api/contests/${contest.id}/reads`).set(auth(outsider));
  assert.equal(denied.status, 403);
});

test('EPC assignment maps tags to participants in reads, passings and CSV', async () => {
  const assign = await request(app).post(`/api/contests/${contest.id}/tags`).set(auth(org))
    .send({ epc: 'e2801160600002012345678a', bib: '17', participant: 'Dana Rider' });
  assert.equal(assign.status, 201);

  const badEpc = await request(app).post(`/api/contests/${contest.id}/tags`).set(auth(org))
    .send({ epc: 'zz', participant: 'X' });
  assert.equal(badEpc.status, 400);

  const reads = await request(app).get(`/api/contests/${contest.id}/reads`).set(auth(org));
  const tagged = reads.body.reads.filter((r) => r.epc === 'E2801160600002012345678A');
  assert.ok(tagged.every((r) => r.participant === 'Dana Rider' && r.bib === '17'));

  const passings = await request(app).get(`/api/contests/${contest.id}/passings`).set(auth(org));
  const dana = passings.body.passings.find((p) => p.epc === 'E2801160600002012345678A');
  assert.equal(dana.passes, 2);
  assert.equal(dana.participant, 'Dana Rider');
  assert.ok(dana.elapsed_seconds >= 29 && dana.elapsed_seconds <= 31, `elapsed ${dana.elapsed_seconds}`);

  const csv = await request(app).get(`/api/contests/${contest.id}/reads?format=csv`).set(auth(org));
  assert.match(csv.headers['content-type'], /text\/csv/);
  assert.match(csv.text, /Dana Rider/);
});

test('reader last_seen and read counts are tracked; readers can be deleted', async () => {
  const list = await request(app).get(`/api/contests/${contest.id}/readers`).set(auth(org));
  assert.equal(list.body.readers.length, 1);
  assert.equal(list.body.readers[0].read_count, 3);
  assert.ok(list.body.readers[0].last_seen, 'last_seen updated after ingestion');

  const del = await request(app).delete(`/api/contests/${contest.id}/readers/${reader.id}`).set(auth(org));
  assert.equal(del.status, 200);
  const after = await request(app).post('/api/ingest/reads').set('X-Reader-Token', reader.token)
    .send({ reads: [{ epc: 'AABBCCDD' }] });
  assert.equal(after.status, 401, 'deleted reader token no longer works');
});

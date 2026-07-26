'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = process.env.DATA_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'vgs-pdf-'));
process.env.DISABLE_RATE_LIMIT = '1';

const request = require('supertest');
const { app, seedAdmin } = require('../server/index');

seedAdmin();

const past = new Date(Date.now() - 3600_000).toISOString();
const future = new Date(Date.now() + 86400_000).toISOString();
const auth = (s) => ({ Authorization: `Bearer ${s.token}` });
const isPdf = (res) => res.headers['content-type'] === 'application/pdf' &&
  res.body.subarray(0, 5).toString('latin1') === '%PDF-';

let org, other, contest, league;

test('setup: a public race with a Hebrew entrant + a league', async () => {
  org = (await request(app).post('/api/auth/register')
    .send({ email: 'pdf-org@test.co', password: 'password123', name: 'Org' })).body;
  other = (await request(app).post('/api/auth/register')
    .send({ email: 'pdf-other@test.co', password: 'password123', name: 'Nobody' })).body;

  contest = (await request(app).post('/api/contests').set(auth(org))
    .send({ kind: 'race', title: 'מרוץ הנגב', visibility: 'public', start_at: past, end_at: future })).body;
  const wave = (await request(app).post(`/api/contests/${contest.id}/waves`).set(auth(org)).send({ name: 'wave1' })).body;
  await request(app).post(`/api/contests/${contest.id}/tags`).set(auth(org))
    .send({ epc: 'AAAA0109', bib: '109', participant: 'נדב מויאל', team: 'מפעלי ים המלח', distance: '5k', category: 'עד 44', gender: 'male', wave_id: wave.id });

  const admin = (await request(app).post('/api/auth/login')
    .send({ email: 'admin@velogripscorer.local', password: 'change-me-please' })).body;
  league = (await request(app).post('/api/leagues').set(auth(admin))
    .send({ name: 'ליגת הנגב', season: '2026' })).body.league;
  await request(app).post(`/api/leagues/${league.id}/races`).set(auth(admin)).send({ contest_id: contest.id });
});

test('race-results?format=pdf returns a PDF to the organizer', async () => {
  const res = await request(app).get(`/api/contests/${contest.id}/race-results?format=pdf`)
    .set(auth(org)).buffer(true).parse((r, cb) => {
      const chunks = []; r.on('data', (c) => chunks.push(Buffer.from(c))); r.on('end', () => cb(null, Buffer.concat(chunks)));
    });
  assert.equal(res.status, 200);
  assert.ok(isPdf(res), 'application/pdf beginning with %PDF-');
  assert.ok(res.body.length > 1000, 'non-trivial PDF size');
  assert.match(res.headers['content-disposition'], new RegExp(`race-results-${contest.id}\\.pdf`));
});

test('race-results?format=pdf is organizer-gated', async () => {
  const nobody = await request(app).get(`/api/contests/${contest.id}/race-results?format=pdf`).set(auth(other));
  assert.equal(nobody.status, 403);
  const anon = await request(app).get(`/api/contests/${contest.id}/race-results?format=pdf`);
  assert.equal(anon.status, 403);
});

test('league standings?format=pdf returns a PDF for team and individual', async () => {
  for (const table of ['team', 'individual']) {
    const res = await request(app).get(`/api/leagues/${league.id}/standings?format=pdf&table=${table}`)
      .buffer(true).parse((r, cb) => {
        const chunks = []; r.on('data', (c) => chunks.push(Buffer.from(c))); r.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    assert.equal(res.status, 200);
    assert.ok(isPdf(res), `${table}: application/pdf beginning with %PDF-`);
    assert.match(res.headers['content-disposition'], new RegExp(`league-${league.id}-${table}\\.pdf`));
  }
});

const getPdf = (url, session) => {
  const r = request(app).get(url);
  if (session) r.set(auth(session));
  return r.buffer(true).parse((res, cb) => {
    const chunks = []; res.on('data', (c) => chunks.push(Buffer.from(c))); res.on('end', () => cb(null, Buffer.concat(chunks)));
  });
};

test('per-race standings PDFs (doc=individual|team) return PDFs to the organizer', async () => {
  const ind = await getPdf(`/api/contests/${contest.id}/race-results?format=pdf&doc=individual`, org);
  assert.equal(ind.status, 200);
  assert.ok(isPdf(ind), 'individual: application/pdf beginning with %PDF-');
  assert.match(ind.headers['content-disposition'], new RegExp(`individual-standings-${contest.id}\\.pdf`));

  const team = await getPdf(`/api/contests/${contest.id}/race-results?format=pdf&doc=team`, org);
  assert.equal(team.status, 200);
  assert.ok(isPdf(team), 'team: application/pdf beginning with %PDF-');
  assert.match(team.headers['content-disposition'], new RegExp(`team-standings-${contest.id}\\.pdf`));
});

test('per-race standings PDFs are organizer-gated', async () => {
  for (const doc of ['individual', 'team']) {
    const nobody = await request(app).get(`/api/contests/${contest.id}/race-results?format=pdf&doc=${doc}`).set(auth(other));
    assert.equal(nobody.status, 403, `${doc}: other user forbidden`);
    const anon = await request(app).get(`/api/contests/${contest.id}/race-results?format=pdf&doc=${doc}`);
    assert.equal(anon.status, 403, `${doc}: anon forbidden`);
  }
});

test('per-race standings PDFs 400 when the race is not in a league', async () => {
  const solo = (await request(app).post('/api/contests').set(auth(org))
    .send({ kind: 'race', title: 'מרוץ בודד', visibility: 'public', start_at: past, end_at: future })).body;
  for (const doc of ['individual', 'team']) {
    const res = await request(app).get(`/api/contests/${solo.id}/race-results?format=pdf&doc=${doc}`).set(auth(org));
    assert.equal(res.status, 400, `${doc}: not in a league`);
  }
});

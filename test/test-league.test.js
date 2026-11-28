'use strict';

// A test league is seen only by the user who created it — and so are the races
// attached to it — so a league can be tried out on the live site unseen.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = process.env.DATA_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'vgs-testleague-'));
process.env.DISABLE_RATE_LIMIT = '1';
process.env.OPEN_REGISTRATION = '1';

const request = require('supertest');
const { app, seedAdmin } = require('../server/index');

seedAdmin();

const past = new Date(Date.now() - 3600_000).toISOString();
const future = new Date(Date.now() + 86400_000).toISOString();
const auth = (s) => ({ Authorization: `Bearer ${s.token}` });

let owner, other, admin, league, race;

const leagueIds = async (session) => {
  const r = request(app).get('/api/leagues?status=all');
  if (session) r.set(auth(session));
  return ((await r).body.leagues || []).map((l) => l.id);
};
const raceIds = async (session) => {
  const r = request(app).get('/api/contests');
  if (session) r.set(auth(session));
  return ((await r).body.contests || []).map((c) => c.id);
};
const get = (url, session) => {
  const r = request(app).get(url);
  if (session) r.set(auth(session));
  return r;
};

test('setup: a test league with a public race attached', async () => {
  owner = (await request(app).post('/api/auth/register')
    .send({ email: 'tl-owner@test.co', password: 'password123', name: 'Owner' })).body;
  other = (await request(app).post('/api/auth/register')
    .send({ email: 'tl-other@test.co', password: 'password123', name: 'Other' })).body;
  admin = (await request(app).post('/api/auth/login')
    .send({ email: 'admin@velogripscorer.local', password: 'change-me-please' })).body;

  race = (await request(app).post('/api/contests').set(auth(owner))
    .send({ kind: 'race', title: 'Trial race', visibility: 'public', start_at: past, end_at: future })).body;
  const created = await request(app).post('/api/leagues').set(auth(owner))
    .send({ name: 'Trial league', season: '2026', is_test: true });
  assert.equal(created.status, 201);
  league = created.body.league;
  assert.equal(league.is_test, 1);
  const att = await request(app).post(`/api/leagues/${league.id}/races`).set(auth(owner)).send({ contest_id: race.id });
  assert.ok(att.status < 300, `attach: ${att.status}`);
});

test('the creator sees the test league and its race', async () => {
  assert.ok((await leagueIds(owner)).includes(league.id));
  assert.equal((await get(`/api/leagues/${league.id}`, owner)).status, 200);
  const st = await get(`/api/leagues/${league.id}/standings`, owner);
  assert.equal(st.status, 200);
  assert.equal(st.body.league.is_test, 1);
  assert.ok((await raceIds(owner)).includes(race.id));
  assert.equal((await get(`/api/contests/${race.id}`, owner)).status, 200);
  assert.equal((await get(`/api/contests/${race.id}/race-results`, owner)).status, 200);
});

test('nobody else sees it: another user, an admin, the public', async () => {
  for (const [who, s] of [['other user', other], ['admin', admin], ['anon', null]]) {
    assert.ok(!(await leagueIds(s)).includes(league.id), `${who}: not in the league list`);
    assert.equal((await get(`/api/leagues/${league.id}`, s)).status, 404, `${who}: league 404`);
    assert.equal((await get(`/api/leagues/${league.id}/standings`, s)).status, 404, `${who}: standings 404`);
    assert.equal((await get(`/api/leagues/${league.id}/standings?format=csv`, s)).status, 404, `${who}: csv 404`);
    assert.ok(!(await raceIds(s)).includes(race.id), `${who}: race not listed`);
    assert.equal((await get(`/api/contests/${race.id}`, s)).status, 403, `${who}: race page hidden`);
    assert.equal((await get(`/api/contests/${race.id}/race-results`, s)).status, 403, `${who}: results hidden`);
    assert.equal((await get(`/api/contests/${race.id}/startlist`, s)).status, 403, `${who}: start list hidden`);
  }
});

test('only the creator can change it', async () => {
  const res = await request(app).patch(`/api/leagues/${league.id}`).set(auth(other)).send({ is_test: false });
  assert.equal(res.status, 403);
});

test('un-marking the league makes it and its race public again', async () => {
  const res = await request(app).patch(`/api/leagues/${league.id}`).set(auth(owner)).send({ is_test: false });
  assert.equal(res.status, 200);
  assert.equal(res.body.league.is_test, 0);
  assert.ok((await leagueIds(null)).includes(league.id));
  assert.equal((await get(`/api/leagues/${league.id}/standings`, null)).status, 200);
  assert.ok((await raceIds(other)).includes(race.id));
  assert.equal((await get(`/api/contests/${race.id}`, null)).status, 200);
});

test('marking it again hides it; detaching the race brings the race back', async () => {
  await request(app).patch(`/api/leagues/${league.id}`).set(auth(owner)).send({ is_test: true });
  assert.ok(!(await raceIds(null)).includes(race.id), 'hidden again');
  const det = await request(app).delete(`/api/leagues/${league.id}/races/${race.id}`).set(auth(owner));
  assert.ok(det.status < 300);
  assert.ok((await raceIds(null)).includes(race.id), 'a detached race is public again');
  assert.ok(!(await leagueIds(null)).includes(league.id), 'the league itself stays hidden');
});

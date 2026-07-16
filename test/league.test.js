'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = process.env.DATA_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'vgs-league-'));
process.env.DISABLE_RATE_LIMIT = '1';
process.env.ADMIN_EMAIL = 'league-admin@test.local';
process.env.ADMIN_PASSWORD = 'admin-secret-1';

const request = require('supertest');
const { app, seedAdmin } = require('../server/index');
const { DEFAULT_SETTINGS, normalizeSettings, scoreRace, computeLeagueStandings } = require('../server/league-scoring');

seedAdmin();

const past = new Date(Date.now() - 3600_000).toISOString();
const future = new Date(Date.now() + 86400_000).toISOString();
const auth = (s) => ({ Authorization: `Bearer ${s.token}` });

let admin, user, league;
const races = []; // {contest, reader, wave, gun}

// ---- pure scoring unit tests ----

test('normalizeSettings merges over defaults and validates', () => {
  assert.deepEqual(normalizeSettings({}), DEFAULT_SETTINGS);
  assert.deepEqual(normalizeSettings(undefined), DEFAULT_SETTINGS);
  assert.deepEqual(normalizeSettings('{"individual_best_n": 3}').individual_best_n, 3);
  assert.equal(normalizeSettings({ individual_best_n: 3 }).team_best_n, DEFAULT_SETTINGS.team_best_n);
  // unknown keys are dropped
  assert.equal('bogus' in normalizeSettings({ bogus: 1 }), false);
  assert.throws(() => normalizeSettings({ individual_points: 'nope' }));
  assert.throws(() => normalizeSettings({ individual_points: [] }));
  assert.throws(() => normalizeSettings({ individual_points: [10, -1] }));
  assert.throws(() => normalizeSettings({ team_best_n: 0 }));
  assert.throws(() => normalizeSettings({ team_top_runners: 1.5 }));
  assert.throws(() => normalizeSettings('not json {'));
});

test('scoreRace: points by category place, non-finishers score 0, ties share', () => {
  const fin = (bib, elapsed, over = {}) => ({
    bib, participant: `R${bib}`, status: 'finished', laps: 1, elapsed_ms: elapsed,
    distance: '5k', gender: 'M', category: 'A', team: 'T1', ...over,
  });
  const results = [
    fin('1', 1000), fin('2', 2000), fin('3', 2000),          // tie for 2nd
    fin('4', 4000),
    fin('9', 1500, { category: 'B' }),                        // other category: own winner
    { bib: '5', participant: 'DNF guy', status: 'DNF', laps: 0, distance: '5k', gender: 'M', category: 'A', team: 'T1' },
  ];
  const { riders } = scoreRace(results, DEFAULT_SETTINGS);
  const byBib = Object.fromEntries(riders.map((r) => [r.bib, r]));
  assert.equal(byBib['1'].points, 20);
  assert.equal(byBib['2'].points, 18, 'tied riders share the place');
  assert.equal(byBib['3'].points, 18);
  assert.equal(byBib['2'].place, 2);
  assert.equal(byBib['3'].place, 2);
  assert.equal(byBib['4'].place, 4, 'competition ranking skips after a tie');
  assert.equal(byBib['4'].points, 14);
  assert.equal(byBib['9'].points, 20, 'each category has its own winner');
  assert.equal(byBib['5'], undefined, 'non-finishers earn nothing');
});

test('scoreRace: team sums its best N runners only', () => {
  const fin = (bib, team, elapsed) => ({
    bib, participant: `R${bib}`, status: 'finished', laps: 1, elapsed_ms: elapsed,
    distance: '5k', gender: 'M', category: 'A', team,
  });
  // 6 Aces finish 1..6, 2 Solos finish 7..8
  const results = [
    fin('1', 'Aces', 100), fin('2', 'Aces', 200), fin('3', 'Aces', 300),
    fin('4', 'Aces', 400), fin('5', 'Aces', 500), fin('6', 'Aces', 600),
    fin('7', 'Solo', 700), fin('8', 'Solo', 800),
  ];
  const { teams } = scoreRace(results, DEFAULT_SETTINGS);
  const byTeam = Object.fromEntries(teams.map((t) => [t.team, t]));
  // Aces places 1-5 -> 10+8+6+4+2 = 30; the 6th rider (1 pt) is NOT counted
  assert.equal(byTeam['Aces'].points, 30);
  assert.equal(byTeam['Aces'].counted.length, 5);
  // Solo places 6,7 -> 1+1 = 2 (fewer than 5 runners: sum what exists)
  assert.equal(byTeam['Solo'].points, 2);
});

test('computeLeagueStandings: best-N races and identity by bib', () => {
  const mk = (cid, bib, elapsed, name) => ({
    contest: { id: cid }, round: cid,
    results: [{ bib, participant: name, status: 'finished', laps: 1, elapsed_ms: elapsed,
      distance: '5k', gender: 'M', category: 'A', team: 'T' }],
  });
  const races3 = [
    mk(1, '7', 100, 'Old Name'),
    mk(2, '7', 100, 'New Name'),
    mk(3, '7', 100, 'New Name'),
  ];
  const settings = normalizeSettings({ individual_best_n: 2, team_best_n: 2 });
  const { individual, teams } = computeLeagueStandings(races3, settings);
  assert.equal(individual.length, 1);
  const row = individual[0].rows[0];
  assert.equal(row.bib, '7');
  assert.equal(row.name, 'New Name', 'display name from the latest race');
  assert.equal(row.total, 40, 'best 2 of three 20-point wins');
  assert.equal(row.counted_ids.length, 2);
  assert.equal(Object.keys(row.per_race).length, 3);
  assert.equal(teams[0].total, 20, 'team best 2 of three 10-point scores');
});

// ---- API tests ----

async function makeRace(title, riders, gunOffsetMs) {
  const contest = (await request(app).post('/api/contests').set(auth(admin)).send({
    title, kind: 'race', start_at: past, end_at: future,
  })).body;
  const reader = (await request(app).post(`/api/contests/${contest.id}/readers`).set(auth(admin))
    .send({ name: 'Finish', location: 'finish' })).body;
  const wave = (await request(app).post(`/api/contests/${contest.id}/waves`).set(auth(admin))
    .send({ name: 'mass' })).body;
  const gun = new Date(Date.now() - gunOffsetMs);
  await request(app).post(`/api/contests/${contest.id}/waves/${wave.id}/start`).set(auth(admin))
    .send({ at: gun.toISOString() });

  const reads = [];
  for (const r of riders) {
    const res = await request(app).post(`/api/contests/${contest.id}/tags`).set(auth(admin)).send({
      epc: r.epc, bib: r.bib, participant: r.name, wave_id: wave.id,
      category: r.category, gender: r.gender || 'M', distance: r.distance || '5k',
      team: r.team || '', racer_status: r.status || '',
    });
    assert.equal(res.status, 201);
    if (r.finishSecs) reads.push({ epc: r.epc, read_at: new Date(gun.getTime() + r.finishSecs * 1000).toISOString() });
  }
  if (reads.length) {
    const res = await request(app).post('/api/ingest/reads').set('X-Reader-Token', reader.token).send({ reads });
    assert.equal(res.status, 200);
    assert.equal(res.body.accepted, reads.length, 'all reads accepted');
  }
  return { contest, reader, wave, gun };
}

test('setup: admin + regular user + three races', async () => {
  const login = await request(app).post('/api/auth/login')
    .send({ email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD });
  assert.equal(login.status, 200);
  admin = login.body;
  assert.equal(admin.user.role, 'admin');

  const reg = await request(app).post('/api/auth/register')
    .send({ email: 'runner@test.co', password: 'password123', name: 'Regular Runner' });
  assert.equal(reg.status, 201);
  user = reg.body;

  // Race 1: 13 finishers in category A (tests below-10th = 1 point), plus one
  // category-B rider and one DNF. Teams: Aces x6 finishers, Solo x2.
  const race1Riders = [];
  for (let i = 1; i <= 13; i++) {
    race1Riders.push({
      epc: `AA0100${String(i).padStart(2, '0')}`, bib: String(i), name: `Rider ${i}`,
      category: 'עד 44', finishSecs: 60 + i * 10,
      team: i <= 6 ? 'Aces' : (i <= 8 ? 'Solo' : ''),
    });
  }
  race1Riders.push({ epc: 'AA0100B1', bib: '50', name: 'B Winner', category: '45-49', finishSecs: 300 });
  race1Riders.push({ epc: 'AA0100D1', bib: '60', name: 'DNF Rider', category: 'עד 44', status: 'DNF' });
  races.push(await makeRace('Round 1', race1Riders, 3000_000));

  // Race 2: bibs 1-3 finish in reverse order (3 fastest); Aces only 2 riders.
  races.push(await makeRace('Round 2', [
    { epc: 'AA020001', bib: '1', name: 'Rider 1', category: 'עד 44', finishSecs: 90, team: 'Aces' },
    { epc: 'AA020002', bib: '2', name: 'Rider 2', category: 'עד 44', finishSecs: 80, team: 'Aces' },
    { epc: 'AA020003', bib: '3', name: 'Rider Three Renamed', category: 'עד 44', finishSecs: 70, team: 'Solo' },
  ], 2000_000));

  // Race 3: only bib 1 shows up and wins.
  races.push(await makeRace('Round 3', [
    { epc: 'AA030001', bib: '1', name: 'Rider 1', category: 'עד 44', finishSecs: 100, team: 'Aces' },
  ], 1000_000));
});

test('league write endpoints require admin', async () => {
  assert.equal((await request(app).post('/api/leagues').send({ name: 'X' })).status, 401);
  assert.equal((await request(app).post('/api/leagues').set(auth(user)).send({ name: 'X' })).status, 403);
  assert.equal((await request(app).patch('/api/leagues/1').set(auth(user)).send({ name: 'X' })).status, 403);
  assert.equal((await request(app).delete('/api/leagues/1').set(auth(user))).status, 403);
  assert.equal((await request(app).post('/api/leagues/1/races').set(auth(user)).send({ contest_id: 1 })).status, 403);
});

test('league CRUD: create with defaults, patch settings, validation', async () => {
  const created = await request(app).post('/api/leagues').set(auth(admin))
    .send({ name: 'Negev Running League', season: '2026' });
  assert.equal(created.status, 201);
  league = created.body.league;
  assert.equal(league.status, 'active');
  assert.deepEqual(league.settings, DEFAULT_SETTINGS);

  assert.equal((await request(app).post('/api/leagues').set(auth(admin)).send({ name: '  ' })).status, 400);
  assert.equal((await request(app).post('/api/leagues').set(auth(admin))
    .send({ name: 'Bad', settings: { individual_points: 'zzz' } })).status, 400);

  const patched = await request(app).patch(`/api/leagues/${league.id}`).set(auth(admin))
    .send({ settings: { individual_best_n: 2, team_best_n: 2 } });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.league.settings.individual_best_n, 2);
  assert.equal(patched.body.league.settings.individual_points[0], 20, 'unspecified settings keep defaults');

  assert.equal((await request(app).patch(`/api/leagues/${league.id}`).set(auth(admin))
    .send({ status: 'bogus' })).status, 400);

  const listed = await request(app).get('/api/leagues');
  assert.equal(listed.status, 200);
  assert.equal(listed.body.leagues.length, 1);
});

test('attach races: rounds, duplicates, non-race contests', async () => {
  for (const [i, r] of races.entries()) {
    const res = await request(app).post(`/api/leagues/${league.id}/races`).set(auth(admin))
      .send({ contest_id: r.contest.id });
    assert.equal(res.status, 201);
    assert.equal(res.body.races[i].round, i + 1, 'round defaults to MAX+1');
  }
  const dup = await request(app).post(`/api/leagues/${league.id}/races`).set(auth(admin))
    .send({ contest_id: races[0].contest.id });
  assert.equal(dup.status, 409);

  const voting = (await request(app).post('/api/contests').set(auth(admin)).send({
    title: 'Voting thing', category: 'other', start_at: past, end_at: future,
    criteria: [{ name: 'Overall', weight: 100 }],
  })).body;
  const bad = await request(app).post(`/api/leagues/${league.id}/races`).set(auth(admin))
    .send({ contest_id: voting.id });
  assert.equal(bad.status, 400);

  const info = await request(app).get(`/api/leagues/${league.id}`);
  assert.equal(info.status, 200);
  assert.equal(info.body.races.length, 3);
});

test('standings: per-race points, best-N totals, bib identity, teams', async () => {
  const res = await request(app).get(`/api/leagues/${league.id}/standings`);
  assert.equal(res.status, 200);
  const { individual, teams, races: raceList } = res.body;
  assert.equal(raceList.length, 3);

  const groupA = individual.find((g) => g.category === 'עד 44');
  assert.ok(groupA, 'category group exists');
  const byBib = Object.fromEntries(groupA.rows.map((r) => [r.bib, r]));
  const [r1id, r2id, r3id] = races.map((r) => String(r.contest.id));

  // Race 1 mapping: place 1..10 -> 20..2, places 11-13 -> 1
  assert.equal(byBib['1'].per_race[r1id], 20);
  assert.equal(byBib['2'].per_race[r1id], 18);
  assert.equal(byBib['10'].per_race[r1id], 2);
  assert.equal(byBib['11'].per_race[r1id], 1);
  assert.equal(byBib['13'].per_race[r1id], 1);

  // Category B rider won his own category despite slowest overall time
  const groupB = individual.find((g) => g.category === '45-49');
  assert.equal(groupB.rows[0].per_race[r1id], 20);

  // DNF rider earns nothing anywhere
  assert.equal(byBib['60'], undefined);

  // Race 2: bib 3 fastest -> 20, bib 2 -> 18, bib 1 -> 16
  assert.equal(byBib['3'].per_race[r2id], 20);
  assert.equal(byBib['2'].per_race[r2id], 18);
  assert.equal(byBib['1'].per_race[r2id], 16);

  // Bib 1 season with individual_best_n=2: scores 20,16,20 -> best two = 40
  assert.equal(byBib['1'].per_race[r3id], 20);
  assert.equal(byBib['1'].total, 40);
  assert.equal(byBib['1'].counted_ids.length, 2);
  assert.ok(!byBib['1'].counted_ids.includes(Number(r2id)), 'the 16 is the dropped score');

  // Identity by bib: display name from the latest appearance
  assert.equal(byBib['3'].name, 'Rider Three Renamed');

  // Standings sorted by total within the group; bib 1 (40) leads
  assert.equal(groupA.rows[0].bib, '1');

  // Teams. Race1: Aces riders placed 1-6 -> top5 = 10+8+6+4+2 = 30; Solo (places 7,8) = 1+1 = 2.
  // Race2: Aces places 3,2 -> 6+8 = 14; Solo place 1 -> 10.
  // Race3: Aces place 1 -> 10.
  // team_best_n=2: Aces = 30+14 = 44; Solo = 10+2 = 12.
  const byTeam = Object.fromEntries(teams.map((t) => [t.team, t]));
  assert.equal(byTeam['Aces'].per_race[r1id], 30);
  assert.equal(byTeam['Aces'].per_race[r2id], 14);
  assert.equal(byTeam['Aces'].per_race[r3id], 10);
  assert.equal(byTeam['Aces'].total, 44);
  assert.equal(byTeam['Solo'].total, 12);
  assert.equal(teams[0].team, 'Aces');
});

test('standings CSV: public, BOM, both tables', async () => {
  const ind = await request(app).get(`/api/leagues/${league.id}/standings?format=csv&table=individual`);
  assert.equal(ind.status, 200);
  assert.match(ind.headers['content-type'], /text\/csv/);
  assert.ok(ind.text.startsWith('﻿'), 'BOM for Excel Hebrew');
  assert.match(ind.text, /Rider 1/);
  assert.match(ind.text, /R1,R2,R3,Total/);

  const team = await request(app).get(`/api/leagues/${league.id}/standings?format=csv&table=team`);
  assert.equal(team.status, 200);
  assert.match(team.text, /Aces/);
  assert.match(team.text.split('\n')[1], /^1,Aces/);
});

test('round renumber + detach + delete league', async () => {
  const renum = await request(app).patch(`/api/leagues/${league.id}/races/${races[2].contest.id}`)
    .set(auth(admin)).send({ round: 9 });
  assert.equal(renum.status, 200);
  assert.equal(renum.body.races.find((r) => r.contest_id === races[2].contest.id).round, 9);

  const detach = await request(app).delete(`/api/leagues/${league.id}/races/${races[2].contest.id}`)
    .set(auth(admin));
  assert.equal(detach.status, 200);
  assert.equal((await request(app).get(`/api/leagues/${league.id}`)).body.races.length, 2);

  const del = await request(app).delete(`/api/leagues/${league.id}`).set(auth(admin));
  assert.equal(del.status, 200);
  assert.equal((await request(app).get(`/api/leagues/${league.id}`)).status, 404);
  // contests survive league deletion
  const c = await request(app).get(`/api/contests/${races[0].contest.id}`).set(auth(admin));
  assert.equal(c.status, 200);
});

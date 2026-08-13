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

test('a phone joins as a checkpoint with the short code (auto-provisions a token)', async () => {
  // The organizer's contest fetch mints the join code lazily.
  const c = (await request(app).get(`/api/contests/${contest.id}`).set(auth(org))).body;
  assert.ok(c.checkpoint_code, 'organizer sees a checkpoint join code');
  assert.match(c.checkpoint_code, /^[0-9A-Z]{6}$/);

  // A bad code is rejected.
  const bad = await request(app).post('/api/join/checkpoint').send({ code: 'ZZZ999', name: 'Nope' });
  assert.equal(bad.status, 404);

  // The real code (typed with a dash, as shown) provisions a checkpoint token.
  const dashed = `${c.checkpoint_code.slice(0, 3)}-${c.checkpoint_code.slice(3)}`;
  const join = await request(app).post('/api/join/checkpoint').send({ code: dashed, name: 'KM 8' });
  assert.equal(join.status, 201);
  assert.ok(join.body.token && join.body.token.startsWith('vgr_'));
  assert.equal(join.body.contest_id, contest.id);
  assert.equal(join.body.name, 'KM 8');
  assert.notEqual(join.body.token, cpTok, 'a fresh token, not an existing one');

  // That token ingests as a checkpoint: it records a split, never a finish/lap.
  await request(app).post('/api/ingest/reads').set('X-Reader-Token', join.body.token)
    .send({ reads: [{ epc: 'AAAA0100', read_at: at(45) }] });
  const readers = (await request(app).get(`/api/contests/${contest.id}/readers`).set(auth(org))).body.readers;
  const joined = readers.find((r) => r.name === 'KM 8');
  assert.equal(joined.role, 'checkpoint');

  const res = await request(app).get(`/api/contests/${contest.id}/race-results`).set(auth(org));
  const r = res.body.results.find((x) => x.bib === '100');
  assert.equal(r.laps, 1, 'joined checkpoint did not add a lap');
  assert.equal(r.splits[joined.id].elapsed, '0:45.0', 'joined checkpoint split at +45s');
});

test('an authorized operator sees the join code in their own account; others do not', async () => {
  const op = (await request(app).post('/api/auth/register')
    .send({ email: 'cp-op@test.co', password: 'password123', name: 'Marshal' })).body;
  const other = (await request(app).post('/api/auth/register')
    .send({ email: 'cp-other@test.co', password: 'password123', name: 'Nobody' })).body;

  // Before being added, the operator sees no code and no shared races.
  const before = (await request(app).get(`/api/contests/${contest.id}`).set(auth(op))).body;
  assert.equal(before.checkpoint_code, undefined, 'no code before access is granted');
  const noneYet = (await request(app).get('/api/my/checkpoints').set(auth(op))).body;
  assert.equal(noneYet.races.length, 0);

  // A non-registered email is rejected.
  const bad = await request(app).post(`/api/contests/${contest.id}/collaborators`).set(auth(org))
    .send({ email: 'ghost@nowhere.co' });
  assert.equal(bad.status, 404);

  // The organizer authorizes the operator by email.
  const add = await request(app).post(`/api/contests/${contest.id}/collaborators`).set(auth(org))
    .send({ email: 'cp-op@test.co' });
  assert.equal(add.status, 201);
  assert.equal(add.body.email, 'cp-op@test.co');

  // Now the operator sees the code on the race and under /my/checkpoints...
  const c = (await request(app).get(`/api/contests/${contest.id}`).set(auth(op))).body;
  assert.ok(c.checkpoint_code, 'operator sees the checkpoint code');
  assert.equal(c.is_collaborator, true);
  assert.equal(c.app_token, undefined, 'operator never sees the primary app token');
  const mine = (await request(app).get('/api/my/checkpoints').set(auth(op))).body;
  assert.equal(mine.races.length, 1);
  assert.equal(mine.races[0].id, contest.id);
  assert.ok(mine.races[0].checkpoint_code);

  // ...but an unrelated user still sees neither.
  const stranger = (await request(app).get(`/api/contests/${contest.id}`).set(auth(other))).body;
  assert.equal(stranger.checkpoint_code, undefined);
  const strangerList = (await request(app).get('/api/my/checkpoints').set(auth(other))).body;
  assert.equal(strangerList.races.length, 0);

  // Removing the operator revokes it.
  const del = await request(app).delete(`/api/contests/${contest.id}/collaborators/${add.body.id}`).set(auth(org));
  assert.equal(del.status, 200);
  const after = (await request(app).get('/api/my/checkpoints').set(auth(op))).body;
  assert.equal(after.races.length, 0);
});

test('organizer can list marshals and add one by picking (not just email)', async () => {
  const m = (await request(app).post('/api/auth/register')
    .send({ email: 'pick-me@test.co', password: 'password123', username: 'pickme' })).body;
  assert.equal(m.user.role, 'marshal');

  let cands = (await request(app).get(`/api/contests/${contest.id}/marshal-candidates`).set(auth(org))).body.marshals;
  assert.ok(cands.find((x) => x.id === m.user.id), 'the marshal shows up as a candidate');

  const add = await request(app).post(`/api/contests/${contest.id}/collaborators`).set(auth(org))
    .send({ user_id: m.user.id });
  assert.equal(add.status, 201);

  cands = (await request(app).get(`/api/contests/${contest.id}/marshal-candidates`).set(auth(org))).body.marshals;
  assert.ok(!cands.find((x) => x.id === m.user.id), 'an added marshal drops off the candidate list');

  const mine = (await request(app).get('/api/my/checkpoints').set(auth(m))).body.races;
  assert.ok(mine.find((r) => r.id === contest.id), 'the picked marshal now sees the race');
});

test('an authorized account mints a checkpoint token without a code (app pick-list)', async () => {
  const stranger = (await request(app).post('/api/auth/register')
    .send({ email: 'cp-stranger@test.co', password: 'password123', name: 'Stranger' })).body;
  // Not authorized for the race.
  const no = await request(app).post(`/api/contests/${contest.id}/checkpoint-token`).set(auth(stranger)).send({ name: 'X' });
  assert.equal(no.status, 403);

  // The organizer (authorized) mints a checkpoint token directly.
  const ok = await request(app).post(`/api/contests/${contest.id}/checkpoint-token`).set(auth(org)).send({ name: 'KM 12' });
  assert.equal(ok.status, 201);
  assert.ok(ok.body.token && ok.body.token.startsWith('vgr_'));
  assert.equal(ok.body.contest_id, contest.id);

  // The minted token records splits, not finish crossings.
  await request(app).post('/api/ingest/reads').set('X-Reader-Token', ok.body.token)
    .send({ reads: [{ epc: 'AAAA0100', read_at: at(30) }] });
  const readers = (await request(app).get(`/api/contests/${contest.id}/readers`).set(auth(org))).body.readers;
  const km12 = readers.find((r) => r.name === 'KM 12');
  assert.equal(km12.role, 'checkpoint');
  const res = await request(app).get(`/api/contests/${contest.id}/race-results`).set(auth(org));
  const r = res.body.results.find((x) => x.bib === '100');
  assert.equal(r.laps, 1);
  assert.equal(r.splits[km12.id].elapsed, '0:30.0');
});

test('server-anchored clock correction fixes a checkpoint with a skewed clock', async () => {
  const skewMs = 30_000; // this phone's clock runs 30s FAST
  // Two checkpoints: one reports client_time (corrected), one does not (raw).
  const corrected = (await request(app).post(`/api/contests/${contest.id}/readers`).set(auth(org))
    .send({ name: 'Skewed corrected', role: 'checkpoint' })).body;
  const raw = (await request(app).post(`/api/contests/${contest.id}/readers`).set(auth(org))
    .send({ name: 'Skewed raw', role: 'checkpoint' })).body;

  // Racer passes both at TRUE +60s, but the phone stamps +30s fast (so +90s).
  const stampedFast = new Date(gun.getTime() + 90_000).toISOString();
  const deviceNow = new Date(Date.now() + skewMs).toISOString();

  await request(app).post('/api/ingest/reads').set('X-Reader-Token', corrected.token)
    .send({ reads: [{ epc: 'AAAA0100', read_at: stampedFast }], client_time: deviceNow });
  await request(app).post('/api/ingest/reads').set('X-Reader-Token', raw.token)
    .send({ reads: [{ epc: 'AAAA0100', read_at: stampedFast }] }); // no client_time

  const res = await request(app).get(`/api/contests/${contest.id}/race-results`).set(auth(org));
  const r = res.body.results.find((x) => x.bib === '100');
  assert.equal(r.splits[corrected.id].elapsed, '1:00.0', 'corrected back to the true +60s');
  assert.equal(r.splits[raw.id].elapsed, '1:30.0', 'uncorrected still shows the +90s skew');
  // The finish (primary, no skew) is untouched by any of this.
  assert.equal(r.elapsed, '2:00.0');
  assert.equal(r.laps, 1);
});

test('a manual tap on a checkpoint records a split, not a finish crossing', async () => {
  const manualCp = (await request(app).post(`/api/contests/${contest.id}/readers`).set(auth(org))
    .send({ name: 'Manual CP', role: 'checkpoint' })).body;
  // The marshal tapped bib 100 in manually (the app resolves bib->epc and sends
  // the epc with manual:true) at +75s.
  await request(app).post('/api/ingest/reads').set('X-Reader-Token', manualCp.token)
    .send({ reads: [{ epc: 'AAAA0100', read_at: at(75), manual: true }] });

  const res = await request(app).get(`/api/contests/${contest.id}/race-results`).set(auth(org));
  const r = res.body.results.find((x) => x.bib === '100');
  assert.equal(r.laps, 1, 'the manual checkpoint tap did NOT add a lap');
  assert.equal(r.elapsed, '2:00.0', 'finish unchanged');
  assert.equal(r.splits[manualCp.id].elapsed, '1:15.0', 'manual tap is a split at +75s');
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

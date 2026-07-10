'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Isolated database per test run.
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vgs-test-'));
process.env.DISABLE_RATE_LIMIT = '1';
process.env.ADMIN_EMAIL = 'admin@test.local';
process.env.ADMIN_PASSWORD = 'admin-password-1';

const request = require('supertest');
const { app, seedAdmin } = require('../server/index');

seedAdmin();

const past = new Date(Date.now() - 86400_000).toISOString();
const future = new Date(Date.now() + 86400_000).toISOString();
const farFuture = new Date(Date.now() + 7 * 86400_000).toISOString();

async function register(email, name) {
  const res = await request(app)
    .post('/api/auth/register')
    .send({ email, password: 'password123', name });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body;
}

function auth(session) {
  return { Authorization: `Bearer ${session.token}` };
}

const CRITERIA = [
  { name: 'Creativity', weight: 60 },
  { name: 'Technical quality', weight: 40 },
];

async function createContest(session, overrides = {}) {
  const res = await request(app)
    .post('/api/contests')
    .set(auth(session))
    .send({
      title: overrides.title || `Contest ${Math.random()}`,
      description: 'A test contest',
      category: 'photo',
      tags: ['test', 'photo'],
      start_at: past,
      end_at: future,
      criteria: CRITERIA,
      ...overrides,
    });
  return res;
}

test('health endpoint responds', async () => {
  const res = await request(app).get('/api/health');
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
});

test('registration validates email and password', async () => {
  assert.equal((await request(app).post('/api/auth/register').send({ email: 'bad', password: 'password123', name: 'X' })).status, 400);
  assert.equal((await request(app).post('/api/auth/register').send({ email: 'ok@x.co', password: 'short', name: 'X' })).status, 400);
});

test('login works and rejects bad credentials', async () => {
  await register('login@test.co', 'Login User');
  const ok = await request(app).post('/api/auth/login').send({ email: 'login@test.co', password: 'password123' });
  assert.equal(ok.status, 200);
  assert.ok(ok.body.token);
  const bad = await request(app).post('/api/auth/login').send({ email: 'login@test.co', password: 'wrong-password' });
  assert.equal(bad.status, 401);
});

test('duplicate registration is rejected', async () => {
  await register('dup@test.co', 'Dup');
  const res = await request(app).post('/api/auth/register').send({ email: 'dup@test.co', password: 'password123', name: 'Dup2' });
  assert.equal(res.status, 409);
});

test('contest creation requires criteria weights summing to 100', async () => {
  const org = await register('org1@test.co', 'Organizer One');
  const bad = await createContest(org, { criteria: [{ name: 'A', weight: 50 }, { name: 'B', weight: 30 }] });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /sum to 100/);
  const good = await createContest(org);
  assert.equal(good.status, 201);
  assert.equal(good.body.criteria.length, 2);
});

test('anonymous users can browse public contests but cannot vote', async () => {
  const org = await register('org2@test.co', 'Organizer Two');
  const contest = (await createContest(org)).body;
  const list = await request(app).get('/api/contests');
  assert.equal(list.status, 200);
  assert.ok(list.body.contests.some((c) => c.id === contest.id));
  const vote = await request(app).post('/api/entries/1/vote').send({ scores: {} });
  assert.equal(vote.status, 401);
});

test('private contests are hidden without the invite code', async () => {
  const org = await register('org3@test.co', 'Organizer Three');
  const outsider = await register('outsider@test.co', 'Outsider');
  const contest = (await createContest(org, { visibility: 'private' })).body;
  assert.ok(contest.invite_code, 'organizer sees invite code');

  const denied = await request(app).get(`/api/contests/${contest.id}`).set(auth(outsider));
  assert.equal(denied.status, 403);
  const allowed = await request(app).get(`/api/contests/${contest.id}?invite_code=${contest.invite_code}`).set(auth(outsider));
  assert.equal(allowed.status, 200);
  assert.equal(allowed.body.invite_code, undefined, 'non-organizer must not see invite code');
});

test('full voting flow computes the weighted score and ranks the leaderboard', async () => {
  const org = await register('org4@test.co', 'Organizer Four');
  const alice = await register('alice@test.co', 'Alice');
  const bob = await register('bob@test.co', 'Bob');
  const carol = await register('carol@test.co', 'Carol');
  const contest = (await createContest(org)).body;

  const e1 = await request(app).post(`/api/contests/${contest.id}/entries`).set(auth(alice))
    .send({ title: 'Alice entry', body: 'my work', kind: 'text' });
  assert.equal(e1.status, 201);
  const e2 = await request(app).post(`/api/contests/${contest.id}/entries`).set(auth(bob))
    .send({ title: 'Bob entry', body: 'other work', kind: 'text' });
  assert.equal(e2.status, 201);

  const [critA, critB] = contest.criteria;

  // self-vote forbidden
  const self = await request(app).post(`/api/entries/${e1.body.id}/vote`).set(auth(alice))
    .send({ scores: { [critA.id]: 5, [critB.id]: 5 } });
  assert.equal(self.status, 403);

  // out-of-range score rejected
  const badScore = await request(app).post(`/api/entries/${e1.body.id}/vote`).set(auth(carol))
    .send({ scores: { [critA.id]: 42, [critB.id]: 5 } });
  assert.equal(badScore.status, 400);

  // Carol scores Alice: 8 on creativity (60%), 6 on technical (40%) => 0.6*8 + 0.4*6 = 7.2
  const v1 = await request(app).post(`/api/entries/${e1.body.id}/vote`).set(auth(carol))
    .send({ scores: { [critA.id]: 8, [critB.id]: 6 } });
  assert.equal(v1.status, 200);
  assert.equal(v1.body.entry_score, 7.2);

  // Bob also scores Alice: 4 and 10 => avg creativity 6, avg technical 8 => 0.6*6+0.4*8 = 6.8
  await request(app).post(`/api/entries/${e1.body.id}/vote`).set(auth(bob))
    .send({ scores: { [critA.id]: 4, [critB.id]: 10 } });

  // Carol scores Bob lower
  await request(app).post(`/api/entries/${e2.body.id}/vote`).set(auth(carol))
    .send({ scores: { [critA.id]: 3, [critB.id]: 3 } });

  const board = (await request(app).get(`/api/contests/${contest.id}/leaderboard`)).body;
  assert.equal(board.leaderboard[0].title, 'Alice entry');
  assert.equal(board.leaderboard[0].score, 6.8);
  assert.equal(board.leaderboard[0].rank, 1);
  assert.equal(board.leaderboard[0].pct_of_max, 68);
  assert.equal(board.leaderboard[1].title, 'Bob entry');

  // re-voting overwrites instead of double counting
  const revote = await request(app).post(`/api/entries/${e2.body.id}/vote`).set(auth(carol))
    .send({ scores: { [critA.id]: 10, [critB.id]: 10 } });
  assert.equal(revote.status, 200);
  assert.equal(revote.body.entry_score, 10);

  // CSV export
  const csv = await request(app).get(`/api/contests/${contest.id}/leaderboard?format=csv`);
  assert.equal(csv.status, 200);
  assert.match(csv.headers['content-type'], /text\/csv/);
  assert.match(csv.text, /rank,entry,author,score/);
  assert.match(csv.text, /Alice entry/);
});

test('closed voting mode rejects votes outside the window', async () => {
  const org = await register('org5@test.co', 'Organizer Five');
  const voter = await register('voter5@test.co', 'Voter Five');
  const player = await register('player5@test.co', 'Player Five');
  const contest = (await createContest(org, {
    voting_mode: 'closed',
    voting_start_at: future,
    voting_end_at: farFuture,
  })).body;
  const entry = await request(app).post(`/api/contests/${contest.id}/entries`).set(auth(player))
    .send({ title: 'Early entry', body: 'text', kind: 'text' });
  const vote = await request(app).post(`/api/entries/${entry.body.id}/vote`).set(auth(voter))
    .send({ scores: Object.fromEntries(contest.criteria.map((c) => [c.id, 5])) });
  assert.equal(vote.status, 400);
  assert.match(vote.body.error, /voting is not open/);
});

test('blind voting hides authors until the contest is finished', async () => {
  const org = await register('org6@test.co', 'Organizer Six');
  const player = await register('player6@test.co', 'Player Six');
  const voter = await register('voter6@test.co', 'Voter Six');
  const contest = (await createContest(org, { blind_voting: true })).body;
  await request(app).post(`/api/contests/${contest.id}/entries`).set(auth(player))
    .send({ title: 'Anon entry', body: 'text', kind: 'text' });

  const listed = await request(app).get(`/api/contests/${contest.id}/entries`).set(auth(voter));
  assert.equal(listed.body.entries[0].author.name, 'Hidden until voting ends');
  assert.equal(listed.body.entries[0].user_id, null);

  // the author still sees themselves
  const own = await request(app).get(`/api/contests/${contest.id}/entries`).set(auth(player));
  assert.equal(own.body.entries[0].author.name, 'Player Six');

  // after finishing, identity is revealed
  await request(app).post(`/api/contests/${contest.id}/finish`).set(auth(org));
  const after = await request(app).get(`/api/contests/${contest.id}/entries`).set(auth(voter));
  assert.equal(after.body.entries[0].author.name, 'Player Six');
});

test('finishing a contest declares winners, awards badges and reputation', async () => {
  const org = await register('org7@test.co', 'Organizer Seven');
  const player = await register('player7@test.co', 'Player Seven');
  const voter = await register('voter7@test.co', 'Voter Seven');
  const contest = (await createContest(org, {
    prizes: [{ rank: 1, name: 'Golden Grip', type: 'badge' }],
  })).body;
  const entry = await request(app).post(`/api/contests/${contest.id}/entries`).set(auth(player))
    .send({ title: 'Winner entry', body: 'text', kind: 'text' });
  await request(app).post(`/api/entries/${entry.body.id}/vote`).set(auth(voter))
    .send({ scores: Object.fromEntries(contest.criteria.map((c) => [c.id, 9])) });

  const fin = await request(app).post(`/api/contests/${contest.id}/finish`).set(auth(org));
  assert.equal(fin.status, 200);
  assert.equal(fin.body.winners[0].badge, 'gold');
  assert.equal(fin.body.winners[0].prize.name, 'Golden Grip');

  // winner got an in-app notification
  const notifs = await request(app).get('/api/notifications').set(auth(player));
  assert.ok(notifs.body.notifications.some((n) => n.type === 'award'));

  // reputation increased
  const profile = await request(app).get(`/api/users/${player.user.id}`);
  assert.ok(profile.body.reputation > 0);

  // submissions are now closed
  const late = await request(app).post(`/api/contests/${contest.id}/entries`).set(auth(voter))
    .send({ title: 'Too late', body: 'text', kind: 'text' });
  assert.equal(late.status, 400);
});

test('comments notify the entry owner and support reporting + moderation', async () => {
  const org = await register('org8@test.co', 'Organizer Eight');
  const player = await register('player8@test.co', 'Player Eight');
  const commenter = await register('commenter8@test.co', 'Commenter Eight');
  const contest = (await createContest(org)).body;
  const entry = await request(app).post(`/api/contests/${contest.id}/entries`).set(auth(player))
    .send({ title: 'Commented entry', body: 'text', kind: 'text' });

  const comment = await request(app).post(`/api/entries/${entry.body.id}/comments`).set(auth(commenter))
    .send({ body: 'Nice work, love the colours!' });
  assert.equal(comment.status, 201);

  const notifs = await request(app).get('/api/notifications').set(auth(player));
  assert.ok(notifs.body.notifications.some((n) => n.type === 'comment'));

  // profane comments are blocked by the automated filter
  const rude = await request(app).post(`/api/entries/${entry.body.id}/comments`).set(auth(commenter))
    .send({ body: 'this is shit' });
  assert.equal(rude.status, 400);

  // report the comment, then admin removes it
  const report = await request(app).post('/api/reports').set(auth(player))
    .send({ target_type: 'comment', target_id: comment.body.id, reason: 'spam' });
  assert.equal(report.status, 201);

  const admin = await request(app).post('/api/auth/login')
    .send({ email: 'admin@test.local', password: 'admin-password-1' });
  assert.equal(admin.status, 200);
  assert.equal(admin.body.user.role, 'admin');

  const queue = await request(app).get('/api/admin/reports').set(auth(admin.body));
  const queued = queue.body.reports.find((r) => r.id === report.body.id);
  assert.ok(queued, 'report reaches the moderation queue');

  const resolve = await request(app).post(`/api/admin/reports/${report.body.id}/resolve`)
    .set(auth(admin.body)).send({ action: 'remove' });
  assert.equal(resolve.status, 200);

  const comments = await request(app).get(`/api/entries/${entry.body.id}/comments`);
  assert.equal(comments.body.comments.length, 0, 'removed comment no longer listed');

  // moderation queue is admin-only
  const forbidden = await request(app).get('/api/admin/reports').set(auth(player));
  assert.equal(forbidden.status, 403);
});

test('profane entries are auto-held for review', async () => {
  const org = await register('org9@test.co', 'Organizer Nine');
  const player = await register('player9@test.co', 'Player Nine');
  const contest = (await createContest(org)).body;
  const entry = await request(app).post(`/api/contests/${contest.id}/entries`).set(auth(player))
    .send({ title: 'my fuck-ing masterpiece', body: 'fuck this', kind: 'text' });
  assert.equal(entry.status, 201);
  assert.match(entry.body.moderation, /held for review/);
  const listed = await request(app).get(`/api/contests/${contest.id}/entries`);
  assert.ok(!listed.body.entries.some((e) => e.id === entry.body.id), 'held entry is not publicly listed');
});

test('file uploads accept images and reject unsupported types', async () => {
  const org = await register('org10@test.co', 'Organizer Ten');
  const player = await register('player10@test.co', 'Player Ten');
  const contest = (await createContest(org)).body;
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

  const ok = await request(app).post(`/api/contests/${contest.id}/entries`).set(auth(player))
    .field('title', 'Photo entry')
    .attach('file', png, { filename: 'photo.png', contentType: 'image/png' });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.kind, 'image');
  assert.match(ok.body.file_url, /^\/uploads\//);

  const served = await request(app).get(ok.body.file_url);
  assert.equal(served.status, 200);

  const bad = await request(app).post(`/api/contests/${contest.id}/entries`).set(auth(player))
    .field('title', 'Evil entry')
    .attach('file', Buffer.from('#!/bin/sh'), { filename: 'x.sh', contentType: 'application/x-sh' });
  assert.equal(bad.status, 400);
});

test('participant cap limits distinct participants', async () => {
  const org = await register('org11@test.co', 'Organizer Eleven');
  const p1 = await register('p11a@test.co', 'P One');
  const p2 = await register('p11b@test.co', 'P Two');
  const contest = (await createContest(org, { participant_cap: 1 })).body;
  const first = await request(app).post(`/api/contests/${contest.id}/entries`).set(auth(p1))
    .send({ title: 'First in', body: 'x', kind: 'text' });
  assert.equal(first.status, 201);
  const second = await request(app).post(`/api/contests/${contest.id}/entries`).set(auth(p2))
    .send({ title: 'Too many', body: 'x', kind: 'text' });
  assert.equal(second.status, 409);
});

test('search and filters find contests by text, tag and category', async () => {
  const org = await register('org12@test.co', 'Organizer Twelve');
  await createContest(org, { title: 'Sunset photography masters', tags: ['sunset'], category: 'photo' });
  await createContest(org, { title: 'Rustlang golf', tags: ['rust'], category: 'code' });

  const byText = await request(app).get('/api/contests?q=sunset');
  assert.ok(byText.body.contests.some((c) => c.title.includes('Sunset')));
  assert.ok(!byText.body.contests.some((c) => c.title.includes('Rustlang')));

  const byCat = await request(app).get('/api/contests?category=code');
  assert.ok(byCat.body.contests.every((c) => c.category === 'code'));

  const byTag = await request(app).get('/api/contests?tag=rust');
  assert.ok(byTag.body.contests.length >= 1);
});

test('GDPR export returns the user own data', async () => {
  const user = await register('gdpr@test.co', 'GDPR User');
  const res = await request(app).get('/api/users/me/export').set(auth(user));
  assert.equal(res.status, 200);
  assert.equal(res.body.user.email, 'gdpr@test.co');
  assert.ok(Array.isArray(res.body.votes));
});

test('private profiles hide details from strangers', async () => {
  const user = await register('shy@test.co', 'Shy User');
  await request(app).patch('/api/users/me').set(auth(user)).send({ is_public: false, bio: 'secret' });
  const anon = await request(app).get(`/api/users/${user.user.id}`);
  assert.equal(anon.body.bio, undefined);
  const self = await request(app).get(`/api/users/${user.user.id}`).set(auth(user));
  assert.equal(self.body.bio, 'secret');
});

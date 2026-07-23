'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = process.env.DATA_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'vgs-tgr-'));
process.env.DISABLE_RATE_LIMIT = '1';
process.env.ADMIN_EMAIL = 'runners-admin@test.local';
process.env.ADMIN_PASSWORD = 'admin-secret-1';
process.env.TELEGRAM_ALLOWED_USER_IDS = '42'; // Telegram operator/admin id

const request = require('supertest');
const { app, seedAdmin } = require('../server/index');
const { createBotCore } = require('../server/telegram');
const { db } = require('../server/db');

seedAdmin();

const past = new Date(Date.now() - 3600_000).toISOString();
const future = new Date(Date.now() + 86400_000).toISOString();
const auth = (s) => ({ Authorization: `Bearer ${s.token}` });

const api = async (method, p, { token, body } = {}) => {
  let r = request(app)[method.toLowerCase()](`/api${p}`);
  if (token) r = r.set('Authorization', `Bearer ${token}`);
  if (body !== undefined) r = r.send(body);
  const res = await r;
  return { status: res.status, json: res.body, text: res.text };
};

function makeSend() {
  return {
    calls: [],
    reset() { this.calls.length = 0; },
    to(chatId) { return this.calls.filter((c) => String(c.chatId) === String(chatId) && c.type === 'message'); },
    last(chatId) { const m = this.to(chatId); return m[m.length - 1]; },
    async message(chatId, text, extra) { this.calls.push({ type: 'message', chatId, text, extra }); },
    async answerCallback(id) { this.calls.push({ type: 'answer', id }); },
    async document(chatId, filename, content, caption) { this.calls.push({ type: 'document', chatId, filename, content, caption }); },
  };
}

const send = makeSend();
const { handleUpdate } = createBotCore({ api, send });

let uid = 0;
const ADMIN = 42;
const text = (userId, t) => handleUpdate({ update_id: ++uid, message: { from: { id: userId, first_name: `U${userId}` }, chat: { id: userId }, text: t } });
const tap = (userId, data) => handleUpdate({ update_id: ++uid, callback_query: { id: `cq${++uid}`, from: { id: userId }, message: { chat: { id: userId } }, data } });

let admin, league;

test('setup: active league with a finished race (bibs 1,2 Aces; 3 Solo)', async () => {
  admin = (await request(app).post('/api/auth/login')
    .send({ email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD })).body;
  assert.equal(admin.user.role, 'admin');

  const contest = (await request(app).post('/api/contests').set(auth(admin))
    .send({ title: 'Round 1', kind: 'race', start_at: past, end_at: future })).body;
  const reader = (await request(app).post(`/api/contests/${contest.id}/readers`).set(auth(admin))
    .send({ name: 'Finish' })).body;
  const wave = (await request(app).post(`/api/contests/${contest.id}/waves`).set(auth(admin))
    .send({ name: 'mass' })).body;
  const gun = new Date(Date.now() - 1000_000);
  await request(app).post(`/api/contests/${contest.id}/waves/${wave.id}/start`).set(auth(admin))
    .send({ at: gun.toISOString() });

  const riders = [
    { epc: 'AA000001', bib: '1', name: 'Alice', team: 'Aces', finishSecs: 300 },
    { epc: 'AA000002', bib: '2', name: 'Bob', team: 'Aces', finishSecs: 360 },
    { epc: 'AA000003', bib: '3', name: 'Cara', team: 'Solo', finishSecs: 420 },
  ];
  const reads = [];
  for (const r of riders) {
    await request(app).post(`/api/contests/${contest.id}/tags`).set(auth(admin)).send({
      epc: r.epc, bib: r.bib, participant: r.name, wave_id: wave.id,
      category: 'עד 44', gender: 'M', distance: '5k', team: r.team,
    });
    reads.push({ epc: r.epc, read_at: new Date(gun.getTime() + r.finishSecs * 1000).toISOString() });
  }
  await request(app).post('/api/ingest/reads').set('X-Reader-Token', reader.token).send({ reads });
  db.prepare("UPDATE contests SET status = 'finished' WHERE id = ?").run(contest.id);

  league = (await request(app).post('/api/leagues').set(auth(admin))
    .send({ name: 'Negev League', season: '2026' })).body.league;
  const attach = await request(app).post(`/api/leagues/${league.id}/races`).set(auth(admin))
    .send({ contest_id: contest.id });
  assert.equal(attach.status, 201);
});

test('runner onboarding: /start -> bib -> name -> approval request', async () => {
  send.reset();
  await text(999, '/start');
  assert.match(send.last(999).text, /החזה/, 'runner is asked for a bib in Hebrew');

  send.reset();
  await text(999, 'abc'); // not a number
  assert.match(send.last(999).text, /מספר חזה תקין/, 'non-numeric bib is rejected');

  send.reset();
  await text(999, '1'); // valid bib -> now asks for the name
  assert.match(send.last(999).text, /השם המלא/, 'runner is asked for their name');
  let row = db.prepare('SELECT * FROM runners WHERE chat_id = ?').get('999');
  assert.equal(row.status, 'pending');
  assert.equal(row.bib, '1');
  assert.equal(row.name, '', 'name not captured yet');
  assert.equal(send.last(ADMIN), undefined, 'admin not notified until the name is given');

  send.reset();
  await text(999, 'אבי כהן'); // the name -> now the admin is notified
  row = db.prepare('SELECT * FROM runners WHERE chat_id = ?').get('999');
  assert.equal(row.name, 'אבי כהן');
  assert.match(send.last(999).text, /לאישור/);
  const adminMsg = send.last(ADMIN);
  assert.ok(adminMsg, 'admin was notified');
  assert.match(adminMsg.text, /אבי כהן/, 'admin sees the declared name');
  const buttons = JSON.stringify(adminMsg.extra.reply_markup);
  assert.match(buttons, /rappr:999/);
  assert.match(buttons, /rrej:999/);
});

test('runner never gets a telegram_sessions row (operator reminders stay separate)', () => {
  assert.equal(db.prepare('SELECT * FROM telegram_sessions WHERE chat_id = ?').get('999'), undefined);
});

test('a pending runner is told to wait, and cannot see the menu yet', async () => {
  send.reset();
  await text(999, '🏁 הדירוג שלי');
  assert.match(send.last(999).text, /ממתינה לאישור/);
});

test('admin approves -> runner is welcomed with the menu', async () => {
  send.reset();
  await tap(ADMIN, `rappr:999:${league.id}`);
  assert.equal(db.prepare('SELECT status, league_id FROM runners WHERE chat_id = ?').get('999').status, 'approved');
  assert.match(send.last(ADMIN).text, /Approved/);
  const welcome = send.last(999);
  assert.match(welcome.text, /אושרת/);
  assert.ok(welcome.extra.reply_markup.keyboard, 'runner gets the reply keyboard');
});

test('approved runner: my ranking shows their finished-race result', async () => {
  send.reset();
  await text(999, '🏁 הדירוג שלי');
  const t = send.last(999).text;
  assert.match(t, /Round 1/);
  assert.match(t, /מקום כללי/);
  assert.match(t, /Alice/);
});

test('approved runner: all races lists the league races', async () => {
  send.reset();
  await text(999, '📋 כל המרוצים');
  const t = send.last(999).text;
  assert.match(t, /מרוצי הליגה/);
  assert.match(t, /R1 · Round 1/);
  assert.match(t, /הסתיים/);
});

test('approved runner: my team shows the team standing and members', async () => {
  send.reset();
  await text(999, '🏆 הקבוצה שלי');
  const t = send.last(999).text;
  assert.match(t, /Aces/);
  assert.match(t, /מקום בליגה/);
  assert.match(t, /Alice/); // teammate listed
});

test('approval is idempotent; reject path tells the runner and blocks the menu', async () => {
  // re-approving the same runner is a no-op with a notice to the admin
  send.reset();
  await tap(ADMIN, `rappr:999:${league.id}`);
  assert.match(send.last(ADMIN).text, /Already approved/);

  // a second runner completes onboarding then gets rejected
  await text(888, '2');
  await text(888, 'בוב'); // name step
  assert.equal(db.prepare('SELECT status FROM runners WHERE chat_id = ?').get('888').status, 'pending');
  send.reset();
  await tap(ADMIN, 'rrej:888');
  assert.equal(db.prepare('SELECT status FROM runners WHERE chat_id = ?').get('888').status, 'rejected');
  assert.match(send.last(888).text, /לא אושרה/);

  send.reset();
  await text(888, '🏆 הקבוצה שלי');
  assert.match(send.last(888).text, /לא אושרה/, 'a rejected runner cannot use the menu');
});

// ---- second (runner) bot: role routing + cross-bot delivery ----

test('a runner-role bot treats EVERY sender as a runner (even an operator id)', async () => {
  const opSend = makeSend();
  const rnSend = makeSend();
  const runnerCore = createBotCore({ api, send: rnSend, role: 'runner', crossSend: { operator: opSend, runner: rnSend } });
  // The allowlisted operator (42) messaging the runner bot gets the bib prompt,
  // not the admin flow.
  await runnerCore.handleUpdate({ update_id: 1, message: { from: { id: 42, first_name: 'Op' }, chat: { id: 42 }, text: '/start' } });
  assert.match(rnSend.last(42).text, /החזה/);
  assert.equal(opSend.calls.length, 0, 'operator bot said nothing');
});

test('cross-bot: bib on the runner bot pings admins on the operator bot; approve welcomes on the runner bot', async () => {
  const opSend = makeSend();
  const rnSend = makeSend();
  const cross = { operator: opSend, runner: rnSend };
  const operatorCore = createBotCore({ api, send: opSend, role: 'operator', crossSend: cross });
  const runnerCore = createBotCore({ api, send: rnSend, role: 'runner', crossSend: cross });
  const rHandle = (userId, t) => runnerCore.handleUpdate({ update_id: ++uid, message: { from: { id: userId, first_name: `U${userId}` }, chat: { id: userId }, text: t } });
  const oTap = (userId, data) => operatorCore.handleUpdate({ update_id: ++uid, callback_query: { id: `cq${++uid}`, from: { id: userId }, message: { chat: { id: userId } }, data } });

  // Runner 777 (bib 1, then name) submits on the runner bot.
  await rHandle(777, '1');
  assert.match(rnSend.last(777).text, /השם המלא/, 'runner bot asks for the name');
  assert.equal(opSend.calls.length, 0, 'admin not pinged before the name');
  await rHandle(777, 'דן');
  // The runner is answered on the RUNNER bot...
  assert.match(rnSend.last(777).text, /לאישור/);
  // ...and the Approve/Reject prompt lands on the OPERATOR bot, to admin 42.
  const adminPrompt = opSend.last(42);
  assert.ok(adminPrompt, 'admin prompted on the operator bot');
  assert.match(JSON.stringify(adminPrompt.extra.reply_markup), /rappr:777/);

  // Admin approves on the operator bot.
  opSend.reset(); rnSend.reset();
  await oTap(42, `rappr:777:${league.id}`);
  assert.match(opSend.last(42).text, /Approved/, 'admin ack on the operator bot');
  // The welcome + menu reach the runner on the RUNNER bot.
  const welcome = rnSend.last(777);
  assert.match(welcome.text, /אושרת/);
  assert.ok(welcome.extra.reply_markup.keyboard, 'runner keyboard delivered via the runner bot');

  // Approved runner uses the menu on the runner bot.
  rnSend.reset();
  await rHandle(777, '🏁 הדירוג שלי');
  assert.match(rnSend.last(777).text, /מקום כללי/);
});

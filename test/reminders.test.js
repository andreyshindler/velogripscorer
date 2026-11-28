'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = process.env.DATA_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'vgs-rem-'));
process.env.DISABLE_RATE_LIMIT = '1';
process.env.OPEN_REGISTRATION = '1'; // tests use self-service accounts; approval flow covered in approval.test.js

const request = require('supertest');
const { app } = require('../server/index');
const { db } = require('../server/db');
const { pendingRaceReminders, sendRaceReminders, raceReminderMessage, pendingLiveLinks, sendLiveLinks, publicRaceUrl } = require('../server/telegram');

const auth = (s) => ({ Authorization: `Bearer ${s.token}` });
const iso = (msFromNow) => new Date(Date.now() + msFromNow).toISOString();
const HOUR = 3600_000;

async function makeRace(org, title, startMs, endMs, extra = {}) {
  return (await request(app).post('/api/contests').set(auth(org)).send({
    kind: 'race', title, category: 'other',
    start_at: iso(startMs), end_at: iso(endMs), ...extra,
  })).body;
}

test('race-day reminders: window, recipients, dedup', async () => {
  const org = (await request(app).post('/api/auth/register')
    .send({ email: 'rem@test.co', password: 'password123', name: 'Rem' })).body;

  const soon = await makeRace(org, 'Tomorrow 5k', 12 * HOUR, 14 * HOUR, { location: 'Kiryat Gat' });
  const later = await makeRace(org, 'In three days', 72 * HOUR, 74 * HOUR);
  const pastRace = await makeRace(org, 'Yesterday', -26 * HOUR, -24 * HOUR);
  // A race a day out but already finished must not be reminded.
  const finished = await makeRace(org, 'Done', 10 * HOUR, 11 * HOUR);
  db.prepare("UPDATE contests SET status = 'finished' WHERE id = ?").run(finished.id);

  // Only the race within the next 24h and still active is pending.
  const pendingIds = pendingRaceReminders().map((c) => c.id);
  assert.deepEqual(pendingIds, [soon.id], 'only the day-out active race is due');
  assert.ok(!pendingIds.includes(later.id) && !pendingIds.includes(pastRace.id)
    && !pendingIds.includes(finished.id));

  // Two chats have talked to the bot -> both get the reminder.
  for (const chat of ['1001', '1002']) {
    db.prepare(`INSERT INTO telegram_sessions (chat_id, active_contest_id, state, updated_at)
                VALUES (?, NULL, '', datetime('now'))`).run(chat);
  }

  const sent = [];
  const send = { message: async (chat_id, text) => { sent.push({ chat_id, text }); } };

  const res = await sendRaceReminders({ send, now: new Date() });
  assert.equal(res.races, 1);
  assert.equal(res.messages, 2, 'one message per chat');
  assert.deepEqual(sent.map((m) => m.chat_id).sort(), ['1001', '1002']);
  assert.match(sent[0].text, /Tomorrow 5k/);
  assert.match(sent[0].text, /Kiryat Gat/);

  // The race is now marked reminded and won't fire again.
  const row = db.prepare('SELECT reminder_sent_at FROM contests WHERE id = ?').get(soon.id);
  assert.ok(row.reminder_sent_at, 'reminder_sent_at is stamped');
  const again = await sendRaceReminders({ send, now: new Date() });
  assert.equal(again.races, 0, 'no duplicate reminder');
  assert.equal(sent.length, 2, 'no extra messages sent');
});

test('reminder message includes a public link only when PUBLIC_BASE_URL is set', () => {
  const c = { id: 42, title: 'Link race', start_at: iso(12 * HOUR), location: '' };
  const prev = process.env.PUBLIC_BASE_URL;
  delete process.env.PUBLIC_BASE_URL;
  assert.ok(!/🔗/.test(raceReminderMessage(c)), 'no link without a base url');
  process.env.PUBLIC_BASE_URL = 'https://example.test/veloscorer/';
  const withLink = raceReminderMessage(c);
  assert.match(withLink, /🔗 https:\/\/example\.test\/veloscorer\/#\/results\/42/);
  if (prev === undefined) delete process.env.PUBLIC_BASE_URL; else process.env.PUBLIC_BASE_URL = prev;
});

// ---- live link: sent to the operators when a race's first gun is fired ----

test('live link: sent once when the first gun fires, only for recent guns', async () => {
  const org = (await request(app).post('/api/auth/register')
    .send({ email: 'live@test.co', password: 'password123', name: 'Live' })).body;
  const prevIds = process.env.TELEGRAM_ALLOWED_USER_IDS;
  const prevUrl = process.env.PUBLIC_BASE_URL;
  process.env.TELEGRAM_ALLOWED_USER_IDS = '2001,2002';
  process.env.PUBLIC_BASE_URL = 'https://scores.example.test/';

  const gun = async (race, msAgo) => {
    const wave = (await request(app).post(`/api/contests/${race.id}/waves`).set(auth(org)).send({ name: `w${race.id}` })).body;
    await request(app).post(`/api/contests/${race.id}/waves/${wave.id}/start`).set(auth(org)).send({ at: iso(-msAgo) });
  };
  const live = await makeRace(org, 'Gun just fired', -HOUR, HOUR);
  await gun(live, 60_000);
  const old = await makeRace(org, 'Gun hours ago', -6 * HOUR, HOUR);
  await gun(old, 5 * HOUR);
  const noGun = await makeRace(org, 'No gun yet', -HOUR, HOUR);
  const done = await makeRace(org, 'Finished one', -HOUR, HOUR);
  await gun(done, 60_000);
  db.prepare("UPDATE contests SET status = 'finished' WHERE id = ?").run(done.id);

  const pending = pendingLiveLinks().map((c) => c.id);
  assert.ok(pending.includes(live.id), 'the race whose gun just fired is due');
  for (const r of [old, noGun, done]) assert.ok(!pending.includes(r.id), `${r.title} is not`);

  const sent = [];
  const send = { message: async (chat_id, text) => { sent.push({ chat_id, text }); } };
  const res = await sendLiveLinks({ send, now: new Date() });
  const mine = sent.filter((m) => m.text.includes('Gun just fired'));
  assert.deepEqual(mine.map((m) => m.chat_id).sort(), ['2001', '2002'], 'every operator gets it');
  assert.match(mine[0].text, /הלייב התחיל/);
  assert.ok(mine[0].text.includes(`https://scores.example.test/#/results/${live.id}`), 'with the public link');
  assert.ok(res.messages >= 2);

  const before = sent.length;
  await sendLiveLinks({ send, now: new Date() });
  assert.equal(sent.length, before, 'sent once per race');

  if (prevIds === undefined) delete process.env.TELEGRAM_ALLOWED_USER_IDS; else process.env.TELEGRAM_ALLOWED_USER_IDS = prevIds;
  if (prevUrl === undefined) delete process.env.PUBLIC_BASE_URL; else process.env.PUBLIC_BASE_URL = prevUrl;
});

test('public link falls back to DOMAIN (+ BASE_PATH) when PUBLIC_BASE_URL is unset', () => {
  const saved = { u: process.env.PUBLIC_BASE_URL, d: process.env.DOMAIN, b: process.env.BASE_PATH };
  delete process.env.PUBLIC_BASE_URL;
  delete process.env.DOMAIN;
  delete process.env.BASE_PATH;
  assert.equal(publicRaceUrl(7), '', 'nothing configured -> no link');
  process.env.DOMAIN = 'scores.example.test';
  assert.equal(publicRaceUrl(7), 'https://scores.example.test/#/results/7');
  process.env.BASE_PATH = '/veloscorer';
  assert.equal(publicRaceUrl(7), 'https://scores.example.test/veloscorer/#/results/7');
  for (const [k, v] of [['PUBLIC_BASE_URL', saved.u], ['DOMAIN', saved.d], ['BASE_PATH', saved.b]]) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

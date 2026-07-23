'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = process.env.DATA_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'vgs-rem-'));
process.env.DISABLE_RATE_LIMIT = '1';

const request = require('supertest');
const { app } = require('../server/index');
const { db } = require('../server/db');
const { pendingRaceReminders, sendRaceReminders, raceReminderMessage } = require('../server/telegram');

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

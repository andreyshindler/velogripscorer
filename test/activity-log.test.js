'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vgs-logs-'));
process.env.LOG_DIR = LOG_DIR;
process.env.DATA_DIR = process.env.DATA_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'vgs-logdata-'));
process.env.DISABLE_RATE_LIMIT = '1';
process.env.OPEN_REGISTRATION = '1';
process.env.TELEGRAM_ALLOWED_USER_IDS = '42';

const request = require('supertest');
const { app } = require('../server/index');
const { createBotCore } = require('../server/telegram');
const { logActivity } = require('../server/activity-log');

const today = new Date().toISOString().slice(0, 10);
const logFile = path.join(LOG_DIR, `${today}.log`);
const readLog = () => { try { return fs.readFileSync(logFile, 'utf8'); } catch { return ''; } };
async function waitFor(re, ms = 1500) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (re.test(readLog())) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return false;
}

test('logActivity writes a today-dated line with source + actor', async () => {
  logActivity('web', 'alice@test.co', 'TEST action', 'detail');
  assert.ok(await waitFor(/ \| web \| user=alice@test\.co \| TEST action \| detail/));
  assert.equal(path.basename(logFile), `${today}.log`, 'the file is named for today');
  assert.ok(readLog().split('\n').every((l) => !l || l.startsWith(today)), 'every line is dated today');
});

test('web: a mutating API request is logged as [web]', async () => {
  await request(app).post('/api/auth/register').send({ email: 'log-web@test.co', password: 'password123', name: 'W' });
  assert.ok(await waitFor(/ \| web \| user=.* \| POST \/api\/auth\/register \| 20\d/));
});

test('web: passive GET reads are not logged', async () => {
  const before = readLog();
  await request(app).get('/api/health');
  await request(app).get('/api/contests');
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(readLog(), before, 'GET reads add nothing to the activity log');
});

test('bot: each command is logged as [bot]', async () => {
  const send = { async message() {}, async editMessage() {}, async answerCallback() {}, async document() {} };
  const api = async () => ({ status: 200, json: {} });
  const { handleUpdate } = createBotCore({ api, send });
  await handleUpdate({ update_id: 1, message: { from: { id: 42 }, chat: { id: 42 }, text: '/whoami' } });
  assert.ok(await waitFor(/ \| bot \| user=42 \| \/whoami \| operator/));
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = process.env.DATA_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'vgs-tg-'));
process.env.DISABLE_RATE_LIMIT = '1';
process.env.TELEGRAM_ALLOWED_USER_IDS = '42'; // only user 42 may talk to the bot

const request = require('supertest');
const { app, seedAdmin } = require('../server/index');
const { createBotCore } = require('../server/telegram');

seedAdmin();

const past = new Date(Date.now() - 3600_000).toISOString();
const future = new Date(Date.now() + 86400_000).toISOString();

// supertest-backed API client (same shape the prod fetch client returns)
const api = async (method, p, { token, body } = {}) => {
  let r = request(app)[method.toLowerCase()](`/api${p}`);
  if (token) r = r.set('Authorization', `Bearer ${token}`);
  if (body !== undefined) r = r.send(body);
  const res = await r;
  return { status: res.status, json: res.body, text: res.text };
};

// collecting fake Telegram transport
function makeSend() {
  return {
    calls: [],
    reset() { this.calls.length = 0; },
    last(type) { return [...this.calls].reverse().find((c) => c.type === type); },
    async message(chatId, text, extra) { this.calls.push({ type: 'message', chatId, text, extra }); },
    async answerCallback(id) { this.calls.push({ type: 'answer', id }); },
    async document(chatId, filename, content, caption) { this.calls.push({ type: 'document', chatId, filename, content, caption }); },
  };
}

const send = makeSend();
const { handleUpdate } = createBotCore({ api, send });

let uid = 0;
const ALLOWED = 42;
const text = (userId, t) => handleUpdate({ update_id: ++uid, message: { from: { id: userId }, chat: { id: userId }, text: t } });
const tap = (userId, data) => handleUpdate({ update_id: ++uid, callback_query: { id: `cq${++uid}`, from: { id: userId }, message: { chat: { id: userId } }, data } });
const pad = (s) => String(s).padStart(24, '0'); // EPCs are stored as full 24-char ids

let organizer, contestId;

test('setup: a race exists', async () => {
  organizer = (await request(app).post('/api/auth/register').send({ email: 'tg-org@test.co', password: 'password123', name: 'Org' })).body;
  const c = await request(app).post('/api/contests').set({ Authorization: `Bearer ${organizer.token}` })
    .send({ kind: 'race', title: 'Telegram race', start_at: past, end_at: future });
  assert.equal(c.status, 201);
  contestId = c.body.id;
});

test('non-allowlisted users get no reply at all', async () => {
  send.reset();
  await text(999, '/whoami');
  await text(999, '/races');
  assert.equal(send.calls.length, 0, 'bot must stay silent for anyone but the allowlist');
});

test('/whoami answers the allowlisted user', async () => {
  send.reset();
  await text(ALLOWED, '/whoami');
  assert.match(send.last('message').text, /42/);
});

test('/races then /use selects the race', async () => {
  send.reset();
  await text(ALLOWED, '/races');
  const listing = send.last('message');
  const flat = JSON.stringify(listing.extra.reply_markup);
  assert.ok(flat.includes(`use:${contestId}`), 'race appears as a button');

  send.reset();
  await tap(ALLOWED, `use:${contestId}`);
  assert.match(send.last('message').text, /Managing/);
});

test('command buttons: /start shows the keyboard and label taps map to commands', async () => {
  send.reset();
  await text(ALLOWED, '/start');
  const kb = send.last('message').extra.reply_markup;
  assert.ok(kb && kb.keyboard, 'a persistent reply keyboard is attached');
  const labels = kb.keyboard.flat().map((b) => b.text);
  assert.ok(labels.includes('🏁 Races') && labels.includes('➕ Add') && labels.includes('📄 CSV'));

  // tapping the "🏁 Races" button sends its label text — it must act like /races
  send.reset();
  await text(ALLOWED, '🏁 Races');
  assert.ok(JSON.stringify(send.last('message').extra.reply_markup).includes(`use:${contestId}`));
});

test('/add (one line) creates a racer with a synthetic chip id', async () => {
  send.reset();
  await text(ALLOWED, '/add bib=101 name=Jane Doe cat=M40 dist=10k gender=F team=Aces');
  assert.match(send.last('message').text, /Added/);

  const { body } = await request(app).get(`/api/contests/${contestId}/tags`).set({ Authorization: `Bearer ${organizer.token}` });
  const r = body.tags.find((x) => x.bib === '101');
  assert.ok(r, 'racer 101 exists');
  assert.equal(r.participant, 'Jane Doe');
  assert.equal(r.category, 'M40');
  assert.equal(r.distance, '10k');
  assert.equal(r.gender, 'Female');
  assert.equal(r.team, 'Aces');
  assert.equal(r.epcs[0], pad('101')); // derived from the bib, padded to 24 chars
});

test('/add guided wizard walks through the steps incl. wave + chip', async () => {
  send.reset();
  await text(ALLOWED, '/add');
  assert.match(send.last('message').text, /bib/i);
  await text(ALLOWED, '202');          // bib
  await text(ALLOWED, 'Sam Runner');   // name
  await text(ALLOWED, 'M30');          // category
  await text(ALLOWED, '5k');           // distance
  await tap(ALLOWED, 'addg:Male');     // gender button
  await text(ALLOWED, 'Solo');         // team
  await tap(ALLOWED, 'addw:Sprint');   // wave button (creates the wave)
  await text(ALLOWED, '/skip');        // chip -> derived from bib -> creates

  const { body } = await request(app).get(`/api/contests/${contestId}/tags`).set({ Authorization: `Bearer ${organizer.token}` });
  const r = body.tags.find((x) => x.bib === '202');
  assert.ok(r);
  assert.equal(r.participant, 'Sam Runner');
  assert.equal(r.gender, 'Male');
  assert.equal(r.distance, '5k');
  assert.equal(r.wave_name, 'Sprint');
  assert.equal(r.epcs[0], pad('202'));
});

test('/add (one line) accepts an explicit chip id and wave', async () => {
  send.reset();
  await text(ALLOWED, '/add bib=303 name=Wave Rider dist=10k wave=Elite epc=E2801234');
  assert.match(send.last('message').text, /Added/);
  const { body } = await request(app).get(`/api/contests/${contestId}/tags`).set({ Authorization: `Bearer ${organizer.token}` });
  const r = body.tags.find((x) => x.bib === '303');
  assert.ok(r);
  assert.equal(r.epcs[0], pad('E2801234')); // explicit chip, padded to 24 chars
  assert.equal(r.wave_name, 'Elite');
});

test('/edit can change the wave and re-key the chip id', async () => {
  send.reset();
  await text(ALLOWED, '/edit 303 wave=Sport epc=E2809999');
  const { body } = await request(app).get(`/api/contests/${contestId}/tags`).set({ Authorization: `Bearer ${organizer.token}` });
  const r = body.tags.find((x) => x.bib === '303');
  assert.equal(r.wave_name, 'Sport');
  assert.equal(r.epcs[0], pad('E2809999'));                                    // chip changed
  assert.equal(body.tags.some((x) => x.epcs.includes(pad('E2801234'))), false); // old chip removed
});

test('/edit changes a field (one line) and via button value', async () => {
  send.reset();
  await text(ALLOWED, '/edit 101 name=Jane Smith cat=M45');
  const after = (await request(app).get(`/api/contests/${contestId}/tags`).set({ Authorization: `Bearer ${organizer.token}` })).body;
  let r = after.tags.find((x) => x.bib === '101');
  assert.equal(r.participant, 'Jane Smith');
  assert.equal(r.category, 'M45');

  // button flow: pick Status -> DNF
  await tap(ALLOWED, 'ev:101:racer_status:DNF');
  r = (await request(app).get(`/api/contests/${contestId}/tags`).set({ Authorization: `Bearer ${organizer.token}` })).body.tags.find((x) => x.bib === '101');
  assert.equal(r.racer_status, 'DNF');
});

test('/del removes the racer after confirmation', async () => {
  send.reset();
  await text(ALLOWED, '/del 202');
  const confirm = send.last('message');
  assert.ok(JSON.stringify(confirm.extra.reply_markup).includes('delyes:202'));
  await tap(ALLOWED, 'delyes:202');

  const { body } = await request(app).get(`/api/contests/${contestId}/tags`).set({ Authorization: `Bearer ${organizer.token}` });
  assert.equal(body.tags.find((x) => x.bib === '202'), undefined);
});

test('/csv sends a document with a UTF-8 BOM', async () => {
  send.reset();
  await text(ALLOWED, '/csv');
  const doc = send.last('document');
  assert.ok(doc, 'a document was sent');
  assert.equal(doc.filename, `race-results-${contestId}.csv`);
  assert.ok(doc.content.startsWith('﻿'), 'CSV starts with the Excel BOM');
});

test('empty allowlist serves nobody (fail-safe)', async () => {
  const saved = process.env.TELEGRAM_ALLOWED_USER_IDS;
  process.env.TELEGRAM_ALLOWED_USER_IDS = '';
  send.reset();
  await text(ALLOWED, '/whoami');
  assert.equal(send.calls.length, 0);
  process.env.TELEGRAM_ALLOWED_USER_IDS = saved;
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = process.env.DATA_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'vgs-tg-'));
process.env.DISABLE_RATE_LIMIT = '1';
process.env.OPEN_REGISTRATION = '1'; // tests use self-service accounts; approval flow covered in approval.test.js
process.env.TELEGRAM_ALLOWED_USER_IDS = '42'; // only user 42 may talk to the bot

const request = require('supertest');
const { app, seedAdmin } = require('../server/index');
const { createBotCore } = require('../server/telegram');

seedAdmin();

const past = new Date(Date.now() - 3600_000).toISOString();
const future = new Date(Date.now() + 86400_000).toISOString();

// Collect a binary response body into a Buffer (PDF exports).
const binaryParser = (res, cb) => {
  const chunks = [];
  res.on('data', (c) => chunks.push(Buffer.from(c)));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
};

// supertest-backed API client (same shape the prod fetch client returns):
// PDF requests come back as a Buffer, everything else as json/text.
const api = async (method, p, { token, body } = {}) => {
  let r = request(app)[method.toLowerCase()](`/api${p}`);
  if (token) r = r.set('Authorization', `Bearer ${token}`);
  if (body !== undefined) r = r.send(body);
  if (/[?&]format=pdf(&|$)/.test(p)) {
    const res = await r.buffer(true).parse(binaryParser);
    return { status: res.status, buffer: res.body };
  }
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

test('non-allowlisted users get the runner self-service flow, not the admin bot', async () => {
  send.reset();
  await text(999, '/start');
  // Prompted for a bib (Hebrew), NOT the operator help/keyboard.
  assert.match(send.last('message').text, /Bib|בחזה|החזה/);
  // Admin operations stay closed to them: /races is treated as a (bad) bib, not a race list.
  send.reset();
  await text(999, '/races');
  assert.ok(!/Pick a race/.test(send.last('message').text || ''), 'runner cannot list races like an operator');
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

test('grouped menu: /start shows the category keyboard; groups open sub-menus', async () => {
  send.reset();
  await text(ALLOWED, '/start');
  const kb = send.last('message').extra.reply_markup;
  assert.ok(kb && kb.keyboard, 'a persistent reply keyboard is attached');
  const labels = kb.keyboard.flat().map((b) => b.text);
  assert.ok(labels.includes('🏁 Race') && labels.includes('⚙️ Setup') && labels.includes('📊 Results'));

  // Tapping a group opens an inline sub-menu of its actions.
  send.reset();
  await text(ALLOWED, '📊 Results');
  const results = JSON.stringify(send.last('message').extra.reply_markup);
  assert.ok(results.includes('go:csv') && results.includes('go:pdf') && results.includes('go:league'));

  send.reset();
  await text(ALLOWED, '⚙️ Setup');
  const setup = JSON.stringify(send.last('message').extra.reply_markup);
  assert.ok(setup.includes('go:laps') && setup.includes('go:operators'), 'Setup offers Laps + Marshals');

  // An inline action runs its command: Switch race → the race picker.
  send.reset();
  await tap(ALLOWED, 'go:races');
  assert.ok(JSON.stringify(send.last('message').extra.reply_markup).includes(`use:${contestId}`));

  // The old flat-keyboard labels still work (a phone showing the previous keyboard).
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

test('/league lists leagues, shows standings, and sends CSVs', async () => {
  // an admin creates a league and attaches the race
  const admin = (await request(app).post('/api/auth/login')
    .send({ email: 'admin@velogripscorer.local', password: 'change-me-please' })).body;
  const league = (await request(app).post('/api/leagues')
    .set({ Authorization: `Bearer ${admin.token}` })
    .send({ name: 'Bot League', season: '2026' })).body.league;
  await request(app).post(`/api/leagues/${league.id}/races`)
    .set({ Authorization: `Bearer ${admin.token}` })
    .send({ contest_id: contestId });

  // single league -> straight to the standings summary with CSV buttons
  send.reset();
  await text(ALLOWED, '/league');
  const msg = send.last('message');
  assert.ok(msg, 'a standings message was sent');
  assert.match(msg.text, /Bot League/);
  const btns = msg.extra.reply_markup.inline_keyboard.flat().map((b) => b.callback_data);
  assert.ok(btns.includes(`lgcsv:${league.id}:individual`));
  assert.ok(btns.includes(`lgcsv:${league.id}:team`));

  // CSV button taps send documents
  send.reset();
  await tap(ALLOWED, `lgcsv:${league.id}:individual`);
  let doc = send.last('document');
  assert.ok(doc, 'individual CSV sent');
  assert.equal(doc.filename, `league-${league.id}-individual.csv`);
  assert.ok(doc.content.startsWith('﻿'), 'CSV starts with the Excel BOM');

  send.reset();
  await tap(ALLOWED, `lgcsv:${league.id}:team`);
  doc = send.last('document');
  assert.equal(doc.filename, `league-${league.id}-team.csv`);
});

test('/races browses by league first, then lists that league’s races', async () => {
  const admin = (await request(app).post('/api/auth/login')
    .send({ email: 'admin@velogripscorer.local', password: 'change-me-please' })).body;
  const league = (await request(app).get('/api/leagues')
    .set({ Authorization: `Bearer ${admin.token}` })).body.leagues[0];

  // /races (no query) now shows leagues, not the flat race list
  send.reset();
  await text(ALLOWED, '/races');
  let btns = send.last('message').extra.reply_markup.inline_keyboard.flat().map((b) => b.callback_data);
  assert.ok(btns.includes(`rl:${league.id}`), 'a league button is shown');
  assert.ok(!btns.some((d) => d && d.startsWith('use:')), 'no race buttons at the league level');

  // tapping the league lists its races (with a back button)
  send.reset();
  await tap(ALLOWED, `rl:${league.id}`);
  btns = send.last('message').extra.reply_markup.inline_keyboard.flat().map((b) => b.callback_data);
  assert.ok(btns.includes(`use:${contestId}`), 'the attached race appears');
  assert.ok(btns.includes('racesback'), 'a back-to-leagues button is present');

  // "/races <text>" still searches every race directly
  send.reset();
  await text(ALLOWED, '/races Telegram');
  btns = send.last('message').extra.reply_markup.inline_keyboard.flat().map((b) => b.callback_data);
  assert.ok(btns.includes(`use:${contestId}`), 'search still jumps straight to matching races');
});

test('/pdf sends a PDF document', async () => {
  send.reset();
  await text(ALLOWED, '/pdf');
  const doc = send.last('document');
  assert.ok(doc, 'a document was sent');
  assert.equal(doc.filename, `race-results-${contestId}.pdf`);
  assert.ok(Buffer.isBuffer(doc.content), 'PDF content is a Buffer');
  assert.equal(doc.content.subarray(0, 5).toString('latin1'), '%PDF-');
});

test('league PDF buttons send PDF documents', async () => {
  const admin = (await request(app).post('/api/auth/login')
    .send({ email: 'admin@velogripscorer.local', password: 'change-me-please' })).body;
  const leagues = (await request(app).get('/api/leagues')
    .set({ Authorization: `Bearer ${admin.token}` })).body;
  const league = (leagues.leagues || leagues)[0];
  assert.ok(league && league.id, 'a league exists from the earlier test');

  // the standings message offers PDF buttons alongside the CSV ones
  send.reset();
  await text(ALLOWED, '/league');
  const btns = send.last('message').extra.reply_markup.inline_keyboard.flat().map((b) => b.callback_data);
  assert.ok(btns.includes(`lgpdf:${league.id}:individual`));
  assert.ok(btns.includes(`lgpdf:${league.id}:team`));

  for (const which of ['individual', 'team']) {
    send.reset();
    await tap(ALLOWED, `lgpdf:${league.id}:${which}`);
    const doc = send.last('document');
    assert.ok(doc, `${which} PDF sent`);
    assert.equal(doc.filename, `league-${league.id}-${which}.pdf`);
    assert.ok(Buffer.isBuffer(doc.content), 'PDF content is a Buffer');
    assert.equal(doc.content.subarray(0, 5).toString('latin1'), '%PDF-');
  }
});

test('email flow: pick a predefined recipient and the PDF is mailed', async () => {
  // A dedicated core with an injected fake mailer captures what would be sent.
  const mailed = [];
  const fakeMailer = {
    isConfigured: () => true,
    recipients: () => [{ label: 'Race Committee', email: 'committee@club.org' }, { label: 'Coach', email: 'coach@club.org' }],
    sendMail: async (m) => { mailed.push(m); },
  };
  const esend = makeSend();
  const eh = createBotCore({ api, send: esend, mailer: fakeMailer }).handleUpdate;
  const etap = (data) => eh({ update_id: ++uid, callback_query: { id: `cq${++uid}`, from: { id: ALLOWED }, message: { chat: { id: ALLOWED } }, data } });

  // /pdf offers an "Email results" button
  esend.reset();
  await eh({ update_id: ++uid, message: { from: { id: ALLOWED }, chat: { id: ALLOWED }, text: '/pdf' } });
  const offer = esend.last('message').extra.reply_markup.inline_keyboard.flat().map((b) => b.callback_data);
  assert.ok(offer.includes(`emask:rr:${contestId}:results`), 'email-results button present');

  // tapping it lists the predefined recipients as buttons
  esend.reset();
  await etap(`emask:rr:${contestId}:results`);
  const recips = esend.last('message').extra.reply_markup.inline_keyboard.flat().map((b) => b.callback_data);
  assert.ok(recips.includes(`emto:rr:${contestId}:results:0`) && recips.includes(`emto:rr:${contestId}:results:1`));

  // tapping a recipient mails the PDF to that address
  esend.reset();
  await etap(`emto:rr:${contestId}:results:0`);
  assert.equal(mailed.length, 1, 'one email sent');
  assert.equal(mailed[0].to, 'committee@club.org');
  assert.equal(mailed[0].attachments[0].filename, `race-results-${contestId}.pdf`);
  assert.ok(Buffer.isBuffer(mailed[0].attachments[0].content), 'PDF attached as a Buffer');
  assert.match(esend.last('message').text, /Sent/);
});

test('email flow: reports when SMTP or recipients are not configured', async () => {
  const esend = makeSend();
  const off = createBotCore({ api, send: esend, mailer: { isConfigured: () => false, recipients: () => [], sendMail: async () => {} } }).handleUpdate;
  await off({ update_id: ++uid, callback_query: { id: `cq${++uid}`, from: { id: ALLOWED }, message: { chat: { id: ALLOWED } }, data: `emask:rr:${contestId}:results` } });
  assert.match(esend.last('message').text, /configured/i);

  const esend2 = makeSend();
  const noRecips = createBotCore({ api, send: esend2, mailer: { isConfigured: () => true, recipients: () => [], sendMail: async () => {} } }).handleUpdate;
  await noRecips({ update_id: ++uid, callback_query: { id: `cq${++uid}`, from: { id: ALLOWED }, message: { chat: { id: ALLOWED } }, data: `emask:lg:1:individual` } });
  assert.match(esend2.last('message').text, /recipient/i);
});

test('/emails adds a recipient (persisted, merged into the picker) and removes it', async () => {
  const mailer = require('../server/mailer');

  send.reset();
  await text(ALLOWED, '/emails');
  assert.match(JSON.stringify(send.last('message').extra.reply_markup), /emadd:/);

  // ➕ Add email -> prompted -> type an address
  send.reset();
  await tap(ALLOWED, 'emadd:');
  assert.match(send.last('message').text, /email address/i);
  send.reset();
  await text(ALLOWED, 'Committee <committee@club.org>');
  const rec = mailer.savedRecipients().find((r) => r.email === 'committee@club.org');
  assert.ok(rec, 'recipient persisted to the DB');
  assert.match(JSON.stringify(send.last('message').extra.reply_markup), new RegExp(`emdel:${rec.id}`));
  assert.ok(mailer.recipients().some((r) => r.email === 'committee@club.org'), 'shows up in the send picker');

  // an invalid address is rejected and the add-flow stays armed until /cancel
  send.reset();
  await tap(ALLOWED, 'emadd:');
  send.reset();
  await text(ALLOWED, 'nope');
  assert.match(send.last('message').text, /valid address/i);
  await text(ALLOWED, '/cancel');

  // 🗑 removes it
  send.reset();
  await tap(ALLOWED, `emdel:${rec.id}`);
  assert.ok(!mailer.savedRecipients().some((r) => r.email === 'committee@club.org'));
});

test('mailer parses EMAIL_RECIPIENTS into label/email pairs', () => {
  const mailer = require('../server/mailer');
  const saved = process.env.EMAIL_RECIPIENTS;
  process.env.EMAIL_RECIPIENTS = 'Race Committee <committee@club.org>, coach@club.org, , not-an-email';
  assert.deepEqual(mailer.recipients(), [
    { label: 'Race Committee', email: 'committee@club.org' },
    { label: 'coach@club.org', email: 'coach@club.org' },
  ]);
  process.env.EMAIL_RECIPIENTS = saved;
});

test('empty allowlist serves nobody (fail-safe)', async () => {
  const saved = process.env.TELEGRAM_ALLOWED_USER_IDS;
  process.env.TELEGRAM_ALLOWED_USER_IDS = '';
  send.reset();
  await text(ALLOWED, '/whoami');
  assert.equal(send.calls.length, 0);
  process.env.TELEGRAM_ALLOWED_USER_IDS = saved;
});

test('/laps binds the lap count to the selected race', async () => {
  await tap(ALLOWED, `use:${contestId}`);
  const getLaps = async () => (await api('GET', `/contests/${contestId}/lap-targets`, { token: organizer.token })).json;
  const distances = (await getLaps()).distances;
  assert.ok(distances.length >= 1, 'race has distances from earlier /add tests');

  // No-arg listing shows the race-wide line and "no limit" (nothing set yet).
  send.reset();
  await text(ALLOWED, '/laps');
  assert.match(send.last('message').text, /whole race/);
  assert.match(send.last('message').text, /no limit/);

  // A bare number sets the whole race — bound to this contest.
  send.reset();
  await text(ALLOWED, '/laps 3');
  assert.match(send.last('message').text, /✅/);
  assert.equal((await getLaps()).race_laps, 3, 'race-wide laps saved on the race');

  // A distance argument sets a per-distance override, leaving race-wide intact.
  send.reset();
  await text(ALLOWED, `/laps ${distances[0]} 5`);
  let laps = await getLaps();
  assert.equal(laps.lap_targets[distances[0]], 5, 'distance override saved');
  assert.equal(laps.race_laps, 3, 'race-wide untouched by an override');

  // Clear the race-wide cap.
  send.reset();
  await text(ALLOWED, '/laps 0');
  laps = await getLaps();
  assert.equal(laps.race_laps, null, 'race-wide cleared');
  assert.equal(laps.lap_targets[distances[0]], 5, 'override preserved');

  // An unknown distance is rejected, not saved.
  send.reset();
  await text(ALLOWED, '/laps NoSuchDistance 4');
  assert.match(send.last('message').text, /Unknown distance/);
});

test('/operators adds a checkpoint marshal and removes via button', async () => {
  await tap(ALLOWED, `use:${contestId}`);
  await request(app).post('/api/auth/register')
    .send({ email: 'tg-marshal@test.co', password: 'password123', username: 'tgmarshal' });
  const collabsOf = async () =>
    (await api('GET', `/contests/${contestId}/collaborators`, { token: organizer.token })).json.collaborators;

  // Add by email.
  send.reset();
  await text(ALLOWED, '/operators tg-marshal@test.co');
  assert.match(send.last('message').text, /Or add by email/); // the refreshed operator list
  let collabs = await collabsOf();
  const row = collabs.find((u) => u.email === 'tg-marshal@test.co');
  assert.ok(row, 'marshal added as an operator');

  // /operators shows them with a remove button.
  send.reset();
  await text(ALLOWED, '/operators');
  const flat = JSON.stringify(send.calls.map((m) => m.extra && m.extra.reply_markup));
  assert.ok(flat.includes(`opdel:${row.id}`), 'a remove button is offered');

  // Remove via the button.
  send.reset();
  await tap(ALLOWED, `opdel:${row.id}`);
  collabs = await collabsOf();
  assert.ok(!collabs.some((u) => u.email === 'tg-marshal@test.co'), 'marshal removed');
});

test('/list chunks a big roster so no message exceeds Telegram limits', async () => {
  const big = (await api('POST', '/contests',
    { token: organizer.token, body: { kind: 'race', title: 'Big race', start_at: past, end_at: future } })).json;
  for (let i = 1; i <= 70; i++) {
    await api('POST', `/contests/${big.id}/tags`, { token: organizer.token, body: {
      epc: String(i).padStart(24, '0'), bib: String(100 + i),
      participant: 'רוכב עם שם מאוד מאוד מאוד ארוך לבדיקת חלוקה למקטעים מספר ' + i, category: 'MTB',
    }});
  }
  await tap(ALLOWED, `use:${big.id}`);
  send.reset();
  await text(ALLOWED, '/list');
  const msgs = send.calls.filter((c) => c.type === 'message');
  assert.ok(msgs.length >= 2, 'a 70-rider roster is split across multiple messages');
  for (const m of msgs) assert.ok(m.text.length <= 4096, `each message stays under Telegram's 4096 limit (was ${m.text.length})`);
  const all = msgs.map((m) => m.text).join('\n');
  assert.ok(all.includes('#101') && all.includes('#170'), 'every rider is covered (first + last bib present)');
});

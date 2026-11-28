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
  // Telegram rejects callback_data over 64 BYTES with BUTTON_DATA_INVALID and
  // drops the whole message. The fake transport used to accept anything, so a
  // wave name long enough in Hebrew (two bytes a character) sailed through here
  // and failed only in the operator's hands, as "Something went wrong".
  const checkButtons = (extra) => {
    const rm = extra && extra.reply_markup;
    for (const row of (rm && (rm.inline_keyboard || rm.keyboard)) || []) {
      for (const b of row) {
        if (!b || b.callback_data === undefined) continue;
        const n = Buffer.byteLength(String(b.callback_data), 'utf8');
        if (n > 64) throw new Error(`callback_data is ${n} bytes > 64: ${b.callback_data}`);
      }
    }
  };
  return {
    calls: [],
    reset() { this.calls.length = 0; },
    last(type) { return [...this.calls].reverse().find((c) => c.type === type); },
    async message(chatId, text, extra) { checkButtons(extra); this.calls.push({ type: 'message', chatId, text, extra }); },
    async editMessage(chatId, messageId, text, extra) { this.calls.push({ type: 'edit', chatId, messageId, text, extra }); },
    async answerCallback(id) { this.calls.push({ type: 'answer', id }); },
    async document(chatId, filename, content, caption) { this.calls.push({ type: 'document', chatId, filename, content, caption }); },
  };
}

const send = makeSend();
const { handleUpdate } = createBotCore({ api, send });

let uid = 0;
const ALLOWED = 42;
const text = (userId, t) => handleUpdate({ update_id: ++uid, message: { from: { id: userId }, chat: { id: userId }, text: t } });
const tap = (userId, data) => handleUpdate({ update_id: ++uid, callback_query: { id: `cq${++uid}`, from: { id: userId }, message: { message_id: uid, chat: { id: userId } }, data } });
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

const CATEGORY_LABELS = ['🏁 Race', '👤 Start list', '⚙️ Setup', '📊 Results'];

test('flat keyboard: /start offers one button per action; group labels still work', async () => {
  send.reset();
  await text(ALLOWED, '/start');
  const kb = send.last('message').extra.reply_markup;
  assert.ok(kb && kb.keyboard, 'a persistent reply keyboard is attached');
  const labels = kb.keyboard.flat().map((b) => b.text);
  // CSV and PDF are on the keyboard itself: at a race they are wanted in one
  // tap, not two behind a group.
  assert.deepEqual(labels,
    ['🏁 Races', '📋 List', '➕ Add', '✏️ Edit', '📄 CSV', '📑 PDF', '🏆 League', '🔗 Link', '❓ Help']);
  assert.ok(!labels.some((l) => CATEGORY_LABELS.includes(l)), 'no group buttons on the keyboard');

  // A phone still showing the grouped keyboard keeps working: the group labels
  // open their inline sub-menus as before.
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

  // Every keyboard button runs its command directly.
  send.reset();
  await text(ALLOWED, '🏁 Races');
  assert.ok(JSON.stringify(send.last('message').extra.reply_markup).includes(`use:${contestId}`));
  send.reset();
  await text(ALLOWED, '📄 CSV');
  assert.ok(send.last('document'), '📄 CSV sends the results CSV in one tap');
  send.reset();
  await text(ALLOWED, '📑 PDF');
  assert.ok(send.last('document'), '📑 PDF sends the results PDF in one tap');

  // 🔗 Link: the race's public page, to forward to spectators
  const prevUrl = process.env.PUBLIC_BASE_URL;
  process.env.PUBLIC_BASE_URL = 'https://scores.example.test';
  send.reset();
  await text(ALLOWED, '🔗 Link');
  assert.ok(send.last('message').text.includes(`https://scores.example.test/#/results/${contestId}`), 'the link is sent');
  if (prevUrl === undefined) delete process.env.PUBLIC_BASE_URL; else process.env.PUBLIC_BASE_URL = prevUrl;
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
  // Typing is how a NEW wave is created; the buttons only ever offer waves
  // that already exist, and now carry their id rather than their name.
  await text(ALLOWED, 'Sprint');       // wave (created on the fly)
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

test('the add wizard offers existing categories and teams (this race + its league), and a new one', async () => {
  const org = { Authorization: `Bearer ${organizer.token}` };
  const admin = (await request(app).post('/api/auth/login')
    .send({ email: 'admin@velogripscorer.local', password: 'change-me-please' })).body;
  const league = ((await request(app).get('/api/leagues').set({ Authorization: `Bearer ${admin.token}` })).body.leagues || [])
    .find((l) => l.name === 'Bot League');
  assert.ok(league, 'the league from the test above');
  // another round of the same league, whose start list has team Bees / M50
  const sib = (await request(app).post('/api/contests').set(org)
    .send({ kind: 'race', title: 'Telegram race round 2', start_at: past, end_at: future })).body;
  await request(app).post(`/api/contests/${sib.id}/tags`).set(org)
    .send({ epc: pad(5501), bib: '5501', participant: 'Bee Rider', team: 'Bees', category: 'M50' });
  await request(app).post(`/api/leagues/${league.id}/races`).set({ Authorization: `Bearer ${admin.token}` })
    .send({ contest_id: sib.id });

  await text(ALLOWED, `/use ${contestId}`);
  send.reset();
  await text(ALLOWED, '/add');
  await text(ALLOWED, '404');
  await text(ALLOWED, 'Pick Rider');
  // category: buttons from this race and the league's other round
  let prompt = send.last('message');
  assert.match(prompt.text, /Category\?/);
  let buttons = prompt.extra.reply_markup.inline_keyboard.flat();
  const m50 = buttons.find((b) => b.text === 'M50');
  assert.ok(m50 && /^addc:\d+$/.test(m50.callback_data), 'M50 (from the other round) is a button carrying an index');
  assert.ok(buttons.some((b) => b.text === 'M45'), 'this race’s own category too');
  await tap(ALLOWED, m50.callback_data);
  await text(ALLOWED, '/skip');            // distance
  await tap(ALLOWED, 'addg:');             // gender: skip
  // team: existing teams + ➕ New team
  prompt = send.last('message');
  assert.match(prompt.text, /Team\?/);
  buttons = prompt.extra.reply_markup.inline_keyboard.flat();
  for (const team of ['Aces', 'Bees']) assert.ok(buttons.some((b) => b.text === team), `${team} offered`);
  assert.ok(buttons.some((b) => b.callback_data === 'addnew:'), 'a ➕ New team button');
  await tap(ALLOWED, 'addnew:');
  assert.match(send.last('message').text, /Type the new team/);
  await text(ALLOWED, 'Comets');           // the new team
  await text(ALLOWED, '/skip');            // wave
  await text(ALLOWED, '/skip');            // chip -> create

  let r = (await request(app).get(`/api/contests/${contestId}/tags`).set(org)).body.tags.find((x) => x.bib === '404');
  assert.ok(r, 'racer 404 created');
  assert.equal(r.category, 'M50');
  assert.equal(r.team, 'Comets');

  // Edit -> Team offers the same list (now with Comets) as buttons
  send.reset();
  await tap(ALLOWED, 'ef:404:team');
  buttons = send.last('message').extra.reply_markup.inline_keyboard.flat();
  const bees = buttons.find((b) => b.text === 'Bees');
  assert.ok(bees && /^evo:\d+$/.test(bees.callback_data), 'edit offers teams as index buttons');
  assert.ok(buttons.some((b) => b.text === 'Comets'), 'the team just created is offered');
  await tap(ALLOWED, bees.callback_data);
  r = (await request(app).get(`/api/contests/${contestId}/tags`).set(org)).body.tags.find((x) => x.bib === '404');
  assert.equal(r.team, 'Bees', 'tapping a team saves it');

  // typing a new value at the edit prompt still works
  await tap(ALLOWED, 'ef:404:team');
  await text(ALLOWED, 'Dragons');
  r = (await request(app).get(`/api/contests/${contestId}/tags`).set(org)).body.tags.find((x) => x.bib === '404');
  assert.equal(r.team, 'Dragons');
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

  // "All races" reaches every race in one list, whatever league it is in — the
  // league-at-a-time view made a bot with many races look like it had one.
  send.reset();
  await text(ALLOWED, '/races');
  btns = send.last('message').extra.reply_markup.inline_keyboard.flat().map((b) => b.callback_data);
  assert.ok(btns.includes('rl:all'), 'an all-races button is offered');
  send.reset();
  await tap(ALLOWED, 'rl:all');
  const all = send.last('message');
  btns = all.extra.reply_markup.inline_keyboard.flat().map((b) => b.callback_data);
  const races = (await request(app).get('/api/contests?kind=race')).body.contests || [];
  assert.ok(btns.includes(`use:${contestId}`), 'the league race is in the flat list');
  assert.ok(btns.filter((d) => d && d.startsWith('use:')).length >= Math.min(races.length, 2),
    'every race is reachable, not just the current one');
  assert.match(all.text, /Pick a race \(\d+\)/, 'the list says how many races there are');

  // The 🏁 Race menu button draws the picker itself, so the other races are
  // one tap away rather than hidden behind "Switch race".
  send.reset();
  await text(ALLOWED, '🏁 Race');
  btns = send.last('message').extra.reply_markup.inline_keyboard.flat().map((b) => b.callback_data);
  assert.ok(btns.some((d) => d && (d.startsWith('rl:') || d.startsWith('use:'))),
    'the Race menu lists races without another tap');

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

  // the menu offers the general results PDF beside the league ones
  const btns = send.last('message').extra.reply_markup.inline_keyboard.flat().map((b) => b.callback_data);
  for (const d of ['rpdf:results', 'rpdf:teampoints', 'rpdf:individual', 'rpdf:team', `emask:rr:${contestId}:results`]) {
    assert.ok(btns.includes(d), `menu has ${d}`);
  }

  // and the Results PDF button sends the same file again
  send.reset();
  await tap(ALLOWED, 'rpdf:results');
  const again = send.last('document');
  assert.ok(again, 'Results PDF button sent a document');
  assert.equal(again.filename, `race-results-${contestId}.pdf`);
  assert.equal(again.content.subarray(0, 5).toString('latin1'), '%PDF-');

  // and Team points PDF sends this race's team score worked out
  send.reset();
  await tap(ALLOWED, 'rpdf:teampoints');
  const tp = send.last('document');
  assert.ok(tp, 'Team points PDF button sent a document');
  assert.equal(tp.filename, `team-points-${contestId}.pdf`);
  assert.equal(tp.content.subarray(0, 5).toString('latin1'), '%PDF-');
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

test('/list paginates a big roster 20 per page, showing category, with working nav', async () => {
  const big = (await api('POST', '/contests',
    { token: organizer.token, body: { kind: 'race', title: 'Big race', start_at: past, end_at: future } })).json;
  for (let i = 1; i <= 70; i++) {
    await api('POST', `/contests/${big.id}/tags`, { token: organizer.token, body: {
      epc: String(i).padStart(24, '0'), bib: String(100 + i),
      participant: 'רוכב מספר ' + i, category: (i % 2 ? 'M40' : 'M50'),
    }});
  }
  await tap(ALLOWED, `use:${big.id}`);

  // Page 1: 20 riders, category shown, a Next button (no Prev), under the limit.
  send.reset();
  await text(ALLOWED, '/list');
  const m1 = send.last('message');
  assert.ok(m1.text.length <= 4096, 'a page fits in one message');
  assert.match(m1.text, /page 1\/4/);
  assert.ok(m1.text.includes('#101') && m1.text.includes('#120') && !m1.text.includes('#121'), 'shows exactly the first 20 bibs');
  assert.match(m1.text, /M40|M50/, 'category is shown on the line');
  const nav1 = JSON.stringify(m1.extra.reply_markup);
  assert.ok(nav1.includes('lp:1') && !nav1.includes('lp:'.concat('-')), 'Next present, no Prev on page 1');

  // Tap Next → edits the message in place to page 2 (bibs 121–140), with Prev + Next.
  send.reset();
  await tap(ALLOWED, 'lp:1');
  const e = send.last('edit');
  assert.ok(e, 'pagination edits the message in place');
  assert.match(e.text, /page 2\/4/);
  assert.ok(e.text.includes('#121') && e.text.includes('#140') && !e.text.includes('#120'), 'page 2 shows the next 20');
  const nav2 = JSON.stringify(e.extra.reply_markup);
  assert.ok(nav2.includes('lp:0') && nav2.includes('lp:2'), 'Prev + Next on a middle page');
});

// ---------------------------------------------------------------------------
// /chip — swapping a chip in the field
// ---------------------------------------------------------------------------

const tagsOf = async () => (await request(app).get(`/api/contests/${contestId}/tags`)
  .set({ Authorization: `Bearer ${organizer.token}` })).body.tags;
const chipsOfBib = async (bib) => {
  const r = (await tagsOf()).find((x) => String(x.bib) === String(bib));
  return r ? (r.epcs || [r.epc]) : null;
};

test('/chip with an id swaps the chip and keeps the racer', async () => {
  // Earlier tests leave their own race selected; pin ours so these stand alone.
  await text(ALLOWED, `/use ${contestId}`);
  await text(ALLOWED, `/add bib=701 name=Swap Target cat=M40 epc=${pad('A1')}`);
  send.reset();
  await text(ALLOWED, `/chip 701 ${pad('B1')}`);
  assert.match(send.last('message').text, /chip replaced/i);
  assert.deepEqual(await chipsOfBib('701'), [pad('B1')]);
});

// The old path upserted the chip onto the new racer, which silently removed
// whoever held it — they simply vanished from the start list.
test('/chip refuses a chip another racer holds, and names them', async () => {
  await text(ALLOWED, `/add bib=702 name=Chip Holder cat=M40 epc=${pad('C1')}`);
  send.reset();
  await text(ALLOWED, `/chip 701 ${pad('C1')}`);
  const msg = send.last('message').text;
  assert.match(msg, /already on/i);
  assert.ok(msg.includes('702') && /Chip Holder/.test(msg), 'says who has it');
  assert.deepEqual(await chipsOfBib('701'), [pad('B1')], 'the swap did not happen');
  assert.deepEqual(await chipsOfBib('702'), [pad('C1')], 'and the holder is untouched');
});

test('/chip2 adds a second chip; either read counts', async () => {
  send.reset();
  await text(ALLOWED, `/chip2 701 ${pad('B2')}`);
  assert.match(send.last('message').text, /chip added/i);
  assert.deepEqual((await chipsOfBib('701')).sort(), [pad('B1'), pad('B2')].sort());
});

// The point of the feature: no 24-character id typed on a phone. The operator
// sends /chip <bib>, waves the chip at the mat, and the read binds itself.
test('/chip with no id binds the next unknown chip seen by the reader', async () => {
  const auth = { Authorization: `Bearer ${organizer.token}` };
  const reader = (await request(app).post(`/api/contests/${contestId}/readers`).set(auth)
    .send({ name: 'Mat' })).body;
  await text(ALLOWED, `/add bib=703 name=Scan Me cat=M40 epc=${pad('D1')}`);

  // A read BEFORE the prompt must be ignored, or a chip left lying on the mat
  // would be bound instead of the one being presented.
  await request(app).post('/api/ingest/reads').set('X-Reader-Token', reader.token)
    .send({ reads: [{ epc: pad('EE'), read_at: new Date().toISOString() }] });

  send.reset();
  await text(ALLOWED, '/chip 703');
  assert.match(send.last('message').text, /Hold the new chip/i);

  // Now the mat sees a racer already in the list (must be ignored) and then the
  // new chip being presented.
  await request(app).post('/api/ingest/reads').set('X-Reader-Token', reader.token)
    .send({ reads: [{ epc: pad('C1'), read_at: new Date().toISOString() }] }); // bib 702, assigned
  await request(app).post('/api/ingest/reads').set('X-Reader-Token', reader.token)
    .send({ reads: [{ epc: pad('F9'), read_at: new Date().toISOString() }] }); // unknown

  // The scan runs detached; give it a couple of poll cycles.
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline && !/chip replaced/i.test(send.last('message').text || '')) {
    await new Promise((r) => setTimeout(r, 250));
  }
  assert.match(send.last('message').text, /chip replaced/i);
  assert.deepEqual(await chipsOfBib('703'), [pad('F9')], 'bound the new chip, not the stale or assigned one');
  assert.deepEqual(await chipsOfBib('702'), [pad('C1')], 'the assigned racer was left alone');
});

// A real race names its waves in Hebrew, and Hebrew costs two bytes a
// character. "מקצה אליט גברים ונשים אליפות הנגב 2027" as callback_data came to
// 71 bytes, over Telegram's 64, so the API rejected the message carrying the
// wave buttons and the operator saw "⚠️ Something went wrong" in the middle of
// adding a racer — reported from the field.
test('a long Hebrew wave name does not break the add wizard', async () => {
  const auth = { Authorization: `Bearer ${organizer.token}` };
  const longWave = 'מקצה אליט גברים ונשים אליפות הנגב 2027';
  assert.ok(Buffer.byteLength(`addw:${longWave}`, 'utf8') > 64, 'the name really is over the limit');
  await request(app).post(`/api/contests/${contestId}/waves`).set(auth).send({ name: longWave });

  await text(ALLOWED, `/use ${contestId}`);
  send.reset();
  await text(ALLOWED, '/add');
  await text(ALLOWED, '801');
  await text(ALLOWED, 'Wave Tester');
  await text(ALLOWED, '/skip');            // category
  await text(ALLOWED, '/skip');            // distance
  await tap(ALLOWED, 'addg:Male');
  await text(ALLOWED, 'AudioCodes');       // team -> the wave prompt comes next
  const prompt = send.last('message');
  assert.match(prompt.text, /Wave\?/, 'the wizard reached the wave step instead of failing');

  // Tapping it still has to produce the right wave, now that the button carries
  // an id rather than the name.
  const row = JSON.parse(JSON.stringify(prompt.extra.reply_markup)).inline_keyboard
    .flat().find((b) => b.text.startsWith('מקצה אליט'));
  assert.ok(row, 'the long wave is offered');
  send.reset();
  await tap(ALLOWED, row.callback_data);
  await text(ALLOWED, '/skip');            // chip -> finish
  const tags = (await request(app).get(`/api/contests/${contestId}/tags`).set(auth)).body.tags;
  const made = tags.find((t) => String(t.bib) === '801');
  assert.ok(made, 'the racer was created');
  assert.equal(made.wave_name, longWave, 'and landed in the wave that was tapped');
});

// The edit flow builds the same buttons with an even longer prefix.
test('a long Hebrew wave name does not break /edit wave either', async () => {
  send.reset();
  await text(ALLOWED, '/edit 801');
  await tap(ALLOWED, 'ef:801:wave');
  const prompt = send.last('message');
  assert.match(prompt.text, /Pick a wave/);
});

// Races here are timed with "Live results" OFF, which holds every read on the
// tablet until the operator posts results — so the server sees no reads at all
// and scanning could never work in exactly the mode being used. A sighting is
// not a result, so the device reports those regardless, and /chip binds from
// them.
test('/chip binds by scanning even when no reads are published', async () => {
  const auth = { Authorization: `Bearer ${organizer.token}` };
  const reader = (await request(app).post(`/api/contests/${contestId}/readers`).set(auth)
    .send({ name: 'Mat2' })).body;
  await text(ALLOWED, `/use ${contestId}`);
  await text(ALLOWED, `/add bib=901 name=No Live cat=M40 epc=${pad('91')}`);

  const readsBefore = (await request(app).get(`/api/contests/${contestId}/reads?limit=1`).set(auth)).body.reads.length;

  send.reset();
  await text(ALLOWED, '/chip 901');
  assert.match(send.last('message').text, /Hold the new chip/i);

  // The device reports what it saw. Note this is NOT /ingest/reads.
  const seen = await request(app).post('/api/ingest/seen').set('X-Reader-Token', reader.token)
    .send({ epcs: [pad('FA')] });
  assert.equal(seen.status, 200);
  assert.equal(seen.body.seen, 1);

  const deadline = Date.now() + 15000;
  while (Date.now() < deadline && !/chip replaced/i.test(send.last('message').text || '')) {
    await new Promise((r) => setTimeout(r, 250));
  }
  assert.match(send.last('message').text, /chip replaced/i);
  const tags = (await request(app).get(`/api/contests/${contestId}/tags`).set(auth)).body.tags;
  assert.deepEqual(tags.find((t) => String(t.bib) === '901').epcs, [pad('FA')]);

  // And nothing was published: a sighting must never become a crossing.
  const readsAfter = (await request(app).get(`/api/contests/${contestId}/reads?limit=200`).set(auth)).body.reads;
  assert.ok(!readsAfter.some((x) => x.epc === pad('FA')), 'the sighting did not enter the read log');
  assert.ok(readsAfter.length >= readsBefore, 'and no results were invented');
});

test('a chip already on the start list is not offered as a sighting', async () => {
  const auth = { Authorization: `Bearer ${organizer.token}` };
  const reader = (await request(app).post(`/api/contests/${contestId}/readers`).set(auth)
    .send({ name: 'Mat3' })).body;
  // pad('FA') now belongs to bib 901 from the previous test.
  const res = await request(app).post('/api/ingest/seen').set('X-Reader-Token', reader.token)
    .send({ epcs: [pad('FA'), 'nothex!', pad('FB')] });
  assert.equal(res.status, 200);
  assert.equal(res.body.seen, 1, 'only the unknown, well-formed chip counted');
  const list = (await request(app).get(`/api/contests/${contestId}/chip-sightings`).set(auth)).body.sightings;
  // (no `within` -> the full hour, so both would show if they qualified)
  const epcs = list.map((s) => s.epc);
  assert.ok(epcs.includes(pad('FB')));
  assert.ok(!epcs.includes(pad('FA')), 'an assigned chip is never a candidate');
});

// Freshness, not a set of chips already seen. With a set, the retry after a
// timed-out scan could never work: the chip is known by then, so presenting the
// same one again would be ignored — exactly when the operator is trying hardest.
test('a sighting goes stale, and presenting the same chip again is seen afresh', async () => {
  const { db } = require('../server/db');
  const auth = { Authorization: `Bearer ${organizer.token}` };
  const reader = (await request(app).post(`/api/contests/${contestId}/readers`).set(auth)
    .send({ name: 'Mat4' })).body;
  const epc = pad('AC');
  const within = async (secs) => (await request(app)
    .get(`/api/contests/${contestId}/chip-sightings?within=${secs}`).set(auth))
    .body.sightings.map((s) => s.epc);

  await request(app).post('/api/ingest/seen').set('X-Reader-Token', reader.token).send({ epcs: [epc] });
  assert.ok((await within(5)).includes(epc), 'just presented');

  // Age it past the window, as it would be a minute after a failed attempt.
  db.prepare("UPDATE chip_sightings SET seen_at = datetime('now','-30 seconds') WHERE contest_id = ? AND epc = ?")
    .run(contestId, epc);
  assert.ok(!(await within(5)).includes(epc), 'no longer counts as being presented');
  assert.ok((await within(3600)).includes(epc), 'but the row is still there');

  // The retry: the same chip, waved again.
  await request(app).post('/api/ingest/seen').set('X-Reader-Token', reader.token).send({ epcs: [epc] });
  assert.ok((await within(5)).includes(epc), 'seen afresh, so a retry binds');
});

// Reported from the field: adding a NEW racer with an existing racer's chip id
// replaced that racer — and the bot still answered "✅ Added". /add does not go
// through the chips endpoint, so the earlier chip-safety work did not cover it.
test('/add refuses a chip that belongs to someone, instead of replacing them', async () => {
  const auth = { Authorization: `Bearer ${organizer.token}` };
  await text(ALLOWED, `/use ${contestId}`);
  await text(ALLOWED, `/add bib=950 name=Original Rider cat=M40 epc=${pad('D5')}`);

  send.reset();
  await text(ALLOWED, `/add bib=951 name=Impostor cat=M40 epc=${pad('D5')}`);
  const msg = send.last('message').text;
  assert.match(msg, /already on/i);
  assert.ok(msg.includes('950') && /Original Rider/.test(msg), 'names who holds it');
  assert.ok(!/Added/.test(msg), 'and does not claim success');

  const tags = (await request(app).get(`/api/contests/${contestId}/tags`).set(auth)).body.tags;
  const held = tags.find((t) => (t.epcs || [t.epc]).includes(pad('D5')));
  assert.equal(held.bib, '950', 'the chip stayed with its owner');
  assert.equal(held.participant, 'Original Rider');
  assert.ok(!tags.some((t) => String(t.bib) === '951'), 'and the impostor was not created');
});

// The same disappearance through another door, with no chip id involved: /add
// with a bib that exists derives the SAME synthetic chip from it and collided.
test('/add refuses a bib that already exists', async () => {
  const auth = { Authorization: `Bearer ${organizer.token}` };
  await text(ALLOWED, '/add bib=960 name=First Holder cat=M40');
  send.reset();
  await text(ALLOWED, '/add bib=960 name=Second Person cat=M50');
  const msg = send.last('message').text;
  assert.match(msg, /already/i);
  assert.ok(/First Holder/.test(msg), 'names who has the bib');

  const tags = (await request(app).get(`/api/contests/${contestId}/tags`).set(auth)).body.tags;
  const row = tags.find((t) => String(t.bib) === '960');
  assert.equal(row.participant, 'First Holder', 'the original is untouched');
  assert.equal(tags.filter((t) => String(t.bib) === '960').length, 1);
});

// Re-saving an existing racer must still work — that is what the web Manage
// tab and a corrected CSV re-import do, and expect_new is not set there.
test('re-saving an existing assignment is still an update, not a collision', async () => {
  const auth = { Authorization: `Bearer ${organizer.token}` };
  const res = await request(app).post(`/api/contests/${contestId}/tags`).set(auth)
    .send({ epc: pad('D5'), bib: '950', participant: 'Original Rider', category: 'M45' });
  assert.ok(res.status < 300, `re-save should succeed, got ${res.status} ${JSON.stringify(res.body)}`);
  const tags = (await request(app).get(`/api/contests/${contestId}/tags`).set(auth)).body.tags;
  assert.equal(tags.find((t) => String(t.bib) === '950').category, 'M45', 'the edit landed');
});

// These chips are a short number padded to 24 — 000000000000000000009866 is
// "9866" — so the full form is a wall of zeros around the part that matters.
test('chips are shown short, and the short form is what can be typed back', async () => {
  const auth = { Authorization: `Bearer ${organizer.token}` };
  await text(ALLOWED, `/use ${contestId}`);
  await text(ALLOWED, `/add bib=970 name=Short Chip cat=M40 epc=${pad('9866')}`);

  send.reset();
  await text(ALLOWED, '/list 970');
  const listed = send.last('message').text;
  assert.match(listed, /9866/, 'the chip is visible at last');
  assert.ok(!/000000000000000000009866/.test(listed), 'without the padding');

  // And typing that same short form addresses the same chip.
  send.reset();
  await text(ALLOWED, '/chip 970 9867');
  assert.match(send.last('message').text, /chip replaced/i);
  const tags = (await request(app).get(`/api/contests/${contestId}/tags`).set(auth)).body.tags;
  assert.deepEqual(tags.find((t) => String(t.bib) === '970').epcs, [pad('9867')]);
});

// A chip that is not mostly padding cannot be typed short, so it is shown as a
// tail behind an ellipsis rather than pretending otherwise.
test('a real random EPC is shown as a tail, not as a typeable number', async () => {
  await text(ALLOWED, '/add bib=971 name=Random Chip cat=M40 epc=E28011606000020000A1B2');
  send.reset();
  await text(ALLOWED, '/list 971');
  const listed = send.last('message').text;
  assert.match(listed, /…/, 'marked as not typeable');
  assert.match(listed, /0A1B2/, 'with enough of the tail to recognise it');
});

// The point of the whole thing: bib in, chip out, new number in — two messages.
test('/chip <bib> shows the chip and takes the new number as the next message', async () => {
  const auth = { Authorization: `Bearer ${organizer.token}` };
  send.reset();
  await text(ALLOWED, '/chip 970');
  const prompt = send.last('message').text;
  assert.match(prompt, /9867/, 'shows what they carry now');
  assert.ok(!/000000000000000000009867/.test(prompt), 'short, not padded');
  assert.match(prompt, /send its number/i, 'and offers typing as well as waving');

  send.reset();
  await text(ALLOWED, '9912');          // just the number, no command
  assert.match(send.last('message').text, /chip replaced/i);
  const tags = (await request(app).get(`/api/contests/${contestId}/tags`).set(auth)).body.tags;
  assert.deepEqual(tags.find((t) => String(t.bib) === '970').epcs, [pad('9912')]);
});

// Typing a number must stop the scan that is still running, or it could bind a
// chip afterwards over the one the operator just settled on.
test('a typed number ends the scan instead of racing it', async () => {
  const auth = { Authorization: `Bearer ${organizer.token}` };
  const reader = (await request(app).post(`/api/contests/${contestId}/readers`).set(auth)
    .send({ name: 'Mat5' })).body;
  await text(ALLOWED, '/chip 970');
  await text(ALLOWED, '9001');           // settled by typing
  send.reset();

  // A chip waved a moment later must NOT overwrite that.
  await request(app).post('/api/ingest/seen').set('X-Reader-Token', reader.token)
    .send({ epcs: [pad('BEEF')] });
  await new Promise((r) => setTimeout(r, 4000));
  const tags = (await request(app).get(`/api/contests/${contestId}/tags`).set(auth)).body.tags;
  assert.deepEqual(tags.find((t) => String(t.bib) === '970').epcs, [pad('9001')],
    'the typed chip stands');
});

test('a typo keeps the chip prompt open instead of dropping out of it', async () => {
  const auth = { Authorization: `Bearer ${organizer.token}` };
  await text(ALLOWED, '/chip 970');
  send.reset();

  await text(ALLOWED, 'ok');  // a fat-fingered reply, not a chip
  const warn = send.last('message').text;
  assert.match(warn, /not a chip number/, 'it says what went wrong');
  assert.doesNotMatch(warn, /✅/, 'and nothing was assigned');

  // Still in the flow: the next message is taken as the chip, with no re-/chip.
  send.reset();
  await text(ALLOWED, '9123');
  assert.match(send.last('message').text, /✅/, 'the retry lands');
  const tags = (await request(app).get(`/api/contests/${contestId}/tags`).set(auth)).body.tags;
  assert.deepEqual(tags.find((t) => String(t.bib) === '970').epcs, [pad('9123')]);
});

test('/cancel stops the scan, so a later chip is not bound', async () => {
  const auth = { Authorization: `Bearer ${organizer.token}` };
  const reader = (await request(app).post(`/api/contests/${contestId}/readers`).set(auth)
    .send({ name: 'Mat6' })).body;
  await text(ALLOWED, '/chip 970');
  await text(ALLOWED, '/cancel');
  send.reset();

  await request(app).post('/api/ingest/seen').set('X-Reader-Token', reader.token)
    .send({ epcs: [pad('C0DE')] });
  await new Promise((r) => setTimeout(r, 4000));
  const tags = (await request(app).get(`/api/contests/${contestId}/tags`).set(auth)).body.tags;
  assert.deepEqual(tags.find((t) => String(t.bib) === '970').epcs, [pad('9123')],
    'the cancelled scan bound nothing');
  assert.equal(send.calls.filter((c) => c.type === 'message' && /✅/.test(c.text)).length, 0);
});

test('✏️ Edit asks for the bib, then opens the field picker', async () => {
  send.reset();
  await text(ALLOWED, '✏️ Edit');          // the keyboard button, not /edit 970
  assert.match(send.last('message').text, /bib number/, 'it asks instead of printing usage');

  // A wrong number keeps the prompt: tapping ✏️ again would be the alternative.
  send.reset();
  await text(ALLOWED, '99999');
  assert.match(send.last('message').text, /No racer matches/);
  assert.equal(send.last('message').extra, undefined, 'no picker for a miss');

  send.reset();
  await text(ALLOWED, '970');
  const picker = JSON.stringify(send.last('message').extra.reply_markup);
  assert.ok(picker.includes('ef:970:category'), 'the field picker opens');
  assert.ok(picker.includes('ef:970:epc'), 'including the chip');
});

test('the bib prompt also takes a name, and asks which when several match', async () => {
  const auth = { Authorization: `Bearer ${organizer.token}` };
  for (const [bib, name] of [[981, 'Dana Levi'], [982, 'Dana Cohen']]) {
    await request(app).post(`/api/contests/${contestId}/tags`).set(auth)
      .send({ epc: pad(bib), bib: String(bib), participant: name });
  }

  send.reset();
  await text(ALLOWED, '✏️ Edit');
  await text(ALLOWED, 'dana');             // lower case, partial
  const rows = send.last('message').extra.reply_markup.inline_keyboard;
  const data = rows.flat().map((b) => b.callback_data);
  assert.deepEqual(data.sort(), ['eb:981', 'eb:982'], 'both Danas are offered');

  send.reset();
  await tap(ALLOWED, 'eb:982');
  assert.match(send.last('message').text, /Dana Cohen/);
  assert.ok(JSON.stringify(send.last('message').extra.reply_markup).includes('ef:982:category'));

  // A name that is unique skips the picking step entirely.
  send.reset();
  await text(ALLOWED, '✏️ Edit');
  await text(ALLOWED, 'Levi');
  assert.match(send.last('message').text, /Dana Levi/);
  assert.ok(JSON.stringify(send.last('message').extra.reply_markup).includes('ef:981:'));
});

test('the picker comes back after a save, so a second field needs no /edit', async () => {
  send.reset();
  await tap(ALLOWED, 'ef:981:gender');
  await tap(ALLOWED, 'ev:981:gender:Female');
  const msgs = send.calls.filter((c) => c.type === 'message').map((c) => c.text);
  assert.ok(msgs.some((t) => /✅ Saved/.test(t)), 'it saved');
  const last = send.last('message');
  assert.match(last.text, /Still editing/, 'and offers the next field');
  assert.ok(JSON.stringify(last.extra.reply_markup).includes('ef:981:category'));
});

test('the Chip button hands over to /chip instead of asking for 24 characters', async () => {
  send.reset();
  await tap(ALLOWED, 'ef:981:epc');
  const msg = send.last('message').text;
  assert.match(msg, /Hold the new chip to the reader/, 'the scan is offered');
  assert.match(msg, /9866/, 'and the short typed form');
  assert.doesNotMatch(msg, /Send the new Chip/, 'not the old type-it-out prompt');

  // And it is a real /chip flow: the typed short number binds.
  send.reset();
  await text(ALLOWED, '9871');
  assert.match(send.last('message').text, /✅/);
  const tags = (await request(app).get(`/api/contests/${contestId}/tags`)
    .set({ Authorization: `Bearer ${organizer.token}` })).body.tags;
  assert.deepEqual(tags.find((t) => String(t.bib) === '981').epcs, [pad('9871')]);
});

test('a scan that finds nothing says WHY: the app never reported to this race', async () => {
  const auth = { Authorization: `Bearer ${organizer.token}` };
  const made = await request(app).post('/api/contests').set(auth)
    .send({ kind: 'race', title: 'Diagnosis race', start_at: past, end_at: future });
  assert.equal(made.status, 201);
  const fresh = made.body;
  await request(app).post(`/api/contests/${fresh.id}/tags`).set(auth)
    .send({ epc: pad('7001'), bib: '701', participant: 'Nobody Reads' });
  await text(ALLOWED, `/use ${fresh.id}`);

  send.reset();
  await text(ALLOWED, '/chip 701');
  await new Promise((r) => setTimeout(r, 47000));
  const msg = send.last('message').text;
  assert.match(msg, /never<\/b> reported to this race/, 'it names the actual fault');
  assert.doesNotMatch(msg, /gone quiet|reported no chip/, 'and not a fault that does not apply');
});

test('a scan that saw the racer\'s own chip says so instead of blaming the reader', async () => {
  const auth = { Authorization: `Bearer ${organizer.token}` };
  const made = await request(app).post('/api/contests').set(auth)
    .send({ kind: 'race', title: 'Own chip race', start_at: past, end_at: future });
  assert.equal(made.status, 201);
  const c = made.body;
  const reader = (await request(app).post(`/api/contests/${c.id}/readers`).set(auth)
    .send({ name: 'Mat7' })).body;
  await request(app).post(`/api/contests/${c.id}/tags`).set(auth)
    .send({ epc: pad('8601'), bib: '86', participant: 'Danon Nisan' });
  await text(ALLOWED, `/use ${c.id}`);

  send.reset();
  await text(ALLOWED, '/chip 86');
  // The operator holds up the tag the racer is already wearing.
  await new Promise((r) => setTimeout(r, 3000));
  await request(app).post('/api/ingest/reads').set('X-Reader-Token', reader.token)
    .send({ reads: [{ epc: pad('8601'), read_at: new Date().toISOString() }] });

  await new Promise((r) => setTimeout(r, 45000));
  const msg = send.last('message').text;
  assert.match(msg, /already this racer's own chip/, 'it recognises the tag in hand');
  assert.doesNotMatch(msg, /No reader has joined/);
});

test('the add wizard offers the race\'s distances, and the button is an index', async () => {
  const auth = { Authorization: `Bearer ${organizer.token}` };
  const made = await request(app).post('/api/contests').set(auth)
    .send({ kind: 'race', title: 'Distance race', start_at: past, end_at: future });
  assert.equal(made.status, 201);
  const c = made.body;
  // A race knows its distances by using them. Hebrew on purpose: a name in
  // callback_data is two bytes a character and is what broke the wave picker.
  await request(app).post(`/api/contests/${c.id}/tags`).set(auth)
    .send({ epc: pad('5001'), bib: '500', participant: 'Seed', distance: 'מקצה אופני הרים ארוך' });
  await text(ALLOWED, `/use ${c.id}`);

  await text(ALLOWED, '/add');
  await text(ALLOWED, '501');            // bib
  await text(ALLOWED, 'Noa Bar');        // name
  send.reset();
  await text(ALLOWED, 'M40');            // category -> the distance step
  const rows = send.last('message').extra.reply_markup.inline_keyboard;
  const data = rows.flat().map((b) => b.callback_data);
  assert.ok(data.includes('addd:0'), 'the known distance is offered by index');
  assert.ok(!data.some((d) => /מקצה/.test(d)), 'never the name itself');
  assert.match(send.last('message').text, /Tap one, type a new one/);

  send.reset();
  await tap(ALLOWED, 'addd:0');
  await tap(ALLOWED, 'addg:');           // gender skip
  await text(ALLOWED, '/skip');          // team
  await tap(ALLOWED, 'addw:');           // wave skip
  await text(ALLOWED, '/skip');          // chip -> derived from the bib

  const added = send.last('message').text;
  assert.match(added, /✅ Added/);
  assert.match(added, /מקצה אופני הרים ארוך/, 'the picked distance is confirmed back');
  assert.doesNotMatch(added, /no distance/, 'and no warning, since it has one');

  const tags = (await request(app).get(`/api/contests/${c.id}/tags`).set(auth)).body.tags;
  assert.equal(tags.find((t) => String(t.bib) === '501').distance, 'מקצה אופני הרים ארוך');
});

test('a racer saved with no distance is flagged, because no lap target can apply', async () => {
  const auth = { Authorization: `Bearer ${organizer.token}` };
  send.reset();
  await text(ALLOWED, '/add');
  await text(ALLOWED, '502');
  await text(ALLOWED, 'Blank Distance');
  await text(ALLOWED, '/skip');          // category
  await tap(ALLOWED, 'addd:');           // distance: Skip
  await tap(ALLOWED, 'addg:');
  await text(ALLOWED, '/skip');          // team
  await tap(ALLOWED, 'addw:');
  await text(ALLOWED, '/skip');          // chip

  const msgs = send.calls.filter((m) => m.type === 'message').map((m) => m.text);
  assert.ok(msgs.some((t) => /✅ Added/.test(t)), 'it still saved — this is a warning, not a refusal');
  const warn = msgs.find((t) => /no distance/.test(t));
  assert.ok(warn, 'the blank is called out at once, not left for the start list');
  assert.match(warn, /no lap target applies/);
  assert.match(warn, /מקצה אופני הרים ארוך/, 'and it lists what the race uses');
});

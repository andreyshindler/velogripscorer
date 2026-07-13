'use strict';

// Telegram start-list bot.
//
// A thin Telegram front-end over the app's own HTTP API: it lets ONE trusted
// operator (allowlisted by Telegram user id) browse a race's start list and
// add / edit / delete racers and pull the results CSV — the same operations the
// web "Manage" tab performs. All writes go through the organizer-only /api
// endpoints (reusing their validation, two-chip sync and audit logging); the
// bot authenticates as the admin account.
//
// The message-handling core (createBotCore/handleUpdate) is IO-free and unit
// tested by injecting a fake `send` and a supertest-backed `api`. The transport
// (startBot) does the real long-poll loop and only runs when TELEGRAM_BOT_TOKEN
// is set, so tests and default deployments never spin it up.

const { db } = require('./db');
const { signToken } = require('./auth');
const { getContest, isOrganizer } = require('./routes/contests');

const EPC_RE = /^[0-9A-Fa-f]{4,64}$/;
const FIELD_LABELS = {
  participant: 'Name', bib: 'Bib', category: 'Category', distance: 'Distance',
  team: 'Team', gender: 'Gender', racer_status: 'Status',
};

// ---------- access gate ----------

function allowedIds() {
  return new Set(String(process.env.TELEGRAM_ALLOWED_USER_IDS || '')
    .split(',').map((s) => s.trim()).filter(Boolean));
}
function isAllowed(userId) {
  const ids = allowedIds();
  return ids.size > 0 && ids.has(String(userId));
}

// The bot acts as the admin account (admins are organizers of every race).
function actingUser() {
  const email = (process.env.ADMIN_EMAIL || '').toLowerCase();
  return (email && db.prepare("SELECT * FROM users WHERE email = ? AND role = 'admin'").get(email))
    || db.prepare("SELECT * FROM users WHERE role = 'admin' ORDER BY id LIMIT 1").get()
    || null;
}

// ---------- session store ----------

function getSession(chatId) {
  const row = db.prepare('SELECT * FROM telegram_sessions WHERE chat_id = ?').get(String(chatId));
  return row || { chat_id: String(chatId), active_contest_id: null, state: '' };
}
function saveSession(chatId, { active_contest_id, state }) {
  db.prepare(
    `INSERT INTO telegram_sessions (chat_id, active_contest_id, state, updated_at)
     VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT (chat_id) DO UPDATE SET active_contest_id = excluded.active_contest_id,
       state = excluded.state, updated_at = excluded.updated_at`
  ).run(String(chatId), active_contest_id ?? null, state || '');
}
function setActive(chatId, contestId) {
  const s = getSession(chatId);
  saveSession(chatId, { active_contest_id: contestId, state: s.state });
}
function setState(chatId, stateObj) {
  const s = getSession(chatId);
  saveSession(chatId, { active_contest_id: s.active_contest_id, state: stateObj ? JSON.stringify(stateObj) : '' });
}
function getState(chatId) {
  const s = getSession(chatId);
  try { return s.state ? JSON.parse(s.state) : null; } catch { return null; }
}

// ---------- small helpers ----------

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function kb(rows) { return { inline_keyboard: rows }; }
function btn(text, data) { return { text, callback_data: data }; }

function normGender(raw) {
  const s = String(raw || '').trim().toLowerCase();
  if (['m', 'male', 'man', 'boy', 'זכר', 'גבר'].includes(s)) return 'Male';
  if (['f', 'female', 'woman', 'girl', 'נקבה', 'אישה'].includes(s)) return 'Female';
  return String(raw || '').trim();
}
function normStatus(raw) {
  const s = String(raw || '').trim().toUpperCase();
  return ['DNS', 'DNF', 'DSQ'].includes(s) ? s : '';
}
function syntheticEpc(bib) {
  return ('AA' + String(bib).padStart(4, '0')).toUpperCase();
}

// Parse "bib=101 name=Jane Doe cat=M40 dist=10k team=Aces gender=F" — values may
// contain spaces; a new token starts only at a known "key=".
function parseFields(str) {
  const KEYS = ['bib', 'name', 'participant', 'cat', 'category', 'dist', 'distance', 'team', 'gender', 'epc', 'status', 'wave'];
  const re = new RegExp(`(?:^|\\s)(${KEYS.join('|')})=`, 'gi');
  const toks = [];
  let m;
  while ((m = re.exec(str))) toks.push({ key: m[1].toLowerCase(), vStart: m.index + m[0].length, mStart: m.index });
  const out = {};
  for (let i = 0; i < toks.length; i++) {
    const end = i + 1 < toks.length ? toks[i + 1].mStart : str.length;
    let key = toks[i].key;
    if (key === 'cat') key = 'category';
    if (key === 'dist') key = 'distance';
    if (key === 'name') key = 'participant';
    if (key === 'status') key = 'racer_status';
    out[key] = str.slice(toks[i].vStart, end).trim();
  }
  return out;
}

function racerLine(r) {
  const bits = [`#${esc(r.bib || '?')}`, esc(r.participant)];
  const tail = [r.category, r.distance, r.gender].filter(Boolean).map(esc).join(' · ');
  if (tail) bits.push(`<i>${tail}</i>`);
  if (r.racer_status) bits.push(`[${esc(r.racer_status)}]`);
  return bits.join(' — ');
}

const HELP = [
  '<b>VeloGrip start-list bot</b>',
  '',
  '/races [text] — pick a race to manage',
  '/list [text] — show racers (optionally filtered)',
  '/add — add a racer (guided), or one line:',
  '   <code>/add bib=101 name=Jane Doe cat=M40 dist=10k gender=F team=Aces</code>',
  '/edit &lt;bib&gt; — edit a racer (buttons), or:',
  '   <code>/edit 101 name=New Name cat=M45</code>',
  '/del &lt;bib&gt; — remove a racer',
  '/csv — download the results CSV',
  '/whoami — show your Telegram id',
  '/cancel — abort the current step',
].join('\n');

// ---------- core (IO injected) ----------

function createBotCore({ api, send }) {
  const token = () => {
    const u = actingUser();
    return u ? signToken(u) : null;
  };
  const A = (method, path, body) => api(method, path, { token: token(), body });

  async function activeContest(chatId) {
    const id = getSession(chatId).active_contest_id;
    if (!id) return null;
    const c = getContest(id);
    if (!c || !isOrganizer(c, actingUser())) return null;
    return c;
  }
  const needRace = async (chatId) => {
    const c = await activeContest(chatId);
    if (!c) { await send.message(chatId, 'No race selected. Use /races to pick one.'); return null; }
    return c;
  };

  async function listRacers(contestId) {
    const res = await A('GET', `/contests/${contestId}/tags`);
    return (res.json && res.json.tags) || [];
  }
  const findRacer = (racers, bib) => racers.find((r) => String(r.bib) === String(bib));

  // Upsert a racer object (must carry epc, and epc2 for two-chip) via the API.
  async function upsertRacer(contestId, r) {
    const body = {
      epc: (r.epcs && r.epcs[0]) || r.epc,
      epc2: (r.epcs && r.epcs[1]) || '',
      bib: r.bib || '', participant: r.participant || '',
      category: r.category || '', distance: r.distance || '',
      team: r.team || '', gender: r.gender || '',
      racer_status: r.racer_status || '', wave_id: r.wave_id || null,
    };
    return A('POST', `/contests/${contestId}/tags`, body);
  }

  // ---- commands ----

  async function cmdRaces(chatId, query) {
    const q = String(query || '').trim().toLowerCase();
    let rows = db.prepare("SELECT id, title, status FROM contests WHERE kind = 'race' ORDER BY datetime(start_at) DESC LIMIT 60").all();
    if (q) rows = rows.filter((r) => String(r.title).toLowerCase().includes(q));
    if (!rows.length) { await send.message(chatId, 'No races found.'); return; }
    const buttons = rows.slice(0, 20).map((r) => [btn(`${r.title} (${r.status})`.slice(0, 60), `use:${r.id}`)]);
    await send.message(chatId, 'Pick a race:', { reply_markup: kb(buttons) });
  }

  async function useRace(chatId, id) {
    const c = getContest(id);
    if (!c || !isOrganizer(c, actingUser())) { await send.message(chatId, 'Race not found.'); return; }
    setActive(chatId, c.id);
    const racers = await listRacers(c.id);
    await send.message(chatId, `✅ Managing <b>${esc(c.title)}</b> — ${racers.length} racer(s).\nUse /list, /add, /edit, /del, /csv.`);
  }

  async function cmdList(chatId, query) {
    const c = await needRace(chatId);
    if (!c) return;
    const q = String(query || '').trim().toLowerCase();
    let racers = await listRacers(c.id);
    if (q) racers = racers.filter((r) => `${r.bib} ${r.participant} ${r.category} ${r.team}`.toLowerCase().includes(q));
    if (!racers.length) { await send.message(chatId, q ? 'No matching racers.' : 'This race has no racers yet. Use /add.'); return; }
    // Small result sets get per-racer edit/delete buttons; large ones a text list.
    if (racers.length <= 8) {
      for (const r of racers) {
        await send.message(chatId, racerLine(r), {
          reply_markup: kb([[btn('✏️ Edit', `edit:${r.bib}`), btn('🗑 Delete', `del:${r.bib}`)]]),
        });
      }
      return;
    }
    const lines = racers.slice(0, 60).map(racerLine);
    const more = racers.length > 60 ? `\n… and ${racers.length - 60} more (filter with /list <text>).` : '';
    await send.message(chatId, `<b>${racers.length} racers</b>\n${lines.join('\n')}${more}`);
  }

  async function createRacer(chatId, contestId, f) {
    const bib = String(f.bib || '').trim();
    const participant = String(f.participant || '').trim();
    if (!participant) { await send.message(chatId, '⚠️ A name is required.'); return; }
    let epc = String(f.epc || '').trim().toUpperCase();
    if (!epc) {
      if (!bib) { await send.message(chatId, '⚠️ Provide a bib or a chip EPC.'); return; }
      epc = syntheticEpc(bib);
    }
    if (!EPC_RE.test(epc)) { await send.message(chatId, '⚠️ Chip EPC must be 4–64 hex chars (or omit it and give a numeric bib).'); return; }
    const res = await upsertRacer(contestId, {
      epc, bib, participant,
      category: f.category || '', distance: f.distance || '', team: f.team || '',
      gender: normGender(f.gender), racer_status: normStatus(f.racer_status),
    });
    if (res.status >= 400) { await send.message(chatId, `⚠️ ${esc((res.json && res.json.error) || 'could not add racer')}`); return; }
    await send.message(chatId, `✅ Added #${esc(bib)} ${esc(participant)}.`);
  }

  async function cmdAdd(chatId, rest) {
    const c = await needRace(chatId);
    if (!c) return;
    if (rest && rest.trim()) { await createRacer(chatId, c.id, parseFields(rest)); return; }
    setState(chatId, { flow: 'add', step: 'bib', data: {} });
    await send.message(chatId, 'Add a racer. Send the <b>bib number</b> (or /cancel):');
  }

  async function cmdEdit(chatId, rest) {
    const c = await needRace(chatId);
    if (!c) return;
    const trimmed = String(rest || '').trim();
    const bib = trimmed.split(/\s+/)[0];
    if (!bib) { await send.message(chatId, 'Usage: /edit <bib>'); return; }
    const racers = await listRacers(c.id);
    const r = findRacer(racers, bib);
    if (!r) { await send.message(chatId, `No racer with bib #${esc(bib)}.`); return; }
    const fields = parseFields(trimmed.slice(bib.length));
    if (Object.keys(fields).length) { await applyEdit(chatId, c.id, r, fields); return; }
    await send.message(chatId, `Editing ${racerLine(r)}\nChoose a field:`, {
      reply_markup: kb([
        [btn('Name', `ef:${bib}:participant`), btn('Bib', `ef:${bib}:bib`)],
        [btn('Category', `ef:${bib}:category`), btn('Distance', `ef:${bib}:distance`)],
        [btn('Team', `ef:${bib}:team`), btn('Gender', `ef:${bib}:gender`)],
        [btn('Status', `ef:${bib}:racer_status`), btn('🗑 Delete', `del:${bib}`)],
      ]),
    });
  }

  // Merge changed fields into the racer and persist. Handles the synthetic-EPC
  // bib rename (the chip id is derived from the bib) the way Manage does.
  async function applyEdit(chatId, contestId, racer, fields) {
    const merged = { ...racer };
    for (const [k, v] of Object.entries(fields)) {
      if (k === 'gender') merged.gender = normGender(v);
      else if (k === 'racer_status') merged.racer_status = normStatus(v);
      else merged[k] = v;
    }
    const oldBib = String(racer.bib || '');
    const newBib = String(merged.bib || '');
    const primaryEpc = (racer.epcs && racer.epcs[0]) || racer.epc;
    const wasSynthetic = primaryEpc === syntheticEpc(oldBib);
    if (newBib !== oldBib && wasSynthetic && !(racer.epcs && racer.epcs[1])) {
      // rebuild the derived chip id, then drop the old row
      const res = await upsertRacer(contestId, { ...merged, epcs: undefined, epc: syntheticEpc(newBib) });
      if (res.status < 400) await A('DELETE', `/contests/${contestId}/tags/${primaryEpc}`);
      await report(chatId, res, merged);
      return;
    }
    const res = await upsertRacer(contestId, merged);
    await report(chatId, res, merged);
  }
  async function report(chatId, res, r) {
    if (res.status >= 400) { await send.message(chatId, `⚠️ ${esc((res.json && res.json.error) || 'update failed')}`); return; }
    await send.message(chatId, `✅ Saved ${racerLine(r)}`);
  }

  async function cmdDel(chatId, rest) {
    const c = await needRace(chatId);
    if (!c) return;
    const bib = String(rest || '').trim().split(/\s+/)[0];
    if (!bib) { await send.message(chatId, 'Usage: /del <bib>'); return; }
    const r = findRacer(await listRacers(c.id), bib);
    if (!r) { await send.message(chatId, `No racer with bib #${esc(bib)}.`); return; }
    await send.message(chatId, `Delete ${racerLine(r)}?`, {
      reply_markup: kb([[btn('🗑 Yes, delete', `delyes:${bib}`), btn('Cancel', 'delno')]]),
    });
  }
  async function doDelete(chatId, bib) {
    const c = await needRace(chatId);
    if (!c) return;
    const r = findRacer(await listRacers(c.id), bib);
    if (!r) { await send.message(chatId, `No racer with bib #${esc(bib)}.`); return; }
    const epc = (r.epcs && r.epcs[0]) || r.epc;
    const res = await A('DELETE', `/contests/${c.id}/tags/${epc}`);
    if (res.status >= 400) { await send.message(chatId, '⚠️ Delete failed.'); return; }
    await send.message(chatId, `🗑 Deleted #${esc(bib)} ${esc(r.participant)}.`);
  }

  async function cmdCsv(chatId) {
    const c = await needRace(chatId);
    if (!c) return;
    const res = await A('GET', `/contests/${c.id}/race-results?format=csv`);
    if (res.status >= 400) { await send.message(chatId, '⚠️ Could not build the CSV.'); return; }
    await send.document(chatId, `race-results-${c.id}.csv`, res.text, `${c.title} — results`);
  }

  // ---- wizard (guided /add) ----

  const ADD_STEPS = ['bib', 'participant', 'category', 'distance', 'gender', 'team'];
  const ADD_PROMPT = {
    participant: 'Name?', category: 'Category? (or /skip)', distance: 'Distance? (or /skip)',
    team: 'Team? (or /skip)',
  };
  async function wizardStep(chatId, st, value) {
    const step = st.step;
    if (step !== 'gender') st.data[step] = value; // gender comes from a button
    const next = ADD_STEPS[ADD_STEPS.indexOf(step) + 1];
    if (!next) return finishAdd(chatId, st);
    st.step = next;
    setState(chatId, st);
    if (next === 'gender') {
      await send.message(chatId, 'Gender?', {
        reply_markup: kb([[btn('Male', 'addg:Male'), btn('Female', 'addg:Female'), btn('Skip', 'addg:')]]),
      });
      return undefined;
    }
    return send.message(chatId, ADD_PROMPT[next]);
  }
  async function finishAdd(chatId, st) {
    setState(chatId, null);
    const c = await activeContest(chatId);
    if (!c) { await send.message(chatId, 'Race no longer selected. Use /races.'); return; }
    await createRacer(chatId, c.id, st.data);
  }

  // ---- routing ----

  async function handleText(chatId, text) {
    const st = getState(chatId);
    if (text === '/cancel') { setState(chatId, null); await send.message(chatId, 'Cancelled.'); return; }
    // In a wizard and the user typed a value (not a new command)
    if (st && st.flow === 'add' && !text.startsWith('/')) { await wizardStep(chatId, st, text); return; }
    if (st && st.flow === 'add' && text === '/skip') { await wizardStep(chatId, st, ''); return; }
    if (st && st.flow === 'editval' && !text.startsWith('/')) {
      const c = await activeContest(chatId);
      setState(chatId, null);
      if (!c) { await send.message(chatId, 'Race no longer selected.'); return; }
      const r = findRacer(await listRacers(c.id), st.bib);
      if (!r) { await send.message(chatId, `No racer with bib #${esc(st.bib)}.`); return; }
      await applyEdit(chatId, c.id, r, { [st.field]: text });
      return;
    }

    const [cmdRaw, ...restParts] = text.split(/\s+/);
    const cmd = cmdRaw.toLowerCase().replace(/@.*$/, ''); // strip @botname
    const rest = text.slice(cmdRaw.length).trim();
    switch (cmd) {
      case '/start':
      case '/help': return send.message(chatId, HELP);
      case '/whoami': return; // handled earlier with sender id; see handleUpdate
      case '/races': return cmdRaces(chatId, rest);
      case '/use': return useRace(chatId, restParts[0]);
      case '/list': return cmdList(chatId, rest);
      case '/add': return cmdAdd(chatId, rest);
      case '/edit': return cmdEdit(chatId, rest);
      case '/del':
      case '/delete': return cmdDel(chatId, rest);
      case '/csv': return cmdCsv(chatId);
      default:
        return send.message(chatId, 'Unknown command. /help for the list.');
    }
  }

  async function handleCallback(chatId, cq) {
    const data = String(cq.data || '');
    await send.answerCallback(cq.id);
    const [tag, a, b] = data.split(':');
    if (tag === 'use') return useRace(chatId, a);
    if (tag === 'edit') return cmdEdit(chatId, a);
    if (tag === 'del') return cmdDel(chatId, a);
    if (tag === 'delyes') return doDelete(chatId, a);
    if (tag === 'delno') return send.message(chatId, 'Cancelled.');
    if (tag === 'ef') { // pick a field to edit
      const bib = a; const field = b;
      if (field === 'gender') {
        return send.message(chatId, 'Gender?', { reply_markup: kb([[
          btn('Male', `ev:${bib}:gender:Male`), btn('Female', `ev:${bib}:gender:Female`), btn('Clear', `ev:${bib}:gender:`)]]) });
      }
      if (field === 'racer_status') {
        return send.message(chatId, 'Status?', { reply_markup: kb([[
          btn('OK', `ev:${bib}:racer_status:`), btn('DNS', `ev:${bib}:racer_status:DNS`),
          btn('DNF', `ev:${bib}:racer_status:DNF`), btn('DSQ', `ev:${bib}:racer_status:DSQ`)]]) });
      }
      setState(chatId, { flow: 'editval', bib, field });
      return send.message(chatId, `Send the new ${FIELD_LABELS[field] || field} for #${esc(bib)}:`);
    }
    if (tag === 'ev') { // field value chosen from buttons
      const bib = a; const field = b; const value = data.split(':').slice(3).join(':');
      const c = await activeContest(chatId);
      if (!c) return send.message(chatId, 'Race no longer selected.');
      const r = findRacer(await listRacers(c.id), bib);
      if (!r) return send.message(chatId, `No racer with bib #${esc(bib)}.`);
      return applyEdit(chatId, c.id, r, { [field]: value });
    }
    if (tag === 'addg') { // gender chosen during the add wizard
      const st = getState(chatId);
      if (st && st.flow === 'add' && st.step === 'gender') { st.data.gender = a || ''; return wizardStep(chatId, st, a || ''); }
      return undefined;
    }
    return undefined;
  }

  async function handleUpdate(update) {
    const msg = update.message || update.edited_message;
    const cq = update.callback_query;
    const from = (msg && msg.from) || (cq && cq.from);
    const chat = (msg && msg.chat) || (cq && cq.message && cq.message.chat);
    if (!from || !chat) return;
    if (!isAllowed(from.id)) return; // silent for everyone but the allowlisted operator
    const chatId = chat.id;
    try {
      if (cq) return await handleCallback(chatId, cq);
      if (!msg.text) return;
      const t = msg.text.trim();
      if (t.toLowerCase().replace(/@.*$/, '') === '/whoami') {
        return await send.message(chatId, `Your Telegram id: <code>${esc(from.id)}</code>`);
      }
      return await handleText(chatId, t);
    } catch (err) {
      console.error('telegram handleUpdate error:', err);
      try { await send.message(chatId, '⚠️ Something went wrong.'); } catch { /* ignore */ }
    }
    return undefined;
  }

  return { handleUpdate };
}

// ---------- transport (real IO; only when enabled) ----------

function tgSender(botToken) {
  const base = `https://api.telegram.org/bot${botToken}`;
  const call = async (method, params) => {
    const res = await fetch(`${base}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(35000),
    });
    return res.json().catch(() => ({}));
  };
  return {
    call,
    message: (chatId, text, extra = {}) => call('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true, ...extra }),
    answerCallback: (id, text) => call('answerCallbackQuery', { callback_query_id: id, text: text || undefined }),
    async document(chatId, filename, content, caption) {
      const form = new FormData();
      form.append('chat_id', String(chatId));
      if (caption) form.append('caption', caption);
      form.append('document', new Blob([content], { type: 'text/csv' }), filename);
      const res = await fetch(`${base}/sendDocument`, { method: 'POST', body: form, signal: AbortSignal.timeout(35000) });
      return res.json().catch(() => ({}));
    },
  };
}

function localApi(apiBase) {
  return async (method, path, { token, body } = {}) => {
    const res = await fetch(`${apiBase}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15000),
    });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { /* non-JSON (CSV) */ }
    return { status: res.status, json, text };
  };
}

let started = false;
function startBot({ port, basePath } = {}) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken || started) return;
  started = true;
  if (allowedIds().size === 0) {
    console.warn('Telegram bot: TELEGRAM_ALLOWED_USER_IDS is empty — the bot will ignore every message until it is set.');
  }
  const apiBase = `http://127.0.0.1:${port || process.env.PORT || 3000}${basePath || ''}/api`;
  const send = tgSender(botToken);
  const core = createBotCore({ api: localApi(apiBase), send });

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  (async function poll() {
    await send.call('deleteWebhook', { drop_pending_updates: false }).catch(() => {});
    console.log('Telegram start-list bot started (long polling).');
    let offset = 0;
    for (;;) {
      try {
        const r = await send.call('getUpdates', { offset, timeout: 30 });
        for (const u of (r && r.result) || []) {
          offset = u.update_id + 1;
          core.handleUpdate(u).catch((e) => console.error('telegram update error:', e));
        }
      } catch (err) {
        await sleep(3000); // network hiccup; back off and retry
      }
    }
  })();
}

module.exports = { startBot, createBotCore };

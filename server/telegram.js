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

const { db, auditLog } = require('./db');
const { signToken } = require('./auth');
const { getContest, isOrganizer } = require('./routes/contests');
const { computeRaceResults } = require('./race-results');

const EPC_RE = /^[0-9A-Fa-f]{4,64}$/;
const FIELD_LABELS = {
  participant: 'Name', bib: 'Bib', category: 'Category', distance: 'Distance',
  team: 'Team', gender: 'Gender', racer_status: 'Status', wave: 'Wave', epc: 'Chip EPC',
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

// ---------- runner (self-service, approval-gated) store ----------
//
// A separate identity from telegram_sessions (the operator's per-chat state):
// runners live in the `runners` table so operator-only broadcasts never reach
// them. Status/bib together encode the flow — see db.js.

function getRunner(chatId) {
  return db.prepare('SELECT * FROM runners WHERE chat_id = ?').get(String(chatId)) || null;
}
function upsertRunner(chatId, fields) {
  const cur = getRunner(chatId) || { tg_user_id: '', tg_name: '', bib: '', league_id: null, status: 'pending' };
  const next = { ...cur, ...fields };
  db.prepare(
    `INSERT INTO runners (chat_id, tg_user_id, tg_name, bib, league_id, status)
     VALUES (@chat_id, @tg_user_id, @tg_name, @bib, @league_id, @status)
     ON CONFLICT(chat_id) DO UPDATE SET tg_user_id=excluded.tg_user_id, tg_name=excluded.tg_name,
       bib=excluded.bib, league_id=excluded.league_id, status=excluded.status`
  ).run({
    chat_id: String(chatId), tg_user_id: next.tg_user_id || '', tg_name: next.tg_name || '',
    bib: next.bib || '', league_id: next.league_id ?? null, status: next.status || 'pending',
  });
  return getRunner(chatId);
}
function setRunnerDecision(chatId, status, leagueId, adminId) {
  db.prepare(`UPDATE runners SET status=?, league_id=?, decided_at=datetime('now'), decided_by=? WHERE chat_id=?`)
    .run(status, leagueId ?? null, String(adminId || ''), String(chatId));
}

// Active leagues whose attached races include this bib -> [{id, name}].
function activeLeagueIdsForBib(bib) {
  return db.prepare(
    `SELECT DISTINCT l.id AS id, l.name AS name
       FROM league_races lr JOIN leagues l ON l.id = lr.league_id
       JOIN tag_assignments t ON t.contest_id = lr.contest_id
      WHERE l.status = 'active' AND TRIM(t.bib) = ?`
  ).all(String(bib).trim());
}
function runnerLeagueId(runner) {
  if (runner.league_id) return runner.league_id;
  const cands = activeLeagueIdsForBib(runner.bib);
  return cands.length ? cands[0].id : null;
}
// The most recent FINISHED race of a league (the runner's "current race").
function latestFinishedRace(leagueId) {
  return db.prepare(
    `SELECT c.* FROM league_races lr JOIN contests c ON c.id = lr.contest_id
      WHERE lr.league_id = ? AND c.status = 'finished'
      ORDER BY lr.round DESC, datetime(c.start_at) DESC LIMIT 1`
  ).get(leagueId) || null;
}
function leagueRaceRows(leagueId) {
  return db.prepare(
    `SELECT lr.round, c.id AS contest_id, c.title, c.start_at, c.end_at, c.status
       FROM league_races lr JOIN contests c ON c.id = lr.contest_id
      WHERE lr.league_id = ? ORDER BY lr.round, datetime(c.start_at)`
  ).all(leagueId);
}
function leagueName(id) {
  const l = db.prepare('SELECT name FROM leagues WHERE id = ?').get(id);
  return l ? l.name : '';
}
function adminChatIds() { return [...allowedIds()]; }

function displayName(from) {
  return [from.first_name, from.last_name].filter(Boolean).join(' ') || from.username || String(from.id);
}
function fmtWhen(iso) {
  return new Date(iso).toLocaleString('he-IL',
    { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
}
function fmtDate(iso) {
  return new Date(iso).toLocaleDateString('he-IL', { day: 'numeric', month: 'long', year: 'numeric' });
}
function raceStatusLabel(r) {
  if (r.status === 'finished') return 'הסתיים';
  const now = Date.now();
  const s = Date.parse(r.start_at), e = r.end_at ? Date.parse(r.end_at) : s;
  if (now >= s && now <= e) return 'במהלך המרוץ';
  if (now < s) return 'מתוכנן';
  return 'ממתין לתוצאות';
}

// Runner-facing UI (Hebrew).
const RUNNER_LABELS = { '🏁 הדירוג שלי': 'ranking', '📋 כל המרוצים': 'races', '🏆 הקבוצה שלי': 'team' };
function runnerKeyboard() {
  return {
    keyboard: [[{ text: '🏁 הדירוג שלי' }], [{ text: '📋 כל המרוצים' }, { text: '🏆 הקבוצה שלי' }]],
    resize_keyboard: true, is_persistent: true,
  };
}
const R_MSG = {
  askBib: 'שלום! 👋\nכדי לצפות בתוצאות ובדירוג שלך, שלח/י את מספר החזה (Bib) שלך:',
  badBib: 'שלח/י מספר חזה תקין (ספרות בלבד).',
  sent: (bib) => `✅ קיבלנו את מספר החזה שלך (#${esc(bib)}).\n⏳ הבקשה נשלחה למארגן לאישור — תקבל/י הודעה כשהיא תאושר.`,
  waiting: '⏳ בקשתך ממתינה לאישור המארגן.',
  declined: '❌ הבקשה שלך לא אושרה. אפשר לפנות למארגן.',
  approved: '🎉 אושרת! בחר/י פעולה מהתפריט שבתחתית המסך:',
  menuHint: 'בחר/י פעולה מהתפריט למטה:',
  noLeague: 'מספר החזה שלך עדיין לא משויך לליגה פעילה. נסה/י שוב מאוחר יותר.',
  noResults: 'אין עדיין תוצאות במרוץ שהסתיים.',
  noRow: (bib) => `לא נמצאה תוצאה עבור מספר חזה #${esc(bib)} במרוץ האחרון.`,
  noRaces: 'אין עדיין מרוצים בליגה.',
  noTeam: 'לא נמצאה קבוצה עבור מספר החזה שלך.',
  loadFail: '⚠️ לא ניתן לטעון את הנתונים כרגע.',
};

// ---------- small helpers ----------

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function kb(rows) { return { inline_keyboard: rows }; }
function btn(text, data) { return { text, callback_data: data }; }

// A persistent reply keyboard so the argument-less commands are one tap away.
// The labels map back to their slash commands in handleText.
const COMMAND_LABELS = {
  '🏁 Races': '/races', '📋 List': '/list', '➕ Add': '/add',
  '📄 CSV': '/csv', '🏆 League': '/league', '❓ Help': '/help',
};
function mainKeyboard() {
  return {
    keyboard: [
      [{ text: '🏁 Races' }, { text: '📋 List' }],
      [{ text: '➕ Add' }, { text: '📄 CSV' }],
      [{ text: '🏆 League' }, { text: '❓ Help' }],
    ],
    resize_keyboard: true,
    is_persistent: true,
  };
}

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
// The readers emit full 96-bit (24 hex char) EPCs, so every chip id the bot
// stores is left-padded with zeros to that width — a racer added by bib gets
// the bib as a zero-padded EPC (e.g. 101 -> 000000000000000000000101), which is
// exactly what a tag encoded with that number reads back as.
const EPC_LEN = 24;
function padEpc(raw) {
  const s = String(raw || '').trim().toUpperCase();
  return s.length >= EPC_LEN ? s : s.padStart(EPC_LEN, '0');
}
function syntheticEpc(bib) {
  return padEpc(String(bib).trim());
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
  const tail = [r.category, r.distance, r.gender, r.wave_name && `🚩${r.wave_name}`]
    .filter(Boolean).map(esc).join(' · ');
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
  '   <code>/add bib=101 name=Jane Doe cat=M40 dist=10k gender=F team=Aces wave=Elite epc=E28011</code>',
  '/edit &lt;bib&gt; — edit a racer (buttons: name, bib, category, distance, team, gender, wave, chip, status), or:',
  '   <code>/edit 101 name=New Name cat=M45 wave=Sport epc=E280A1</code>',
  '/del &lt;bib&gt; — remove a racer',
  '/csv — download the results CSV',
  '/league — season league standings + CSV',
  '/whoami — show your Telegram id',
  '/cancel — abort the current step',
].join('\n');

// ---------- core (IO injected) ----------

// When both an operator bot and a runner bot run in one process, cross-bot
// messages must land on the right one: the runner's Approve/Reject prompt goes
// to admins on the OPERATOR bot; the approval welcome goes to the runner on the
// RUNNER bot. startBot registers each bot's sender here. In a single-bot
// deployment the missing side is null and callers fall back to their own send.
const botSenders = { operator: null, runner: null };

// `role` = 'operator' (the full admin bot, also serves runners) or 'runner'
// (a second bot that serves ONLY the runner flow to everyone). `crossSend`
// overrides the registry in tests.
function createBotCore({ api, send, role = 'operator', crossSend } = {}) {
  const adminSend = () => (crossSend && crossSend.operator) || botSenders.operator || send;
  const runnerBotSend = () => (crossSend && crossSend.runner) || botSenders.runner || send;
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
    await send.message(chatId, `✅ Managing <b>${esc(c.title)}</b> — ${racers.length} racer(s).\nUse the buttons below, or /edit &lt;bib&gt; · /del &lt;bib&gt;.`, { reply_markup: mainKeyboard() });
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

  // Resolve a wave name to its id for this race, creating it if new (mirrors the
  // start-list import). Empty / "none" clears the wave (returns null).
  const CLEAR_WORDS = ['', 'none', 'clear', '-'];
  async function resolveWaveId(contestId, name) {
    const clean = String(name || '').trim();
    if (CLEAR_WORDS.includes(clean.toLowerCase())) return null;
    const waves = ((await A('GET', `/contests/${contestId}/waves`)).json || {}).waves || [];
    const found = waves.find((w) => String(w.name).toLowerCase() === clean.toLowerCase());
    if (found) return found.id;
    const created = await A('POST', `/contests/${contestId}/waves`, { name: clean });
    return (created.json && created.json.id) || null;
  }

  async function createRacer(chatId, contestId, f) {
    const bib = String(f.bib || '').trim();
    const participant = String(f.participant || '').trim();
    if (!participant) { await send.message(chatId, '⚠️ A name is required.'); return; }
    let epc = String(f.epc || '').trim();
    if (!epc) {
      if (!bib) { await send.message(chatId, '⚠️ Provide a bib or a chip EPC.'); return; }
      epc = syntheticEpc(bib);
    } else {
      epc = padEpc(epc);
    }
    if (!EPC_RE.test(epc)) { await send.message(chatId, '⚠️ Chip EPC must be 4–64 hex chars (or omit it and give a numeric bib).'); return; }
    const waveName = String(f.wave || '').trim();
    const waveId = waveName ? await resolveWaveId(contestId, waveName) : null;
    const res = await upsertRacer(contestId, {
      epc, bib, participant,
      category: f.category || '', distance: f.distance || '', team: f.team || '',
      gender: normGender(f.gender), racer_status: normStatus(f.racer_status), wave_id: waveId,
    });
    if (res.status >= 400) { await send.message(chatId, `⚠️ ${esc((res.json && res.json.error) || 'could not add racer')}`); return; }
    const extra = [waveId ? `🚩${esc(waveName)}` : '', `chip ${esc(epc)}`].filter(Boolean).join(', ');
    await send.message(chatId, `✅ Added #${esc(bib)} ${esc(participant)}${extra ? ` (${extra})` : ''}.`);
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
        [btn('Wave', `ef:${bib}:wave`), btn('Chip', `ef:${bib}:epc`)],
        [btn('Status', `ef:${bib}:racer_status`), btn('🗑 Delete', `del:${bib}`)],
      ]),
    });
  }

  // Merge changed fields into the racer and persist. Handles the synthetic-EPC
  // bib rename (the chip id is derived from the bib) the way Manage does.
  async function applyEdit(chatId, contestId, racer, fields) {
    const merged = { ...racer };
    let newEpc = null; // an explicit chip-id change
    for (const [k, v] of Object.entries(fields)) {
      if (k === 'gender') merged.gender = normGender(v);
      else if (k === 'racer_status') merged.racer_status = normStatus(v);
      else if (k === 'wave') { merged.wave_id = await resolveWaveId(contestId, v); merged.wave_name = v; }
      else if (k === 'epc') newEpc = padEpc(v);
      else merged[k] = v;
    }
    const oldBib = String(racer.bib || '');
    const newBib = String(merged.bib || '');
    const primaryEpc = (racer.epcs && racer.epcs[0]) || racer.epc;
    const twoChip = !!(racer.epcs && racer.epcs[1]);

    // Explicit chip-id change: re-key the row (single-chip racers only). The bib
    // is unchanged, so the old chip must go first — deleting by epc removes every
    // row sharing the bib, which would otherwise take the new row with it.
    if (newEpc && newEpc !== primaryEpc) {
      if (!EPC_RE.test(newEpc)) { await send.message(chatId, '⚠️ Chip EPC must be 4–64 hex chars.'); return; }
      if (twoChip) { await send.message(chatId, '⚠️ This racer has two chips — edit chips from the web Manage tab.'); return; }
      await A('DELETE', `/contests/${contestId}/tags/${primaryEpc}`);
      const res = await upsertRacer(contestId, { ...merged, epcs: undefined, epc: newEpc });
      await report(chatId, res, merged);
      return;
    }
    // Synthetic-EPC bib rename regenerates the derived chip id, then drops the old row.
    const wasSynthetic = primaryEpc === syntheticEpc(oldBib);
    if (newBib !== oldBib && wasSynthetic && !twoChip) {
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

  // ---- league standings ----

  async function cmdLeague(chatId) {
    const rows = db.prepare(
      "SELECT id, name, season FROM leagues WHERE status != 'archived' ORDER BY created_at DESC LIMIT 20").all();
    if (!rows.length) { await send.message(chatId, 'No leagues yet — create one in the web admin.'); return; }
    if (rows.length === 1) return showLeague(chatId, rows[0].id);
    const buttons = rows.map((l) => [btn(`${l.name}${l.season ? ` (${l.season})` : ''}`.slice(0, 60), `lg:${l.id}`)]);
    await send.message(chatId, 'Pick a league:', { reply_markup: kb(buttons) });
  }

  async function showLeague(chatId, id) {
    const res = await A('GET', `/leagues/${id}/standings`);
    if (res.status >= 400 || !res.json) { await send.message(chatId, '⚠️ League not found.'); return; }
    const { league, races, individual, teams } = res.json;
    const medals = ['🥇', '🥈', '🥉'];

    const lines = [`<b>${esc(league.name)}</b>${league.season ? ` — ${esc(league.season)}` : ''}`,
      `${races.length} race(s)${races.some((r) => r.status !== 'finished') ? ' · provisional' : ''}`, ''];
    for (const g of individual) {
      const title = [g.distance, g.gender, g.category].filter(Boolean).join(' · ') || 'Overall';
      lines.push(`<b>${esc(title)}</b>`);
      g.rows.slice(0, 3).forEach((r, i) =>
        lines.push(`${medals[i]} ${esc(r.name || '')}${r.team ? ` (${esc(r.team)})` : ''} — ${r.total}`));
      lines.push('');
    }
    if (teams.length) {
      lines.push('<b>🏆 Teams</b>');
      teams.slice(0, 3).forEach((r, i) => lines.push(`${medals[i]} ${esc(r.team)} — ${r.total}`));
    }
    // Telegram caps messages at 4096 chars; trim whole lines to stay under it.
    let text = '';
    for (const line of lines) {
      if (text.length + line.length + 1 > 3500) { text += '\n…'; break; }
      text += (text ? '\n' : '') + line;
    }
    await send.message(chatId, text || 'No scores yet.', {
      reply_markup: kb([[btn('📄 Individual CSV', `lgcsv:${id}:individual`), btn('📄 Team CSV', `lgcsv:${id}:team`)]]),
    });
  }

  async function leagueCsv(chatId, id, table) {
    const which = table === 'team' ? 'team' : 'individual';
    const res = await A('GET', `/leagues/${id}/standings?format=csv&table=${which}`);
    if (res.status >= 400) { await send.message(chatId, '⚠️ Could not build the CSV.'); return; }
    await send.document(chatId, `league-${id}-${which}.csv`, res.text, `League standings — ${which}`);
  }

  // ---- wizard (guided /add) ----

  const ADD_STEPS = ['bib', 'participant', 'category', 'distance', 'gender', 'team', 'wave', 'epc'];
  const ADD_PROMPT = {
    participant: 'Name?', category: 'Category? (or /skip)', distance: 'Distance? (or /skip)',
    team: 'Team? (or /skip)', epc: 'Chip EPC? (or /skip to derive it from the bib)',
  };
  const BUTTON_STEPS = new Set(['gender']); // gender is chosen from a button, never typed
  async function promptStep(chatId, st, step) {
    if (step === 'gender') {
      return send.message(chatId, 'Gender?', {
        reply_markup: kb([[btn('Male', 'addg:Male'), btn('Female', 'addg:Female'), btn('Skip', 'addg:')]]),
      });
    }
    if (step === 'wave') {
      const c = await activeContest(chatId);
      const waves = c ? (((await A('GET', `/contests/${c.id}/waves`)).json || {}).waves || []) : [];
      const rows = [];
      for (let i = 0; i < waves.length; i += 2) rows.push(waves.slice(i, i + 2).map((w) => btn(w.name.slice(0, 40), `addw:${w.name}`)));
      rows.push([btn('Skip', 'addw:')]);
      return send.message(chatId, 'Wave? Tap one, type a new name, or /skip.', { reply_markup: kb(rows) });
    }
    return send.message(chatId, ADD_PROMPT[step]);
  }
  async function wizardStep(chatId, st, value) {
    const step = st.step;
    if (!BUTTON_STEPS.has(step)) st.data[step] = value; // button steps store via the callback
    const next = ADD_STEPS[ADD_STEPS.indexOf(step) + 1];
    if (!next) return finishAdd(chatId, st);
    st.step = next;
    setState(chatId, st);
    return promptStep(chatId, st, next);
  }
  async function finishAdd(chatId, st) {
    setState(chatId, null);
    const c = await activeContest(chatId);
    if (!c) { await send.message(chatId, 'Race no longer selected. Use /races.'); return; }
    await createRacer(chatId, c.id, st.data);
  }

  // ---- routing ----

  async function handleText(chatId, text) {
    text = COMMAND_LABELS[text] || text; // a reply-keyboard tap arrives as its label
    const st = getState(chatId);
    if (text === '/cancel') { setState(chatId, null); await send.message(chatId, 'Cancelled.'); return; }
    if (st && st.flow === 'add' && text === '/skip') { await wizardStep(chatId, st, ''); return; }
    // In a wizard and the user typed a value (not a new command)
    if (st && st.flow === 'add' && !text.startsWith('/')) { await wizardStep(chatId, st, text); return; }
    if (st && st.flow === 'editval' && !text.startsWith('/')) {
      const c = await activeContest(chatId);
      setState(chatId, null);
      if (!c) { await send.message(chatId, 'Race no longer selected.'); return; }
      const r = findRacer(await listRacers(c.id), st.bib);
      if (!r) { await send.message(chatId, `No racer with bib #${esc(st.bib)}.`); return; }
      await applyEdit(chatId, c.id, r, { [st.field]: text });
      return;
    }
    if (st) setState(chatId, null); // a fresh command interrupts a half-finished wizard

    const [cmdRaw, ...restParts] = text.split(/\s+/);
    const cmd = cmdRaw.toLowerCase().replace(/@.*$/, ''); // strip @botname
    const rest = text.slice(cmdRaw.length).trim();
    switch (cmd) {
      case '/start':
      case '/help': return send.message(chatId, HELP, { reply_markup: mainKeyboard() });
      case '/whoami': return; // handled earlier with sender id; see handleUpdate
      case '/races': return cmdRaces(chatId, rest);
      case '/use': return useRace(chatId, restParts[0]);
      case '/list': return cmdList(chatId, rest);
      case '/add': return cmdAdd(chatId, rest);
      case '/edit': return cmdEdit(chatId, rest);
      case '/del':
      case '/delete': return cmdDel(chatId, rest);
      case '/csv': return cmdCsv(chatId);
      case '/league': return cmdLeague(chatId);
      default:
        return send.message(chatId, 'Unknown command. /help for the list.');
    }
  }

  async function handleCallback(chatId, cq) {
    const data = String(cq.data || '');
    await send.answerCallback(cq.id);
    const [tag, a, b] = data.split(':');
    if (tag === 'rappr') return approveRunner(chatId, a, b, cq.from);
    if (tag === 'rrej') return rejectRunner(chatId, a, cq.from);
    if (tag === 'use') return useRace(chatId, a);
    if (tag === 'lg') return showLeague(chatId, a);
    if (tag === 'lgcsv') return leagueCsv(chatId, a, b);
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
      if (field === 'wave') {
        const c = await activeContest(chatId);
        const waves = c ? (((await A('GET', `/contests/${c.id}/waves`)).json || {}).waves || []) : [];
        const rows = [];
        for (let i = 0; i < waves.length; i += 2) rows.push(waves.slice(i, i + 2).map((w) => btn(w.name.slice(0, 40), `ev:${bib}:wave:${w.name}`)));
        rows.push([btn('Clear', `ev:${bib}:wave:`)]);
        return send.message(chatId, waves.length
          ? `Pick a wave (or type a new one: <code>/edit ${esc(bib)} wave=NAME</code>):`
          : `No waves yet — create one with <code>/edit ${esc(bib)} wave=NAME</code>.`,
        waves.length ? { reply_markup: kb(rows) } : undefined);
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
    if (tag === 'addw') { // wave chosen during the add wizard
      const st = getState(chatId);
      if (st && st.flow === 'add' && st.step === 'wave') return wizardStep(chatId, st, data.split(':').slice(1).join(':'));
      return undefined;
    }
    return undefined;
  }

  // ---- runner self-service flow (non-allowlisted users) ----

  async function notifyAdminsOfRunner(runnerChatId, name, bib, cands) {
    const admins = adminChatIds();
    if (!admins.length) return;
    const leagueLine = cands.length === 0 ? 'League: — (bib not in any active league)'
      : cands.length === 1 ? `League: ${esc(cands[0].name)}`
        : `Leagues: ${cands.map((c) => esc(c.name)).join(', ')}`;
    const text = ['🏃 <b>Runner access request</b>', `Name: ${esc(name)}`, `Bib: <b>${esc(bib)}</b>`, leagueLine].join('\n');
    let rows;
    if (cands.length <= 1) {
      rows = [[btn('✅ Approve', `rappr:${runnerChatId}:${cands[0] ? cands[0].id : ''}`), btn('❌ Reject', `rrej:${runnerChatId}`)]];
    } else {
      rows = cands.map((c) => [btn(`✅ Approve — ${c.name}`.slice(0, 60), `rappr:${runnerChatId}:${c.id}`)]);
      rows.push([btn('❌ Reject', `rrej:${runnerChatId}`)]);
    }
    const asend = adminSend(); // admins get the prompt on the operator bot
    for (const admin of admins) {
      try { await asend.message(admin, text, { reply_markup: kb(rows) }); } catch { /* admin hasn't opened the bot */ }
    }
  }

  async function approveRunner(adminChatId, runnerChatId, leagueIdStr, adminFrom) {
    const runner = getRunner(runnerChatId);
    if (!runner) return send.message(adminChatId, 'Runner not found.');
    if (runner.status !== 'pending') return send.message(adminChatId, `Already ${runner.status}.`);
    let lid = leagueIdStr ? Number(leagueIdStr) : (runner.league_id || null);
    if (!lid) { const cands = activeLeagueIdsForBib(runner.bib); lid = cands.length ? cands[0].id : null; }
    setRunnerDecision(runnerChatId, 'approved', lid, adminFrom.id);
    auditLog(null, 'runner.approve', 'runner', null, `chat ${runner.chat_id} bib ${runner.bib} league ${lid || '-'} by tg ${adminFrom.id}`);
    await send.message(adminChatId, `✅ Approved ${esc(runner.tg_name)} (bib ${esc(runner.bib)}).`);
    try { await runnerBotSend().message(runner.chat_id, R_MSG.approved, { reply_markup: runnerKeyboard() }); } catch { /* ignore */ }
    return undefined;
  }

  async function rejectRunner(adminChatId, runnerChatId, adminFrom) {
    const runner = getRunner(runnerChatId);
    if (!runner) return send.message(adminChatId, 'Runner not found.');
    if (runner.status !== 'pending') return send.message(adminChatId, `Already ${runner.status}.`);
    setRunnerDecision(runnerChatId, 'rejected', runner.league_id || null, adminFrom.id);
    auditLog(null, 'runner.reject', 'runner', null, `chat ${runner.chat_id} bib ${runner.bib} by tg ${adminFrom.id}`);
    await send.message(adminChatId, `❌ Rejected ${esc(runner.tg_name)}.`);
    try { await runnerBotSend().message(runner.chat_id, R_MSG.declined); } catch { /* ignore */ }
    return undefined;
  }

  async function runnerMyRanking(chatId, runner) {
    const lid = runnerLeagueId(runner);
    if (!lid) return send.message(chatId, R_MSG.noLeague, { reply_markup: runnerKeyboard() });
    const contest = latestFinishedRace(lid);
    if (!contest) return send.message(chatId, R_MSG.noResults, { reply_markup: runnerKeyboard() });
    const results = computeRaceResults(contest);
    const mine = results.find((x) => String(x.bib).trim() === String(runner.bib).trim());
    if (!mine) return send.message(chatId, R_MSG.noRow(runner.bib), { reply_markup: runnerKeyboard() });
    const lines = [`🏁 <b>${esc(contest.title)}</b>`, `🗓 ${esc(fmtWhen(contest.start_at))}`, '',
      `<b>${esc(mine.participant || ('#' + runner.bib))}</b> — #${esc(mine.bib)}`];
    if (mine.status === 'finished') {
      lines.push(`🏅 מקום כללי: <b>${mine.rank}</b>`);
      if (mine.category) lines.push(`📊 מקום בקטגוריה ${esc(mine.category)}: <b>${mine.category_rank}</b>`);
      lines.push(`⏱ זמן: <b>${esc(mine.elapsed)}</b>`);
      if (mine.behind) lines.push(`⛳ פער מהמוביל: ${esc(mine.behind)}`);
    } else {
      const st = { DNS: 'לא זינק (DNS)', DNF: 'לא סיים (DNF)', DSQ: 'נפסל (DSQ)', on_course: 'על המסלול', not_started: 'טרם זינק' }[mine.status] || mine.status;
      lines.push(`סטטוס: ${esc(st)}`);
    }
    return send.message(chatId, lines.join('\n'), { reply_markup: runnerKeyboard() });
  }

  async function runnerAllRaces(chatId, runner) {
    const lid = runnerLeagueId(runner);
    if (!lid) return send.message(chatId, R_MSG.noLeague, { reply_markup: runnerKeyboard() });
    const rows = leagueRaceRows(lid);
    if (!rows.length) return send.message(chatId, R_MSG.noRaces, { reply_markup: runnerKeyboard() });
    const lines = [`📋 <b>מרוצי הליגה — ${esc(leagueName(lid))}</b>`, ''];
    for (const x of rows) lines.push(`R${x.round} · ${esc(x.title)} · ${esc(fmtDate(x.start_at))} · ${esc(raceStatusLabel(x))}`);
    return send.message(chatId, lines.join('\n'), { reply_markup: runnerKeyboard() });
  }

  async function runnerMyTeam(chatId, runner) {
    const lid = runnerLeagueId(runner);
    if (!lid) return send.message(chatId, R_MSG.noLeague, { reply_markup: runnerKeyboard() });
    const res = await A('GET', `/leagues/${lid}/standings`);
    if (res.status >= 400 || !res.json) return send.message(chatId, R_MSG.loadFail, { reply_markup: runnerKeyboard() });
    const { individual, teams } = res.json;
    let myTeam = '';
    for (const g of individual) {
      const row = g.rows.find((x) => String(x.bib).trim() === String(runner.bib).trim());
      if (row) { myTeam = row.team || ''; break; }
    }
    if (!myTeam) return send.message(chatId, R_MSG.noTeam, { reply_markup: runnerKeyboard() });
    const idx = teams.findIndex((t) => t.team === myTeam);
    const lines = [`🏆 <b>${esc(myTeam)}</b>`];
    if (idx >= 0) lines.push(`🏅 מקום בליגה: <b>${idx + 1}</b>`, `➕ נקודות: <b>${teams[idx].total}</b>`);
    const members = [];
    for (const g of individual) for (const x of g.rows) if ((x.team || '') === myTeam) members.push(x);
    members.sort((x, y) => y.total - x.total);
    if (members.length) {
      lines.push('', '<b>חברי הקבוצה:</b>');
      members.slice(0, 15).forEach((m) => lines.push(`• ${esc(m.name || ('#' + m.bib))} — ${m.total}`));
    }
    return send.message(chatId, lines.join('\n'), { reply_markup: runnerKeyboard() });
  }

  async function handleRunner(chatId, from, text) {
    const cmd = text.toLowerCase().replace(/@.*$/, '');
    let runner = getRunner(chatId);

    // Approved -> the three-button menu.
    if (runner && runner.status === 'approved') {
      const action = RUNNER_LABELS[text];
      if (action === 'ranking') return runnerMyRanking(chatId, runner);
      if (action === 'races') return runnerAllRaces(chatId, runner);
      if (action === 'team') return runnerMyTeam(chatId, runner);
      return send.message(chatId, R_MSG.menuHint, { reply_markup: runnerKeyboard() });
    }
    if (runner && runner.status === 'rejected') return send.message(chatId, R_MSG.declined);

    // Awaiting the bib (brand new, or pending with no bib yet).
    if (!runner || runner.bib === '') {
      if (!runner) runner = upsertRunner(chatId, { tg_user_id: String(from.id), tg_name: displayName(from), status: 'pending', bib: '' });
      if (cmd === '/start' || cmd === '/help') return send.message(chatId, R_MSG.askBib);
      const bib = text.trim();
      if (!/^\d{1,10}$/.test(bib)) return send.message(chatId, R_MSG.badBib);
      const cands = activeLeagueIdsForBib(bib);
      upsertRunner(chatId, {
        tg_user_id: String(from.id), tg_name: displayName(from), bib,
        league_id: cands.length === 1 ? cands[0].id : null, status: 'pending',
      });
      await notifyAdminsOfRunner(chatId, displayName(from), bib, cands);
      return send.message(chatId, R_MSG.sent(bib));
    }

    // Pending with a bib -> waiting on the admin.
    return send.message(chatId, R_MSG.waiting);
  }

  async function handleUpdate(update) {
    const msg = update.message || update.edited_message;
    const cq = update.callback_query;
    const from = (msg && msg.from) || (cq && cq.from);
    const chat = (msg && msg.chat) || (cq && cq.message && cq.message.chat);
    if (!from || !chat) return;
    // Fail-safe: with no configured operators the bot does nothing at all —
    // neither admin actions nor the runner self-service flow (which needs an
    // admin to approve). This also keeps a misconfigured bot silent.
    if (allowedIds().size === 0) return;
    const chatId = chat.id;
    try {
      // The runner bot serves ONLY the runner flow, to everyone — even an
      // allowlisted operator messaging it is treated as a runner. It never
      // handles admin actions or approval callbacks.
      const asRunner = role === 'runner' || !isAllowed(from.id);
      if (!asRunner) {
        // Operator bot, trusted user: the existing admin flow.
        if (cq) return await handleCallback(chatId, cq);
        if (!msg.text) return;
        const t = msg.text.trim();
        if (t.toLowerCase().replace(/@.*$/, '') === '/whoami') {
          return await send.message(chatId, `Your Telegram id: <code>${esc(from.id)}</code>`);
        }
        return await handleText(chatId, t);
      }
      // Runner self-service flow (approval-gated).
      if (cq) { await send.answerCallback(cq.id); return undefined; } // runners have no inline buttons
      if (!msg || !msg.text) return undefined;
      const t = msg.text.trim();
      if (t.toLowerCase().replace(/@.*$/, '') === '/whoami') {
        return await send.message(chatId, `Your Telegram id: <code>${esc(from.id)}</code>`);
      }
      return await handleRunner(chatId, from, t);
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

const OPERATOR_COMMANDS = [
  { command: 'races', description: 'Pick a race to manage' },
  { command: 'list', description: 'Show racers' },
  { command: 'add', description: 'Add a racer' },
  { command: 'edit', description: 'Edit a racer: /edit <bib>' },
  { command: 'del', description: 'Delete a racer: /del <bib>' },
  { command: 'csv', description: 'Download the results CSV' },
  { command: 'league', description: 'Season league standings' },
  { command: 'whoami', description: 'Show your Telegram id' },
  { command: 'help', description: 'Show help' },
];
const RUNNER_COMMANDS = [
  { command: 'start', description: 'Start / show my results menu' },
  { command: 'help', description: 'How this works' },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function pollLoop(label, send, core, commands) {
  await send.call('deleteWebhook', { drop_pending_updates: false }).catch(() => {});
  await send.call('setMyCommands', { commands }).catch(() => {});
  console.log(`Telegram ${label} bot started (long polling).`);
  let offset = 0;
  for (;;) {
    try {
      const r = await send.call('getUpdates', { offset, timeout: 30 });
      for (const u of (r && r.result) || []) {
        offset = u.update_id + 1;
        core.handleUpdate(u).catch((e) => console.error(`telegram ${label} update error:`, e));
      }
    } catch {
      await sleep(3000); // network hiccup; back off and retry
    }
  }
}

const startedRoles = new Set();
function startBot({ port, basePath } = {}) {
  const apiBase = `http://127.0.0.1:${port || process.env.PORT || 3000}${basePath || ''}/api`;
  const api = localApi(apiBase);
  const operatorToken = process.env.TELEGRAM_BOT_TOKEN;
  const runnerToken = process.env.TELEGRAM_RUNNER_BOT_TOKEN;

  // Operator bot: full admin flow (and serves runners too when no runner bot).
  if (operatorToken && !startedRoles.has('operator')) {
    startedRoles.add('operator');
    if (allowedIds().size === 0) {
      console.warn('Telegram bot: TELEGRAM_ALLOWED_USER_IDS is empty — the bot will ignore every message until it is set.');
    }
    const send = tgSender(operatorToken);
    botSenders.operator = send;
    const core = createBotCore({ api, send, role: 'operator' });
    // Race-day reminders run once, on the operator bot only.
    const runReminders = () => sendRaceReminders({ send, now: new Date() })
      .then((r) => { if (r.races) console.log(`Race-day reminders: ${r.races} race(s), ${r.messages} message(s).`); })
      .catch((err) => console.error('race reminder sweep failed:', err.message));
    setInterval(runReminders, 60 * 60 * 1000).unref();
    setTimeout(runReminders, 10_000).unref();
    pollLoop('operator', send, core, OPERATOR_COMMANDS);
  }

  // Runner bot: a second bot that serves ONLY the runner flow, to everyone.
  if (runnerToken && runnerToken !== operatorToken && !startedRoles.has('runner')) {
    startedRoles.add('runner');
    const send = tgSender(runnerToken);
    botSenders.runner = send;
    const core = createBotCore({ api, send, role: 'runner' });
    pollLoop('runner', send, core, RUNNER_COMMANDS);
  }
}

// ---------- race-day reminders ----------
//
// A day before a race, ping every chat that has talked to the bot (the
// allowlisted organizers) so nobody forgets to set up timing. Fires at most
// once per race, tracked by contests.reminder_sent_at.

// Active races starting within the next 24h that haven't been reminded yet.
function pendingRaceReminders(nowMs = Date.now()) {
  const now = new Date(nowMs).toISOString();
  const soon = new Date(nowMs + 24 * 3600 * 1000).toISOString();
  return db.prepare(
    `SELECT * FROM contests
      WHERE kind = 'race' AND status = 'active' AND reminder_sent_at IS NULL
        AND datetime(start_at) > datetime(?) AND datetime(start_at) <= datetime(?)
      ORDER BY datetime(start_at)`
  ).all(now, soon);
}

function raceReminderMessage(c) {
  const when = new Date(c.start_at).toLocaleString('he-IL', {
    weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const lines = [
    '⏰ <b>תזכורת: מחר יוצאים לדרך!</b>',
    '',
    `🏁 <b>${esc(c.title)}</b>`,
    `🗓 ${esc(when)}`,
  ];
  if (c.location) lines.push(`📍 ${esc(c.location)}`);
  const baseUrl = String(process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  if (baseUrl) lines.push('', `🔗 ${baseUrl}/#/results/${c.id}`);
  return lines.join('\n');
}

// Send the reminder for each race that's a day out to every known chat, then
// mark it reminded. Best-effort per chat: a failed send skips that chat but
// still marks the race so it isn't retried in a loop.
async function sendRaceReminders({ send, now = new Date() } = {}) {
  const due = pendingRaceReminders(now.getTime());
  if (!due.length) return { races: 0, messages: 0 };
  const chats = db.prepare('SELECT chat_id FROM telegram_sessions').all().map((r) => r.chat_id);
  const mark = db.prepare('UPDATE contests SET reminder_sent_at = ? WHERE id = ?');
  let messages = 0;
  for (const c of due) {
    const text = raceReminderMessage(c);
    for (const chatId of chats) {
      try { await send.message(chatId, text); messages++; }
      catch (err) { console.error(`race reminder to ${chatId} failed:`, err.message); }
    }
    mark.run(now.toISOString(), c.id);
  }
  return { races: due.length, messages };
}

module.exports = {
  startBot, createBotCore,
  pendingRaceReminders, raceReminderMessage, sendRaceReminders,
};

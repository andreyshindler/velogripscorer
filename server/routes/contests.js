'use strict';

const crypto = require('crypto');
const express = require('express');
const { db, auditLog } = require('../db');
const { requireAuth } = require('../auth');
const { computeLeaderboard } = require('../scoring');
const { sseSubscribe, notify, dispatchWebhooks } = require('../events');

const router = express.Router();

const CATEGORIES = ['photo', 'design', 'code', 'writing', 'video', 'other'];
const BADGES = ['gold', 'silver', 'bronze'];

function getContest(id) {
  return db.prepare('SELECT * FROM contests WHERE id = ?').get(id);
}

function isOrganizer(contest, user) {
  return user && (user.id === contest.organizer_id || user.role === 'admin');
}

// Private contests are visible to the organizer, admins, approved participants,
// and anyone presenting the invite code (req 3.2).
function canView(contest, user, inviteCode) {
  if (contest.visibility === 'public') return true;
  if (isOrganizer(contest, user)) return true;
  if (inviteCode && inviteCode === contest.invite_code) return true;
  if (user) {
    const row = db
      .prepare(`SELECT 1 FROM participants WHERE contest_id = ? AND user_id = ? AND status = 'approved'`)
      .get(contest.id, user.id);
    if (row) return true;
  }
  return false;
}

function votingOpen(contest) {
  if (contest.status !== 'active') return false;
  const now = new Date();
  if (now < new Date(contest.start_at) || now > new Date(contest.end_at)) return false;
  if (contest.voting_mode === 'closed') {
    if (contest.voting_start_at && now < new Date(contest.voting_start_at)) return false;
    if (contest.voting_end_at && now > new Date(contest.voting_end_at)) return false;
  }
  return true;
}

// Blind voting hides author identity until the contest is finished (req 3.4).
function blindActive(contest, user) {
  return !!contest.blind_voting && contest.status === 'active' && !isOrganizer(contest, user);
}

function serializeContest(contest, user) {
  const criteria = db.prepare('SELECT id, name, weight FROM criteria WHERE contest_id = ?').all(contest.id);
  const prizes = db.prepare('SELECT * FROM prizes WHERE contest_id = ? ORDER BY rank').all(contest.id);
  const counts = db
    .prepare(
      `SELECT
        (SELECT COUNT(*) FROM entries WHERE contest_id = c.id AND status = 'visible') AS entry_count,
        (SELECT COUNT(DISTINCT voter_id) FROM votes v JOIN entries e ON e.id = v.entry_id
          WHERE e.contest_id = c.id) AS voter_count,
        (SELECT COUNT(*) FROM participants WHERE contest_id = c.id AND status = 'approved') AS participant_count,
        (SELECT COUNT(*) FROM follows WHERE contest_id = c.id) AS follower_count
       FROM contests c WHERE c.id = ?`
    )
    .get(contest.id);
  const organizer = db.prepare('SELECT id, name, avatar_url FROM users WHERE id = ?').get(contest.organizer_id);
  const out = {
    ...contest,
    tags: JSON.parse(contest.tags || '[]'),
    criteria,
    prizes,
    organizer,
    ...counts,
    voting_open: votingOpen(contest),
    is_organizer: isOrganizer(contest, user),
    is_following: user
      ? !!db.prepare('SELECT 1 FROM follows WHERE user_id = ? AND contest_id = ?').get(user.id, contest.id)
      : false,
  };
  if (!isOrganizer(contest, user)) {
    delete out.invite_code;
  } else {
    const reader = db.prepare('SELECT token FROM readers WHERE contest_id = ? ORDER BY id LIMIT 1').get(contest.id);
    out.app_token = reader ? reader.token : null;
  }
  return out;
}

function validateCriteria(criteria) {
  if (!Array.isArray(criteria) || criteria.length === 0) return 'at least one judging criterion is required';
  for (const c of criteria) {
    if (!c || !String(c.name || '').trim()) return 'every criterion needs a name';
    const w = Number(c.weight);
    if (!Number.isFinite(w) || w <= 0 || w > 100) return 'criterion weights must be between 1 and 100';
  }
  const total = criteria.reduce((s, c) => s + Number(c.weight), 0);
  if (Math.round(total) !== 100) return `criterion weights must sum to 100 (got ${total})`;
  return null;
}

// ---- Listing, search & discovery (req 3.7) ----

router.get('/contests', (req, res) => {
  const { q, category, tag, status, sort, from, to } = req.query;
  let rows = db
    .prepare(
      `SELECT c.*, u.name AS organizer_name,
        (SELECT COUNT(*) FROM entries WHERE contest_id = c.id AND status='visible') AS entry_count,
        (SELECT COUNT(*) FROM votes v JOIN entries e ON e.id = v.entry_id WHERE e.contest_id = c.id) AS vote_count,
        (SELECT COUNT(*) FROM participants WHERE contest_id = c.id AND status='approved') AS participant_count,
        (SELECT GROUP_CONCAT(l.name, ', ') FROM league_races lr
           JOIN leagues l ON l.id = lr.league_id WHERE lr.contest_id = c.id) AS league_names
       FROM contests c JOIN users u ON u.id = c.organizer_id
       WHERE c.status != 'archived'`
    )
    .all()
    .filter((c) => canView(c, req.user, null));

  if (q) {
    const needle = String(q).toLowerCase();
    rows = rows.filter(
      (c) =>
        c.title.toLowerCase().includes(needle) ||
        c.description.toLowerCase().includes(needle) ||
        c.tags.toLowerCase().includes(needle) ||
        c.organizer_name.toLowerCase().includes(needle)
    );
  }
  if (category) rows = rows.filter((c) => c.category === category);
  if (tag) rows = rows.filter((c) => JSON.parse(c.tags).includes(tag));
  if (status) rows = rows.filter((c) => c.status === status);
  if (from) rows = rows.filter((c) => c.end_at >= from);
  if (to) rows = rows.filter((c) => c.start_at <= to);

  if (sort === 'popular') rows.sort((a, b) => b.vote_count + b.entry_count - (a.vote_count + a.entry_count));
  else rows.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));

  res.json({
    contests: rows.slice(0, 100).map((c) => ({ ...c, tags: JSON.parse(c.tags || '[]'), voting_open: votingOpen(c) })),
  });
});

// Recommended contests based on tags of contests the user follows/entered (req 3.7)
router.get('/contests/recommended', requireAuth, (req, res) => {
  const myTags = new Set();
  const mine = db
    .prepare(
      `SELECT tags FROM contests WHERE id IN (
         SELECT contest_id FROM follows WHERE user_id = $id
         UNION SELECT contest_id FROM entries WHERE user_id = $id)`
    )
    .all({ id: req.user.id });
  for (const row of mine) for (const t of JSON.parse(row.tags || '[]')) myTags.add(t);

  const candidates = db
    .prepare(
      `SELECT * FROM contests WHERE status = 'active' AND visibility = 'public'
       AND organizer_id != ? ORDER BY created_at DESC LIMIT 200`
    )
    .all(req.user.id)
    .filter((c) => JSON.parse(c.tags || '[]').some((t) => myTags.has(t)))
    .slice(0, 10)
    .map((c) => ({ ...c, tags: JSON.parse(c.tags || '[]') }));
  res.json({ contests: candidates });
});

// Races organized by the logged-in user, with their app pairing tokens —
// lets the Android app offer "log in and pick your race" instead of manual
// token entry. Tokens are auto-created for races that predate them.
router.get('/my/races', requireAuth, (req, res) => {
  const races = db
    .prepare(
      `SELECT c.id, c.title, c.sport, c.location, c.start_at, c.end_at, c.status,
        (SELECT COUNT(DISTINCT CASE WHEN a.bib != '' THEN 'b' || a.bib ELSE 'e' || a.epc END)
           FROM tag_assignments a WHERE a.contest_id = c.id) AS racer_count,
        (SELECT token FROM readers r WHERE r.contest_id = c.id ORDER BY r.id LIMIT 1) AS app_token,
        (SELECT GROUP_CONCAT(l.name, ', ') FROM league_races lr
           JOIN leagues l ON l.id = lr.league_id WHERE lr.contest_id = c.id) AS league_names,
        (SELECT lr.league_id FROM league_races lr WHERE lr.contest_id = c.id LIMIT 1) AS league_id
       FROM contests c WHERE c.organizer_id = ? AND c.kind = 'race'
       ORDER BY c.start_at DESC LIMIT 100`
    )
    .all(req.user.id);
  for (const race of races) {
    if (!race.app_token) {
      race.app_token = `vgr_${crypto.randomBytes(24).toString('hex')}`;
      db.prepare('INSERT INTO readers (contest_id, name, token, location) VALUES (?,?,?,?)')
        .run(race.id, 'Timing app', race.app_token, '');
    }
  }
  // Reader WiFi credentials for the timing app (env-configured, shared across
  // races). Only returned to the authenticated organizer.
  res.json({
    races,
    reader_wifi: {
      ssid: process.env.READER_WIFI_SSID || 'Tenda_raceit',
      password: process.env.READER_WIFI_PASSWORD || '',
    },
  });
});

// ---- Creation & management (req 3.2) ----

router.post('/contests', requireAuth, (req, res) => {
  const b = req.body || {};
  if (!b.title || !String(b.title).trim()) return res.status(400).json({ error: 'title required' });
  if (!b.start_at || !b.end_at) return res.status(400).json({ error: 'start_at and end_at required' });
  if (new Date(b.end_at) <= new Date(b.start_at)) return res.status(400).json({ error: 'end_at must be after start_at' });
  if (b.category && !CATEGORIES.includes(b.category)) return res.status(400).json({ error: 'invalid category' });
  // Two contest kinds: 'race' (RFID/manual timing, ranked by time) and
  // 'voting' (community-judged entries with weighted criteria). Default is
  // inferred for API compatibility: criteria supplied -> voting.
  const kind = b.kind === 'race' || b.kind === 'voting'
    ? b.kind
    : Array.isArray(b.criteria) && b.criteria.length ? 'voting' : 'race';
  if (kind === 'voting') {
    const criteriaError = validateCriteria(b.criteria);
    if (criteriaError) return res.status(400).json({ error: criteriaError });
  }
  if (b.voting_mode === 'closed' && (!b.voting_start_at || !b.voting_end_at)) {
    return res.status(400).json({ error: 'closed voting mode requires voting_start_at and voting_end_at' });
  }

  const insert = db.transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO contests
          (organizer_id, title, description, category, tags, visibility, invite_code,
           voting_mode, blind_voting, scale_max, participant_cap,
           start_at, end_at, voting_start_at, voting_end_at, kind, sport, location, photo_url, organizer_name)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        req.user.id,
        String(b.title).trim(),
        String(b.description || ''),
        b.category || 'other',
        JSON.stringify(Array.isArray(b.tags) ? b.tags.map(String) : []),
        b.visibility === 'private' ? 'private' : 'public',
        b.visibility === 'private' ? crypto.randomBytes(6).toString('hex') : null,
        b.voting_mode === 'closed' ? 'closed' : 'open',
        b.blind_voting ? 1 : 0,
        Number(b.scale_max) >= 2 && Number(b.scale_max) <= 100 ? Number(b.scale_max) : 10,
        Number.isInteger(b.participant_cap) && b.participant_cap > 0 ? b.participant_cap : null,
        b.start_at,
        b.end_at,
        b.voting_start_at || null,
        b.voting_end_at || null,
        kind,
        String(b.sport || '').trim(),
        String(b.location || '').trim(),
        typeof b.photo_url === 'string' && b.photo_url.startsWith('data:image/') ? b.photo_url : '',
        String(b.organizer_name || '').trim().slice(0, 80)
      );
    const contestId = info.lastInsertRowid;
    if (kind === 'race') {
      // one device token per race, created up front: the organizer pastes it
      // into the Android timing app; no manual "reader" setup needed.
      db.prepare('INSERT INTO readers (contest_id, name, token, location) VALUES (?,?,?,?)')
        .run(contestId, 'Timing app', `vgr_${crypto.randomBytes(24).toString('hex')}`, '');
    }
    if (kind === 'voting') {
      const stmt = db.prepare('INSERT INTO criteria (contest_id, name, weight) VALUES (?, ?, ?)');
      for (const c of b.criteria) stmt.run(contestId, String(c.name).trim(), Math.round(Number(c.weight)));
    }
    if (Array.isArray(b.prizes)) {
      const pstmt = db.prepare('INSERT INTO prizes (contest_id, rank, name, type, details) VALUES (?,?,?,?,?)');
      for (const p of b.prizes) {
        if (p && p.name && Number.isInteger(Number(p.rank))) {
          pstmt.run(contestId, Number(p.rank), String(p.name), p.type || 'badge', String(p.details || ''));
        }
      }
    }
    return contestId;
  });

  const contestId = insert();
  auditLog(req.user.id, 'contest.create', 'contest', contestId, b.title);
  res.status(201).json(serializeContest(getContest(contestId), req.user));
});

router.get('/contests/:id', (req, res) => {
  const contest = getContest(req.params.id);
  if (!contest) return res.status(404).json({ error: 'contest not found' });
  if (!canView(contest, req.user, req.query.invite_code)) {
    return res.status(403).json({ error: 'this contest is private' });
  }
  res.json(serializeContest(contest, req.user));
});

// Delete a race and everything under it (start list, reads, waves, results).
router.delete('/contests/:id', requireAuth, (req, res) => {
  const contest = getContest(req.params.id);
  if (!contest) return res.status(404).json({ error: 'contest not found' });
  if (!isOrganizer(contest, req.user)) return res.status(403).json({ error: 'organizer only' });
  const wipe = db.transaction(() => {
    // awards reference entries without cascade; clear them first
    db.prepare('DELETE FROM awards WHERE contest_id = ?').run(contest.id);
    db.prepare('DELETE FROM entries WHERE contest_id = ?').run(contest.id);
    db.prepare('DELETE FROM contests WHERE id = ?').run(contest.id);
  });
  wipe();
  auditLog(req.user.id, 'contest.delete', 'contest', contest.id, contest.title);
  res.json({ ok: true });
});

router.patch('/contests/:id', requireAuth, (req, res) => {
  const contest = getContest(req.params.id);
  if (!contest) return res.status(404).json({ error: 'contest not found' });
  if (!isOrganizer(contest, req.user)) return res.status(403).json({ error: 'organizer only' });
  const b = req.body || {};
  const fields = {
    title: b.title !== undefined ? String(b.title).trim() : contest.title,
    description: b.description !== undefined ? String(b.description) : contest.description,
    tags: b.tags !== undefined ? JSON.stringify(b.tags.map(String)) : contest.tags,
    end_at: b.end_at || contest.end_at,
    voting_start_at: b.voting_start_at !== undefined ? b.voting_start_at : contest.voting_start_at,
    voting_end_at: b.voting_end_at !== undefined ? b.voting_end_at : contest.voting_end_at,
    blind_voting: b.blind_voting !== undefined ? (b.blind_voting ? 1 : 0) : contest.blind_voting,
    participant_cap: b.participant_cap !== undefined ? b.participant_cap : contest.participant_cap,
    photo_url: b.photo_url !== undefined
      ? (typeof b.photo_url === 'string' && (b.photo_url === '' || b.photo_url.startsWith('data:image/')) ? b.photo_url : contest.photo_url)
      : contest.photo_url,
  };
  db.prepare(
    `UPDATE contests SET title=?, description=?, tags=?, end_at=?, voting_start_at=?, voting_end_at=?,
     blind_voting=?, participant_cap=?, photo_url=? WHERE id = ?`
  ).run(
    fields.title, fields.description, fields.tags, fields.end_at, fields.voting_start_at,
    fields.voting_end_at, fields.blind_voting, fields.participant_cap, fields.photo_url, contest.id
  );
  auditLog(req.user.id, 'contest.update', 'contest', contest.id);
  res.json(serializeContest(getContest(contest.id), req.user));
});

// Duplicate a race: clone the start list into a brand-new contest (new id,
// fresh pairing token, no reads/results) so the same roster can time another
// event without overwriting the original race's results.
router.post('/contests/:id/duplicate', requireAuth, (req, res) => {
  const src = getContest(req.params.id);
  if (!src) return res.status(404).json({ error: 'contest not found' });
  if (!isOrganizer(src, req.user)) return res.status(403).json({ error: 'organizer only' });
  const b = req.body || {};
  const title = String(b.title || `${src.title} (copy)`).trim().slice(0, 120) || src.title;

  const clone = db.transaction(() => {
    const info = db.prepare(
      `INSERT INTO contests
        (organizer_id, title, description, category, tags, visibility, invite_code,
         voting_mode, blind_voting, scale_max, participant_cap,
         start_at, end_at, voting_start_at, voting_end_at, kind, sport, location, photo_url, organizer_name,
         suppress_secs, min_lap_gap_secs)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      req.user.id, title, src.description, src.category, src.tags,
      src.visibility, src.visibility === 'private' ? crypto.randomBytes(6).toString('hex') : null,
      src.voting_mode, src.blind_voting, src.scale_max, src.participant_cap,
      b.start_at || src.start_at, b.end_at || src.end_at, src.voting_start_at, src.voting_end_at,
      src.kind, src.sport, src.location, src.photo_url, src.organizer_name,
      src.suppress_secs, src.min_lap_gap_secs
    );
    const newId = info.lastInsertRowid;
    db.prepare('INSERT INTO readers (contest_id, name, token, location) VALUES (?,?,?,?)')
      .run(newId, 'Timing app', `vgr_${crypto.randomBytes(24).toString('hex')}`, '');
    // Recreate waves by name (no gun times) and remap the start list's wave_id.
    const waveMap = new Map();
    for (const w of db.prepare('SELECT id, name FROM waves WHERE contest_id = ?').all(src.id)) {
      const wi = db.prepare('INSERT INTO waves (contest_id, name, started_at) VALUES (?,?,NULL)').run(newId, w.name);
      waveMap.set(w.id, wi.lastInsertRowid);
    }
    const ins = db.prepare(
      `INSERT INTO tag_assignments (contest_id, epc, bib, participant, user_id, wave_id, category, distance, team, gender, racer_status)
       VALUES (?,?,?,?,?,?,?,?,?,?,'')`
    );
    for (const a of db.prepare('SELECT * FROM tag_assignments WHERE contest_id = ?').all(src.id)) {
      ins.run(newId, a.epc, a.bib, a.participant, a.user_id,
        a.wave_id ? (waveMap.get(a.wave_id) || null) : null, a.category, a.distance, a.team, a.gender);
    }
    return newId;
  });
  const newId = clone();
  auditLog(req.user.id, 'contest.duplicate', 'contest', newId, `from ${src.id}`);
  res.status(201).json(serializeContest(getContest(newId), req.user));
});

// ---- Participation (req 3.2) ----

router.post('/contests/:id/join', requireAuth, (req, res) => {
  const contest = getContest(req.params.id);
  if (!contest) return res.status(404).json({ error: 'contest not found' });
  if (contest.status !== 'active') return res.status(400).json({ error: 'contest is not active' });
  if (contest.visibility === 'private' && !canView(contest, req.user, req.body?.invite_code)) {
    return res.status(403).json({ error: 'invite code required to join this private contest' });
  }
  if (contest.participant_cap) {
    const n = db
      .prepare(`SELECT COUNT(*) AS n FROM participants WHERE contest_id = ? AND status = 'approved'`)
      .get(contest.id).n;
    if (n >= contest.participant_cap) return res.status(409).json({ error: 'contest is full' });
  }
  db.prepare(
    `INSERT INTO participants (contest_id, user_id, status) VALUES (?, ?, 'approved')
     ON CONFLICT (contest_id, user_id) DO NOTHING`
  ).run(contest.id, req.user.id);
  auditLog(req.user.id, 'contest.join', 'contest', contest.id);
  res.json({ ok: true });
});

router.post('/contests/:id/invite', requireAuth, (req, res) => {
  const contest = getContest(req.params.id);
  if (!contest) return res.status(404).json({ error: 'contest not found' });
  if (!isOrganizer(contest, req.user)) return res.status(403).json({ error: 'organizer only' });
  const invitee = db.prepare('SELECT * FROM users WHERE email = ?').get(String(req.body?.email || '').toLowerCase());
  if (!invitee) return res.status(404).json({ error: 'no user with that email' });
  notify(invitee.id, 'invite', `You are invited to "${contest.title}"`, {
    contest_id: contest.id,
    invite_code: contest.invite_code,
  });
  auditLog(req.user.id, 'contest.invite', 'contest', contest.id, invitee.email);
  res.json({ ok: true, invite_code: contest.invite_code });
});

router.post('/contests/:id/follow', requireAuth, (req, res) => {
  const contest = getContest(req.params.id);
  if (!contest || !canView(contest, req.user, null)) return res.status(404).json({ error: 'contest not found' });
  db.prepare('INSERT OR IGNORE INTO follows (user_id, contest_id) VALUES (?, ?)').run(req.user.id, contest.id);
  res.json({ ok: true });
});

router.delete('/contests/:id/follow', requireAuth, (req, res) => {
  db.prepare('DELETE FROM follows WHERE user_id = ? AND contest_id = ?').run(req.user.id, req.params.id);
  res.json({ ok: true });
});

// ---- Leaderboard & results (req 3.5) ----

router.get('/contests/:id/leaderboard', (req, res) => {
  const contest = getContest(req.params.id);
  if (!contest) return res.status(404).json({ error: 'contest not found' });
  if (!canView(contest, req.user, req.query.invite_code)) return res.status(403).json({ error: 'this contest is private' });

  let board = computeLeaderboard(contest.id);
  if (blindActive(contest, req.user)) {
    board = board.map((row) => ({
      ...row,
      author_name: row.user_id === req.user?.id ? row.author_name : 'Hidden until voting ends',
      author_avatar: row.user_id === req.user?.id ? row.author_avatar : '',
      user_id: row.user_id === req.user?.id ? row.user_id : null,
    }));
  }

  if (req.query.format === 'csv') {
    const header = 'rank,entry,author,score,pct_of_max,votes';
    const lines = board.map((r) =>
      [r.rank, csvCell(r.title), csvCell(r.author_name), r.score, r.pct_of_max, r.votes].join(',')
    );
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="leaderboard-${contest.id}.csv"`);
    return res.send([header, ...lines].join('\n') + '\n');
  }

  const awards = db.prepare('SELECT * FROM awards WHERE contest_id = ? ORDER BY rank').all(contest.id);
  res.json({ contest_id: contest.id, scale_max: contest.scale_max, generated_at: new Date().toISOString(), leaderboard: board, awards });
});

function csvCell(value) {
  const s = String(value ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// Score history for charts (req 3.5)
router.get('/contests/:id/history', (req, res) => {
  const contest = getContest(req.params.id);
  if (!contest) return res.status(404).json({ error: 'contest not found' });
  if (!canView(contest, req.user, req.query.invite_code)) return res.status(403).json({ error: 'this contest is private' });
  const rows = db
    .prepare(
      `SELECT h.entry_id, e.title, h.score, h.created_at FROM score_history h
       JOIN entries e ON e.id = h.entry_id WHERE h.contest_id = ? ORDER BY h.id`
    )
    .all(contest.id);
  res.json({ history: rows });
});

// Server-sent events stream for real-time updates (req 3.4 / NFR)
router.get('/contests/:id/stream', (req, res) => {
  const contest = getContest(req.params.id);
  if (!contest) return res.status(404).json({ error: 'contest not found' });
  if (!canView(contest, req.user, req.query.invite_code)) return res.status(403).json({ error: 'this contest is private' });
  sseSubscribe(contest.id, res);
});

// ---- Finishing a contest: declare winners, hand out prizes (req 3.5/3.8) ----

function finishContest(contest, actorId) {
  const board = computeLeaderboard(contest.id);
  const prizes = db.prepare('SELECT * FROM prizes WHERE contest_id = ? ORDER BY rank').all(contest.id);
  const winners = [];

  const finish = db.transaction(() => {
    db.prepare(`UPDATE contests SET status = 'finished' WHERE id = ?`).run(contest.id);
    const top = board.slice(0, Math.max(3, prizes.length)).filter((r) => r.votes > 0);
    for (const row of top) {
      const badge = BADGES[row.rank - 1] || `top-${row.rank}`;
      const prize = prizes.find((p) => p.rank === row.rank) || null;
      db.prepare(
        `INSERT INTO awards (contest_id, entry_id, user_id, rank, badge, prize_id) VALUES (?,?,?,?,?,?)`
      ).run(contest.id, row.entry_id, row.user_id, row.rank, badge, prize ? prize.id : null);
      db.prepare('UPDATE users SET reputation = reputation + ? WHERE id = ?').run(
        Math.max(0, 40 - 10 * row.rank) + 10, row.user_id
      );
      winners.push({ ...row, badge, prize: prize ? { name: prize.name, type: prize.type, details: prize.details } : null });
    }
  });
  finish();

  for (const w of winners) {
    notify(w.user_id, 'award', `You won ${w.badge} in "${contest.title}"!`, {
      contest_id: contest.id,
      entry_id: w.entry_id,
      rank: w.rank,
      prize: w.prize,
      redemption: w.prize ? 'Check your email for redemption instructions.' : undefined,
    });
  }
  const followers = db.prepare('SELECT user_id FROM follows WHERE contest_id = ?').all(contest.id);
  for (const f of followers) {
    notify(f.user_id, 'contest_finished', `Voting has ended for "${contest.title}" — results are out`, { contest_id: contest.id });
  }
  dispatchWebhooks(contest.id, 'contest.finished', { winners: winners.map((w) => ({ entry_id: w.entry_id, rank: w.rank, score: w.score })) });
  if (winners.length) dispatchWebhooks(contest.id, 'winner.declared', { winners });
  auditLog(actorId, 'contest.finish', 'contest', contest.id);
  return winners;
}

router.post('/contests/:id/finish', requireAuth, (req, res) => {
  const contest = getContest(req.params.id);
  if (!contest) return res.status(404).json({ error: 'contest not found' });
  if (!isOrganizer(contest, req.user)) return res.status(403).json({ error: 'organizer only' });
  if (contest.status !== 'active') return res.status(400).json({ error: 'contest already finished' });
  res.json({ ok: true, winners: finishContest(contest, req.user.id) });
});

// Auto-finish contests whose end date has passed (start/end notifications, req 3.6)
function sweepEndedContests() {
  const ended = db
    .prepare(`SELECT * FROM contests WHERE status = 'active' AND end_at < datetime('now')`)
    .all();
  for (const contest of ended) {
    try {
      finishContest(contest, null);
    } catch (err) {
      console.error(`auto-finish failed for contest ${contest.id}:`, err.message);
    }
  }
}

// ---- Webhook management (req 3.10) ----

router.get('/contests/:id/webhooks', requireAuth, (req, res) => {
  const contest = getContest(req.params.id);
  if (!contest) return res.status(404).json({ error: 'contest not found' });
  if (!isOrganizer(contest, req.user)) return res.status(403).json({ error: 'organizer only' });
  res.json({ webhooks: db.prepare('SELECT id, url, events FROM webhooks WHERE contest_id = ?').all(contest.id) });
});

router.post('/contests/:id/webhooks', requireAuth, (req, res) => {
  const contest = getContest(req.params.id);
  if (!contest) return res.status(404).json({ error: 'contest not found' });
  if (!isOrganizer(contest, req.user)) return res.status(403).json({ error: 'organizer only' });
  const { url, events, secret } = req.body || {};
  if (!url || !/^https?:\/\//.test(url)) return res.status(400).json({ error: 'valid url required' });
  const info = db
    .prepare('INSERT INTO webhooks (contest_id, url, events, secret) VALUES (?,?,?,?)')
    .run(contest.id, url, JSON.stringify(events || ['contest.finished', 'winner.declared', 'abuse.reported']), secret || '');
  auditLog(req.user.id, 'webhook.create', 'contest', contest.id, url);
  res.status(201).json({ id: info.lastInsertRowid });
});

module.exports = { router, getContest, canView, votingOpen, blindActive, isOrganizer, sweepEndedContests };

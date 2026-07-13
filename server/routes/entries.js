'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const { db, auditLog, DATA_DIR } = require('../db');
const { requireAuth, rateLimit } = require('../auth');
const { computeLeaderboard, entryScore } = require('../scoring');
const { sseBroadcast, notify, dispatchWebhooks } = require('../events');
const { containsProfanity } = require('../moderation');
const { getContest, canView, votingOpen, blindActive, isOrganizer } = require('./contests');

const router = express.Router();

// ---- Uploads (req 3.3): images, video <= 100 MB, PDF ----

const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const ALLOWED_MIME = {
  'image/jpeg': 'image', 'image/png': 'image', 'image/gif': 'image', 'image/webp': 'image',
  'video/mp4': 'video', 'video/webm': 'video',
  'application/pdf': 'pdf',
};

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (_req, file, cb) =>
      cb(null, `${crypto.randomBytes(8).toString('hex')}${path.extname(file.originalname).slice(0, 10)}`),
  }),
  limits: { fileSize: 100 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_MIME[file.mimetype]) cb(null, true);
    else cb(new Error('unsupported file type (allowed: JPG, PNG, GIF, WebP, MP4, WebM, PDF)'));
  },
});

function submissionOpen(contest) {
  const now = new Date();
  return contest.status === 'active' && now >= new Date(contest.start_at) && now <= new Date(contest.end_at);
}

function serializeEntry(entry, contest, user, { withScore = true } = {}) {
  const author = db.prepare('SELECT id, name, avatar_url FROM users WHERE id = ?').get(entry.user_id);
  const hide = blindActive(contest, user) && (!user || user.id !== entry.user_id);
  const out = {
    ...entry,
    tags: JSON.parse(entry.tags || '[]'),
    file_url: entry.file_path ? `/uploads/${path.basename(entry.file_path)}` : null,
    author: hide ? { id: null, name: 'Hidden until voting ends', avatar_url: '' } : author,
    comment_count: db.prepare(`SELECT COUNT(*) AS n FROM comments WHERE entry_id = ? AND status='visible'`).get(entry.id).n,
  };
  if (hide) out.user_id = null;
  delete out.file_path;
  if (withScore) {
    const score = entryScore(entry.id);
    out.score = score ? score.score : 0;
    out.pct_of_max = score ? score.pct_of_max : 0;
    out.vote_count = score ? score.votes : 0;
    out.per_criterion = score ? score.per_criterion : [];
  }
  if (user) {
    const mine = db.prepare('SELECT criterion_id, score FROM votes WHERE entry_id = ? AND voter_id = ?').all(entry.id, user.id);
    out.my_votes = Object.fromEntries(mine.map((v) => [v.criterion_id, v.score]));
  }
  return out;
}

// ---- Submission (req 3.3) ----

router.post('/contests/:id/entries', requireAuth, upload.single('file'), (req, res) => {
  const contest = getContest(req.params.id);
  if (!contest) return res.status(404).json({ error: 'contest not found' });
  if (!canView(contest, req.user, req.body?.invite_code)) return res.status(403).json({ error: 'this contest is private' });
  if (!submissionOpen(contest)) return res.status(400).json({ error: 'submissions are closed for this contest' });

  const b = req.body || {};
  if (!b.title || !String(b.title).trim()) return res.status(400).json({ error: 'title required' });

  let kind = ['text', 'code', 'link'].includes(b.kind) ? b.kind : 'text';
  if (req.file) kind = ALLOWED_MIME[req.file.mimetype];
  if (!req.file && !String(b.body || '').trim()) {
    return res.status(400).json({ error: 'entry needs either a file or text content' });
  }

  // Automated moderation: profane submissions go straight to the review queue (req 3.3/3.9)
  const flagged = containsProfanity(b.title, b.description, b.body);

  if (contest.participant_cap) {
    const n = db.prepare(
      `SELECT COUNT(DISTINCT user_id) AS n FROM entries WHERE contest_id = ? AND status != 'removed'`
    ).get(contest.id).n;
    const already = db.prepare('SELECT 1 FROM entries WHERE contest_id = ? AND user_id = ?').get(contest.id, req.user.id);
    if (!already && n >= contest.participant_cap) return res.status(409).json({ error: 'contest is full' });
  }

  let info;
  try {
    info = db
      .prepare(
        `INSERT INTO entries (contest_id, user_id, title, description, kind, body, language, file_path, mime_type, tags, status)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        contest.id,
        req.user.id,
        String(b.title).trim(),
        String(b.description || ''),
        kind,
        String(b.body || ''),
        String(b.language || ''),
        req.file ? req.file.path : null,
        req.file ? req.file.mimetype : null,
        JSON.stringify(typeof b.tags === 'string' ? b.tags.split(',').map((t) => t.trim()).filter(Boolean) : Array.isArray(b.tags) ? b.tags : []),
        flagged ? 'hidden' : 'visible'
      );
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) {
      return res.status(409).json({ error: 'you already submitted an entry with this title' });
    }
    throw err;
  }

  db.prepare(
    `INSERT INTO participants (contest_id, user_id, status) VALUES (?, ?, 'approved')
     ON CONFLICT (contest_id, user_id) DO NOTHING`
  ).run(contest.id, req.user.id);

  if (flagged) {
    db.prepare(
      `INSERT INTO reports (target_type, target_id, reporter_id, reason) VALUES ('entry', ?, ?, ?)`
    ).run(info.lastInsertRowid, req.user.id, 'auto-flagged: profanity filter');
  }

  auditLog(req.user.id, 'entry.create', 'entry', info.lastInsertRowid, `contest ${contest.id}`);
  const entry = db.prepare('SELECT * FROM entries WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json({
    ...serializeEntry(entry, contest, req.user),
    moderation: flagged ? 'held for review (flagged by profanity filter)' : 'ok',
  });
});

router.get('/contests/:id/entries', (req, res) => {
  const contest = getContest(req.params.id);
  if (!contest) return res.status(404).json({ error: 'contest not found' });
  if (!canView(contest, req.user, req.query.invite_code)) return res.status(403).json({ error: 'this contest is private' });
  const rows = db
    .prepare(`SELECT * FROM entries WHERE contest_id = ? AND status = 'visible' ORDER BY created_at DESC`)
    .all(contest.id);
  res.json({ entries: rows.map((e) => serializeEntry(e, contest, req.user)) });
});

router.get('/entries/:id', (req, res) => {
  const entry = db.prepare('SELECT * FROM entries WHERE id = ?').get(req.params.id);
  if (!entry || entry.status === 'removed') return res.status(404).json({ error: 'entry not found' });
  const contest = getContest(entry.contest_id);
  if (!canView(contest, req.user, req.query.invite_code)) return res.status(403).json({ error: 'this contest is private' });
  if (entry.status === 'hidden' && (!req.user || (req.user.id !== entry.user_id && req.user.role !== 'admin'))) {
    return res.status(404).json({ error: 'entry not found' });
  }
  res.json(serializeEntry(entry, contest, req.user));
});

// ---- Voting (req 3.4) ----

router.post('/entries/:id/vote', requireAuth, rateLimit({ max: 120 }), (req, res) => {
  const entry = db.prepare('SELECT * FROM entries WHERE id = ?').get(req.params.id);
  if (!entry || entry.status !== 'visible') return res.status(404).json({ error: 'entry not found' });
  const contest = getContest(entry.contest_id);
  if (!canView(contest, req.user, req.body?.invite_code)) return res.status(403).json({ error: 'this contest is private' });
  if (!votingOpen(contest)) return res.status(400).json({ error: 'voting is not open for this contest' });
  if (entry.user_id === req.user.id) return res.status(403).json({ error: 'you cannot vote on your own entry' });

  const criteria = db.prepare('SELECT * FROM criteria WHERE contest_id = ?').all(contest.id);
  const scores = req.body?.scores;
  if (!scores || typeof scores !== 'object') {
    return res.status(400).json({ error: 'scores object required: { "<criterion_id>": <score> }' });
  }
  for (const criterion of criteria) {
    const raw = scores[criterion.id] ?? scores[String(criterion.id)];
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0 || value > contest.scale_max) {
      return res.status(400).json({
        error: `score for criterion "${criterion.name}" must be a number between 0 and ${contest.scale_max}`,
      });
    }
  }

  // One vote per voter per entry: re-voting overwrites the previous ballot.
  const cast = db.transaction(() => {
    const stmt = db.prepare(
      `INSERT INTO votes (entry_id, voter_id, criterion_id, score) VALUES (?,?,?,?)
       ON CONFLICT (entry_id, voter_id, criterion_id)
       DO UPDATE SET score = excluded.score, updated_at = datetime('now')`
    );
    for (const criterion of criteria) {
      stmt.run(entry.id, req.user.id, criterion.id, Number(scores[criterion.id] ?? scores[String(criterion.id)]));
    }
  });
  cast();

  const updated = entryScore(entry.id);
  db.prepare('INSERT INTO score_history (contest_id, entry_id, score) VALUES (?,?,?)').run(
    contest.id, entry.id, updated ? updated.score : 0
  );
  auditLog(req.user.id, 'vote.cast', 'entry', entry.id);
  sseBroadcast(contest.id, 'leaderboard', {
    contest_id: contest.id,
    updated_entry: entry.id,
    leaderboard: computeLeaderboard(contest.id).map(({ per_criterion, ...row }) => row),
  });
  res.json({ ok: true, entry_score: updated ? updated.score : 0, pct_of_max: updated ? updated.pct_of_max : 0 });
});

// ---- Comments (req 3.4) ----

router.get('/entries/:id/comments', (req, res) => {
  const entry = db.prepare('SELECT * FROM entries WHERE id = ?').get(req.params.id);
  if (!entry) return res.status(404).json({ error: 'entry not found' });
  const contest = getContest(entry.contest_id);
  if (!canView(contest, req.user, req.query.invite_code)) return res.status(403).json({ error: 'this contest is private' });
  const rows = db
    .prepare(
      `SELECT c.id, c.body, c.created_at, u.id AS user_id, u.name, u.avatar_url
       FROM comments c JOIN users u ON u.id = c.user_id
       WHERE c.entry_id = ? AND c.status = 'visible' ORDER BY c.id DESC LIMIT 200`
    )
    .all(entry.id);
  res.json({ comments: rows });
});

router.post('/entries/:id/comments', requireAuth, rateLimit({ max: 30 }), (req, res) => {
  const entry = db.prepare('SELECT * FROM entries WHERE id = ?').get(req.params.id);
  if (!entry || entry.status !== 'visible') return res.status(404).json({ error: 'entry not found' });
  const contest = getContest(entry.contest_id);
  if (!canView(contest, req.user, req.body?.invite_code)) return res.status(403).json({ error: 'this contest is private' });
  const body = String(req.body?.body || '').trim();
  if (!body) return res.status(400).json({ error: 'comment body required' });
  if (containsProfanity(body)) return res.status(400).json({ error: 'comment rejected by the profanity filter' });

  const info = db.prepare('INSERT INTO comments (entry_id, user_id, body) VALUES (?,?,?)').run(entry.id, req.user.id, body);
  if (entry.user_id !== req.user.id) {
    notify(entry.user_id, 'comment', `New comment on your entry "${entry.title}"`, {
      entry_id: entry.id, contest_id: contest.id, comment_id: info.lastInsertRowid,
    });
  }
  auditLog(req.user.id, 'comment.create', 'comment', info.lastInsertRowid);
  res.status(201).json({ id: info.lastInsertRowid, body, created_at: new Date().toISOString() });
});

// ---- Abuse reporting (req 3.9) ----

router.post('/reports', requireAuth, rateLimit({ max: 20 }), (req, res) => {
  const { target_type, target_id, reason } = req.body || {};
  if (!['entry', 'comment', 'user', 'contest'].includes(target_type)) {
    return res.status(400).json({ error: 'target_type must be entry, comment, user or contest' });
  }
  const tables = { entry: 'entries', comment: 'comments', user: 'users', contest: 'contests' };
  const target = db.prepare(`SELECT * FROM ${tables[target_type]} WHERE id = ?`).get(Number(target_id));
  if (!target) return res.status(404).json({ error: 'report target not found' });
  if (!reason || !String(reason).trim()) return res.status(400).json({ error: 'reason required' });

  const info = db
    .prepare('INSERT INTO reports (target_type, target_id, reporter_id, reason) VALUES (?,?,?,?)')
    .run(target_type, Number(target_id), req.user.id, String(reason).trim().slice(0, 1000));
  auditLog(req.user.id, 'report.create', target_type, Number(target_id), reason);

  const contestId = target_type === 'entry' ? target.contest_id
    : target_type === 'comment' ? db.prepare('SELECT contest_id FROM entries WHERE id = ?').get(target.entry_id)?.contest_id
    : target_type === 'contest' ? target.id : null;
  if (contestId) dispatchWebhooks(contestId, 'abuse.reported', { report_id: info.lastInsertRowid, target_type });

  for (const admin of db.prepare(`SELECT id FROM users WHERE role = 'admin'`).all()) {
    notify(admin.id, 'report', `New abuse report on ${target_type} #${target_id}`, { report_id: info.lastInsertRowid });
  }
  res.status(201).json({ id: info.lastInsertRowid, status: 'open' });
});

module.exports = { router };

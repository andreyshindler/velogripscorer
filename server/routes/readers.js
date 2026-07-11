'use strict';

const crypto = require('crypto');
const express = require('express');
const { db, auditLog } = require('../db');
const { requireAuth } = require('../auth');
const { sseBroadcast } = require('../events');
const { getContest, isOrganizer } = require('./contests');

const router = express.Router();

const MAX_BATCH = 500;
const EPC_RE = /^[0-9A-Fa-f]{4,64}$/;

function organizerContest(req, res) {
  const contest = getContest(req.params.id);
  if (!contest) { res.status(404).json({ error: 'contest not found' }); return null; }
  if (!isOrganizer(contest, req.user)) { res.status(403).json({ error: 'organizer only' }); return null; }
  return contest;
}

// ---- Reader device management (organizer) ----

router.post('/contests/:id/readers', requireAuth, (req, res) => {
  const contest = organizerContest(req, res);
  if (!contest) return;
  const name = String(req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'reader name required' });
  const token = `vgr_${crypto.randomBytes(24).toString('hex')}`;
  const info = db
    .prepare('INSERT INTO readers (contest_id, name, token, location) VALUES (?,?,?,?)')
    .run(contest.id, name, token, String(req.body?.location || '').trim());
  auditLog(req.user.id, 'reader.create', 'contest', contest.id, name);
  res.status(201).json({ id: info.lastInsertRowid, name, token, location: req.body?.location || '' });
});

router.get('/contests/:id/readers', requireAuth, (req, res) => {
  const contest = organizerContest(req, res);
  if (!contest) return;
  const readers = db
    .prepare(
      `SELECT r.id, r.name, r.token, r.location, r.last_seen, r.created_at,
        (SELECT COUNT(*) FROM tag_reads WHERE reader_id = r.id) AS read_count
       FROM readers r WHERE r.contest_id = ? ORDER BY r.id`
    )
    .all(contest.id);
  res.json({ readers });
});

router.delete('/contests/:id/readers/:rid', requireAuth, (req, res) => {
  const contest = organizerContest(req, res);
  if (!contest) return;
  const info = db.prepare('DELETE FROM readers WHERE id = ? AND contest_id = ?').run(req.params.rid, contest.id);
  if (!info.changes) return res.status(404).json({ error: 'reader not found' });
  auditLog(req.user.id, 'reader.delete', 'contest', contest.id, `reader ${req.params.rid}`);
  res.json({ ok: true });
});

// ---- Ingestion: called by the Android bridge app, authenticated by reader token ----

router.post('/ingest/reads', (req, res) => {
  const token = req.headers['x-reader-token'] || req.body?.token;
  if (!token) return res.status(401).json({ error: 'X-Reader-Token header required' });
  const reader = db.prepare('SELECT * FROM readers WHERE token = ?').get(String(token));
  if (!reader) return res.status(401).json({ error: 'unknown reader token' });

  const reads = Array.isArray(req.body?.reads) ? req.body.reads.slice(0, MAX_BATCH) : null;
  if (!reads) return res.status(400).json({ error: 'reads array required' });

  const assignments = new Map(
    db.prepare('SELECT epc, bib, participant FROM tag_assignments WHERE contest_id = ?')
      .all(reader.contest_id).map((a) => [a.epc.toUpperCase(), a])
  );

  const accepted = [];
  const insert = db.prepare(
    'INSERT INTO tag_reads (reader_id, contest_id, epc, rssi, read_at) VALUES (?,?,?,?,?)'
  );
  const tx = db.transaction(() => {
    for (const r of reads) {
      const epc = String(r?.epc || '').toUpperCase();
      if (!EPC_RE.test(epc)) continue;
      const readAt = r.read_at && !Number.isNaN(Date.parse(r.read_at)) ? new Date(r.read_at).toISOString() : new Date().toISOString();
      const rssi = Number.isFinite(Number(r.rssi)) ? Number(r.rssi) : null;
      const info = insert.run(reader.id, reader.contest_id, epc, rssi, readAt);
      accepted.push({ id: info.lastInsertRowid, epc, rssi, read_at: readAt, ...(assignments.get(epc) || {}) });
    }
    db.prepare(`UPDATE readers SET last_seen = datetime('now') WHERE id = ?`).run(reader.id);
  });
  tx();

  if (accepted.length) {
    sseBroadcast(reader.contest_id, 'tag_reads', {
      reader: { id: reader.id, name: reader.name, location: reader.location },
      reads: accepted.slice(-50),
    });
  }
  res.json({ ok: true, accepted: accepted.length, rejected: reads.length - accepted.length });
});

// Lightweight connectivity check for the app's "Test connection" button.
router.get('/ingest/ping', (req, res) => {
  const token = req.headers['x-reader-token'];
  const reader = token ? db.prepare('SELECT * FROM readers WHERE token = ?').get(String(token)) : null;
  if (!reader) return res.status(401).json({ error: 'unknown reader token' });
  const contest = getContest(reader.contest_id);
  res.json({ ok: true, reader: { id: reader.id, name: reader.name, location: reader.location }, contest: { id: contest.id, title: contest.title } });
});

// ---- Reads & timing (organizer) ----

router.get('/contests/:id/reads', requireAuth, (req, res) => {
  const contest = organizerContest(req, res);
  if (!contest) return;
  const limit = Math.min(Number(req.query.limit) || 200, 2000);
  const rows = db
    .prepare(
      `SELECT t.id, t.epc, t.rssi, t.read_at, t.received_at,
              r.name AS reader_name, r.location AS reader_location,
              a.bib, a.participant
       FROM tag_reads t
       JOIN readers r ON r.id = t.reader_id
       LEFT JOIN tag_assignments a ON a.contest_id = t.contest_id AND a.epc = t.epc
       WHERE t.contest_id = ?
       ORDER BY t.id DESC LIMIT ?`
    )
    .all(contest.id, limit);

  if (req.query.format === 'csv') {
    const header = 'read_at,epc,bib,participant,reader,location,rssi';
    const cell = (v) => (/[",\n]/.test(String(v ?? '')) ? `"${String(v).replace(/"/g, '""')}"` : String(v ?? ''));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="reads-${contest.id}.csv"`);
    return res.send(
      [header, ...rows.map((x) => [x.read_at, x.epc, cell(x.bib), cell(x.participant), cell(x.reader_name), cell(x.reader_location), x.rssi ?? ''].join(','))].join('\n') + '\n'
    );
  }
  res.json({ reads: rows });
});

// Per-EPC summary: first/last passing and lap counts — a simple timing view.
router.get('/contests/:id/passings', requireAuth, (req, res) => {
  const contest = organizerContest(req, res);
  if (!contest) return;
  const rows = db
    .prepare(
      `SELECT t.epc, a.bib, a.participant,
              COUNT(*) AS passes, MIN(t.read_at) AS first_read, MAX(t.read_at) AS last_read
       FROM tag_reads t
       LEFT JOIN tag_assignments a ON a.contest_id = t.contest_id AND a.epc = t.epc
       WHERE t.contest_id = ?
       GROUP BY t.epc ORDER BY MIN(t.read_at)`
    )
    .all(contest.id)
    .map((r) => ({
      ...r,
      elapsed_seconds: Math.round((Date.parse(r.last_read) - Date.parse(r.first_read)) / 1000),
    }));
  res.json({ passings: rows });
});

// ---- EPC → participant assignment ----

router.get('/contests/:id/tags', requireAuth, (req, res) => {
  const contest = organizerContest(req, res);
  if (!contest) return;
  res.json({ tags: db.prepare('SELECT epc, bib, participant, user_id FROM tag_assignments WHERE contest_id = ? ORDER BY bib, epc').all(contest.id) });
});

router.post('/contests/:id/tags', requireAuth, (req, res) => {
  const contest = organizerContest(req, res);
  if (!contest) return;
  const epc = String(req.body?.epc || '').toUpperCase().trim();
  const participant = String(req.body?.participant || '').trim();
  if (!EPC_RE.test(epc)) return res.status(400).json({ error: 'epc must be a 4-64 char hex string' });
  if (!participant) return res.status(400).json({ error: 'participant name required' });
  db.prepare(
    `INSERT INTO tag_assignments (contest_id, epc, bib, participant, user_id) VALUES (?,?,?,?,?)
     ON CONFLICT (contest_id, epc) DO UPDATE SET bib = excluded.bib, participant = excluded.participant, user_id = excluded.user_id`
  ).run(contest.id, epc, String(req.body?.bib || '').trim(), participant, req.body?.user_id ?? null);
  auditLog(req.user.id, 'tag.assign', 'contest', contest.id, `${epc} -> ${participant}`);
  res.status(201).json({ ok: true });
});

router.delete('/contests/:id/tags/:epc', requireAuth, (req, res) => {
  const contest = organizerContest(req, res);
  if (!contest) return;
  db.prepare('DELETE FROM tag_assignments WHERE contest_id = ? AND epc = ?').run(contest.id, String(req.params.epc).toUpperCase());
  res.json({ ok: true });
});

module.exports = { router };

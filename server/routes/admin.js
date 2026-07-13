'use strict';

const express = require('express');
const { db, auditLog } = require('../db');
const { requireAdmin } = require('../auth');
const { notify } = require('../events');

const router = express.Router();

// Scope the admin guard to /admin/* only — this router is mounted at /api and
// unmatched /api requests flow through it on their way to later routers.
router.use('/admin', requireAdmin);

// Moderation queue (req 3.9)
router.get('/admin/reports', (req, res) => {
  const status = ['open', 'resolved', 'dismissed'].includes(req.query.status) ? req.query.status : 'open';
  const rows = db
    .prepare(
      `SELECT r.*, u.name AS reporter_name FROM reports r
       JOIN users u ON u.id = r.reporter_id WHERE r.status = ? ORDER BY r.id DESC LIMIT 100`
    )
    .all(status)
    .map((r) => {
      const tables = { entry: 'entries', comment: 'comments', user: 'users', contest: 'contests' };
      const target = db.prepare(`SELECT * FROM ${tables[r.target_type]} WHERE id = ?`).get(r.target_id);
      if (target) delete target.password_hash;
      return { ...r, target };
    });
  res.json({ reports: rows });
});

// Act on a report: dismiss, remove content, or ban the offending user (req 3.9)
router.post('/admin/reports/:id/resolve', (req, res) => {
  const report = db.prepare('SELECT * FROM reports WHERE id = ?').get(req.params.id);
  if (!report) return res.status(404).json({ error: 'report not found' });
  if (report.status !== 'open') return res.status(400).json({ error: 'report already handled' });

  const action = req.body?.action;
  if (!['dismiss', 'remove', 'ban'].includes(action)) {
    return res.status(400).json({ error: 'action must be dismiss, remove, or ban' });
  }

  let offenderId = null;
  if (action !== 'dismiss') {
    if (report.target_type === 'entry') {
      const entry = db.prepare('SELECT * FROM entries WHERE id = ?').get(report.target_id);
      if (entry) {
        db.prepare(`UPDATE entries SET status = 'removed' WHERE id = ?`).run(entry.id);
        offenderId = entry.user_id;
      }
    } else if (report.target_type === 'comment') {
      const comment = db.prepare('SELECT * FROM comments WHERE id = ?').get(report.target_id);
      if (comment) {
        db.prepare(`UPDATE comments SET status = 'removed' WHERE id = ?`).run(comment.id);
        offenderId = comment.user_id;
      }
    } else if (report.target_type === 'contest') {
      db.prepare(`UPDATE contests SET status = 'archived' WHERE id = ?`).run(report.target_id);
      offenderId = db.prepare('SELECT organizer_id FROM contests WHERE id = ?').get(report.target_id)?.organizer_id;
    } else if (report.target_type === 'user') {
      offenderId = report.target_id;
    }
    if (action === 'ban' && offenderId) {
      db.prepare('UPDATE users SET is_banned = 1 WHERE id = ?').run(offenderId);
      auditLog(req.user.id, 'admin.ban_user', 'user', offenderId, `report ${report.id}`);
    }
    if (offenderId) {
      notify(offenderId, 'moderation', `Your content was moderated following an abuse report`, { report_id: report.id, action });
    }
  }

  db.prepare(`UPDATE reports SET status = ?, resolved_by = ? WHERE id = ?`).run(
    action === 'dismiss' ? 'dismissed' : 'resolved', req.user.id, report.id
  );
  auditLog(req.user.id, `admin.report_${action}`, report.target_type, report.target_id, `report ${report.id}`);
  res.json({ ok: true, action });
});

// Restore or lift moderation manually
router.post('/admin/entries/:id/status', (req, res) => {
  const status = req.body?.status;
  if (!['visible', 'hidden', 'removed'].includes(status)) return res.status(400).json({ error: 'invalid status' });
  const info = db.prepare('UPDATE entries SET status = ? WHERE id = ?').run(status, req.params.id);
  if (!info.changes) return res.status(404).json({ error: 'entry not found' });
  auditLog(req.user.id, 'admin.entry_status', 'entry', Number(req.params.id), status);
  res.json({ ok: true });
});

router.post('/admin/users/:id/ban', (req, res) => {
  const banned = req.body?.banned === undefined ? 1 : req.body.banned ? 1 : 0;
  const info = db.prepare('UPDATE users SET is_banned = ? WHERE id = ?').run(banned, req.params.id);
  if (!info.changes) return res.status(404).json({ error: 'user not found' });
  auditLog(req.user.id, banned ? 'admin.ban_user' : 'admin.unban_user', 'user', Number(req.params.id));
  res.json({ ok: true, banned: !!banned });
});

router.get('/admin/users', (req, res) => {
  const rows = db
    .prepare('SELECT id, email, name, role, reputation, is_banned, created_at FROM users ORDER BY id DESC LIMIT 200')
    .all();
  res.json({ users: rows });
});

// Immutable audit trail (req 3.9)
router.get('/admin/audit-log', (req, res) => {
  const rows = db
    .prepare(
      `SELECT a.*, u.name AS user_name FROM audit_log a
       LEFT JOIN users u ON u.id = a.user_id ORDER BY a.id DESC LIMIT 500`
    )
    .all();
  res.json({ audit_log: rows });
});

module.exports = { router };

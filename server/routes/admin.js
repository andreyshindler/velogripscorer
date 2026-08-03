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
    .prepare('SELECT id, email, name, role, reputation, is_banned, approved, created_at FROM users ORDER BY id DESC LIMIT 200')
    .all();
  res.json({ users: rows });
});

// Approve a pending self-registration so the account can log in.
router.post('/admin/users/:id/approve', (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'user not found' });
  db.prepare('UPDATE users SET approved = 1 WHERE id = ?').run(user.id);
  auditLog(req.user.id, 'admin.approve_user', 'user', user.id);
  notify(user.id, 'account_approved', 'Your account has been approved — you can now log in.');
  res.json({ ok: true });
});

// Reject (and remove) a still-pending registration. Guarded to approved = 0 so
// it can never delete an active account.
router.post('/admin/users/:id/reject', (req, res) => {
  const info = db.prepare('DELETE FROM users WHERE id = ? AND approved = 0').run(req.params.id);
  if (!info.changes) return res.status(404).json({ error: 'no pending registration with that id' });
  auditLog(req.user.id, 'admin.reject_user', 'user', Number(req.params.id));
  res.json({ ok: true });
});

// Permanently delete a user account. Refuses to delete yourself, another admin,
// or anyone who owns races (those must be removed/reassigned first, so results
// are never destroyed implicitly). Other dependent rows are cleaned up in a
// transaction since the schema has no ON DELETE CASCADE from users.
router.delete('/admin/users/:id', (req, res) => {
  const id = Number(req.params.id);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!user) return res.status(404).json({ error: 'user not found' });
  if (id === req.user.id) return res.status(400).json({ error: 'you cannot delete your own account' });
  if (user.role === 'admin') return res.status(400).json({ error: 'cannot delete an admin account' });
  const owned = db.prepare('SELECT COUNT(*) AS n FROM contests WHERE organizer_id = ?').get(id).n;
  if (owned > 0) return res.status(409).json({ error: 'this user owns races — delete or reassign those races first' });

  try {
    db.transaction(() => {
      db.prepare('DELETE FROM votes WHERE voter_id = ?').run(id);
      db.prepare('DELETE FROM comments WHERE user_id = ?').run(id);
      db.prepare('DELETE FROM awards WHERE user_id = ?').run(id);
      db.prepare('DELETE FROM entries WHERE user_id = ?').run(id); // cascades votes/comments on them
      db.prepare('DELETE FROM participants WHERE user_id = ?').run(id);
      db.prepare('DELETE FROM follows WHERE user_id = ?').run(id);
      db.prepare('DELETE FROM reports WHERE reporter_id = ?').run(id);
      db.prepare('UPDATE reports SET resolved_by = NULL WHERE resolved_by = ?').run(id);
      db.prepare('DELETE FROM notifications WHERE user_id = ?').run(id);
      db.prepare('UPDATE tag_assignments SET user_id = NULL WHERE user_id = ?').run(id);
      db.prepare('UPDATE leagues SET created_by = NULL WHERE created_by = ?').run(id);
      db.prepare('UPDATE audit_log SET user_id = NULL WHERE user_id = ?').run(id);
      db.prepare('DELETE FROM users WHERE id = ?').run(id);
    })();
  } catch (err) {
    return res.status(409).json({ error: 'could not delete: user still has associated data' });
  }
  auditLog(req.user.id, 'admin.delete_user', 'user', id);
  res.json({ ok: true });
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

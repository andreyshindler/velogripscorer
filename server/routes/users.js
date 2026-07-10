'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const { db, auditLog } = require('../db');
const { signToken, requireAuth, rateLimit } = require('../auth');

const router = express.Router();

const PUBLIC_USER_FIELDS = 'id, name, role, bio, avatar_url, links, is_public, reputation, created_at';

function publicUser(user, viewer) {
  const self = viewer && (viewer.id === user.id || viewer.role === 'admin');
  if (!user.is_public && !self) {
    return { id: user.id, name: user.name, is_public: 0 };
  }
  const { id, name, role, bio, avatar_url, links, is_public, reputation, created_at } = user;
  return { id, name, role, bio, avatar_url, links: JSON.parse(links || '[]'), is_public, reputation, created_at, ...(self ? { email: user.email } : {}) };
}

router.post('/auth/register', rateLimit({ max: 20 }), (req, res) => {
  const { email, password, name } = req.body || {};
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return res.status(400).json({ error: 'valid email required' });
  }
  if (!password || password.length < 8) {
    return res.status(400).json({ error: 'password must be at least 8 characters' });
  }
  if (!name || !name.trim()) return res.status(400).json({ error: 'name required' });

  const hash = bcrypt.hashSync(password, 10);
  try {
    const info = db
      .prepare('INSERT INTO users (email, password_hash, name) VALUES (?, ?, ?)')
      .run(email.toLowerCase(), hash, name.trim());
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
    auditLog(user.id, 'user.register', 'user', user.id);
    res.status(201).json({ token: signToken(user), user: publicUser(user, user) });
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) {
      return res.status(409).json({ error: 'email already registered' });
    }
    throw err;
  }
});

router.post('/auth/login', rateLimit({ max: 20 }), (req, res) => {
  const { email, password } = req.body || {};
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(String(email || '').toLowerCase());
  if (!user || !bcrypt.compareSync(String(password || ''), user.password_hash)) {
    return res.status(401).json({ error: 'invalid credentials' });
  }
  if (user.is_banned) return res.status(403).json({ error: 'account is banned' });
  auditLog(user.id, 'user.login', 'user', user.id);
  res.json({ token: signToken(user), user: publicUser(user, user) });
});

router.get('/users/me', requireAuth, (req, res) => {
  res.json(publicUser(req.user, req.user));
});

router.patch('/users/me', requireAuth, (req, res) => {
  const { name, bio, avatar_url, links, is_public } = req.body || {};
  const user = req.user;
  db.prepare(
    `UPDATE users SET name = ?, bio = ?, avatar_url = ?, links = ?, is_public = ? WHERE id = ?`
  ).run(
    name !== undefined && String(name).trim() ? String(name).trim() : user.name,
    bio !== undefined ? String(bio) : user.bio,
    avatar_url !== undefined ? String(avatar_url) : user.avatar_url,
    links !== undefined ? JSON.stringify(links) : user.links,
    is_public !== undefined ? (is_public ? 1 : 0) : user.is_public,
    user.id
  );
  auditLog(user.id, 'user.update_profile', 'user', user.id);
  res.json(publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(user.id), user));
});

router.get('/users/:id', (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'user not found' });
  res.json(publicUser(user, req.user));
});

// Activity history / dashboard data (req 3.1, UI 6)
router.get('/users/:id/activity', (req, res) => {
  const id = Number(req.params.id);
  const user = db.prepare(`SELECT ${PUBLIC_USER_FIELDS} FROM users WHERE id = ?`).get(id);
  if (!user) return res.status(404).json({ error: 'user not found' });
  const self = req.user && (req.user.id === id || req.user.role === 'admin');
  if (!user.is_public && !self) return res.status(403).json({ error: 'profile is private' });

  const created = db
    .prepare(`SELECT id, title, category, status, start_at, end_at FROM contests WHERE organizer_id = ? ORDER BY created_at DESC`)
    .all(id);
  const joined = db
    .prepare(
      `SELECT DISTINCT c.id, c.title, c.category, c.status FROM entries e
       JOIN contests c ON c.id = e.contest_id WHERE e.user_id = ? ORDER BY c.created_at DESC`
    )
    .all(id);
  const awards = db
    .prepare(
      `SELECT a.*, c.title AS contest_title, e.title AS entry_title FROM awards a
       JOIN contests c ON c.id = a.contest_id JOIN entries e ON e.id = a.entry_id
       WHERE a.user_id = ? ORDER BY a.created_at DESC`
    )
    .all(id);
  res.json({ user, created_contests: created, joined_contests: joined, awards });
});

// GDPR-style export of the requesting user's own data (NFR privacy)
router.get('/users/me/export', requireAuth, (req, res) => {
  const id = req.user.id;
  const dump = {
    user: publicUser(req.user, req.user),
    entries: db.prepare('SELECT * FROM entries WHERE user_id = ?').all(id),
    votes: db.prepare('SELECT * FROM votes WHERE voter_id = ?').all(id),
    comments: db.prepare('SELECT * FROM comments WHERE user_id = ?').all(id),
    notifications: db.prepare('SELECT * FROM notifications WHERE user_id = ?').all(id),
  };
  auditLog(id, 'user.data_export', 'user', id);
  res.setHeader('Content-Disposition', 'attachment; filename="my-data.json"');
  res.json(dump);
});

// ---- Notifications (req 3.6) ----

router.get('/notifications', requireAuth, (req, res) => {
  const rows = db
    .prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 50')
    .all(req.user.id)
    .map((n) => ({ ...n, data: JSON.parse(n.data) }));
  res.json({ notifications: rows, unread: rows.filter((n) => !n.read).length });
});

router.post('/notifications/read', requireAuth, (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Number.isInteger) : null;
  if (ids && ids.length) {
    const stmt = db.prepare('UPDATE notifications SET read = 1 WHERE user_id = ? AND id = ?');
    for (const nid of ids) stmt.run(req.user.id, nid);
  } else {
    db.prepare('UPDATE notifications SET read = 1 WHERE user_id = ?').run(req.user.id);
  }
  res.json({ ok: true });
});

module.exports = { router, publicUser };

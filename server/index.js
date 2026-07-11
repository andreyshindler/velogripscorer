'use strict';

const path = require('path');
const express = require('express');
const bcrypt = require('bcryptjs');
const { db, DATA_DIR } = require('./db');
const { optionalAuth } = require('./auth');
const users = require('./routes/users');
const contests = require('./routes/contests');
const entries = require('./routes/entries');
const admin = require('./routes/admin');
const readers = require('./routes/readers');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);

app.use(express.json({ limit: '1mb' }));
app.use((_req, res, next) => {
  // Basic hardening headers (OWASP baseline); TLS termination is the proxy's job.
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});
app.use(optionalAuth);

app.get('/api/health', (_req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

app.use('/api', users.router);
app.use('/api', contests.router);
app.use('/api', entries.router);
app.use('/api', admin.router);
app.use('/api', readers.router);

app.get('/openapi.yaml', (_req, res) => res.sendFile(path.join(__dirname, '..', 'openapi.yaml')));
app.use('/uploads', express.static(path.join(DATA_DIR, 'uploads')));
app.use(express.static(path.join(__dirname, '..', 'public')));
// SPA fallback: any non-API GET serves the app shell.
app.get(/^\/(?!api\/|uploads\/).*/, (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  const status = err.name === 'MulterError' || /unsupported file type/.test(err.message) ? 400 : 500;
  if (status === 500) console.error(err);
  res.status(status).json({ error: status === 400 ? err.message : 'internal server error' });
});

// Seed an administrator account on first boot (configurable via env).
function seedAdmin() {
  const email = (process.env.ADMIN_EMAIL || 'admin@velogripscorer.local').toLowerCase();
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (existing) return;
  const password = process.env.ADMIN_PASSWORD || 'change-me-please';
  db.prepare(`INSERT INTO users (email, password_hash, name, role) VALUES (?, ?, ?, 'admin')`).run(
    email, bcrypt.hashSync(password, 10), 'Administrator'
  );
  console.log(`Seeded admin account: ${email}`);
}

function start(port = process.env.PORT || 3000) {
  seedAdmin();
  setInterval(contests.sweepEndedContests, 60_000).unref();
  return app.listen(port, () => console.log(`velogripscorer listening on http://localhost:${port}`));
}

if (require.main === module) start();

module.exports = { app, start, seedAdmin };

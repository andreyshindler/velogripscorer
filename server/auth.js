'use strict';

const jwt = require('jsonwebtoken');
const { db } = require('./db');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const TOKEN_TTL = '7d';

function signToken(user) {
  return jwt.sign({ sub: user.id, role: user.role }, JWT_SECRET, { expiresIn: TOKEN_TTL });
}

// Populates req.user when a valid Bearer token is present; never rejects.
function optionalAuth(req, _res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (token) {
    try {
      const payload = jwt.verify(token, JWT_SECRET);
      const user = db.prepare('SELECT * FROM users WHERE id = ?').get(payload.sub);
      if (user && !user.is_banned) req.user = user;
    } catch {
      /* invalid token -> treated as anonymous */
    }
  }
  next();
}

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'authentication required' });
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'authentication required' });
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'admin only' });
  next();
}

// Simple in-memory fixed-window rate limiter (anti-fraud requirement 3.4).
function rateLimit({ windowMs = 60_000, max = 60 } = {}) {
  if (process.env.DISABLE_RATE_LIMIT) return (_req, _res, next) => next();
  const hits = new Map();
  setInterval(() => hits.clear(), windowMs).unref();
  return (req, res, next) => {
    const key = req.user ? `u${req.user.id}` : req.ip;
    const n = (hits.get(key) || 0) + 1;
    hits.set(key, n);
    if (n > max) return res.status(429).json({ error: 'rate limit exceeded, slow down' });
    next();
  };
}

module.exports = { signToken, optionalAuth, requireAuth, requireAdmin, rateLimit, JWT_SECRET };

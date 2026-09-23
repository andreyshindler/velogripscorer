'use strict';

// A human-readable activity log, one file per day, capturing what people do on
// the web and in the Telegram bot. Lives under DATA_DIR/logs (persistent volume,
// git-ignored) by default; override with LOG_DIR. Writing must never throw — a
// logging failure must not break a request or a bot command.

const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./db');

const LOG_DIR = process.env.LOG_DIR || path.join(DATA_DIR, 'logs');
try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch { /* best effort */ }

// One file per calendar day: logs/YYYY-MM-DD.log (UTC date).
function fileForToday(now = new Date()) {
  return path.join(LOG_DIR, `${now.toISOString().slice(0, 10)}.log`);
}

// source: 'web' | 'bot'. actor: user id/email or Telegram id. action: what was
// done. details: optional extra context. One pipe-delimited line so every entry
// is clearly keyed by timestamp and user:
//   <ISO timestamp> | <source> | user=<actor> | <action> | <details>
function logActivity(source, actor, action, details) {
  try {
    const now = new Date();
    const clean = (s) => String(s == null ? '' : s).replace(/[\r\n|]+/g, ' ').trim();
    const parts = [now.toISOString(), source, `user=${clean(actor) || '-'}`, clean(action)];
    if (details != null && String(details) !== '') parts.push(clean(details));
    fs.appendFile(fileForToday(now), parts.join(' | ') + '\n', () => { /* ignore write errors */ });
  } catch { /* logging must never crash the caller */ }
}

module.exports = { logActivity, LOG_DIR, fileForToday };

'use strict';

// SMTP email sender for the Telegram "email results" flow. Configured entirely
// by env vars; when SMTP isn't configured, isConfigured() is false and callers
// tell the operator instead of silently dropping the mail.
//
//   SMTP_HOST                 SMTP server host (required to enable email)
//   SMTP_PORT                 default 587
//   SMTP_SECURE               'true' for implicit TLS (port 465), else STARTTLS
//   SMTP_USER, SMTP_PASS      credentials (optional for open relays)
//   EMAIL_FROM                From address (defaults to SMTP_USER)
//   EMAIL_RECIPIENTS          comma-separated predefined recipients, each
//                             "a@b.com" or "Name <a@b.com>"

const nodemailer = require('nodemailer');
const { db } = require('./db');

const EMAIL_RE = /^\S+@\S+\.\S+$/;

function isConfigured() {
  return !!(process.env.SMTP_HOST && (process.env.EMAIL_FROM || process.env.SMTP_USER));
}

// Parse an "a@b.com" / "Name <a@b.com>" entry -> { label, email } or null.
function parseEntry(entry) {
  const m = String(entry || '').match(/^(.*?)<\s*([^>]+?)\s*>$/);
  const email = (m ? m[2] : entry).trim();
  const label = m && m[1].trim() ? m[1].trim() : email;
  return EMAIL_RE.test(email) ? { label, email } : null;
}

// The static EMAIL_RECIPIENTS env list (order preserved).
function envRecipients() {
  return String(process.env.EMAIL_RECIPIENTS || '')
    .split(',').map((s) => s.trim()).filter(Boolean)
    .map(parseEntry).filter(Boolean);
}

// Recipients saved via the bot (DB), oldest first.
function savedRecipients() {
  return db.prepare('SELECT id, label, email FROM email_recipients ORDER BY id').all();
}

// Add a recipient to the DB list. Returns { ok, error?, recipient? }.
function addRecipient(entry) {
  const parsed = parseEntry(entry);
  if (!parsed) return { ok: false, error: 'not a valid email address' };
  try {
    const info = db.prepare('INSERT INTO email_recipients (label, email) VALUES (?, ?)')
      .run(parsed.label, parsed.email);
    return { ok: true, recipient: { id: info.lastInsertRowid, ...parsed } };
  } catch (err) {
    if (/UNIQUE/i.test(String(err.message))) return { ok: false, error: 'that address is already in the list' };
    throw err;
  }
}

function removeRecipient(id) {
  return db.prepare('DELETE FROM email_recipients WHERE id = ?').run(id).changes > 0;
}

// The merged picker list: env entries first, then saved ones, deduped by email
// (case-insensitive). Saved entries carry their `id` (so they're deletable).
function recipients() {
  const seen = new Set();
  const out = [];
  for (const r of envRecipients()) {
    const key = r.email.toLowerCase();
    if (!seen.has(key)) { seen.add(key); out.push({ label: r.label, email: r.email }); }
  }
  for (const r of savedRecipients()) {
    const key = r.email.toLowerCase();
    if (!seen.has(key)) { seen.add(key); out.push({ label: r.label, email: r.email, id: r.id }); }
  }
  return out;
}

let _transport = null;
function transport() {
  if (!_transport) {
    _transport = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: String(process.env.SMTP_SECURE || '').toLowerCase() === 'true',
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
    });
  }
  return _transport;
}

async function sendMail({ to, subject, text, attachments }) {
  if (!isConfigured()) throw new Error('email is not configured');
  const from = process.env.EMAIL_FROM || process.env.SMTP_USER;
  return transport().sendMail({ from, to, subject, text, attachments });
}

module.exports = { isConfigured, recipients, savedRecipients, addRecipient, removeRecipient, sendMail };

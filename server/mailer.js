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

function isConfigured() {
  return !!(process.env.SMTP_HOST && (process.env.EMAIL_FROM || process.env.SMTP_USER));
}

// Parse EMAIL_RECIPIENTS -> [{ label, email }], dropping anything without a
// plausible address. Order is preserved (the buttons follow it).
function recipients() {
  return String(process.env.EMAIL_RECIPIENTS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const m = entry.match(/^(.*?)<\s*([^>]+?)\s*>$/);
      const email = (m ? m[2] : entry).trim();
      const label = m && m[1].trim() ? m[1].trim() : email;
      return { label, email };
    })
    .filter((r) => /.+@.+\..+/.test(r.email));
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

module.exports = { isConfigured, recipients, sendMail };

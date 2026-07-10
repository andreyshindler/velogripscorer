'use strict';

const crypto = require('crypto');
const { db } = require('./db');

// ---- SSE hub: real-time leaderboard/score updates per contest (req 3.4 / NFR <=2s) ----

const channels = new Map(); // contestId -> Set<res>

function sseSubscribe(contestId, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write('retry: 2000\n\n');
  let set = channels.get(contestId);
  if (!set) channels.set(contestId, (set = new Set()));
  set.add(res);
  const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
  res.on('close', () => {
    clearInterval(ping);
    set.delete(res);
    if (set.size === 0) channels.delete(contestId);
  });
}

function sseBroadcast(contestId, event, data) {
  const set = channels.get(contestId);
  if (!set) return;
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of set) res.write(frame);
}

// ---- In-app notifications (req 3.6) ----

function notify(userId, type, message, data = {}) {
  db.prepare(
    'INSERT INTO notifications (user_id, type, message, data) VALUES (?, ?, ?, ?)'
  ).run(userId, type, message, JSON.stringify(data));
}

// ---- Outbound webhooks (req 3.10): best-effort, HMAC-signed ----

function dispatchWebhooks(contestId, event, payload) {
  const hooks = db.prepare('SELECT * FROM webhooks WHERE contest_id = ?').all(contestId);
  for (const hook of hooks) {
    let events;
    try { events = JSON.parse(hook.events); } catch { events = []; }
    if (!events.includes(event)) continue;
    const body = JSON.stringify({ event, contest_id: contestId, payload, ts: new Date().toISOString() });
    const signature = crypto.createHmac('sha256', hook.secret || '').update(body).digest('hex');
    fetch(hook.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Signature-256': `sha256=${signature}` },
      body,
      signal: AbortSignal.timeout(5000),
    }).catch(() => { /* best-effort delivery; failures are ignored */ });
  }
}

module.exports = { sseSubscribe, sseBroadcast, notify, dispatchWebhooks };

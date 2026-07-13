'use strict';

const crypto = require('crypto');
const express = require('express');
const { db, auditLog } = require('../db');
const { requireAuth } = require('../auth');
const { sseBroadcast } = require('../events');
const multer = require('multer');
const { parseXlsx } = require('../xlsx');
const { getContest, isOrganizer, canView } = require('./contests');

const uploadMemory = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const router = express.Router();

const MAX_BATCH = 500;
const EPC_RE = /^[0-9A-Fa-f]{4,64}$/;

function viewableContest(req, res) {
  const contest = getContest(req.params.id);
  if (!contest) { res.status(404).json({ error: 'contest not found' }); return null; }
  if (!canView(contest, req.user, req.query.invite_code)) {
    res.status(403).json({ error: 'this contest is private' });
    return null;
  }
  return contest;
}

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
    'INSERT INTO tag_reads (reader_id, contest_id, epc, rssi, antenna, read_at) VALUES (?,?,?,?,?,?)'
  );
  const tx = db.transaction(() => {
    for (const r of reads) {
      const epc = String(r?.epc || '').toUpperCase();
      if (!EPC_RE.test(epc)) continue;
      const readAt = r.read_at && !Number.isNaN(Date.parse(r.read_at)) ? new Date(r.read_at).toISOString() : new Date().toISOString();
      const rssi = Number.isFinite(Number(r.rssi)) ? Number(r.rssi) : null;
      const antenna = r.antenna != null && Number.isInteger(Number(r.antenna)) ? Number(r.antenna) : null;
      const info = insert.run(reader.id, reader.contest_id, epc, rssi, antenna, readAt);
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

// Start-list download for the offline timing app (reader-token auth):
// everything the phone needs to run the race with no connectivity.
router.get('/ingest/startlist', (req, res) => {
  const reader = readerFromToken(req);
  if (!reader) return res.status(401).json({ error: 'unknown reader token' });
  const contest = getContest(reader.contest_id);
  const tags = db
    .prepare(
      `SELECT a.epc, a.bib, a.participant, a.category, a.distance, a.team, a.gender, w.name AS wave
       FROM tag_assignments a LEFT JOIN waves w ON w.id = a.wave_id
       WHERE a.contest_id = ? ORDER BY a.bib, a.epc`
    )
    .all(contest.id);
  const waves = db.prepare('SELECT name, started_at FROM waves WHERE contest_id = ? ORDER BY id').all(contest.id);
  res.json({
    contest: { id: contest.id, title: contest.title },
    suppress_secs: contest.suppress_secs,
    min_lap_gap_secs: contest.min_lap_gap_secs,
    waves,
    racers: tags,
  });
});

// Gun-time upload from the offline timing app (reader-token auth). Waves are
// matched by name and created if the start list originated on the phone.
router.post('/ingest/wave-start', (req, res) => {
  const reader = readerFromToken(req);
  if (!reader) return res.status(401).json({ error: 'unknown reader token' });
  const name = String(req.body?.name || '').trim();
  const startedAt = req.body?.started_at;
  if (!name) return res.status(400).json({ error: 'wave name required' });
  if (!startedAt || Number.isNaN(Date.parse(startedAt))) {
    return res.status(400).json({ error: 'valid started_at required' });
  }
  const at = new Date(startedAt).toISOString();
  let wave = db.prepare('SELECT * FROM waves WHERE contest_id = ? AND name = ?').get(reader.contest_id, name);
  if (!wave) {
    const info = db.prepare('INSERT INTO waves (contest_id, name, started_at) VALUES (?,?,?)').run(reader.contest_id, name, at);
    wave = { id: info.lastInsertRowid, started_at: at };
  } else if (!wave.started_at || req.body?.force) {
    db.prepare('UPDATE waves SET started_at = ? WHERE id = ?').run(at, wave.id);
  } else {
    // already started on the server; keep the earlier gun time
    return res.json({ ok: true, started_at: wave.started_at, kept_existing: true });
  }
  auditLog(null, 'wave.start_sync', 'contest', reader.contest_id, `${name} @ ${at} via reader ${reader.id}`);
  sseBroadcast(reader.contest_id, 'wave_start', { wave_id: wave.id, name, started_at: at });
  res.json({ ok: true, started_at: at });
});

function readerFromToken(req) {
  const token = req.headers['x-reader-token'] || req.body?.token;
  return token ? db.prepare('SELECT * FROM readers WHERE token = ?').get(String(token)) : null;
}

// Mark the race finished from the timing app (reader-token auth) — used when
// the organizer posts results, so the race appears under "Finished races".
router.post('/ingest/finish', (req, res) => {
  const reader = readerFromToken(req);
  if (!reader) return res.status(401).json({ error: 'unknown reader token' });
  db.prepare(`UPDATE contests SET status = 'finished' WHERE id = ? AND status = 'active'`).run(reader.contest_id);
  res.json({ ok: true });
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

// One entry per RACER: assignments sharing a non-empty bib (two-chip racers)
// collapse into a single row whose `epcs` lists every chip.
router.get('/contests/:id/tags', requireAuth, (req, res) => {
  const contest = organizerContest(req, res);
  if (!contest) return;
  const rows = db.prepare(
    `SELECT a.epc, a.bib, a.participant, a.user_id, a.category, a.wave_id, a.racer_status, w.name AS wave_name
     FROM tag_assignments a LEFT JOIN waves w ON w.id = a.wave_id
     WHERE a.contest_id = ? ORDER BY CAST(a.bib AS INTEGER), a.bib, a.epc`
  ).all(contest.id);
  const racers = new Map();
  for (const r of rows) {
    const key = r.bib ? `b:${r.bib}` : `e:${r.epc}`;
    const g = racers.get(key);
    if (!g) racers.set(key, { ...r, epcs: [r.epc] });
    else {
      g.epcs.push(r.epc);
      if (!g.racer_status && r.racer_status) g.racer_status = r.racer_status;
    }
  }
  res.json({ tags: [...racers.values()] });
});

router.post('/contests/:id/tags', requireAuth, (req, res) => {
  const contest = organizerContest(req, res);
  if (!contest) return;
  const epc = String(req.body?.epc || '').toUpperCase().trim();
  const epc2 = String(req.body?.epc2 || '').toUpperCase().trim();
  const bib = String(req.body?.bib || '').trim();
  const participant = String(req.body?.participant || '').trim();
  if (!EPC_RE.test(epc)) return res.status(400).json({ error: 'epc must be a 4-64 char hex string' });
  if (epc2 && !EPC_RE.test(epc2)) return res.status(400).json({ error: 'second chip must be a 4-64 char hex string' });
  if (epc2 && !bib) return res.status(400).json({ error: 'a bib is required to pair two chips to one racer' });
  if (!participant) return res.status(400).json({ error: 'participant name required' });
  let waveId = null;
  if (req.body?.wave_id) {
    const wave = db.prepare('SELECT id FROM waves WHERE id = ? AND contest_id = ?').get(req.body.wave_id, contest.id);
    if (!wave) return res.status(400).json({ error: 'unknown wave for this contest' });
    waveId = wave.id;
  }
  const racerStatus = ['', 'DNS', 'DNF', 'DSQ'].includes(req.body?.racer_status) ? req.body.racer_status : '';
  const upsert = db.prepare(
    `INSERT INTO tag_assignments (contest_id, epc, bib, participant, user_id, wave_id, category, racer_status)
     VALUES (?,?,?,?,?,?,?,?)
     ON CONFLICT (contest_id, epc) DO UPDATE SET bib = excluded.bib, participant = excluded.participant,
       user_id = excluded.user_id, wave_id = excluded.wave_id, category = excluded.category,
       racer_status = excluded.racer_status`
  );
  db.transaction(() => {
    upsert.run(contest.id, epc, bib, participant, req.body?.user_id ?? null,
      waveId, String(req.body?.category || '').trim(), racerStatus);
    if (epc2 && epc2 !== epc) {
      upsert.run(contest.id, epc2, bib, participant, req.body?.user_id ?? null,
        waveId, String(req.body?.category || '').trim(), racerStatus);
    }
    // status belongs to the racer, not the chip — keep every chip in sync
    if (bib) db.prepare('UPDATE tag_assignments SET racer_status = ? WHERE contest_id = ? AND bib = ?')
      .run(racerStatus, contest.id, bib);
  })();
  auditLog(req.user.id, 'tag.assign', 'contest', contest.id, `${epc}${epc2 ? '+' + epc2 : ''} -> ${participant}`);
  res.status(201).json({ ok: true });
});

// Deletes the RACER the chip belongs to: for a two-chip racer (same bib) both
// assignments go, so the start list never keeps an orphaned second chip.
router.delete('/contests/:id/tags/:epc', requireAuth, (req, res) => {
  const contest = organizerContest(req, res);
  if (!contest) return;
  const epc = String(req.params.epc).toUpperCase();
  const row = db.prepare('SELECT bib FROM tag_assignments WHERE contest_id = ? AND epc = ?').get(contest.id, epc);
  if (row && row.bib) {
    db.prepare('DELETE FROM tag_assignments WHERE contest_id = ? AND bib = ?').run(contest.id, row.bib);
  } else {
    db.prepare('DELETE FROM tag_assignments WHERE contest_id = ? AND epc = ?').run(contest.id, epc);
  }
  res.json({ ok: true });
});

// ---- Start-list import ----
//
// Shared by the JSON bulk endpoint and the file-upload endpoint. Waves are
// matched by name and created on the fly; racers without a chip get a
// synthetic bib-based EPC; a second chip (Chip ID2) becomes an extra
// assignment on the same bib so either chip read counts for the racer.
function importRacers(contest, racers, userId) {
  const waveIdByName = new Map(
    db.prepare('SELECT id, name FROM waves WHERE contest_id = ?').all(contest.id).map((w) => [w.name, w.id])
  );
  const upsert = db.prepare(
    `INSERT INTO tag_assignments (contest_id, epc, bib, participant, wave_id, category, distance, team, gender, racer_status)
     VALUES (?,?,?,?,?,?,?,?,?,'')
     ON CONFLICT (contest_id, epc) DO UPDATE SET bib = excluded.bib, participant = excluded.participant,
       wave_id = excluded.wave_id, category = excluded.category,
       distance = excluded.distance, team = excluded.team, gender = excluded.gender`
  );
  const newWave = db.prepare('INSERT INTO waves (contest_id, name) VALUES (?, ?)');

  let imported = 0;
  const errors = [];
  const tx = db.transaction(() => {
    racers.forEach((row, i) => {
      const bib = String(row?.bib ?? '').trim();
      const participant = String(row?.participant ?? row?.name ?? '').trim();
      let epc = String(row?.epc ?? '').trim().toUpperCase();
      const epc2 = String(row?.epc2 ?? '').trim().toUpperCase();
      if (!participant) { errors.push(`row ${i + 1}: name missing`); return; }
      if (!epc) {
        if (!/^\d{1,10}$/.test(bib)) { errors.push(`row ${i + 1}: needs an EPC or a numeric bib`); return; }
        epc = 'AA' + bib.padStart(4, '0');
      }
      if (!EPC_RE.test(epc)) { errors.push(`row ${i + 1}: invalid EPC "${epc}"`); return; }
      let waveId = null;
      const waveName = String(row?.wave ?? '').trim();
      if (waveName) {
        if (!waveIdByName.has(waveName)) {
          waveIdByName.set(waveName, newWave.run(contest.id, waveName).lastInsertRowid);
        }
        waveId = waveIdByName.get(waveName);
      }
      const category = String(row?.category ?? '').trim();
      const distance = String(row?.distance ?? '').trim();
      const team = String(row?.team ?? '').trim();
      const gender = normalizeGender(row?.gender);
      upsert.run(contest.id, epc, bib, participant, waveId, category, distance, team, gender);
      imported++;
      if (epc2 && EPC_RE.test(epc2) && epc2 !== epc) {
        upsert.run(contest.id, epc2, bib, participant, waveId, category, distance, team, gender);
      }
    });
  });
  tx();
  auditLog(userId, 'tag.bulk_import', 'contest', contest.id, `${imported} racers`);
  return { imported, skipped: racers.length - imported, errors: errors.slice(0, 20) };
}

// Header names recognized in uploaded files (Webscorer exports, our CSV
// template, Hebrew sheets). Matched case-insensitively.
const FILE_HEADERS = {
  bib: ['bib', 'number', 'num', '#', 'מספר', 'מספר חזה', 'חזה'],
  participant: ['name', 'participant', 'racer', 'שם', 'שם מלא'],
  category: ['category', 'cat', 'קטגוריה'],
  wave: ['wave', 'heat', 'מקצה'],
  epc: ['epc', 'chip', 'tag', 'chip id', 'chipid', 'שבב', 'תג'],
  epc2: ['chip id2', 'chipid2', 'epc2', 'chip 2', 'שבב 2'],
  distance: ['distance', 'מרחק'],
  team: ['team', 'team name', 'קבוצה', 'שם קבוצה'],
  gender: ['gender', 'sex', 'מין', 'מגדר'],
};

// Canonical 'Male' / 'Female' / '' from the many spellings seen in start lists.
function normalizeGender(raw) {
  const s = String(raw ?? '').trim().toLowerCase();
  if (['m', 'male', 'man', 'זכר', 'גבר', 'בן'].includes(s)) return 'Male';
  if (['f', 'female', 'woman', 'נקבה', 'אישה', 'בת'].includes(s)) return 'Female';
  return '';
}

function rowsToRacers(rows) {
  if (!rows.length) return [];
  const header = rows[0].map((h) => String(h ?? '').trim().toLowerCase());
  const cols = {};
  let hasHeader = false;
  for (const [field, names] of Object.entries(FILE_HEADERS)) {
    const idx = header.findIndex((h) => names.includes(h));
    if (idx >= 0) { cols[field] = idx; hasHeader = true; }
  }
  if (!hasHeader) {
    // positional fallback: bib, name, category, wave, epc
    Object.assign(cols, { bib: 0, participant: 1, category: 2, wave: 3, epc: 4 });
  }
  return rows.slice(hasHeader ? 1 : 0).map((cells) => {
    const get = (field) => (cols[field] !== undefined ? String(cells[cols[field]] ?? '').trim() : '');
    return {
      bib: get('bib'), participant: get('participant'), category: get('category'),
      wave: get('wave'), epc: get('epc'), epc2: get('epc2'),
      distance: get('distance'), team: get('team'), gender: get('gender'),
    };
  }).filter((r) => r.participant || r.bib);
}

function parseCsvBuffer(buf) {
  const text = buf.toString('utf8').replace(/^\uFEFF/, '');
  const firstLine = text.split('\n')[0] || '';
  const delimiter = [',', ';', '\t'].reduce((best, d) =>
    firstLine.split(d).length > firstLine.split(best).length ? d : best, ',');
  const parseLine = (line) => {
    const cells = [];
    let cur = '', inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQ) {
        if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (ch === '"') inQ = false;
        else cur += ch;
      } else if (ch === '"') inQ = true;
      else if (ch === delimiter) { cells.push(cur); cur = ''; }
      else cur += ch;
    }
    cells.push(cur);
    return cells.map((s) => s.trim());
  };
  return text.split(/\r?\n/).filter((l) => l.trim()).map(parseLine);
}

router.post('/contests/:id/tags/bulk', requireAuth, (req, res) => {
  const contest = organizerContest(req, res);
  if (!contest) return;
  const racers = Array.isArray(req.body?.racers) ? req.body.racers.slice(0, 2000) : null;
  if (!racers || !racers.length) return res.status(400).json({ error: 'racers array required' });
  res.json(importRacers(contest, racers, req.user.id));
});

// File upload: .xlsx (Excel / Webscorer export) or .csv, parsed server-side.
router.post('/contests/:id/startlist-file', requireAuth, uploadMemory.single('file'), (req, res) => {
  const contest = organizerContest(req, res);
  if (!contest) return;
  if (!req.file || !req.file.buffer) return res.status(400).json({ error: 'file required' });
  let rows;
  try {
    const isXlsx = /\.xlsx$/i.test(req.file.originalname || '')
      || req.file.buffer.subarray(0, 2).toString('latin1') === 'PK';
    rows = isXlsx ? parseXlsx(req.file.buffer) : parseCsvBuffer(req.file.buffer);
  } catch (err) {
    return res.status(400).json({ error: `could not read file: ${err.message}` });
  }
  const racers = rowsToRacers(rows).slice(0, 2000);
  if (!racers.length) return res.status(400).json({ error: 'no racers found in the file' });
  res.json(importRacers(contest, racers, req.user.id));
});

// ---- Waves & race start (Webscorer-style: gun time per wave) ----

router.get('/contests/:id/waves', requireAuth, (req, res) => {
  const contest = organizerContest(req, res);
  if (!contest) return;
  const waves = db
    .prepare(
      `SELECT w.*, (SELECT COUNT(DISTINCT CASE WHEN a.bib != '' THEN 'b' || a.bib ELSE 'e' || a.epc END)
                      FROM tag_assignments a WHERE a.wave_id = w.id) AS racer_count
       FROM waves w WHERE w.contest_id = ? ORDER BY w.id`
    )
    .all(contest.id);
  res.json({ waves, suppress_secs: contest.suppress_secs, min_lap_gap_secs: contest.min_lap_gap_secs });
});

router.post('/contests/:id/waves', requireAuth, (req, res) => {
  const contest = organizerContest(req, res);
  if (!contest) return;
  const name = String(req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'wave name required' });
  try {
    const info = db.prepare('INSERT INTO waves (contest_id, name) VALUES (?, ?)').run(contest.id, name);
    auditLog(req.user.id, 'wave.create', 'contest', contest.id, name);
    res.status(201).json({ id: info.lastInsertRowid, name, started_at: null });
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) return res.status(409).json({ error: 'wave name already exists' });
    throw err;
  }
});

// Start the wave: records the gun time (millisecond ISO). Re-starting is
// rejected unless force=true, so a stray double-tap can't wipe race times.
router.post('/contests/:id/waves/:wid/start', requireAuth, (req, res) => {
  const contest = organizerContest(req, res);
  if (!contest) return;
  const wave = db.prepare('SELECT * FROM waves WHERE id = ? AND contest_id = ?').get(req.params.wid, contest.id);
  if (!wave) return res.status(404).json({ error: 'wave not found' });
  if (wave.started_at && !req.body?.force) {
    return res.status(409).json({ error: 'wave already started (pass force=true to restart)' });
  }
  const at = req.body?.at && !Number.isNaN(Date.parse(req.body.at))
    ? new Date(req.body.at).toISOString()
    : new Date().toISOString();
  db.prepare('UPDATE waves SET started_at = ? WHERE id = ?').run(at, wave.id);
  auditLog(req.user.id, 'wave.start', 'contest', contest.id, `${wave.name} @ ${at}`);
  sseBroadcast(contest.id, 'wave_start', { wave_id: wave.id, name: wave.name, started_at: at });
  res.json({ ok: true, started_at: at });
});

router.delete('/contests/:id/waves/:wid', requireAuth, (req, res) => {
  const contest = organizerContest(req, res);
  if (!contest) return;
  db.prepare('UPDATE tag_assignments SET wave_id = NULL WHERE contest_id = ? AND wave_id = ?').run(contest.id, req.params.wid);
  const info = db.prepare('DELETE FROM waves WHERE id = ? AND contest_id = ?').run(req.params.wid, contest.id);
  if (!info.changes) return res.status(404).json({ error: 'wave not found' });
  res.json({ ok: true });
});

router.patch('/contests/:id/timing-settings', requireAuth, (req, res) => {
  const contest = organizerContest(req, res);
  if (!contest) return;
  const suppress = Number(req.body?.suppress_secs);
  const lapGap = Number(req.body?.min_lap_gap_secs);
  db.prepare('UPDATE contests SET suppress_secs = ?, min_lap_gap_secs = ? WHERE id = ?').run(
    Number.isFinite(suppress) && suppress >= 0 ? Math.round(suppress) : contest.suppress_secs,
    Number.isFinite(lapGap) && lapGap >= 0 ? Math.round(lapGap) : contest.min_lap_gap_secs,
    contest.id
  );
  res.json({ ok: true });
});

// ---- Race results: elapsed = first read after wave start + suppression ----
//
// For every assigned tag whose wave has started:
//   - reads inside the suppression window (start .. start+suppress_secs) are
//     ignored (racers crossing the start-line antenna at the gun);
//   - the first valid read is the finish (single-crossing race) and each
//     subsequent read spaced >= min_lap_gap_secs starts a new lap;
//   - no valid reads => still on course (or DNS).
router.get('/contests/:id/race-results', (req, res) => {
  const contest = viewableContest(req, res);
  if (!contest) return;

  const waves = new Map(db.prepare('SELECT * FROM waves WHERE contest_id = ?').all(contest.id).map((w) => [w.id, w]));
  const assignments = db
    .prepare('SELECT * FROM tag_assignments WHERE contest_id = ? ORDER BY bib, epc')
    .all(contest.id)
    .filter((a) => !req.query.category || a.category === req.query.category);
  const allReads = db
    .prepare('SELECT epc, read_at FROM tag_reads WHERE contest_id = ? ORDER BY read_at')
    .all(contest.id);
  const readsByEpc = new Map();
  for (const r of allReads) {
    if (!readsByEpc.has(r.epc)) readsByEpc.set(r.epc, []);
    readsByEpc.get(r.epc).push(Date.parse(r.read_at));
  }

  const suppressMs = contest.suppress_secs * 1000;
  const lapGapMs = contest.min_lap_gap_secs * 1000;

  // Racers can carry two chips (Chip ID + Chip ID2): assignments sharing a
  // non-empty bib are merged, and a read from either chip counts.
  const groups = new Map();
  for (const a of assignments) {
    const key = a.bib ? `bib:${a.bib}` : `epc:${a.epc}`;
    if (!groups.has(key)) groups.set(key, { ...a, epcs: [a.epc] });
    else {
      const g = groups.get(key);
      g.epcs.push(a.epc);
      if (!g.racer_status && a.racer_status) g.racer_status = a.racer_status;
    }
  }

  const results = [...groups.values()].map((a) => {
    const wave = a.wave_id ? waves.get(a.wave_id) : null;
    const base = {
      epc: a.epc, bib: a.bib, participant: a.participant, category: a.category,
      distance: a.distance || '', team: a.team || '', gender: a.gender || '',
      wave: wave ? wave.name : null, wave_started_at: wave ? wave.started_at : null,
    };
    // organizer-declared statuses override everything (Webscorer-style)
    if (a.racer_status) return { ...base, status: a.racer_status, laps: 0 };
    if (!wave || !wave.started_at) return { ...base, status: 'not_started', laps: 0 };
    const startMs = Date.parse(wave.started_at);
    const valid = a.epcs
      .flatMap((epc) => readsByEpc.get(epc) || [])
      .sort((x, y) => x - y)
      .filter((t) => t >= startMs + suppressMs);
    if (!valid.length) return { ...base, status: 'on_course', laps: 0 };

    const crossings = [];
    for (const t of valid) {
      if (!crossings.length || t - crossings[crossings.length - 1] >= lapGapMs) crossings.push(t);
    }
    const lastMs = crossings[crossings.length - 1];
    return {
      ...base,
      status: 'finished',
      laps: crossings.length,
      first_crossing_at: new Date(crossings[0]).toISOString(),
      last_crossing_at: new Date(lastMs).toISOString(),
      elapsed_ms: lastMs - startMs,
      elapsed: formatElapsed(lastMs - startMs),
      // elapsed of each counted crossing, for the per-lap view
      lap_splits: crossings.map((t) => formatElapsed(t - startMs)),
    };
  });

  // Fastest time first (Webscorer default); more laps beats fewer for lap
  // races; DNS/DNF/DSQ and non-finishers sink to the bottom.
  const statusOrder = { finished: 0, on_course: 1, not_started: 2, DNF: 3, DSQ: 4, DNS: 5 };
  results.sort((x, y) => {
    const sx = statusOrder[x.status] ?? 9, sy = statusOrder[y.status] ?? 9;
    if (sx !== sy) return sx - sy;
    if (x.status !== 'finished') return 0;
    return y.laps - x.laps || x.elapsed_ms - y.elapsed_ms;
  });
  // overall rank + gap behind the leader + place within category
  const categoryPlace = new Map();
  let leader = null;
  results.forEach((r, i) => {
    if (r.status !== 'finished') return;
    r.rank = i + 1;
    if (!leader) leader = r;
    r.behind = r.rank === 1 ? '' : (r.laps < leader.laps
      ? `-${leader.laps - r.laps} lap${leader.laps - r.laps > 1 ? 's' : ''}`
      : '+' + formatElapsed(r.elapsed_ms - leader.elapsed_ms));
    const place = (categoryPlace.get(r.category) || 0) + 1;
    categoryPlace.set(r.category, place);
    r.category_rank = place;
  });

  if (req.query.format === 'csv') {
    const cell = (v) => (/[",\n]/.test(String(v ?? '')) ? `"${String(v).replace(/"/g, '""')}"` : String(v ?? ''));
    const header = 'rank,bib,participant,category,category_rank,distance,team,gender,wave,laps,elapsed,behind,status';
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="race-results-${contest.id}.csv"`);
    return res.send([header, ...results.map((r) =>
      [r.rank ?? '', cell(r.bib), cell(r.participant), cell(r.category), r.category_rank ?? '', cell(r.distance ?? ''), cell(r.team ?? ''), cell(r.gender ?? ''), cell(r.wave ?? ''), r.laps, r.elapsed ?? '', cell(r.behind ?? ''), r.status].join(','))].join('\n') + '\n');
  }
  res.json({ results, suppress_secs: contest.suppress_secs, min_lap_gap_secs: contest.min_lap_gap_secs });
});

function formatElapsed(ms) {
  const tenths = Math.round(ms / 100);
  const h = Math.floor(tenths / 36000);
  const m = Math.floor((tenths % 36000) / 600);
  const s = Math.floor((tenths % 600) / 10);
  const t = tenths % 10;
  return (h ? `${h}:${String(m).padStart(2, '0')}` : String(m)) + `:${String(s).padStart(2, '0')}.${t}`;
}

// HH:MM:SS.t time-of-day from an ISO timestamp (device clock as stored).
function timeOfDay(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}.${Math.floor(d.getUTCMilliseconds() / 100)}`;
}

// Taps log: one row per counted crossing (start-suppression + lap-gap applied),
// in chronological order, labelled Lap 1…Lap n / Finish per racer's lap target.
// Mirrors the timing app's own passing log so each race has an auditable trail.
router.get('/contests/:id/taps', (req, res) => {
  const contest = viewableContest(req, res);
  if (!contest) return;

  const waves = new Map(db.prepare('SELECT * FROM waves WHERE contest_id = ?').all(contest.id).map((w) => [w.id, w]));
  const assignments = db.prepare('SELECT * FROM tag_assignments WHERE contest_id = ? ORDER BY bib, epc').all(contest.id);
  const reads = db
    .prepare(
      `SELECT t.epc, t.rssi, t.antenna, t.read_at, r.name AS reader_name
       FROM tag_reads t JOIN readers r ON r.id = t.reader_id
       WHERE t.contest_id = ? ORDER BY t.read_at`
    )
    .all(contest.id);
  const readsByEpc = new Map();
  for (const r of reads) {
    if (!readsByEpc.has(r.epc)) readsByEpc.set(r.epc, []);
    readsByEpc.get(r.epc).push(r);
  }

  const suppressMs = contest.suppress_secs * 1000;
  const lapGapMs = contest.min_lap_gap_secs * 1000;

  // Merge two-chip racers by bib so a read from either chip counts.
  const groups = new Map();
  for (const a of assignments) {
    const key = a.bib ? `bib:${a.bib}` : `epc:${a.epc}`;
    if (!groups.has(key)) groups.set(key, { ...a, epcs: [a.epc] });
    else groups.get(key).epcs.push(a.epc);
  }

  const rows = [];
  for (const g of groups.values()) {
    const wave = g.wave_id ? waves.get(g.wave_id) : null;
    if (g.racer_status || !wave || !wave.started_at) continue; // no timed crossings
    const startMs = Date.parse(wave.started_at);
    const valid = g.epcs
      .flatMap((epc) => readsByEpc.get(epc) || [])
      .map((r) => ({ ...r, ms: Date.parse(r.read_at) }))
      .filter((r) => r.ms >= startMs + suppressMs)
      .sort((x, y) => x.ms - y.ms);

    // Collapse reads within the lap gap into one crossing per lap.
    const crossings = [];
    let lastMs = null;
    for (const r of valid) {
      if (lastMs !== null && r.ms - lastMs < lapGapMs) continue;
      lastMs = r.ms;
      crossings.push(r);
    }
    // Last crossing is the Finish (server treats last read as the finish); the
    // rest are Lap 1…Lap n-1.
    crossings.forEach((r, idx) => {
      const tap = idx === crossings.length - 1 ? 'Finish' : `Lap ${idx + 1}`;
      rows.push({
        bib: g.bib, epc: r.epc, name: g.participant,
        tap, timeTap: formatElapsed(r.ms - startMs),
        distance: g.distance || '', category: g.category || '', team: g.team || '',
        gender: g.gender || '', reader: r.reader_name || '', antenna: r.antenna ?? '',
        peak: r.rssi ?? '', timeOfDay: timeOfDay(r.read_at),
        sortMs: r.ms,
      });
    });
  }
  rows.sort((a, b) => a.sortMs - b.sortMs);

  const cell = (v) => (/[",\n]/.test(String(v ?? '')) ? `"${String(v).replace(/"/g, '""')}"` : String(v ?? ''));
  const header = ['Seq #', 'Bib', 'Chip ID', 'Name', 'Tap', 'Time tap', 'Bib tap',
    'Distance', 'Category', 'Team name', 'Gender', 'Reader', 'Antenna', 'Peak Signal', 'Time tap (time of day)'];
  const lines = rows.map((r, i) =>
    [i + 1, cell(r.bib), cell(r.epc), cell(r.name), r.tap, r.timeTap, '',
      cell(r.distance), cell(r.category), cell(r.team), cell(r.gender), cell(r.reader), r.antenna, r.peak, r.timeOfDay].join(','));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="race-${contest.id}-taps.csv"`);
  res.send('﻿' + [header.join(','), ...lines].join('\n') + '\n'); // BOM so Excel reads Hebrew
});

// Public start list for a viewable contest (spectators, participants).
router.get('/contests/:id/startlist', (req, res) => {
  const contest = viewableContest(req, res);
  if (!contest) return;
  const racers = db
    .prepare(
      `SELECT a.bib, a.participant, a.category, a.distance, a.team, a.gender, a.racer_status, w.name AS wave
       FROM tag_assignments a LEFT JOIN waves w ON w.id = a.wave_id
       WHERE a.contest_id = ?
       GROUP BY CASE WHEN a.bib != '' THEN a.bib ELSE a.epc END
       ORDER BY CAST(a.bib AS INTEGER), a.bib`
    )
    .all(contest.id);
  const waves = db.prepare('SELECT name, started_at FROM waves WHERE contest_id = ? ORDER BY id').all(contest.id);
  res.json({ racers, waves });
});

// ---- Manual passing (tap-to-record fallback, by bib) ----

router.post('/contests/:id/manual-read', requireAuth, (req, res) => {
  const contest = organizerContest(req, res);
  if (!contest) return;
  const bib = String(req.body?.bib || '').trim();
  if (!bib) return res.status(400).json({ error: 'bib required' });

  let assignment = db
    .prepare('SELECT * FROM tag_assignments WHERE contest_id = ? AND bib = ?')
    .get(contest.id, bib);
  if (!assignment) {
    if (!/^\d{1,10}$/.test(bib)) return res.status(400).json({ error: 'no tag assignment for that bib' });
    // Synthesize an EPC for bib-only racers: decimal digits are valid hex.
    const epc = 'AA' + bib.padStart(4, '0');
    db.prepare(
      `INSERT INTO tag_assignments (contest_id, epc, bib, participant) VALUES (?,?,?,?)
       ON CONFLICT (contest_id, epc) DO NOTHING`
    ).run(contest.id, epc, bib, `Bib ${bib}`);
    assignment = db.prepare('SELECT * FROM tag_assignments WHERE contest_id = ? AND epc = ?').get(contest.id, epc);
  }

  let manual = db.prepare(`SELECT * FROM readers WHERE contest_id = ? AND name = 'Manual entry'`).get(contest.id);
  if (!manual) {
    const info = db.prepare('INSERT INTO readers (contest_id, name, token, location) VALUES (?,?,?,?)')
      .run(contest.id, 'Manual entry', `vgr_${crypto.randomBytes(24).toString('hex')}`, 'manual');
    manual = { id: info.lastInsertRowid, name: 'Manual entry', location: 'manual' };
  }

  const at = req.body?.at && !Number.isNaN(Date.parse(req.body.at))
    ? new Date(req.body.at).toISOString()
    : new Date().toISOString();
  db.prepare('INSERT INTO tag_reads (reader_id, contest_id, epc, rssi, read_at) VALUES (?,?,?,?,?)')
    .run(manual.id, contest.id, assignment.epc, null, at);
  auditLog(req.user.id, 'read.manual', 'contest', contest.id, `bib ${bib} @ ${at}`);
  sseBroadcast(contest.id, 'tag_reads', {
    reader: { id: manual.id, name: manual.name, location: manual.location },
    reads: [{ epc: assignment.epc, rssi: null, read_at: at, bib: assignment.bib, participant: assignment.participant }],
  });
  res.status(201).json({ ok: true, epc: assignment.epc, read_at: at });
});

module.exports = { router };

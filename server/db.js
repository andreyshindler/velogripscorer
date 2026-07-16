'use strict';

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'velogripscorer.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  name          TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'voter' CHECK (role IN ('voter','admin')),
  bio           TEXT NOT NULL DEFAULT '',
  avatar_url    TEXT NOT NULL DEFAULT '',
  links         TEXT NOT NULL DEFAULT '[]',
  is_public     INTEGER NOT NULL DEFAULT 1,
  reputation    INTEGER NOT NULL DEFAULT 0,
  is_banned     INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS contests (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  organizer_id    INTEGER NOT NULL REFERENCES users(id),
  title           TEXT NOT NULL,
  description     TEXT NOT NULL DEFAULT '',
  category        TEXT NOT NULL DEFAULT 'other'
                  CHECK (category IN ('photo','design','code','writing','video','other')),
  tags            TEXT NOT NULL DEFAULT '[]',
  visibility      TEXT NOT NULL DEFAULT 'public' CHECK (visibility IN ('public','private')),
  invite_code     TEXT,
  voting_mode     TEXT NOT NULL DEFAULT 'open' CHECK (voting_mode IN ('open','closed')),
  blind_voting    INTEGER NOT NULL DEFAULT 0,
  scale_max       INTEGER NOT NULL DEFAULT 10 CHECK (scale_max BETWEEN 2 AND 100),
  participant_cap INTEGER,
  start_at        TEXT NOT NULL,
  end_at          TEXT NOT NULL,
  voting_start_at TEXT,
  voting_end_at   TEXT,
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','finished','archived')),
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS criteria (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  contest_id INTEGER NOT NULL REFERENCES contests(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  weight     INTEGER NOT NULL CHECK (weight BETWEEN 1 AND 100)
);

CREATE TABLE IF NOT EXISTS participants (
  contest_id INTEGER NOT NULL REFERENCES contests(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  status     TEXT NOT NULL DEFAULT 'approved' CHECK (status IN ('pending','approved','rejected')),
  joined_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (contest_id, user_id)
);

CREATE TABLE IF NOT EXISTS entries (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  contest_id  INTEGER NOT NULL REFERENCES contests(id) ON DELETE CASCADE,
  user_id     INTEGER NOT NULL REFERENCES users(id),
  title       TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  kind        TEXT NOT NULL DEFAULT 'text' CHECK (kind IN ('text','code','image','video','pdf','link')),
  body        TEXT NOT NULL DEFAULT '',
  language    TEXT NOT NULL DEFAULT '',
  file_path   TEXT,
  mime_type   TEXT,
  tags        TEXT NOT NULL DEFAULT '[]',
  status      TEXT NOT NULL DEFAULT 'visible' CHECK (status IN ('visible','hidden','removed')),
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (contest_id, user_id, title)
);

CREATE TABLE IF NOT EXISTS votes (
  entry_id     INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  voter_id     INTEGER NOT NULL REFERENCES users(id),
  criterion_id INTEGER NOT NULL REFERENCES criteria(id) ON DELETE CASCADE,
  score        REAL NOT NULL CHECK (score >= 0),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (entry_id, voter_id, criterion_id)
);

CREATE TABLE IF NOT EXISTS comments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_id   INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  body       TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'visible' CHECK (status IN ('visible','removed')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS reports (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  target_type TEXT NOT NULL CHECK (target_type IN ('entry','comment','user','contest')),
  target_id   INTEGER NOT NULL,
  reporter_id INTEGER NOT NULL REFERENCES users(id),
  reason      TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved','dismissed')),
  resolved_by INTEGER REFERENCES users(id),
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS notifications (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  type       TEXT NOT NULL,
  message    TEXT NOT NULL,
  data       TEXT NOT NULL DEFAULT '{}',
  read       INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS prizes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  contest_id INTEGER NOT NULL REFERENCES contests(id) ON DELETE CASCADE,
  rank       INTEGER NOT NULL CHECK (rank >= 1),
  name       TEXT NOT NULL,
  type       TEXT NOT NULL DEFAULT 'badge' CHECK (type IN ('badge','points','physical','coupon','premium')),
  details    TEXT NOT NULL DEFAULT '',
  UNIQUE (contest_id, rank)
);

CREATE TABLE IF NOT EXISTS awards (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  contest_id  INTEGER NOT NULL REFERENCES contests(id) ON DELETE CASCADE,
  entry_id    INTEGER NOT NULL REFERENCES entries(id),
  user_id     INTEGER NOT NULL REFERENCES users(id),
  rank        INTEGER NOT NULL,
  badge       TEXT NOT NULL,
  prize_id    INTEGER REFERENCES prizes(id),
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (contest_id, rank)
);

CREATE TABLE IF NOT EXISTS follows (
  user_id    INTEGER NOT NULL REFERENCES users(id),
  contest_id INTEGER NOT NULL REFERENCES contests(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, contest_id)
);

CREATE TABLE IF NOT EXISTS webhooks (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  contest_id INTEGER NOT NULL REFERENCES contests(id) ON DELETE CASCADE,
  url        TEXT NOT NULL,
  events     TEXT NOT NULL DEFAULT '["contest.finished","winner.declared","abuse.reported"]',
  secret     TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER,
  action      TEXT NOT NULL,
  target_type TEXT NOT NULL DEFAULT '',
  target_id   INTEGER,
  details     TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS score_history (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  contest_id INTEGER NOT NULL REFERENCES contests(id) ON DELETE CASCADE,
  entry_id   INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  score      REAL NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS readers (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  contest_id INTEGER NOT NULL REFERENCES contests(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  token      TEXT NOT NULL UNIQUE,
  location   TEXT NOT NULL DEFAULT '' , -- e.g. start line, finish line, checkpoint 1
  last_seen  TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tag_reads (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  reader_id   INTEGER NOT NULL REFERENCES readers(id) ON DELETE CASCADE,
  contest_id  INTEGER NOT NULL REFERENCES contests(id) ON DELETE CASCADE,
  epc         TEXT NOT NULL,
  rssi        REAL,
  read_at     TEXT NOT NULL,           -- when the reader saw the tag (device clock)
  received_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tag_assignments (
  contest_id  INTEGER NOT NULL REFERENCES contests(id) ON DELETE CASCADE,
  epc         TEXT NOT NULL,
  bib         TEXT NOT NULL DEFAULT '',
  participant TEXT NOT NULL,           -- display name of the rider/participant
  user_id     INTEGER REFERENCES users(id),
  PRIMARY KEY (contest_id, epc)
);

CREATE TABLE IF NOT EXISTS waves (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  contest_id INTEGER NOT NULL REFERENCES contests(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  started_at TEXT,                     -- ISO with milliseconds; null until the gun goes off
  UNIQUE (contest_id, name)
);

-- Per-chat state for the Telegram start-list bot: which race the chat is
-- working on and any in-progress add/edit wizard (JSON in the state column).
CREATE TABLE IF NOT EXISTS telegram_sessions (
  chat_id           TEXT PRIMARY KEY,
  active_contest_id INTEGER,
  state             TEXT NOT NULL DEFAULT '',
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

-- A league is a season series of races: per-race points are computed from each
-- attached race's results and aggregated into individual + team standings.
-- Scoring rules live in the settings JSON (see server/league-scoring.js defaults).
CREATE TABLE IF NOT EXISTS leagues (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  season     TEXT NOT NULL DEFAULT '',
  status     TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','finished','archived')),
  settings   TEXT NOT NULL DEFAULT '{}',
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS league_races (
  league_id  INTEGER NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  contest_id INTEGER NOT NULL REFERENCES contests(id) ON DELETE CASCADE,
  round      INTEGER NOT NULL,
  PRIMARY KEY (league_id, contest_id)
);

CREATE INDEX IF NOT EXISTS idx_league_races      ON league_races(league_id, round);
CREATE INDEX IF NOT EXISTS idx_reads_contest     ON tag_reads(contest_id, read_at);
CREATE INDEX IF NOT EXISTS idx_reads_epc         ON tag_reads(contest_id, epc);
CREATE INDEX IF NOT EXISTS idx_entries_contest   ON entries(contest_id);
CREATE INDEX IF NOT EXISTS idx_votes_entry       ON votes(entry_id);
CREATE INDEX IF NOT EXISTS idx_comments_entry    ON comments(entry_id);
CREATE INDEX IF NOT EXISTS idx_notifications_usr ON notifications(user_id, read);
CREATE INDEX IF NOT EXISTS idx_history_entry     ON score_history(entry_id);
`);

// Idempotent column migrations for databases created before these fields existed.
for (const stmt of [
  `ALTER TABLE tag_assignments ADD COLUMN wave_id INTEGER REFERENCES waves(id)`,
  `ALTER TABLE tag_assignments ADD COLUMN category TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE contests ADD COLUMN suppress_secs INTEGER NOT NULL DEFAULT 10`,
  `ALTER TABLE contests ADD COLUMN min_lap_gap_secs INTEGER NOT NULL DEFAULT 30`,
  `ALTER TABLE contests ADD COLUMN kind TEXT NOT NULL DEFAULT 'voting'`,
  `ALTER TABLE contests ADD COLUMN sport TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE contests ADD COLUMN location TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE contests ADD COLUMN photo_url TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE contests ADD COLUMN organizer_name TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE tag_assignments ADD COLUMN racer_status TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE tag_assignments ADD COLUMN distance TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE tag_assignments ADD COLUMN team TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE tag_assignments ADD COLUMN gender TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE tag_reads ADD COLUMN antenna INTEGER`,
  // Operator taps from the app/web: exempt from the start-suppression window.
  `ALTER TABLE tag_reads ADD COLUMN manual INTEGER NOT NULL DEFAULT 0`,
  // 0 = single-crossing race: the first valid crossing is the finish and
  // later reads are ignored (no phantom "laps" from double reads).
  `ALTER TABLE contests ADD COLUMN record_laps INTEGER NOT NULL DEFAULT 1`,
]) {
  try {
    db.exec(stmt);
  } catch (err) {
    if (!/duplicate column/.test(String(err.message))) throw err;
  }
}

function auditLog(userId, action, targetType, targetId, details) {
  db.prepare(
    `INSERT INTO audit_log (user_id, action, target_type, target_id, details)
     VALUES (?, ?, ?, ?, ?)`
  ).run(userId ?? null, action, targetType || '', targetId ?? null, details ? String(details) : '');
}

module.exports = { db, auditLog, DATA_DIR };

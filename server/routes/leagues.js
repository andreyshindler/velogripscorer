'use strict';

// Leagues: a season series of races. Admins create a league, attach races
// (contests with kind='race') as numbered rounds, and tune the scoring rules;
// standings (individual by category + teams) are public and recomputed from
// each race's live results on every request — nothing is persisted, so a
// late-corrected race result flows straight into the season table.

const express = require('express');
const { db, auditLog } = require('../db');
const { requireAuth, requireAdmin } = require('../auth');
const { computeRaceResults } = require('../race-results');
const { normalizeSettings, computeLeagueStandings } = require('../league-scoring');

const router = express.Router();

function getLeague(id) {
  return db.prepare('SELECT * FROM leagues WHERE id = ?').get(id);
}

function leagueJson(league) {
  return { ...league, settings: normalizeSettings(league.settings) };
}

function leagueRaces(leagueId) {
  return db.prepare(
    `SELECT lr.contest_id, lr.round, c.title, c.start_at, c.status, c.visibility
       FROM league_races lr JOIN contests c ON c.id = lr.contest_id
      WHERE lr.league_id = ? ORDER BY lr.round, datetime(c.start_at)`
  ).all(leagueId);
}

// ---- public reads ----

router.get('/leagues', (req, res) => {
  // Default hides archived leagues; ?status=<x> filters, ?status=all shows everything.
  const status = req.query.status || '';
  const where = status === 'all' ? '1=1' : status ? 'l.status = ?' : "l.status != 'archived'";
  const rows = db.prepare(
    `SELECT l.id, l.name, l.season, l.status, l.created_at,
            (SELECT COUNT(*) FROM league_races lr WHERE lr.league_id = l.id) AS race_count
       FROM leagues l WHERE ${where} ORDER BY l.created_at DESC`
  ).all(...(status && status !== 'all' ? [status] : []));
  res.json({ leagues: rows });
});

router.get('/leagues/:id', (req, res) => {
  const league = getLeague(req.params.id);
  if (!league) return res.status(404).json({ error: 'league not found' });
  res.json({ league: leagueJson(league), races: leagueRaces(league.id) });
});

router.get('/leagues/:id/standings', (req, res) => {
  const league = getLeague(req.params.id);
  if (!league) return res.status(404).json({ error: 'league not found' });
  const settings = normalizeSettings(league.settings);

  const attached = leagueRaces(league.id);
  const races = attached.map((row) => {
    const contest = db.prepare('SELECT * FROM contests WHERE id = ?').get(row.contest_id);
    return {
      contest: { id: contest.id, title: contest.title, start_at: contest.start_at, status: contest.status },
      round: row.round,
      results: computeRaceResults(contest),
    };
  });

  const { individual, teams } = computeLeagueStandings(races, settings);
  const raceList = races.map((r) => ({
    contest_id: r.contest.id, round: r.round, title: r.contest.title,
    start_at: r.contest.start_at, status: r.contest.status,
  }));

  if (req.query.format === 'csv') {
    const table = req.query.table === 'team' ? 'team' : 'individual';
    const csv = table === 'team' ? teamCsv(teams, raceList) : individualCsv(individual, raceList);
    return res.type('text/csv; charset=utf-8')
      .set('Content-Disposition', `attachment; filename="league-${league.id}-${table}.csv"`)
      .send('﻿' + csv); // BOM so Excel reads Hebrew as UTF-8
  }

  res.json({ league: leagueJson(league), races: raceList, individual, teams });
});

// ---- admin writes ----

router.post('/leagues', requireAuth, requireAdmin, (req, res) => {
  const { name, season, settings } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'name required' });
  let normalized;
  try { normalized = normalizeSettings(settings ?? {}); } catch (err) {
    return res.status(400).json({ error: String(err.message) });
  }
  const info = db.prepare(
    'INSERT INTO leagues (name, season, settings, created_by) VALUES (?, ?, ?, ?)'
  ).run(String(name).trim(), String(season || '').trim(), JSON.stringify(normalized), req.user.id);
  auditLog(req.user.id, 'league.create', 'league', info.lastInsertRowid, name);
  res.status(201).json({ league: leagueJson(getLeague(info.lastInsertRowid)) });
});

router.patch('/leagues/:id', requireAuth, requireAdmin, (req, res) => {
  const league = getLeague(req.params.id);
  if (!league) return res.status(404).json({ error: 'league not found' });
  const { name, season, status, settings } = req.body || {};
  if (name !== undefined && !String(name).trim()) return res.status(400).json({ error: 'name cannot be empty' });
  if (status !== undefined && !['active', 'finished', 'archived'].includes(status)) {
    return res.status(400).json({ error: 'invalid status' });
  }
  let settingsJson;
  if (settings !== undefined) {
    try { settingsJson = JSON.stringify(normalizeSettings(settings)); } catch (err) {
      return res.status(400).json({ error: String(err.message) });
    }
  }
  db.prepare('UPDATE leagues SET name = ?, season = ?, status = ?, settings = ? WHERE id = ?').run(
    name !== undefined ? String(name).trim() : league.name,
    season !== undefined ? String(season).trim() : league.season,
    status !== undefined ? status : league.status,
    settingsJson !== undefined ? settingsJson : league.settings,
    league.id
  );
  auditLog(req.user.id, 'league.update', 'league', league.id, '');
  res.json({ league: leagueJson(getLeague(league.id)) });
});

router.delete('/leagues/:id', requireAuth, requireAdmin, (req, res) => {
  const league = getLeague(req.params.id);
  if (!league) return res.status(404).json({ error: 'league not found' });
  db.prepare('DELETE FROM leagues WHERE id = ?').run(league.id); // league_races cascades
  auditLog(req.user.id, 'league.delete', 'league', league.id, league.name);
  res.json({ ok: true });
});

router.post('/leagues/:id/races', requireAuth, requireAdmin, (req, res) => {
  const league = getLeague(req.params.id);
  if (!league) return res.status(404).json({ error: 'league not found' });
  const { contest_id, round } = req.body || {};
  const contest = db.prepare('SELECT * FROM contests WHERE id = ?').get(contest_id);
  if (!contest) return res.status(400).json({ error: 'contest not found' });
  if (contest.kind !== 'race') return res.status(400).json({ error: 'only races can join a league' });
  const nextRound = Number.isInteger(round) && round >= 1
    ? round
    : (db.prepare('SELECT COALESCE(MAX(round), 0) + 1 AS r FROM league_races WHERE league_id = ?').get(league.id)).r;
  try {
    db.prepare('INSERT INTO league_races (league_id, contest_id, round) VALUES (?, ?, ?)')
      .run(league.id, contest.id, nextRound);
  } catch (err) {
    if (/UNIQUE|PRIMARY KEY/i.test(String(err.message))) {
      return res.status(409).json({ error: 'race already in this league' });
    }
    throw err;
  }
  auditLog(req.user.id, 'league.attach_race', 'league', league.id, `contest ${contest.id} round ${nextRound}`);
  res.status(201).json({ races: leagueRaces(league.id) });
});

router.patch('/leagues/:id/races/:contestId', requireAuth, requireAdmin, (req, res) => {
  const { round } = req.body || {};
  if (!Number.isInteger(round) || round < 1) return res.status(400).json({ error: 'round must be an integer >= 1' });
  const info = db.prepare('UPDATE league_races SET round = ? WHERE league_id = ? AND contest_id = ?')
    .run(round, req.params.id, req.params.contestId);
  if (!info.changes) return res.status(404).json({ error: 'race not in league' });
  res.json({ races: leagueRaces(req.params.id) });
});

router.delete('/leagues/:id/races/:contestId', requireAuth, requireAdmin, (req, res) => {
  const info = db.prepare('DELETE FROM league_races WHERE league_id = ? AND contest_id = ?')
    .run(req.params.id, req.params.contestId);
  if (!info.changes) return res.status(404).json({ error: 'race not in league' });
  auditLog(req.user.id, 'league.detach_race', 'league', Number(req.params.id), `contest ${req.params.contestId}`);
  res.json({ ok: true });
});

// ---- CSV builders ----

const cell = (v) => (/[",\n]/.test(String(v ?? '')) ? `"${String(v).replace(/"/g, '""')}"` : String(v ?? ''));

function roundHeaders(raceList) {
  return raceList.map((r) => `R${r.round}`);
}

function perRaceCells(row, raceList) {
  return raceList.map((r) => (row.per_race[r.contest_id] !== undefined ? row.per_race[r.contest_id] : ''));
}

function individualCsv(individual, raceList) {
  const lines = [];
  for (const group of individual) {
    const title = [group.distance, group.gender, group.category].filter(Boolean).join(' - ') || 'Overall';
    lines.push(cell(title));
    lines.push(['Place', 'Bib', 'Name', 'Team', ...roundHeaders(raceList), 'Total'].map(cell).join(','));
    group.rows.forEach((row, i) => {
      lines.push([i + 1, row.bib, row.name, row.team, ...perRaceCells(row, raceList), row.total].map(cell).join(','));
    });
    lines.push('');
  }
  return lines.join('\n');
}

function teamCsv(teams, raceList) {
  const lines = [];
  lines.push(['Place', 'Team', ...roundHeaders(raceList), 'Total'].map(cell).join(','));
  teams.forEach((row, i) => {
    lines.push([i + 1, row.team, ...perRaceCells(row, raceList), row.total].map(cell).join(','));
  });
  return lines.join('\n');
}

module.exports = { router };

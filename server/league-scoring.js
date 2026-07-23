'use strict';

// League scoring: pure functions (no DB, no Express) turning per-race results
// into per-race points and season standings. The rules mirror the Hapoel
// workplace-league rulebook but every number is configurable per league via
// the settings JSON stored on the leagues row.

const { genderLabelG } = require('./race-results');

const DEFAULT_SETTINGS = {
  // Individual: points by place within a distance+gender+category group;
  // finishers past the end of the array get individual_other_points.
  individual_points: [20, 18, 16, 14, 12, 10, 8, 6, 4, 2],
  individual_other_points: 1,
  individual_best_n: 5, // best race scores counted per rider over the season

  // Team: every finisher earns team_points by the same category place; a
  // team's race score sums its best team_top_runners values.
  team_points: [10, 8, 6, 4, 2],
  team_other_points: 1,
  team_top_runners: 5,
  team_best_n: 6, // best race scores counted per team over the season
};

/** Merge stored settings over the defaults and validate. Throws on garbage. */
function normalizeSettings(raw) {
  let parsed = raw;
  if (typeof raw === 'string') {
    try { parsed = raw.trim() ? JSON.parse(raw) : {}; } catch { throw new Error('settings is not valid JSON'); }
  }
  if (parsed == null) parsed = {};
  if (typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('settings must be an object');

  const s = { ...DEFAULT_SETTINGS, ...parsed };
  for (const key of ['individual_points', 'team_points']) {
    if (!Array.isArray(s[key]) || !s[key].length ||
        s[key].some((n) => typeof n !== 'number' || !Number.isFinite(n) || n < 0)) {
      throw new Error(`${key} must be a non-empty array of non-negative numbers`);
    }
    s[key] = s[key].map(Number);
  }
  for (const key of ['individual_other_points', 'team_other_points']) {
    if (typeof s[key] !== 'number' || !Number.isFinite(s[key]) || s[key] < 0) {
      throw new Error(`${key} must be a non-negative number`);
    }
  }
  for (const key of ['individual_best_n', 'team_top_runners', 'team_best_n']) {
    if (!Number.isInteger(s[key]) || s[key] < 1) throw new Error(`${key} must be an integer >= 1`);
  }
  // keep only known keys so stale/unknown fields never persist
  return Object.fromEntries(Object.keys(DEFAULT_SETTINGS).map((k) => [k, s[k]]));
}

/** Scoring group: riders place within their distance + gender + category. */
function groupKey(r) {
  return `${(r.distance || '').trim()}|${genderLabelG(r.gender)}|${(r.category || '').trim()}`;
}

/**
 * Score one race. `results` is the computeRaceResults array; only finishers
 * score. Returns rider points and team race scores.
 */
function scoreRace(results, settings) {
  const finished = results.filter((r) => r.status === 'finished');

  // Group finishers, order by laps desc / elapsed asc (resultsCsv's byTime),
  // and assign competition-ranking places: ties share a place, next skips.
  const groups = new Map();
  for (const r of finished) {
    const k = groupKey(r);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }

  const pointsFor = (place, table, other) => (place <= table.length ? table[place - 1] : other);

  const riders = [];
  for (const arr of groups.values()) {
    arr.sort((a, b) => (b.laps - a.laps) || (a.elapsed_ms - b.elapsed_ms));
    let place = 0;
    arr.forEach((r, i) => {
      const prev = arr[i - 1];
      if (!prev || prev.laps !== r.laps || prev.elapsed_ms !== r.elapsed_ms) place = i + 1;
      riders.push({
        bib: String(r.bib || '').trim(),
        participant: r.participant,
        team: String(r.team || '').trim(),
        distance: (r.distance || '').trim(),
        gender: r.gender || '',
        category: (r.category || '').trim(),
        place,
        points: pointsFor(place, settings.individual_points, settings.individual_other_points),
        team_points: pointsFor(place, settings.team_points, settings.team_other_points),
      });
    });
  }

  // Team race score: sum of the team's best team_top_runners values.
  const byTeam = new Map();
  for (const r of riders) {
    if (!r.team) continue;
    if (!byTeam.has(r.team)) byTeam.set(r.team, []);
    byTeam.get(r.team).push(r);
  }
  const teams = [...byTeam.entries()].map(([team, members]) => {
    const counted = members
      .slice()
      .sort((a, b) => b.team_points - a.team_points)
      .slice(0, settings.team_top_runners);
    return {
      team,
      points: counted.reduce((sum, m) => sum + m.team_points, 0),
      counted: counted.map((m) => ({ bib: m.bib, team_points: m.team_points })),
    };
  });

  return { riders, teams };
}

/** Sum the best n of a {contestId: points} map; returns {total, counted_ids}. */
function bestN(perRace, n) {
  const entries = Object.entries(perRace).sort((a, b) => b[1] - a[1]);
  const counted = entries.slice(0, n);
  return {
    total: counted.reduce((sum, [, pts]) => sum + pts, 0),
    counted_ids: counted.map(([cid]) => Number(cid)),
  };
}

/**
 * Season standings. `races` = [{contest: {id,...}, round, results}] ordered by
 * round. Rider identity across races = trimmed bib (fixed for the season per
 * the rulebook); display fields come from the rider's latest appearance.
 */
function computeLeagueStandings(races, settings) {
  const riderMap = new Map(); // bib -> {bib, name, team, distance, gender, category, per_race}
  const teamMap = new Map();  // team -> {team, per_race}

  for (const race of races) {
    const { riders, teams } = scoreRace(race.results, settings);
    for (const r of riders) {
      if (!r.bib) continue; // no bib -> cannot be tracked across the season
      if (!riderMap.has(r.bib)) riderMap.set(r.bib, { bib: r.bib, per_race: {} });
      const row = riderMap.get(r.bib);
      row.per_race[race.contest.id] = r.points;
      // latest appearance wins for display + grouping (races arrive in round order)
      row.name = r.participant;
      row.team = r.team;
      row.distance = r.distance;
      row.gender = r.gender;
      row.category = r.category;
    }
    for (const t of teams) {
      if (!teamMap.has(t.team)) teamMap.set(t.team, { team: t.team, per_race: {} });
      teamMap.get(t.team).per_race[race.contest.id] = t.points;
    }
  }

  // Individual standings grouped by the rider's (latest) scoring group.
  const groups = new Map();
  for (const row of riderMap.values()) {
    const { total, counted_ids } = bestN(row.per_race, settings.individual_best_n);
    const out = { bib: row.bib, name: row.name, team: row.team, per_race: row.per_race, counted_ids, total };
    const key = `${row.distance}|${genderLabelG(row.gender)}|${row.category}`;
    if (!groups.has(key)) {
      groups.set(key, { distance: row.distance, gender: genderLabelG(row.gender), category: row.category, rows: [] });
    }
    groups.get(key).rows.push(out);
  }
  const individual = [...groups.values()];
  for (const g of individual) g.rows.sort((a, b) => b.total - a.total);
  individual.sort((a, b) =>
    a.distance.localeCompare(b.distance) || a.gender.localeCompare(b.gender) || a.category.localeCompare(b.category));

  const teams = [...teamMap.values()].map((row) => {
    const { total, counted_ids } = bestN(row.per_race, settings.team_best_n);
    return { team: row.team, per_race: row.per_race, counted_ids, total };
  });
  teams.sort((a, b) => b.total - a.total);

  return { individual, teams };
}

module.exports = { DEFAULT_SETTINGS, normalizeSettings, groupKey, scoreRace, computeLeagueStandings };

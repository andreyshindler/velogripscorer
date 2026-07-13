'use strict';

const { db } = require('./db');

/**
 * Weighted final score per the spec (3.4):
 *   Score = Σ (weight_criterion × average_score_criterion)
 * Weights are percentages summing to 100, so the result lives on the same
 * scale as the raw scores (0..scale_max). pct_of_max = score / scale_max.
 */
function computeLeaderboard(contestId) {
  const contest = db.prepare('SELECT * FROM contests WHERE id = ?').get(contestId);
  if (!contest) return [];
  const criteria = db.prepare('SELECT * FROM criteria WHERE contest_id = ?').all(contestId);
  const entries = db
    .prepare(
      `SELECT e.*, u.name AS author_name, u.avatar_url AS author_avatar
       FROM entries e JOIN users u ON u.id = e.user_id
       WHERE e.contest_id = ? AND e.status = 'visible'`
    )
    .all(contestId);

  const avgRows = db
    .prepare(
      `SELECT v.entry_id, v.criterion_id, AVG(v.score) AS avg_score, COUNT(*) AS n
       FROM votes v JOIN entries e ON e.id = v.entry_id
       WHERE e.contest_id = ? AND e.status = 'visible'
       GROUP BY v.entry_id, v.criterion_id`
    )
    .all(contestId);

  const avgByEntry = new Map();
  for (const row of avgRows) {
    if (!avgByEntry.has(row.entry_id)) avgByEntry.set(row.entry_id, new Map());
    avgByEntry.get(row.entry_id).set(row.criterion_id, row);
  }

  const board = entries.map((entry) => {
    const avgs = avgByEntry.get(entry.id) || new Map();
    let score = 0;
    let voteCount = 0;
    const perCriterion = criteria.map((criterion) => {
      const row = avgs.get(criterion.id);
      const avg = row ? row.avg_score : 0;
      voteCount = Math.max(voteCount, row ? row.n : 0);
      score += (criterion.weight / 100) * avg;
      return { criterion_id: criterion.id, name: criterion.name, weight: criterion.weight, average: round2(avg) };
    });
    return {
      entry_id: entry.id,
      title: entry.title,
      user_id: entry.user_id,
      author_name: entry.author_name,
      author_avatar: entry.author_avatar,
      score: round2(score),
      pct_of_max: round2((score / contest.scale_max) * 100),
      votes: voteCount,
      per_criterion: perCriterion,
      created_at: entry.created_at,
    };
  });

  board.sort((a, b) => b.score - a.score || b.votes - a.votes || a.entry_id - b.entry_id);
  board.forEach((row, i) => (row.rank = i + 1));
  return board;
}

function entryScore(entryId) {
  const entry = db.prepare('SELECT contest_id FROM entries WHERE id = ?').get(entryId);
  if (!entry) return null;
  return computeLeaderboard(entry.contest_id).find((r) => r.entry_id === entryId) || null;
}

function round2(x) {
  return Math.round(x * 100) / 100;
}

module.exports = { computeLeaderboard, entryScore };

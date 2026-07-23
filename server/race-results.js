'use strict';

// Race results computed on the fly from raw chip reads — extracted from the
// /contests/:id/race-results route so the league standings can score attached
// races server-side without HTTP self-calls. Nothing is ever persisted: for
// every assigned tag whose wave has started,
//   - reads inside the suppression window (start .. start+suppress_secs) are
//     ignored (racers crossing the start-line antenna at the gun);
//   - the first valid read is the finish (single-crossing race) and each
//     subsequent read spaced >= min_lap_gap_secs starts a new lap;
//   - no valid reads => still on course (or DNS).

const { db } = require('./db');

/**
 * Compute the ranked results for one contest row (needs suppress_secs and
 * min_lap_gap_secs on it). Returns the results array with rank / behind /
 * category_rank filled in for finishers.
 */
function computeRaceResults(contest, { category } = {}) {
  const waves = new Map(db.prepare('SELECT * FROM waves WHERE contest_id = ?').all(contest.id).map((w) => [w.id, w]));
  const assignments = db
    .prepare('SELECT * FROM tag_assignments WHERE contest_id = ? ORDER BY bib, epc')
    .all(contest.id)
    .filter((a) => !category || a.category === category);
  const allReads = db
    .prepare('SELECT epc, read_at, manual FROM tag_reads WHERE contest_id = ? ORDER BY read_at')
    .all(contest.id);
  const readsByEpc = new Map();
  for (const r of allReads) {
    if (!readsByEpc.has(r.epc)) readsByEpc.set(r.epc, []);
    readsByEpc.get(r.epc).push({ at: Date.parse(r.read_at), manual: !!r.manual });
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
      epc: a.epc, epcs: a.epcs.slice(), bib: a.bib, participant: a.participant, category: a.category,
      distance: a.distance || '', team: a.team || '', gender: a.gender || '',
      wave: wave ? wave.name : null, wave_started_at: wave ? wave.started_at : null,
    };
    // organizer-declared statuses override everything (Webscorer-style)
    if (a.racer_status) return { ...base, status: a.racer_status, laps: 0 };
    if (!wave || !wave.started_at) return { ...base, status: 'not_started', laps: 0 };
    const startMs = Date.parse(wave.started_at);
    // Operator taps are deliberate: exempt from the start-suppression window
    // and the lap-gap dedupe (each tap is one crossing) — mirrors the app.
    const valid = a.epcs
      .flatMap((epc) => readsByEpc.get(epc) || [])
      .sort((x, y) => x.at - y.at)
      .filter((r) => r.manual || r.at >= startMs + suppressMs);
    if (!valid.length) return { ...base, status: 'on_course', laps: 0 };

    const crossings = [];
    for (const r of valid) {
      if (r.manual || !crossings.length || r.at - crossings[crossings.length - 1] >= lapGapMs) crossings.push(r.at);
      // Single-crossing race: the first valid crossing IS the finish.
      if (contest.record_laps === 0 && crossings.length) break;
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
      lap_ms: crossings.map((t) => t - startMs),
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

  return results;
}

function formatElapsed(ms) {
  const tenths = Math.round(ms / 100);
  const h = Math.floor(tenths / 36000);
  const m = Math.floor((tenths % 36000) / 600);
  const s = Math.floor((tenths % 600) / 10);
  const t = tenths % 10;
  return (h ? `${h}:${String(m).padStart(2, '0')}` : String(m)) + `:${String(s).padStart(2, '0')}.${t}`;
}

const isFemaleG = (g) => ['f', 'female', 'נקבה', 'אישה'].includes(String(g || '').trim().toLowerCase());
const isMaleG = (g) => ['m', 'male', 'זכר', 'גבר'].includes(String(g || '').trim().toLowerCase());
const genderLabelG = (g) => (isMaleG(g) ? 'Male' : isFemaleG(g) ? 'Female' : '');

module.exports = { computeRaceResults, formatElapsed, isFemaleG, isMaleG, genderLabelG };

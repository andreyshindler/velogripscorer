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
  // Reader roles: 'primary' reads (and any manual tap) are start/finish/lap
  // crossings; 'checkpoint' reads are split/pass times and must NOT count as
  // crossings. Default role is 'primary', so a race with no checkpoints behaves
  // exactly as before.
  const readerRole = new Map(
    db.prepare('SELECT id, name, location, role, clock_offset_ms FROM readers WHERE contest_id = ?').all(contest.id)
      .map((r) => [r.id, r])
  );
  // Reconcile a wave's gun to server time (0 offset when it was set from the web).
  const gunMs = (w) => Date.parse(w.started_at) + (w.gun_offset_ms || 0);
  const checkpointReaders = [...readerRole.values()]
    .filter((r) => r.role === 'checkpoint')
    .sort((a, b) => a.id - b.id);

  const allReads = db
    .prepare('SELECT epc, read_at, manual, reader_id FROM tag_reads WHERE contest_id = ? ORDER BY read_at')
    .all(contest.id);
  const readsByEpc = new Map();     // primary crossings (finish/lap)
  const cpReadsByEpc = new Map();   // checkpoint passes: epc -> [{at, reader_id}]
  for (const r of allReads) {
    const manual = !!r.manual;
    const role = readerRole.get(r.reader_id)?.role;
    const off = readerRole.get(r.reader_id)?.clock_offset_ms || 0;
    // Reconcile device reads to server time by the reader's clock offset.
    // Checkpoint reads — auto OR a marshal's manual tap — come from the
    // checkpoint device, so always correct them. On a primary reader, device
    // reads are corrected but web/operator manual reads are already server time.
    const offset = role === 'checkpoint' ? off : (manual ? 0 : off);
    const at = Date.parse(r.read_at) + offset;
    // A read on a checkpoint reader is a split/pass — whether the tag was read by
    // RFID or the marshal tapped the bib in manually.
    if (role === 'checkpoint') {
      if (!cpReadsByEpc.has(r.epc)) cpReadsByEpc.set(r.epc, []);
      cpReadsByEpc.get(r.epc).push({ at, reader_id: r.reader_id });
    } else {
      if (!readsByEpc.has(r.epc)) readsByEpc.set(r.epc, []);
      readsByEpc.get(r.epc).push({ at, manual });
    }
  }

  const suppressMs = contest.suppress_secs * 1000;
  const lapGapMs = contest.min_lap_gap_secs * 1000;

  // MTB/XCO "leader ends the race" rule: when the first rider completes the
  // target lap count, the race is over — everyone still on course finishes only
  // their current lap. Needs a lap target (per-distance, else race-wide) and a
  // multi-lap race. Applied as a cutoff after all crossings are known (below).
  let lapTargets = {};
  try { lapTargets = contest.lap_targets ? JSON.parse(contest.lap_targets) : {}; } catch { lapTargets = {}; }
  const targetFor = (distance) => {
    const d = Number(lapTargets[distance]);
    if (Number.isFinite(d) && d > 0) return d;
    const r = Number(contest.race_laps);
    return Number.isFinite(r) && r > 0 ? r : null;
  };
  const leaderRule = contest.leader_ends_race === 1 && contest.record_laps === 1;

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
      // raw organizer override ('' when auto) so the web editor shows the true
      // stored value, not the computed DNS/DNF; ignored by the public views.
      racer_status: a.racer_status || '',
    };
    // Checkpoint split/pass times (elapsed from the wave gun), keyed by
    // checkpoint reader id. Only the first pass at each checkpoint after the gun.
    base.splits = {};
    if (wave && wave.started_at && checkpointReaders.length) {
      const cpStartMs = gunMs(wave);
      const cpReads = a.epcs.flatMap((epc) => cpReadsByEpc.get(epc) || []);
      for (const cp of checkpointReaders) {
        const first = cpReads
          .filter((x) => x.reader_id === cp.id && x.at >= cpStartMs)
          .reduce((min, x) => (min === null || x.at < min ? x.at : min), null);
        if (first !== null) base.splits[cp.id] = { elapsed_ms: first - cpStartMs, elapsed: formatElapsed(first - cpStartMs) };
      }
    }
    // Once the race is finished, a racer who never crossed is a non-finisher,
    // not still "on course": no started wave -> DNS, no finish read -> DNF.
    const raceFinished = contest.status === 'finished';
    // organizer-declared statuses override everything (Webscorer-style)
    if (a.racer_status) return { ...base, status: a.racer_status, laps: 0 };
    if (!wave || !wave.started_at) return { ...base, status: raceFinished ? 'DNS' : 'not_started', laps: 0 };
    const startMs = gunMs(wave);
    // Operator taps are deliberate: exempt from the start-suppression window
    // and the lap-gap dedupe (each tap is one crossing) — mirrors the app.
    const valid = a.epcs
      .flatMap((epc) => readsByEpc.get(epc) || [])
      .sort((x, y) => x.at - y.at)
      .filter((r) => r.manual || r.at >= startMs + suppressMs);
    if (!valid.length) return { ...base, status: raceFinished ? 'DNF' : 'on_course', laps: 0 };

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
      // kept only when the leader rule is on, stripped before returning.
      ...(leaderRule ? { _crossings: crossings.slice(), _startMs: startMs, _target: targetFor(a.distance || '') } : {}),
    };
  });

  // Apply the leader cutoff once every racer's crossings are known. The cutoff
  // is the earliest wall-clock time any rider completes the target laps (first
  // overall finisher ends it for the whole field). Each racer then finishes on
  // the first crossing that reaches the target OR falls at/after the cutoff —
  // their current lap — and any crossing after that is ignored.
  if (leaderRule) {
    let cutoff = Infinity;
    for (const r of results) {
      if (r.status === 'finished' && r._target && r._crossings.length >= r._target) {
        cutoff = Math.min(cutoff, r._crossings[r._target - 1]);
      }
    }
    if (Number.isFinite(cutoff)) {
      for (const r of results) {
        if (r.status !== 'finished' || !r._crossings) continue;
        let idx = -1;
        for (let i = 0; i < r._crossings.length; i++) {
          if ((r._target && i + 1 >= r._target) || r._crossings[i] >= cutoff) { idx = i; break; }
        }
        if (idx === -1) continue; // never reached target nor crossed after cutoff — leave as-is
        const kept = r._crossings.slice(0, idx + 1);
        const last = kept[kept.length - 1];
        r.laps = kept.length;
        r.last_crossing_at = new Date(last).toISOString();
        r.elapsed_ms = last - r._startMs;
        r.elapsed = formatElapsed(last - r._startMs);
        r.lap_splits = kept.map((t) => formatElapsed(t - r._startMs));
        r.lap_ms = kept.map((t) => t - r._startMs);
      }
    }
    for (const r of results) { delete r._crossings; delete r._startMs; delete r._target; }
  }

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

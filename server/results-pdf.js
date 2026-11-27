'use strict';

// PDF builders for the exports the operator pulls from Telegram: one per-race
// results sheet and the two accumulated league-standings sheets (team +
// individual). They mirror the column/section layout of the CSV builders
// (resultsCsv in routes/readers.js; individualCsv/teamCsv in routes/leagues.js)
// but render a paginated table with pdf-lib. Headers and labels are Hebrew;
// each cell is split into bidi runs by ./bidi and drawn right-aligned so Hebrew
// reads RTL while numbers/times stay LTR.

const fs = require('fs');
const path = require('path');
const { PDFDocument, rgb } = require('pdf-lib');
const fontkit = require('@pdf-lib/fontkit');
const { visualParts } = require('./bidi');
const { formatElapsed, isFemaleG, isMaleG, genderLabelG, isTimeOnlySport } = require('./race-results');
// The same order the standings and the results page use: an age category is
// read by the number in it, so "עד 42" leads and "מעל 60" lands after 50-60.
const { compareCategories } = require('./league-scoring');

// Hebrew column headers + labels, matching the web UI (public/i18n.js `he`).
const H = {
  place: 'מקום', bib: 'מס׳', name: 'שם', team: 'קבוצה', category: 'קטגוריה',
  gender: 'מין', time: 'זמן', behind: 'פער', status: 'סטטוס', distance: 'מרחק',
  total: 'סה״כ', overall: 'כללי', female: 'נשים', male: 'גברים',
  finishers: 'מסיימים', dnf: 'לא סיימו', races: 'מרוצים', counted: 'נספרים',
  teamStandings: 'ניקוד קבוצתי', individualStandings: 'ניקוד אישי',
  // הקפה / הקפות, as the web UI says it (public/i18n.js he.lap / he.laps).
  // This used to read 'סיבובים', which nothing rendered and the website never
  // said; "-1 הקפה" below has to match what a rider sees on screen.
  laps: 'הקפות', lap: 'הקפה',
  points: 'ניקוד', cumulative: 'ניקוד מצטבר', deduction: 'הפחתה',
};
// gender label for a cell (singular) or a section/group title (plural).
function genderHe(label, plural) {
  if (label === 'Male' || isMaleG(label)) return plural ? 'גברים' : 'גבר';
  if (label === 'Female' || isFemaleG(label)) return plural ? 'נשים' : 'אישה';
  return '';
}

// Fonts embedded (and subset) into every document; read once at startup.
const FONT_DIR = path.join(__dirname, 'assets', 'fonts');
const REGULAR_BYTES = fs.readFileSync(path.join(FONT_DIR, 'NotoSansHebrew-Regular.ttf'));
const BOLD_BYTES = fs.readFileSync(path.join(FONT_DIR, 'NotoSansHebrew-Bold.ttf'));

const A4 = { W: 841.89, H: 595.28 };        // landscape
const A4_PORTRAIT = { W: 595.28, H: 841.89 };
const MARGIN = 36;
const HEADER_BG = rgb(0.93, 0.93, 0.95);
const ROW_ALT = rgb(0.97, 0.97, 0.98);
const LINE = rgb(0.85, 0.85, 0.87);
const INK = rgb(0.1, 0.1, 0.12);

async function newDoc(landscape) {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const fontR = await doc.embedFont(REGULAR_BYTES, { subset: true });
  const fontB = await doc.embedFont(BOLD_BYTES, { subset: true });
  const size = landscape ? A4 : A4_PORTRAIT;
  return { doc, fontR, fontB, size, page: null, y: 0 };
}

function addPage(ctx) {
  ctx.page = ctx.doc.addPage([ctx.size.W, ctx.size.H]);
  ctx.y = ctx.size.H - MARGIN;
  return ctx.page;
}

// Rendered width of a cell: its bidi runs laid out with a single gap between.
function partsWidth(font, parts, sizePt) {
  if (!parts.length) return 0;
  const gap = font.widthOfTextAtSize(' ', sizePt);
  return parts.reduce((s, t) => s + font.widthOfTextAtSize(t, sizePt), 0) + gap * (parts.length - 1);
}

// Truncate a logical-order string so its rendered (bidi) width fits maxWidth.
function fit(ctx, str, sizePt, maxWidth, bold) {
  const font = bold ? ctx.fontB : ctx.fontR;
  let s = String(str == null ? '' : str);
  if (partsWidth(font, visualParts(s), sizePt) <= maxWidth) return s;
  while (s.length > 1) {
    s = s.slice(0, -1);
    if (partsWidth(font, visualParts(s + '…'), sizePt) <= maxWidth) return s + '…';
  }
  return s;
}

// Place already-split visual runs within [x0, x0+boxW] at absolute y, each run
// drawn as its own text object so the viewer's bidi can't reorder across runs.
function drawParts(ctx, parts, font, sizePt, align, x0, boxW, y, color) {
  if (!parts.length) return;
  const gap = font.widthOfTextAtSize(' ', sizePt);
  const total = partsWidth(font, parts, sizePt);
  let tx;
  if (align === 'l') tx = x0;
  else if (align === 'c') tx = x0 + (boxW - total) / 2;
  else tx = x0 + boxW - total; // 'r'
  for (const t of parts) {
    ctx.page.drawText(t, { x: tx, y, size: sizePt, font, color });
    tx += font.widthOfTextAtSize(t, sizePt) + gap;
  }
}

// Draw one table cell, honouring alignment; splits into bidi runs first.
function drawCell(ctx, value, col, x, y, sizePt, bold) {
  const font = bold ? ctx.fontB : ctx.fontR;
  const pad = 3;
  const parts = visualParts(fit(ctx, value, sizePt, col.width - pad * 2, bold));
  drawParts(ctx, parts, font, sizePt, col.align, x + pad, col.width - pad * 2, y, INK);
}

const ROW_H = 15;
const CELL_SIZE = 8.5;
const HEAD_SIZE = 8.5;

function drawHeaderRow(ctx, columns, x0) {
  const totalW = columns.reduce((s, c) => s + c.width, 0);
  ctx.page.drawRectangle({ x: x0, y: ctx.y - ROW_H + 3, width: totalW, height: ROW_H, color: HEADER_BG });
  const ty = ctx.y - ROW_H + 7;
  // RTL: the first logical column sits at the right edge.
  let x = x0;
  for (const c of columns.slice().reverse()) { drawCell(ctx, c.header, c, x, ty, HEAD_SIZE, true); x += c.width; }
  ctx.y -= ROW_H;
  ctx.page.drawLine({ start: { x: x0, y: ctx.y + 3 }, end: { x: x0 + totalW, y: ctx.y + 3 }, thickness: 0.6, color: LINE });
}

/**
 * Draw a table. columns: [{header, key|render, width, align:'l'|'c'|'r', rtl}].
 * rows: array of source objects. `render(row, i)` (or row[key]) yields the cell
 * string. Repeats the header band on each new page. Returns nothing; advances y.
 */
function drawTable(ctx, columns, rows, x0) {
  drawHeaderRow(ctx, columns, x0);
  rows.forEach((row, i) => {
    if (ctx.y - ROW_H < MARGIN) { addPage(ctx); drawHeaderRow(ctx, columns, x0); }
    const totalW = columns.reduce((s, c) => s + c.width, 0);
    if (i % 2 === 1) ctx.page.drawRectangle({ x: x0, y: ctx.y - ROW_H + 3, width: totalW, height: ROW_H, color: ROW_ALT });
    const ty = ctx.y - ROW_H + 7;
    let x = x0;
    // RTL: draw columns right-to-left so the first logical column is rightmost.
    for (const c of columns.slice().reverse()) {
      const v = typeof c.render === 'function' ? c.render(row, i) : row[c.key];
      drawCell(ctx, v, c, x, ty, CELL_SIZE, false);
      x += c.width;
    }
    ctx.y -= ROW_H;
  });
}

function drawTitle(ctx, text, sizePt, x0, totalW) {
  if (ctx.y - sizePt - 6 < MARGIN) addPage(ctx);
  const parts = Array.isArray(text) ? text : visualParts(text);
  drawParts(ctx, parts, ctx.fontB, sizePt, 'r', x0, totalW, ctx.y - sizePt, INK);
  ctx.y -= sizePt + 6;
}

// Build a section-title draw order from components given in RTL reading order
// (first component sits at the right). Each component keeps its own internal
// bidi; forcing the order avoids the base-direction guess flipping the distance
// to the left when a title starts with "5k"/"10k".
function rtlTitle(components) {
  const parts = [];
  for (let i = components.length - 1; i >= 0; i--) {
    if (components[i]) parts.push(...visualParts(components[i]));
  }
  return parts.length ? parts : [H.overall];
}

function drawSub(ctx, text, x0, totalW) {
  if (ctx.y - 12 < MARGIN) addPage(ctx);
  drawParts(ctx, visualParts(text), ctx.fontR, 9, 'r', x0, totalW, ctx.y - 10, rgb(0.4, 0.4, 0.45));
  ctx.y -= 16;
}

/**
 * Gap to the leader of one section. A rider a lap down reads "-N הקפות", not a
 * time: the clock difference to someone who rode further says nothing, and on
 * a multi-lap field a rider a whole lap back used to print as "+0:12.4" — as
 * if twelve seconds covered it. Mirrors r.behind in race-results.js and
 * gapToLeader in public/app.js, so the sheet, the API and the screen agree.
 */
function sectionGap(r, leader, timeOnly) {
  if (r === leader) return '';
  if (!timeOnly && Number.isFinite(r.laps) && Number.isFinite(leader.laps) && r.laps < leader.laps) {
    const down = leader.laps - r.laps;
    return `-${down} ${down > 1 ? H.laps : H.lap}`;
  }
  // Clamp rather than print a negative: with laps deciding places the leader is
  // not always the quickest on the clock.
  if (r.elapsed_ms <= leader.elapsed_ms) return '';
  return '+' + formatElapsed(r.elapsed_ms - leader.elapsed_ms);
}

/**
 * The rows of one results section, placed and gapped within that section.
 * Exported so the placing rules can be checked without rendering a PDF.
 *
 * timeOnly mirrors computeRaceResults: a running race is ranked on elapsed time
 * ALONE, because it is scored on one crossing and an extra "lap" there is a
 * stray double read. So laps must not sort, break a tie, or show as "-1 הקפה"
 * in that case — and anywhere else a lap is a place and all three apply.
 */
function raceSectionRows(rowsIn, timeOnly) {
  const rows = rowsIn.slice()
    .sort((a, b) => (timeOnly ? 0 : b.laps - a.laps) || (a.elapsed_ms - b.elapsed_ms));
  const leader = rows[0];
  let prev = null, prevPlace = 0;
  return rows.map((r, i) => {
    // Equal elapsed time alone is not a tie in a lap race: the rider a lap down
    // covered a shorter distance in it, and used to be handed the same place.
    const tied = prev && r.elapsed_ms === prev.elapsed_ms && (timeOnly || r.laps === prev.laps);
    const place = tied ? prevPlace : i + 1;
    prev = r; prevPlace = place;
    return {
      place, bib: r.bib, name: r.participant, team: r.team, category: r.category,
      gender: r.gender, laps: r.laps, time: r.elapsed, behind: sectionGap(r, leader, timeOnly),
    };
  });
}

// ---------------------------------------------------------------------------
// 1) Per-race results
// ---------------------------------------------------------------------------
async function raceResultsPdf(contest, results) {
  const ctx = await newDoc(true);
  addPage(ctx);

  // A lap race is placed on laps first, so the sheet has to show them — without
  // the column, two riders a lap apart differ only by a gap the reader cannot
  // account for. A running race is placed on time alone and every finisher has
  // one lap, so the column would be a stripe of 1s: left out there.
  const timeOnly = isTimeOnlySport(contest.sport);
  const cols = [
    { header: H.place, width: 34, align: 'r', render: (r) => r.place },
    { header: H.bib, width: 40, align: 'r', render: (r) => r.bib },
    { header: H.name, width: 140, align: 'r', render: (r) => r.name },
    { header: H.team, width: 145, align: 'r', render: (r) => r.team },
    { header: H.category, width: 64, align: 'r', render: (r) => r.category },
    { header: H.gender, width: 42, align: 'r', render: (r) => genderHe(genderLabelG(r.gender), false) },
    ...(timeOnly ? [] : [{ header: H.laps, width: 44, align: 'r', render: (r) => r.laps }]),
    { header: H.time, width: 60, align: 'r', render: (r) => r.time },
    { header: H.behind, width: 70, align: 'r', render: (r) => r.behind },
  ];
  const totalW = cols.reduce((s, c) => s + c.width, 0);
  const x0 = ctx.size.W - MARGIN - totalW; // right-anchor the RTL table block

  drawTitle(ctx, contest.title || 'Race results', 15, x0, totalW);
  drawSub(ctx, `${results.filter((r) => r.status === 'finished').length} ${H.finishers}`, x0, totalW);

  const finished = results.filter((r) => r.status === 'finished');

  const section = (title, rowsIn) => {
    if (!rowsIn.length) return;
    const view = raceSectionRows(rowsIn, timeOnly);
    ctx.y -= 4;
    drawTitle(ctx, title, 11, x0, totalW);
    drawTable(ctx, cols, view, x0);
  };

  const distances = [...new Set(finished.map((r) => r.distance))]
    .sort((a, b) => String(a || '').localeCompare(String(b || ''), undefined, { numeric: true }));
  for (const d of distances) {
    const inD = finished.filter((r) => r.distance === d);
    const label = d || H.overall;
    section(rtlTitle([label, H.overall]), inD);
    section(rtlTitle([label, H.female]), inD.filter((r) => isFemaleG(r.gender)));
    section(rtlTitle([label, H.male]), inD.filter((r) => isMaleG(r.gender)));
  }
  for (const d of distances) {
    const inD = finished.filter((r) => r.distance === d);
    const label = d || H.overall;
    for (const { category: cat, gender: g } of categorySections(inD)) {
      const gl = genderHe(genderLabelG(g), true);
      // RTL reading order: distance, then gender, then category.
      section(rtlTitle([label, gl, cat]),
        inD.filter((r) => r.category === cat && (r.gender || '').toLowerCase() === g));
    }
  }

  // Non-finishers (DNS/DNF/DSQ and still-on-course), if any.
  const others = results.filter((r) => r.status !== 'finished');
  if (others.length) {
    ctx.y -= 6;
    drawTitle(ctx, `${H.dnf} · ${others.length}`, 11, x0, totalW);
    const cols = [
      { header: H.bib, width: 40, align: 'r', render: (r) => r.bib },
      { header: H.name, width: 150, align: 'r', render: (r) => r.participant },
      { header: H.team, width: 150, align: 'r', render: (r) => r.team },
      { header: H.category, width: 74, align: 'r', render: (r) => r.category },
      { header: H.status, width: 60, align: 'r', render: (r) => r.status },
    ];
    const dnfW = cols.reduce((s, c) => s + c.width, 0);
    drawTable(ctx, cols, others, ctx.size.W - MARGIN - dnfW); // right-anchored too
  }

  return Buffer.from(await ctx.doc.save());
}

// ---------------------------------------------------------------------------
// 2) League team standings
// ---------------------------------------------------------------------------
function roundColumns(raceList, availWidth, fixedWidth, opts = {}) {
  const n = raceList.length;
  const roundW = n ? Math.max(22, Math.min(40, Math.floor((availWidth - fixedWidth) / Math.max(n, 1)))) : 0;
  return raceList.map((r) => ({
    header: `ס${r.round}`, width: roundW, align: 'r', // ס = סבב (round)
    render: (row) => (row.per_race && row.per_race[r.contest_id] !== undefined ? row.per_race[r.contest_id] : ''),
  }));
}

async function leagueTeamPdf(league, teams, raceList) {
  const ctx = await newDoc(false);
  addPage(ctx);
  const usable = ctx.size.W - MARGIN * 2;
  const fixed = [
    { header: H.place, width: 36, align: 'r', render: (r, i) => i + 1 },
    { header: H.team, width: 150, align: 'r', render: (r) => r.team },
  ];
  const totalFixed = fixed.reduce((s, c) => s + c.width, 0) + 46 + 62; // + Deduction + Cumulative cols
  const rounds = roundColumns(raceList, usable, totalFixed);
  // The dropped rounds (best-N) show as a deduction: the points not counted.
  const deduction = (r) => {
    const sum = Object.values(r.per_race || {}).reduce((a, b) => a + b, 0);
    const d = sum - r.total;
    return d > 0 ? d : '';
  };
  const columns = [...fixed, ...rounds,
    { header: H.deduction, width: 46, align: 'r', render: deduction },
    { header: H.cumulative, width: 62, align: 'r', render: (r) => r.total }];
  const totalW = columns.reduce((s, c) => s + c.width, 0);
  const x0 = ctx.size.W - MARGIN - totalW; // right-anchor the RTL table block

  drawTitle(ctx, `${league.name}${league.season ? ` — ${league.season}` : ''}`, 15, x0, totalW);
  drawSub(ctx, `${H.teamStandings} · ${raceList.length} ${H.races} · ${bestNote(teams)}`, x0, totalW);
  drawTable(ctx, columns, teams, x0);
  return Buffer.from(await ctx.doc.save());
}

// ---------------------------------------------------------------------------
// 3) League individual standings
// ---------------------------------------------------------------------------
async function leagueIndividualPdf(league, individual, raceList) {
  const ctx = await newDoc(true);
  addPage(ctx);
  const usable = ctx.size.W - MARGIN * 2;
  const fixed = [
    { header: H.place, width: 34, align: 'r', render: (r, i) => i + 1 },
    { header: H.bib, width: 40, align: 'r', render: (r) => r.bib },
    { header: H.name, width: 140, align: 'r', render: (r) => r.name },
    { header: H.team, width: 140, align: 'r', render: (r) => r.team },
  ];
  const totalFixed = fixed.reduce((s, c) => s + c.width, 0) + 46; // + Total col
  const rounds = roundColumns(raceList, usable, totalFixed);
  const columns = [...fixed, ...rounds, { header: H.total, width: 46, align: 'r', render: (r) => r.total }];
  const totalW = columns.reduce((s, c) => s + c.width, 0);
  const x0 = ctx.size.W - MARGIN - totalW; // right-anchor the RTL table block

  drawTitle(ctx, `${league.name}${league.season ? ` — ${league.season}` : ''}`, 15, x0, totalW);
  drawSub(ctx, `${H.individualStandings} · ${raceList.length} ${H.races}`, x0, totalW);

  for (const group of individual) {
    // RTL reading order: distance, then gender, then category.
    const title = rtlTitle([group.distance, genderHe(group.gender, true), group.category]);
    ctx.y -= 4;
    drawTitle(ctx, title, 11, x0, totalW);
    drawTable(ctx, columns, group.rows, x0);
  }
  return Buffer.from(await ctx.doc.save());
}

// ---------------------------------------------------------------------------
// 4) One race's team points, worked out: every rider's place and points and
//    which of them make up each team's score.
// ---------------------------------------------------------------------------
/**
 * `scored` is scoreRace(results, settings) for this one race. In "overall"
 * mode a rider's team points come from the place among every finisher
 * (100, 99, …); in "category" mode from the place within the category.
 */
async function raceTeamPointsPdf(contest, scored, settings) {
  const ctx = await newDoc(true);
  addPage(ctx);
  const overall = settings.team_scoring_mode === 'overall';
  const top = settings.team_top_runners;

  // Teams, best first; equal scores share a place.
  const teams = scored.teams.slice()
    .sort((a, b) => (b.points - a.points) || a.team.localeCompare(b.team));
  let prevPts = null, prevPlace = 0;
  teams.forEach((t, i) => {
    t.rank = t.points === prevPts ? prevPlace : i + 1;
    prevPts = t.points; prevPlace = t.rank;
  });

  const placeOf = (r) => (overall ? r.overall_place : r.place);
  const memberCols = [
    { header: overall ? 'מקום כללי' : 'מקום בקטגוריה', width: 62, align: 'r', render: (r) => placeOf(r) },
    { header: H.bib, width: 38, align: 'r', render: (r) => r.bib },
    { header: H.name, width: 140, align: 'r', render: (r) => r.participant },
    { header: H.team, width: 130, align: 'r', render: (r) => r.team },
    { header: H.distance, width: 46, align: 'r', render: (r) => r.distance },
    { header: H.category, width: 66, align: 'r', render: (r) => r.category },
    { header: H.gender, width: 38, align: 'r', render: (r) => genderHe(genderLabelG(r.gender), false) },
    { header: H.time, width: 56, align: 'r', render: (r) => r.elapsed },
    { header: H.points, width: 44, align: 'r', render: (r) => r.team_points },
    { header: 'נספר', width: 40, align: 'r', render: (r) => (r.counted ? 'כן' : '') },
  ];
  const totalW = memberCols.reduce((s, c) => s + c.width, 0);
  const x0 = ctx.size.W - MARGIN - totalW;

  const rule = overall
    ? `ניקוד לפי מקום כללי: ${settings.team_overall_start} למקום הראשון, ומטה נקודה לכל מקום, מינימום ${settings.team_other_points}`
    : `ניקוד לפי מקום בקטגוריה: ${settings.team_points.join(' / ')}, אחרים ${settings.team_other_points}`;
  drawTitle(ctx, contest.title || 'Race', 15, x0, totalW);
  drawSub(ctx, `${H.teamStandings} · ${rule}`, x0, totalW);
  drawSub(ctx, `ניקוד הקבוצה = סכום ${top} הרוכבים הטובים שלה`, x0, totalW);

  // Summary: one line per team.
  const sumCols = [
    { header: H.place, width: 40, align: 'r', render: (t) => t.rank },
    { header: H.team, width: 170, align: 'r', render: (t) => t.team },
    { header: H.points, width: 56, align: 'r', render: (t) => t.points },
    { header: 'פירוט', width: 254, align: 'r', render: (t) => t.counted.map((m) => m.team_points).join(' + ') },
  ];
  const sumW = sumCols.reduce((s, c) => s + c.width, 0);
  ctx.y -= 4;
  drawTitle(ctx, 'סיכום', 11, x0, totalW);
  drawTable(ctx, sumCols, teams, ctx.size.W - MARGIN - sumW);

  // Each team with every member; the counted ones marked.
  for (const t of teams) {
    const rows = t.members.map((m, i) => ({ ...m, counted: i < t.counted.length }));
    ctx.y -= 8;
    if (ctx.y - 11 - 6 - ROW_H * 2 < MARGIN) addPage(ctx);
    drawTitle(ctx, rtlTitle([`${H.place} ${t.rank}`, '·', t.team, '·', `${t.points} נקודות`]), 11, x0, totalW);
    drawTable(ctx, memberCols, rows, x0);
  }

  // Overall mode: the whole field in finishing order, so every 100, 99, … can
  // be traced, riders without a team included.
  if (overall) {
    const all = scored.riders.slice().sort((a, b) => a.overall_place - b.overall_place);
    const allCols = [
      { header: 'מקום כללי', width: 62, align: 'r', render: (r) => r.overall_place },
      { header: H.bib, width: 38, align: 'r', render: (r) => r.bib },
      { header: H.name, width: 140, align: 'r', render: (r) => r.participant },
      { header: H.team, width: 140, align: 'r', render: (r) => r.team },
      { header: H.distance, width: 40, align: 'r', render: (r) => r.distance },
      { header: H.category, width: 56, align: 'r', render: (r) => r.category },
      { header: H.time, width: 56, align: 'r', render: (r) => r.elapsed },
      { header: H.points, width: 44, align: 'r', render: (r) => r.team_points },
    ];
    const allW = allCols.reduce((s, c) => s + c.width, 0);
    addPage(ctx);
    drawTitle(ctx, `כל המסיימים · ${all.length}`, 11, ctx.size.W - MARGIN - allW, allW);
    drawTable(ctx, allCols, all, ctx.size.W - MARGIN - allW);
  }

  return Buffer.from(await ctx.doc.save());
}

function bestNote(teams) {
  const c = teams.reduce((mx, t) => Math.max(mx, (t.counted_ids || []).length), 0);
  return c ? `${c} ${H.counted}` : H.overall;
}

/**
 * The category sections of a race PDF, in the order they are printed.
 *
 * They used to come out in the order a category first appeared in the results
 * — which is finishing order — so the PDF opened with 50-60, then עד 42, then
 * 43-45, depending on who happened to cross first. Ordered by the category's
 * number now, the same rule the standings and the results page use.
 *
 * Exported for the tests: the order is the thing being fixed, and reading it
 * back out of a rendered PDF is not a test anyone would trust.
 */
function categorySections(rows) {
  return [...new Set(rows.filter((r) => r.category)
    .map((r) => `${r.category}|${(r.gender || '').toLowerCase()}`))]
    .sort((a, b) => {
      const [ca, ga] = a.split('|');
      const [cb, gb] = b.split('|');
      return compareCategories(ca, cb) || ga.localeCompare(gb);
    })
    .map((combo) => {
      const [category, gender] = combo.split('|');
      return { category, gender };
    });
}

// raceSectionRows is exported for the tests: it carries the placing, tie and
// gap rules, none of which can be read back out of a rendered PDF.
module.exports = { raceResultsPdf, leagueTeamPdf, leagueIndividualPdf, raceTeamPointsPdf, raceSectionRows, categorySections };

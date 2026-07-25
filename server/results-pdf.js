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
const { formatElapsed, isFemaleG, isMaleG, genderLabelG } = require('./race-results');

// Hebrew column headers + labels, matching the web UI (public/i18n.js `he`).
const H = {
  place: 'מקום', bib: 'מס׳', name: 'שם', team: 'קבוצה', category: 'קטגוריה',
  gender: 'מין', time: 'זמן', behind: 'פער', status: 'סטטוס', distance: 'מרחק',
  total: 'סה״כ', overall: 'כללי', female: 'נשים', male: 'גברים',
  finishers: 'מסיימים', dnf: 'לא סיימו', races: 'מרוצים', counted: 'נספרים',
  teamStandings: 'ניקוד קבוצתי', individualStandings: 'ניקוד אישי',
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

// ---------------------------------------------------------------------------
// 1) Per-race results
// ---------------------------------------------------------------------------
async function raceResultsPdf(contest, results) {
  const ctx = await newDoc(true);
  addPage(ctx);

  const columns = [
    { header: H.place, width: 42, align: 'r' },
    { header: H.bib, width: 46, align: 'r' },
    { header: H.name, width: 195, align: 'r' },
    { header: H.team, width: 180, align: 'r' },
    { header: H.category, width: 90, align: 'r' },
    { header: H.gender, width: 58, align: 'r' },
    { header: H.time, width: 78, align: 'r' },
    { header: H.behind, width: 80, align: 'r' },
  ];
  const totalW = columns.reduce((s, c) => s + c.width, 0);
  const x0 = ctx.size.W - MARGIN - totalW; // right-anchor the RTL table block

  drawTitle(ctx, contest.title || 'Race results', 15, x0, totalW);
  drawSub(ctx, `${results.filter((r) => r.status === 'finished').length} ${H.finishers}`, x0, totalW);

  const finished = results.filter((r) => r.status === 'finished');
  const byTime = (a, b) => (b.laps - a.laps) || (a.elapsed_ms - b.elapsed_ms);

  const section = (title, rowsIn) => {
    const rows = rowsIn.slice().sort(byTime);
    if (!rows.length) return;
    const leaderMs = rows[0].elapsed_ms;
    let prevMs = null, prevPlace = 0;
    const view = rows.map((r, i) => {
      const place = (prevMs !== null && r.elapsed_ms === prevMs) ? prevPlace : i + 1;
      prevMs = r.elapsed_ms; prevPlace = place;
      const behind = r.elapsed_ms === leaderMs ? '' : '+' + formatElapsed(r.elapsed_ms - leaderMs);
      return { place, bib: r.bib, name: r.participant, team: r.team, category: r.category,
        gender: genderHe(genderLabelG(r.gender), false), time: r.elapsed, behind };
    });
    const cols = [
      { ...columns[0], render: (r) => r.place },
      { ...columns[1], render: (r) => r.bib },
      { ...columns[2], render: (r) => r.name },
      { ...columns[3], render: (r) => r.team },
      { ...columns[4], render: (r) => r.category },
      { ...columns[5], render: (r) => r.gender },
      { ...columns[6], render: (r) => r.time },
      { ...columns[7], render: (r) => r.behind },
    ];
    ctx.y -= 4;
    drawTitle(ctx, title, 11, x0, totalW);
    drawTable(ctx, cols, view, x0);
  };

  const distances = [...new Set(finished.map((r) => r.distance))];
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
    const combos = [...new Set(inD.filter((r) => r.category).map((r) => `${r.category}|${(r.gender || '').toLowerCase()}`))];
    for (const combo of combos) {
      const [cat, g] = combo.split('|');
      const gl = genderHe(genderLabelG(g), true);
      // RTL reading order: distance, then category, then gender.
      section(rtlTitle([label, cat, gl]),
        inD.filter((r) => r.category === cat && (r.gender || '').toLowerCase() === g));
    }
  }

  // Non-finishers (DNS/DNF/DSQ and still-on-course), if any.
  const others = results.filter((r) => r.status !== 'finished');
  if (others.length) {
    ctx.y -= 6;
    drawTitle(ctx, `${H.dnf} · ${others.length}`, 11, x0, totalW);
    const cols = [
      { header: H.bib, width: 46, align: 'r', render: (r) => r.bib },
      { header: H.name, width: 220, align: 'r', render: (r) => r.participant },
      { header: H.team, width: 200, align: 'r', render: (r) => r.team },
      { header: H.category, width: 110, align: 'r', render: (r) => r.category },
      { header: H.status, width: 80, align: 'r', render: (r) => r.status },
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
    { header: H.place, width: 40, align: 'r', render: (r, i) => i + 1 },
    { header: H.team, width: 190, align: 'r', render: (r) => r.team },
  ];
  const totalFixed = fixed.reduce((s, c) => s + c.width, 0) + 52; // + Total col
  const rounds = roundColumns(raceList, usable, totalFixed);
  const columns = [...fixed, ...rounds, { header: H.total, width: 52, align: 'r', render: (r) => r.total }];
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
    { header: H.place, width: 40, align: 'r', render: (r, i) => i + 1 },
    { header: H.bib, width: 44, align: 'r', render: (r) => r.bib },
    { header: H.name, width: 190, align: 'r', render: (r) => r.name },
    { header: H.team, width: 170, align: 'r', render: (r) => r.team },
  ];
  const totalFixed = fixed.reduce((s, c) => s + c.width, 0) + 50; // + Total col
  const rounds = roundColumns(raceList, usable, totalFixed);
  const columns = [...fixed, ...rounds, { header: H.total, width: 50, align: 'r', render: (r) => r.total }];
  const totalW = columns.reduce((s, c) => s + c.width, 0);
  const x0 = ctx.size.W - MARGIN - totalW; // right-anchor the RTL table block

  drawTitle(ctx, `${league.name}${league.season ? ` — ${league.season}` : ''}`, 15, x0, totalW);
  drawSub(ctx, `${H.individualStandings} · ${raceList.length} ${H.races}`, x0, totalW);

  for (const group of individual) {
    // RTL reading order: distance, then category, then gender.
    const title = rtlTitle([group.distance, group.category, genderHe(group.gender, true)]);
    ctx.y -= 4;
    drawTitle(ctx, title, 11, x0, totalW);
    drawTable(ctx, columns, group.rows, x0);
  }
  return Buffer.from(await ctx.doc.save());
}

function bestNote(teams) {
  const c = teams.reduce((mx, t) => Math.max(mx, (t.counted_ids || []).length), 0);
  return c ? `${c} ${H.counted}` : H.overall;
}

module.exports = { raceResultsPdf, leagueTeamPdf, leagueIndividualPdf };

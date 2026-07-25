'use strict';

// PDF builders for the exports the operator pulls from Telegram: one per-race
// results sheet and the two accumulated league-standings sheets (team +
// individual). They mirror the column/section layout of the CSV builders
// (resultsCsv in routes/readers.js; individualCsv/teamCsv in routes/leagues.js)
// but render a paginated table with pdf-lib. Hebrew cells are reordered to
// visual order with ./bidi and right-aligned; numbers/times stay LTR.

const fs = require('fs');
const path = require('path');
const { PDFDocument, rgb } = require('pdf-lib');
const fontkit = require('@pdf-lib/fontkit');
const { reorderRtl } = require('./bidi');
const { formatElapsed, isFemaleG, isMaleG, genderLabelG } = require('./race-results');

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

// Truncate a logical-order string so its reordered visual form fits maxWidth.
function fit(ctx, str, sizePt, maxWidth, bold) {
  const font = bold ? ctx.fontB : ctx.fontR;
  let s = String(str == null ? '' : str);
  if (font.widthOfTextAtSize(reorderRtl(s), sizePt) <= maxWidth) return s;
  while (s.length > 1) {
    s = s.slice(0, -1);
    if (font.widthOfTextAtSize(reorderRtl(s + '…'), sizePt) <= maxWidth) return s + '…';
  }
  return s;
}

// Draw one cell's text within [x, x+width], honouring alignment + RTL reorder.
function drawCell(ctx, value, col, x, y, sizePt, bold) {
  const font = bold ? ctx.fontB : ctx.fontR;
  const pad = 3;
  const text = reorderRtl(fit(ctx, value, sizePt, col.width - pad * 2, bold));
  if (text === '') return;
  const w = font.widthOfTextAtSize(text, sizePt);
  let tx;
  if (col.align === 'l') tx = x + pad;
  else if (col.align === 'c') tx = x + (col.width - w) / 2;
  else tx = x + col.width - w - pad; // 'r'
  ctx.page.drawText(text, { x: tx, y, size: sizePt, font, color: INK });
}

const ROW_H = 15;
const CELL_SIZE = 8.5;
const HEAD_SIZE = 8.5;

function drawHeaderRow(ctx, columns, x0) {
  const totalW = columns.reduce((s, c) => s + c.width, 0);
  ctx.page.drawRectangle({ x: x0, y: ctx.y - ROW_H + 3, width: totalW, height: ROW_H, color: HEADER_BG });
  let x = x0;
  const ty = ctx.y - ROW_H + 7;
  for (const c of columns) { drawCell(ctx, c.header, c, x, ty, HEAD_SIZE, true); x += c.width; }
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
    let x = x0;
    const ty = ctx.y - ROW_H + 7;
    for (const c of columns) {
      const v = typeof c.render === 'function' ? c.render(row, i) : row[c.key];
      drawCell(ctx, v, c, x, ty, CELL_SIZE, false);
      x += c.width;
    }
    ctx.y -= ROW_H;
  });
}

function drawTitle(ctx, text, sizePt, x0, totalW) {
  if (ctx.y - sizePt - 6 < MARGIN) addPage(ctx);
  const t = reorderRtl(text);
  const w = ctx.fontB.widthOfTextAtSize(t, sizePt);
  ctx.page.drawText(t, { x: x0 + totalW - w, y: ctx.y - sizePt, size: sizePt, font: ctx.fontB, color: INK });
  ctx.y -= sizePt + 6;
}

function drawSub(ctx, text, x0, totalW) {
  if (ctx.y - 12 < MARGIN) addPage(ctx);
  const t = reorderRtl(text);
  const w = ctx.fontR.widthOfTextAtSize(t, 9);
  ctx.page.drawText(t, { x: x0 + totalW - w, y: ctx.y - 10, size: 9, font: ctx.fontR, color: rgb(0.4, 0.4, 0.45) });
  ctx.y -= 16;
}

// ---------------------------------------------------------------------------
// 1) Per-race results
// ---------------------------------------------------------------------------
async function raceResultsPdf(contest, results) {
  const ctx = await newDoc(true);
  addPage(ctx);
  const x0 = MARGIN;

  const columns = [
    { header: 'Place', width: 42, align: 'r' },
    { header: 'Bib', width: 46, align: 'r' },
    { header: 'Name', width: 195, align: 'r' },
    { header: 'Team', width: 180, align: 'r' },
    { header: 'Category', width: 90, align: 'r' },
    { header: 'Gender', width: 58, align: 'l' },
    { header: 'Time', width: 78, align: 'r' },
    { header: 'Behind', width: 80, align: 'r' },
  ];
  const totalW = columns.reduce((s, c) => s + c.width, 0);

  drawTitle(ctx, contest.title || 'Race results', 15, x0, totalW);
  drawSub(ctx, `${results.filter((r) => r.status === 'finished').length} finishers`, x0, totalW);

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
        gender: genderLabelG(r.gender), time: r.elapsed, behind };
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
    const label = d || 'Overall';
    section(`${label} — Overall`, inD);
    section(`${label} — Female`, inD.filter((r) => isFemaleG(r.gender)));
    section(`${label} — Male`, inD.filter((r) => isMaleG(r.gender)));
  }
  for (const d of distances) {
    const inD = finished.filter((r) => r.distance === d);
    const label = d || 'Overall';
    const combos = [...new Set(inD.filter((r) => r.category).map((r) => `${r.category}|${(r.gender || '').toLowerCase()}`))];
    for (const combo of combos) {
      const [cat, g] = combo.split('|');
      const gl = genderLabelG(g);
      section(`${label} — ${cat}${gl ? ` — ${gl}` : ''}`,
        inD.filter((r) => r.category === cat && (r.gender || '').toLowerCase() === g));
    }
  }

  // Non-finishers (DNS/DNF/DSQ and still-on-course), if any.
  const others = results.filter((r) => r.status !== 'finished');
  if (others.length) {
    ctx.y -= 6;
    drawTitle(ctx, `Did not finish (${others.length})`, 11, x0, totalW);
    const cols = [
      { header: 'Bib', width: 46, align: 'r', render: (r) => r.bib },
      { header: 'Name', width: 220, align: 'r', render: (r) => r.participant },
      { header: 'Team', width: 200, align: 'r', render: (r) => r.team },
      { header: 'Category', width: 110, align: 'r', render: (r) => r.category },
      { header: 'Status', width: 80, align: 'l', render: (r) => r.status },
    ];
    drawTable(ctx, cols, others, x0);
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
    header: `R${r.round}`, width: roundW, align: 'r',
    render: (row) => (row.per_race && row.per_race[r.contest_id] !== undefined ? row.per_race[r.contest_id] : ''),
  }));
}

async function leagueTeamPdf(league, teams, raceList) {
  const ctx = await newDoc(false);
  addPage(ctx);
  const x0 = MARGIN;
  const usable = ctx.size.W - MARGIN * 2;
  const fixed = [
    { header: 'Place', width: 40, align: 'r', render: (r, i) => i + 1 },
    { header: 'Team', width: 190, align: 'r', render: (r) => r.team },
  ];
  const totalFixed = fixed.reduce((s, c) => s + c.width, 0) + 52; // + Total col
  const rounds = roundColumns(raceList, usable, totalFixed);
  const columns = [...fixed, ...rounds, { header: 'Total', width: 52, align: 'r', render: (r) => r.total }];
  const totalW = columns.reduce((s, c) => s + c.width, 0);

  drawTitle(ctx, `${league.name}${league.season ? ` — ${league.season}` : ''}`, 15, x0, totalW);
  drawSub(ctx, `Team standings · ${raceList.length} race(s) · best ${bestNote(teams)}`, x0, totalW);
  drawTable(ctx, columns, teams, x0);
  return Buffer.from(await ctx.doc.save());
}

// ---------------------------------------------------------------------------
// 3) League individual standings
// ---------------------------------------------------------------------------
async function leagueIndividualPdf(league, individual, raceList) {
  const ctx = await newDoc(true);
  addPage(ctx);
  const x0 = MARGIN;
  const usable = ctx.size.W - MARGIN * 2;
  const fixed = [
    { header: 'Place', width: 40, align: 'r', render: (r, i) => i + 1 },
    { header: 'Bib', width: 44, align: 'r', render: (r) => r.bib },
    { header: 'Name', width: 190, align: 'r', render: (r) => r.name },
    { header: 'Team', width: 170, align: 'r', render: (r) => r.team },
  ];
  const totalFixed = fixed.reduce((s, c) => s + c.width, 0) + 50; // + Total col
  const rounds = roundColumns(raceList, usable, totalFixed);
  const columns = [...fixed, ...rounds, { header: 'Total', width: 50, align: 'r', render: (r) => r.total }];
  const totalW = columns.reduce((s, c) => s + c.width, 0);

  drawTitle(ctx, `${league.name}${league.season ? ` — ${league.season}` : ''}`, 15, x0, totalW);
  drawSub(ctx, `Individual standings · ${raceList.length} race(s)`, x0, totalW);

  for (const group of individual) {
    const title = [group.distance, group.gender, group.category].filter(Boolean).join(' · ') || 'Overall';
    ctx.y -= 4;
    drawTitle(ctx, title, 11, x0, totalW);
    drawTable(ctx, columns, group.rows, x0);
  }
  return Buffer.from(await ctx.doc.save());
}

function bestNote(teams) {
  const c = teams.reduce((mx, t) => Math.max(mx, (t.counted_ids || []).length), 0);
  return c ? `${c} counted` : 'all';
}

module.exports = { raceResultsPdf, leagueTeamPdf, leagueIndividualPdf };

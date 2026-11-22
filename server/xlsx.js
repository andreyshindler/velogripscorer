'use strict';

const zlib = require('zlib');

/**
 * Minimal .xlsx reader — enough to load a start-list sheet without pulling in
 * a spreadsheet library. An xlsx file is a ZIP of XML parts; we walk the ZIP
 * central directory, inflate the parts we need (sharedStrings + first sheet),
 * and parse cells with regexes (fine for Excel/LibreOffice/Google exports).
 *
 * Returns rows as arrays of strings indexed by column (A=0, B=1, ...).
 */

function readZipEntries(buf) {
  // End Of Central Directory: signature 0x06054b50, scan from the tail.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65558); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a valid xlsx (zip) file');
  const count = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);

  const entries = new Map();
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(offset) !== 0x02014b50) break;
    const method = buf.readUInt16LE(offset + 10);
    const compSize = buf.readUInt32LE(offset + 20);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const localOffset = buf.readUInt32LE(offset + 42);
    const name = buf.toString('utf8', offset + 46, offset + 46 + nameLen);
    entries.set(name, { method, compSize, localOffset });
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return {
    read(name) {
      const entry = entries.get(name);
      if (!entry) return null;
      // local header: variable name/extra lengths, data follows
      const lh = entry.localOffset;
      if (buf.readUInt32LE(lh) !== 0x04034b50) throw new Error('bad zip local header');
      const nameLen = buf.readUInt16LE(lh + 26);
      const extraLen = buf.readUInt16LE(lh + 28);
      const start = lh + 30 + nameLen + extraLen;
      const data = buf.subarray(start, start + entry.compSize);
      return entry.method === 8 ? zlib.inflateRawSync(data) : Buffer.from(data);
    },
    names: [...entries.keys()],
  };
}

function decodeXmlEntities(s) {
  return s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&');
}

function colIndex(ref) {
  // "AB12" -> column index 27
  let n = 0;
  for (const ch of ref) {
    if (ch < 'A' || ch > 'Z') break;
    n = n * 26 + (ch.charCodeAt(0) - 64);
  }
  return n - 1;
}

/**
 * Every worksheet in the workbook, in the order the tabs appear, as
 * `[{ name, rows }]`.
 *
 * This reader used to stop at sheet1 and say nothing about the rest. A results
 * workbook that splits its distances across tabs — "5 ק\"מ", "10 ק\"מ" — then
 * imported as a third of the field, with no error and no warning: the sheet it
 * read looked perfectly valid, so nothing anywhere said that two thirds of the
 * runners had been dropped on the floor.
 */
function parseXlsxSheets(buf) {
  const zip = readZipEntries(buf);

  const shared = [];
  const sharedXml = zip.read('xl/sharedStrings.xml');
  if (sharedXml) {
    for (const m of sharedXml.toString('utf8').matchAll(/<si>([\s\S]*?)<\/si>/g)) {
      // concatenate all <t> runs inside the item (rich text splits them)
      const text = [...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join('');
      shared.push(decodeXmlEntities(text));
    }
  }

  // Tab order and tab names come from the workbook part, which points at each
  // sheet by relationship id; the rels part maps that id to the file. Either
  // may be missing or unreadable in a hand-made file, so fall back to the
  // worksheet files in numeric order, which is the order Excel writes them.
  const files = zip.names.filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
    .sort((a, b) => Number(a.match(/(\d+)\.xml$/)[1]) - Number(b.match(/(\d+)\.xml$/)[1]));
  if (!files.length) throw new Error('xlsx has no worksheet');

  let ordered = null;
  try {
    const wb = zip.read('xl/workbook.xml');
    const rels = zip.read('xl/_rels/workbook.xml.rels');
    if (wb && rels) {
      const target = new Map();
      for (const m of rels.toString('utf8').matchAll(/<Relationship\b([^>]*)\/?>/g)) {
        const id = /Id="([^"]+)"/.exec(m[1]);
        const to = /Target="([^"]+)"/.exec(m[1]);
        if (id && to) target.set(id[1], 'xl/' + to[1].replace(/^\/?xl\//, '').replace(/^\.\//, ''));
      }
      const list = [];
      for (const m of wb.toString('utf8').matchAll(/<sheet\b([^>]*)\/?>/g)) {
        const name = /name="([^"]*)"/.exec(m[1]);
        const rid = /r:id="([^"]+)"/.exec(m[1]);
        const file = rid && target.get(rid[1]);
        if (file && files.includes(file)) {
          list.push({ name: name ? decodeXmlEntities(name[1]) : file, file });
        }
      }
      if (list.length) ordered = list;
    }
  } catch { /* fall back to file order below */ }
  if (!ordered) ordered = files.map((file, i) => ({ name: `Sheet${i + 1}`, file }));

  return ordered.map(({ name, file }) => ({
    name,
    rows: parseSheetRows(zip.read(file).toString('utf8'), shared),
  }));
}

/** The first worksheet's rows. Prefer parseXlsxSheets: a workbook that keeps
 *  part of its data on a later tab loses it here, silently. */
function parseXlsx(buf) {
  return parseXlsxSheets(buf)[0].rows;
}

// Split out so the cell-parsing (the tricky part) can be unit-tested directly.
function parseSheetRows(sheet, shared) {
  const rows = [];
  for (const rowMatch of sheet.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells = [];
    // NOTE: attrs must be non-greedy ([^>]*?), otherwise a self-closing empty
    // cell like <c r="G5" s="15"/> lets the greedy match swallow the trailing
    // "/" — the /> branch then fails and the next cell is eaten, shifting a
    // whole column (e.g. an empty Age cell dropping the Distance beside it).
    for (const c of rowMatch[1].matchAll(
      /<c\s+r="([A-Z]+\d+)"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const [, ref, attrs, inner] = c;
      if (!inner) continue;
      const idx = colIndex(ref);
      let value = '';
      const v = inner.match(/<v>([\s\S]*?)<\/v>/);
      const inlineT = inner.match(/<t[^>]*>([\s\S]*?)<\/t>/);
      if (/t="s"/.test(attrs) && v) value = shared[Number(v[1])] ?? '';
      else if (/t="inlineStr"/.test(attrs) && inlineT) value = decodeXmlEntities(inlineT[1]);
      else if (v) value = decodeXmlEntities(v[1]);
      cells[idx] = String(value).trim();
    }
    if (cells.some((x) => x !== undefined && x !== '')) rows.push(cells);
  }
  return rows;
}

module.exports = { parseXlsx, parseXlsxSheets, parseSheetRows };

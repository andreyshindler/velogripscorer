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

/** Parses the first worksheet into an array of rows (arrays of strings). */
function parseXlsx(buf) {
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

  const sheetName = zip.names.find((n) => /^xl\/worksheets\/sheet1\.xml$/.test(n))
    || zip.names.find((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n));
  if (!sheetName) throw new Error('xlsx has no worksheet');
  const sheet = zip.read(sheetName).toString('utf8');

  const rows = [];
  for (const rowMatch of sheet.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells = [];
    for (const c of rowMatch[1].matchAll(
      /<c\s+r="([A-Z]+\d+)"([^>]*)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
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

module.exports = { parseXlsx };

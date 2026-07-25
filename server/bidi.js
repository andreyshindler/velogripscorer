'use strict';

// Compact right-to-left reorderer for the PDF exports. pdf-lib (like every
// pure-JS PDF library) has no bidi engine: drawText() paints glyphs strictly
// left-to-right in code-point order, so a logical-order Hebrew string comes out
// reversed on the page. The result tables are made of short, per-cell
// mono-directional strings — a Hebrew name/team, or an LTR bib/time/place — so a
// full UAX#9 implementation is overkill. reorderRtl() turns one logical-order
// cell into the visual (left-to-right) order pdf-lib should draw, with a base
// direction of RTL.
//
// Fidelity limits (deliberate): no nested embeddings/overrides, no bracket-pair
// mirroring, no combining-mark reordering, and no Arabic shaping. This is
// sufficient for Hebrew names, team names, categories, bib numbers and times;
// pathological mixed punctuation could rarely misorder.

// Hebrew block (letters + niqqud + geresh/gershayim) plus the Alphabetic
// Presentation Forms used for a few Hebrew ligatures.
function isHebrew(ch) {
  const c = ch.codePointAt(0);
  return (c >= 0x0590 && c <= 0x05ff) || (c >= 0xfb1d && c <= 0xfb4f);
}
// Latin letters (basic + Latin-1 + extended) count as strong LTR.
function isLatin(ch) {
  const c = ch.codePointAt(0);
  return (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) ||
    (c >= 0xc0 && c <= 0x24f);
}
// ASCII digits: kept LTR so bibs ("3"), times ("12:34") and years never reverse.
function isDigit(ch) {
  const c = ch.codePointAt(0);
  return c >= 0x30 && c <= 0x39;
}

// R = strong RTL (Hebrew); L = keep-logical-order LTR (Latin letters and
// digits — neither is ever glyph-reversed); N = neutral (punctuation,
// whitespace — direction inherited from the surrounding runs).
function dirOf(ch) {
  if (isHebrew(ch)) return 'R';
  if (isLatin(ch) || isDigit(ch)) return 'L';
  return 'N';
}

/**
 * Reorder one logical-order string into visual (left-to-right draw) order for a
 * base-RTL paragraph. Hebrew runs are reversed; Latin and neutral (number/time)
 * runs keep their logical order so bibs like "3" and times like "12:34" stay
 * upright. Non-strings return ''.
 */
function reorderRtl(str) {
  if (typeof str !== 'string') return '';
  if (!str) return '';
  const chars = Array.from(str); // code-point safe

  // 1) Resolve each character's direction. A neutral takes the direction shared
  //    by its nearest strong neighbours on both sides, otherwise the base (R).
  const strong = chars.map(dirOf);
  const resolved = strong.slice();
  for (let i = 0; i < chars.length; i++) {
    if (strong[i] !== 'N') continue;
    let prev = null, next = null;
    for (let j = i - 1; j >= 0; j--) { if (strong[j] !== 'N') { prev = strong[j]; break; } }
    for (let j = i + 1; j < chars.length; j++) { if (strong[j] !== 'N') { next = strong[j]; break; } }
    // A neutral takes the direction shared by its nearest strong neighbours; at
    // a string boundary it follows its only neighbour (so a leading "+"/"." binds
    // to the number it precedes); with none, or a conflict, it takes base (R).
    if (prev === null && next === null) resolved[i] = 'R';
    else if (prev === null) resolved[i] = next;
    else if (next === null) resolved[i] = prev;
    else resolved[i] = prev === next ? prev : 'R';
  }

  // 2) Coalesce into maximal runs of one resolved direction.
  const runs = [];
  for (let i = 0; i < chars.length; i++) {
    const d = resolved[i];
    const last = runs[runs.length - 1];
    if (last && last.dir === d) last.text += chars[i];
    else runs.push({ dir: d, text: chars[i] });
  }

  // 3) Emit runs right-to-left (last logical run drawn leftmost). Reverse the
    //  glyphs inside RTL runs; leave LTR/number runs in logical order.
  let out = '';
  for (let i = runs.length - 1; i >= 0; i--) {
    const run = runs[i];
    out += run.dir === 'R' ? Array.from(run.text).reverse().join('') : run.text;
  }
  return out;
}

module.exports = { reorderRtl, dirOf };

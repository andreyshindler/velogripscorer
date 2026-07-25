'use strict';

// Bidi run splitting for the PDF exports. The PDF renderers real users open
// (Chromium/pdfium, phone viewers, Telegram's in-app viewer) render a *pure*
// left-to-right or *pure* right-to-left string correctly on their own, but when
// a single drawn text run mixes Hebrew with a multi-digit number they mangle it
// — e.g. "נדב 109" comes out "נדב 901" (the digits get reversed). The reliable
// fix is to never hand the renderer a mixed run: split each cell into maximal
// same-direction runs and let the caller draw each run with its own positioned
// drawText, ordered per the paragraph's base direction.
//
// visualParts(str) returns the runs already ordered left-to-right for drawing
// (each run drawn as-is, no character reversal), trimmed, so the caller lays
// them out with a single gap between runs.
//
// Fidelity limits (deliberate): the base direction is the first strong
// character (UAX#9 P2/P3), neutrals resolve to their surrounding runs, but
// there are no nested embeddings/overrides, no bracket-pair mirroring and no
// Arabic shaping. Sufficient for names, teams, categories, times and titles.

function isHebrew(ch) {
  const c = ch.codePointAt(0);
  return (c >= 0x0590 && c <= 0x05ff) || (c >= 0xfb1d && c <= 0xfb4f);
}
function isLatin(ch) {
  const c = ch.codePointAt(0);
  return (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || (c >= 0xc0 && c <= 0x24f);
}
function isDigit(ch) {
  const c = ch.codePointAt(0);
  return c >= 0x30 && c <= 0x39;
}

// R = strong RTL (Hebrew); L = strong-ish LTR (Latin letters and digits — a
// digit never joins an RTL run so numbers stay upright); N = neutral.
function dirOf(ch) {
  if (isHebrew(ch)) return 'R';
  if (isLatin(ch) || isDigit(ch)) return 'L';
  return 'N';
}

/** Resolve directions and coalesce into logical-order runs. */
function resolveRuns(str) {
  const chars = Array.from(str);
  const strong = chars.map(dirOf);
  const base = strong.find((s) => s !== 'N') || 'L'; // first strong char (UAX#9)

  const resolved = strong.slice();
  for (let i = 0; i < chars.length; i++) {
    if (strong[i] !== 'N') continue;
    let prev = null, next = null;
    for (let j = i - 1; j >= 0; j--) { if (strong[j] !== 'N') { prev = strong[j]; break; } }
    for (let j = i + 1; j < chars.length; j++) { if (strong[j] !== 'N') { next = strong[j]; break; } }
    // A neutral joins a run only when both sides agree; at a boundary between
    // opposite runs (or the string edge) it takes the base direction, which
    // keeps a boundary space out of a Hebrew word and beside the number.
    if (prev === null && next === null) resolved[i] = base;
    else if (prev === null) resolved[i] = next;
    else if (next === null) resolved[i] = prev;
    else resolved[i] = prev === next ? prev : base;
  }

  const runs = [];
  for (let i = 0; i < chars.length; i++) {
    const d = resolved[i];
    const last = runs[runs.length - 1];
    if (last && last.dir === d) last.text += chars[i];
    else runs.push({ dir: d, text: chars[i] });
  }
  return { base, runs };
}

/**
 * Runs of one string ordered left-to-right for drawing, each trimmed and drawn
 * as-is (no reversal). For a base-RTL paragraph the logical run order is
 * reversed so the first logical run sits rightmost. Non-strings → [].
 */
function visualParts(str) {
  if (typeof str !== 'string' || !str) return [];
  const { base, runs } = resolveRuns(str);
  const ordered = base === 'R' ? runs.slice().reverse() : runs;
  return ordered.map((r) => r.text.trim()).filter((t) => t.length > 0);
}

module.exports = { visualParts, dirOf };

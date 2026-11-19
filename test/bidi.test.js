'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { visualParts } = require('../server/bidi');

test('pure Hebrew stays one run, drawn as-is (renderer handles pure RTL)', () => {
  assert.deepEqual(visualParts('מכבי'), ['מכבי']);
  assert.deepEqual(visualParts('מכבי שרותי בריאות'), ['מכבי שרותי בריאות']);
  assert.deepEqual(visualParts('או. פי. סי רותם'), ['או. פי. סי רותם']);
});

test('pure Latin / number is one run, unchanged', () => {
  assert.deepEqual(visualParts('ICL'), ['ICL']);
  assert.deepEqual(visualParts('12:34'), ['12:34']);
  assert.deepEqual(visualParts('43-49'), ['43-49']);
  assert.deepEqual(visualParts('+2:02.1'), ['+2:02.1']);
});

test('Hebrew + number splits into runs, number first (leftmost) under RTL base', () => {
  // base RTL (starts Hebrew): the LTR number run is drawn to the LEFT
  assert.deepEqual(visualParts('עד 44'), ['44', 'עד']);
  assert.deepEqual(visualParts('נדב מויאל 109'), ['109', 'נדב מויאל']);
});

test('digits are never reversed inside a run', () => {
  for (const s of ['עד 42', 'נדב 109', 'מרוץ 13']) {
    const joined = visualParts(s).join(' ');
    // the digit substring survives intact (not "24"/"901"/"31")
    const digits = s.match(/\d+/)[0];
    assert.ok(joined.includes(digits), `${s} keeps ${digits}, got ${joined}`);
  }
});

test('LTR-based mixed title keeps logical run order, Hebrew run intact', () => {
  // first strong char is Latin -> base LTR -> runs stay in order
  assert.deepEqual(visualParts('10k — עד 42 — Male'), ['10k —', 'עד', '42 — Male']);
});

test('non-strings and empty are safe', () => {
  assert.deepEqual(visualParts(null), []);
  assert.deepEqual(visualParts(undefined), []);
  assert.deepEqual(visualParts(123), []);
  assert.deepEqual(visualParts(''), []);
});

// A digit is not a strong character (UAX#9 P2), so it must not decide the
// paragraph's direction. It used to: dirOf deliberately calls digits L, to keep
// a number upright in its own run, and the base was read straight off that — so
// a string that merely STARTED with a number was laid out left-to-right and
// came out mirrored. Checked against Chromium on each of these.
test('a leading number does not flip the base direction', () => {
  // Hebrew leads, so the number is drawn to its left - the same as when the
  // number comes last, which always worked.
  assert.deepEqual(visualParts('44 עד'), ['עד', '44']);
  assert.deepEqual(visualParts('109 נדב'), ['נדב', '109']);
  assert.deepEqual(visualParts('3 הקפות'), ['הקפות', '3']);
  assert.deepEqual(visualParts('5 ק״מ'), ['ק״מ', '5']);
  // The PDF's lap gap, which is why this surfaced.
  assert.deepEqual(visualParts('-1 הקפה'), ['הקפה', '-1']);
  assert.deepEqual(visualParts('-2 הקפות'), ['הקפות', '-2']);
});

// Under an RTL base the FIRST logical run is drawn rightmost, i.e. last in the
// returned array — whichever end of the string the number is on. Swapping the
// two therefore swaps the output, which is the point: the reading order the
// author wrote is preserved rather than mirrored.
test('the first logical run is drawn rightmost under an RTL base', () => {
  assert.deepEqual(visualParts('עד 44'), ['44', 'עד']);   // "עד" read first
  assert.deepEqual(visualParts('44 עד'), ['עד', '44']);   // "44" read first
  assert.deepEqual(visualParts('נדב 109'), ['109', 'נדב']);
  assert.deepEqual(visualParts('109 נדב'), ['נדב', '109']);
});

// Nothing strong at all: a time, a bib, a gap. These stay one upright run, so a
// results column is not reordered.
test('digits-only and symbol-only strings stay a single upright run', () => {
  for (const s of ['12:34', '1:02:00.0', '+2:02.1', '43-49', '3', '-1']) {
    assert.deepEqual(visualParts(s), [s], s);
  }
});

// Latin is strong, so it still sets the base and the run order is kept.
test('a Latin-led string is unchanged by the base fix', () => {
  assert.deepEqual(visualParts('10k — עד 42 — Male'), ['10k —', 'עד', '42 — Male']);
  assert.deepEqual(visualParts('Elite כללי'), ['Elite', 'כללי']);
});

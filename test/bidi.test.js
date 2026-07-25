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

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { reorderRtl } = require('../server/bidi');

const rev = (s) => Array.from(s).reverse().join('');

test('pure Hebrew is fully reversed to visual order', () => {
  assert.equal(reorderRtl('מכבי'), rev('מכבי'));
  assert.equal(reorderRtl('בית הלוחם באר שבע'), rev('בית הלוחם באר שבע'));
});

test('pure Latin and digit runs keep logical order (upright)', () => {
  assert.equal(reorderRtl('ICL'), 'ICL');
  assert.equal(reorderRtl('3'), '3');
  assert.equal(reorderRtl('12:34'), '12:34');
  assert.equal(reorderRtl('18:58.5'), '18:58.5');
  assert.equal(reorderRtl('+2:02.1'), '+2:02.1');
  assert.equal(reorderRtl('-1 lap'), '-1 lap');
});

test('Hebrew followed by a number: number stays LTR, drawn to the left', () => {
  // logical "נדב מויאל 109" -> visual: 109 (leftmost, upright) then reversed Hebrew
  assert.equal(reorderRtl('נדב מויאל 109'), '109 ' + rev('נדב מויאל'));
  // logical "מקום 3" -> "3 " then reversed Hebrew
  assert.equal(reorderRtl('מקום 3'), '3 ' + rev('מקום'));
});

test('mixed team name with dots reverses as one Hebrew run', () => {
  assert.equal(reorderRtl('או. פי. סי רותם'), rev('או. פי. סי רותם'));
});

test('non-strings and empty are safe', () => {
  assert.equal(reorderRtl(null), '');
  assert.equal(reorderRtl(undefined), '');
  assert.equal(reorderRtl(123), '');
  assert.equal(reorderRtl(''), '');
});

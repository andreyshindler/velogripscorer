'use strict';

// SQLite's datetime('now') stores UTC as "YYYY-MM-DD HH:MM:SS" — no "T", no
// zone — and JavaScript reads that shape as LOCAL time. Every stamp with a DB
// default (audit log, sign-ups, readers last seen) therefore rendered hours
// out: the audit log showed 22:06 for an event the details line stamped
// 22:06:44Z, which in Israel is 01:06 the next day.
//
// fmtDate lives in public/i18n.js, a browser script with no exports, so pull
// the normaliser out of the source and exercise it directly.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'i18n.js'), 'utf8');
const snippet = src.match(/const NAIVE_TS = [\s\S]*?\n}\n/);
assert.ok(snippet, 'public/i18n.js should define NAIVE_TS + toInstant');
// eslint-disable-next-line no-eval
const toInstant = eval(`${snippet[0]}; toInstant`);

const EXPECTED = Date.UTC(2026, 8, 23, 22, 6, 44); // 2026-09-23T22:06:44Z

test('a zone-less SQLite stamp is read as UTC, not local time', () => {
  assert.equal(toInstant('2026-09-23 22:06:44').getTime(), EXPECTED);
});

test('stamps that already carry a zone are left alone', () => {
  assert.equal(toInstant('2026-09-23T22:06:44Z').getTime(), EXPECTED);
  assert.equal(toInstant('2026-09-23T22:06:44.000Z').getTime(), EXPECTED);
  assert.equal(toInstant('2026-09-24T01:06:44+03:00').getTime(), EXPECTED);
});

test('every spelling of the same instant agrees', () => {
  const forms = [
    '2026-09-23 22:06:44',
    '2026-09-23T22:06:44',
    '2026-09-23T22:06:44Z',
    '2026-09-24T01:06:44+03:00',
  ];
  const times = new Set(forms.map((f) => toInstant(f).getTime()));
  assert.equal(times.size, 1, `forms disagree: ${[...times].join(', ')}`);
  assert.equal([...times][0], EXPECTED);
});

test('sub-second precision survives normalisation', () => {
  assert.equal(toInstant('2026-09-23 22:06:44.079').getTime(), EXPECTED + 79);
});

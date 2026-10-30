'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseDuration, parseClock, parseDays, nextRun, describeRule, parseRemind, parseEvery,
} = require('../mcp/telegram-schedule');

// Thursday 2026-10-29 10:00 local time.
const NOW = new Date(2026, 9, 29, 10, 0, 0, 0).getTime();
const local = (...args) => new Date(...args).getTime();

test('parses durations, clocks and day lists', () => {
  assert.equal(parseDuration('45m'), 45 * 60000);
  assert.equal(parseDuration('1h30m'), 90 * 60000);
  assert.equal(parseDuration('1d'), 24 * 3600000);
  assert.equal(parseDuration('check'), null);
  assert.equal(parseDuration('0m'), null);
  assert.deepEqual(parseClock('07:30'), { hh: 7, mm: 30 });
  assert.deepEqual(parseClock('7:30pm'), { hh: 19, mm: 30 });
  assert.deepEqual(parseClock('12am'), { hh: 0, mm: 0 });
  assert.equal(parseClock('25:00'), null);
  assert.deepEqual(parseDays('weekdays'), [1, 2, 3, 4, 5]);
  assert.deepEqual(parseDays('sun-thu'), [0, 1, 2, 3, 4]);
  assert.deepEqual(parseDays('fri-mon'), [0, 1, 5, 6]);
  assert.deepEqual(parseDays('mon,wed,friday'), [1, 3, 5]);
  assert.equal(parseDays('check'), null);
});

test('/remind takes a delay, a clock time or a day and time', () => {
  assert.deepEqual(parseRemind('45m check the vMotion', NOW), { at: NOW + 45 * 60000, text: 'check the vMotion' });
  assert.deepEqual(parseRemind('in 2h look again', NOW), { at: NOW + 2 * 3600000, text: 'look again' });
  assert.equal(parseRemind('14:30 call', NOW).at, local(2026, 9, 29, 14, 30));
  assert.equal(parseRemind('09:00 call', NOW).at, local(2026, 9, 30, 9, 0), 'a time already past today means tomorrow');
  assert.equal(parseRemind('tomorrow at 07:30 call', NOW).at, local(2026, 9, 30, 7, 30));
  assert.equal(parseRemind('mon 09:00 call', NOW).at, local(2026, 10, 2, 9, 0));
  assert.match(parseRemind('soon do it', NOW).error, /Usage/);
  assert.match(parseRemind('45m', NOW).error, /Usage/);
});

test('/every takes an interval or days and a time', () => {
  assert.deepEqual(parseEvery('30m check'), { rule: { kind: 'interval', ms: 30 * 60000 }, text: 'check' });
  assert.match(parseEvery('5m check').error, /shortest/);
  assert.deepEqual(parseEvery('07:30 check lag'), { rule: { kind: 'clock', days: [0, 1, 2, 3, 4, 5, 6], hh: 7, mm: 30 }, text: 'check lag' });
  assert.deepEqual(parseEvery('weekdays at 7:30am check lag').rule, { kind: 'clock', days: [1, 2, 3, 4, 5], hh: 7, mm: 30 });
  assert.match(parseEvery('weekdays check lag').error, /Usage/);
});

test('next run skips days outside the rule', () => {
  const rule = parseEvery('weekdays 07:30 x').rule;
  // Friday 2026-10-30 07:30 is next; after that, Monday 2026-11-02.
  assert.equal(nextRun(rule, NOW), local(2026, 9, 30, 7, 30));
  assert.equal(nextRun(rule, local(2026, 9, 30, 7, 30)), local(2026, 10, 2, 7, 30));
  assert.equal(nextRun({ kind: 'interval', ms: 60000 }, NOW), NOW + 60000);
});

test('describes rules in plain words', () => {
  assert.equal(describeRule(parseEvery('90m x').rule), 'every 1h30m');
  assert.equal(describeRule(parseEvery('07:30 x').rule), 'every day at 07:30');
  assert.equal(describeRule(parseEvery('sun-thu 7:05 x').rule), 'Sun–Thu at 07:05');
  assert.equal(describeRule(parseEvery('mon,wed 18:00 x').rule), 'Mon, Wed at 18:00');
});

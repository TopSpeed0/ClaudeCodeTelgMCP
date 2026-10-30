'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { pick, fill, alertTime, readAlerts, diffAlerts, muteKey } = require('../mcp/sentry-alerts');

const MONITOR = {
  name: 'Monitor', server: 'monitoring', tool: 'active_alerts', list: 'result',
  id: 'AlertID', title: 'AlertName', object: ['Entity', 'Node'], severity: 'SeverityText', time: 'Triggered',
  skip_if: 'Acknowledged', only: { Severity: [2, 3] },
};
const DATA = { result: [
  { AlertID: 1, AlertName: 'Interface is down', Entity: 'eth0', Node: 'sw1', Severity: 2, SeverityText: 'Critical', Triggered: '2026-10-30T10:00:00Z', Acknowledged: false },
  { AlertID: 2, AlertName: 'Node rebooted', Entity: 'sw2', Node: 'sw2', Severity: 3, SeverityText: 'Serious', Triggered: '2026-10-30T11:00:00Z' },
  { AlertID: 3, AlertName: 'Old one', Entity: 'x', Severity: 2, Acknowledged: true },
  { AlertID: 4, AlertName: 'Just a warning', Entity: 'y', Severity: 1 },
  { AlertName: 'No id', Severity: 2 },
] };

test('picks dotted paths and fills argument templates', () => {
  assert.equal(pick({ a: { b: [{ c: 5 }] } }, 'a.b.0.c'), 5);
  assert.equal(pick({ a: 1 }, 'a.b.c'), undefined);
  assert.deepEqual(fill({ id: '{r.id}', target: 'one', n: 3, list: ['{x}'] }, { r: { id: 'abc' }, x: 7 }), { id: 'abc', target: 'one', n: 3, list: ['7'] });
});

test('reads times in seconds, milliseconds and ISO', () => {
  assert.equal(alertTime(1793393655002), 1793393655002);
  assert.equal(alertTime(1793393655), 1793393655000);
  assert.equal(alertTime('2026-10-30T10:00:00Z'), Date.UTC(2026, 9, 30, 10));
  assert.equal(alertTime('soon'), null);
});

test('reads only the alerts the source cares about', () => {
  const alerts = readAlerts(MONITOR, DATA);
  assert.deepEqual(alerts.map(a => a.key), ['Monitor#1', 'Monitor#2'], 'acknowledged, wrong severity and id-less ones are left out');
  assert.equal(alerts[0].object, 'eth0 · sw1');
  assert.equal(alerts[1].object, 'sw2', 'repeated object fields are shown once');
  assert.equal(alerts[0].severity, 'Critical');
  assert.equal(alerts[0].time, Date.UTC(2026, 9, 30, 10));
  assert.throws(() => readAlerts(MONITOR, { other: [] }), /no alert list at "result"/);
  assert.deepEqual(readAlerts({ name: 'Top', id: 'id', title: 't' }, [{ id: 'a', t: 'x' }]).map(a => a.key), ['Top#a']);
});

test('tells new alerts from cleared ones, per source', () => {
  const known = {
    'Monitor#1': { source: 'Monitor', title: 'Interface is down' },
    'Monitor#9': { source: 'Monitor', title: 'Gone now' },
    'Other#9': { source: 'Other', title: 'Not this source' },
  };
  const { added, cleared } = diffAlerts(known, 'Monitor', readAlerts(MONITOR, DATA));
  assert.deepEqual(added.map(a => a.key), ['Monitor#2']);
  assert.deepEqual(cleared.map(c => c.key), ['Monitor#9']);
});

test('a mute covers the same alert on the same object, whatever the id', () => {
  const [a] = readAlerts(MONITOR, DATA);
  assert.equal(muteKey('Monitor', a), muteKey('Monitor', { ...a, id: '99', key: 'Monitor#99' }));
  assert.notEqual(muteKey('Monitor', a), muteKey('Monitor', { ...a, object: 'eth1 · sw1' }));
});

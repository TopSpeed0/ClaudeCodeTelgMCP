'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseQuery, plain, snippet, searchArchive } = require('../mcp/archive-search');

function archive() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-search-'));
  const line = (o) => JSON.stringify(o);
  fs.writeFileSync(path.join(dir, '2026-10-28.jsonl'), [
    line({ day: '2026-10-28', ts: '2026-10-28T08:00:00.000Z', user: 'check a1k-prd aggregates', assistant: 'aggr_data_n1 is <b>39%</b> used on A1K-PRD', sessionId: 's1' }),
    line({ day: '2026-10-28', ts: '2026-10-28T09:00:00.000Z', user: 'snapmirror lag on cyp?', assistant: 'Lag is 2h &amp; growing', sessionId: 's2' }),
    'not json',
  ].join('\n'));
  fs.writeFileSync(path.join(dir, '2026-10-29.jsonl'), line({ day: '2026-10-29', ts: '2026-10-29T10:00:00.000Z', source: 'bg', user: '/bg a1k-prd snapshots', assistant: '1,282 snapshots', sessionId: 's3' }));
  fs.writeFileSync(path.join(dir, 'daily-summaries.json'), JSON.stringify({ '2026-10-28': '- Ran A1K-PRD overview\n- SnapMirror lag on cyp is 2h' }));
  return dir;
}

test('parses words and quoted phrases', () => {
  assert.deepEqual(parseQuery('A1K-PRD "SnapMirror lag"  a1k-prd'), ['snapmirror lag', 'a1k-prd']);
  assert.deepEqual(parseQuery('  '), []);
});

test('strips Telegram HTML for search and display', () => {
  assert.equal(plain('<b>39%</b> used &amp; <code>x &lt; y</code>'), '39% used & x < y');
});

test('finds turns with every word, newest first, summaries after their day', () => {
  const dir = archive();
  const { hits } = searchArchive(dir, 'a1k-prd');
  assert.deepEqual(hits.map(h => `${h.kind}:${h.day}`), ['turn:2026-10-29', 'summary:2026-10-28', 'turn:2026-10-28']);
  assert.equal(hits[0].source, 'bg');
  assert.equal(hits[2].assistant, 'aggr_data_n1 is 39% used on A1K-PRD');
  assert.equal(searchArchive(dir, 'a1k-prd 39%').hits.length, 1, 'all words must match');
  assert.equal(searchArchive(dir, '"lag is 2h"').hits.length, 1);
  assert.equal(searchArchive(dir, 'nothing-like-this').hits.length, 0);
  assert.equal(searchArchive(path.join(dir, 'missing'), 'x').hits.length, 0);
});

test('snippets bold every term and escape the rest', () => {
  const html = snippet('Lag on <cyp> is 2h, and LAG grows', ['lag']);
  assert.equal(html, '<b>Lag</b> on &lt;cyp&gt; is 2h, and <b>LAG</b> grows');
  assert.equal(snippet('nothing here', ['lag']), null);
  const long = snippet(`${'x'.repeat(300)} target ${'y'.repeat(300)}`, ['target'], 60);
  assert.match(long, /^….*<b>target<\/b>.*…$/);
});

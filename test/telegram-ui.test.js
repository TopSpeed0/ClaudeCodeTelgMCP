'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { extractTables, richMarkdown } = require('../mcp/telegram-ui');

test('rich Markdown keeps line breaks, but not inside tables or code', () => {
  const md = 'Line one\nLine two\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n```\ncode a\ncode b\n```\nend';
  assert.equal(richMarkdown(md), 'Line one  \nLine two\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n```\ncode a\ncode b\n```  \nend');
});

const mark = (i) => `@@T${i}@@`;

test('a narrow table becomes an aligned monospace block', () => {
  const md = 'Before\n| Vol | Used |\n|---|---:|\n| vol1 | 80% |\n| data_2 | 5% |\nAfter';
  const { text, tables } = extractTables(md, mark);
  assert.equal(text, 'Before\n@@T0@@\nAfter');
  assert.equal(tables[0], '<pre>Vol     Used\n────────────\nvol1    80%\ndata_2  5%</pre>');
});

test('a wide table becomes one line per row, escaped, without raw pipes', () => {
  const md = '| # | Time | Alert | Affected VM |\n|---|------|-------|-------------|\n'
    + '| 1 | 00:52:50 | Disk I/O write latency high | Own_PC_Default_romaster9.cgnt_OWNPC2 |\n'
    + '| 2 | 00:52:48 | **Read** <latency> | `vm2` |';
  const { text, tables } = extractTables(md, mark);
  assert.equal(text, '@@T0@@');
  assert.equal(tables[0], '• <b>1</b> · 00:52:50 · Disk I/O write latency high · Own_PC_Default_romaster9.cgnt_OWNPC2\n'
    + '• <b>2</b> · 00:52:48 · Read &lt;latency&gt; · vm2');
});

test('leaves text with stray pipes alone', () => {
  const md = 'Run: grep x | sort\nA | B without a rule line';
  assert.deepEqual(extractTables(md, mark), { text: md, tables: [] });
});

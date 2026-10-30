'use strict';
// Telegram presentation helpers shared by the daemon and the MCP server, so
// both decorate messages the same way.

// Full-screen animations Telegram plays on a message: built-in effects, free,
// private chats only.
const MESSAGE_EFFECTS = {
  confetti: '5046509860389126442', // 🎉
  fire: '5104841245755180586',     // 🔥
  like: '5107584321108051014',     // 👍
  heart: '5159385139981059251',    // ❤️
  dislike: '5104858069142078462',  // 👎
  poop: '5046589136895476101',     // 💩
};

// Up to three one-tap "📋 Copy" buttons (Telegram's copy_text allows 1-256 characters).
function copyKeyboard(texts) {
  const items = [...new Set((Array.isArray(texts) ? texts : []).map(String))]
    .filter(t => t.length >= 1 && t.length <= 256).slice(0, 3);
  if (!items.length) return undefined;
  return {
    inline_keyboard: items.map((text) => {
      const first = text.split('\n')[0];
      const label = items.length === 1 ? '📋 Copy' : `📋 ${first.length > 28 ? `${first.slice(0, 27)}…` : first}`;
      return [{ text: label, copy_text: { text }, style: 'primary' }];
    }),
  };
}

// The short fenced code blocks of a Markdown answer, as candidates for copyKeyboard.
function codeBlocks(markdown) {
  const blocks = [];
  for (const m of String(markdown).matchAll(/```[\w-]*\n?([\s\S]*?)```/g)) {
    const code = m[1].replace(/\n+$/, '').trim();
    if (code) blocks.push(code);
  }
  return blocks;
}

// Green for agreeing choices, red for refusing ones (Telegram button styles).
function choiceStyle(choice) {
  if (/^\s*(✅|✔|👍|🟢)|\b(yes|allow|approve|confirm|go ahead|publish|push|send|install|deploy)\b/i.test(choice)) return 'success';
  if (/^\s*(❌|✖|🛑|🔴|⛔)|\b(no|deny|cancel|stop|abort|reject|don't|do not)\b/i.test(choice)) return 'danger';
  return undefined;
}

// A standalone page for an answer too long for one Telegram message. Telegram
// HTML is a subset of HTML, so it renders as is; newlines stay line breaks.
function htmlPage(telegramHtml) {
  return '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<body style="font-family:system-ui,sans-serif;line-height:1.5;padding:12px;max-width:900px;margin:auto">'
    + `<div style="white-space:pre-wrap">${telegramHtml}</div></body>`;
}

// Markdown tables, which Telegram cannot show: each one in `markdown` is
// replaced by a placeholder from `mark(i)` and returned as finished Telegram
// HTML. A table that fits a phone (PHONE_COLUMNS wide) becomes an aligned
// monospace block; a wider one becomes one line per row, the first cell in
// bold, so a narrow screen never shows raw pipes or wrapped columns.
const PHONE_COLUMNS = 36;
const TABLE_RULE = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;
const escapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function tableCells(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|')
    .map(cell => cell.trim().replace(/\*\*|__|`/g, ''));
}

function renderTable(rows) {
  const columns = Math.max(...rows.map(r => r.length));
  const grid = rows.map(r => Array.from({ length: columns }, (_, i) => r[i] || ''));
  const widths = Array.from({ length: columns }, (_, i) => Math.max(...grid.map(r => [...r[i]].length)));
  const total = widths.reduce((a, b) => a + b, 0) + 2 * (columns - 1);
  if (total <= PHONE_COLUMNS) {
    const line = (r) => r.map((cell, i) => cell + ' '.repeat(widths[i] - [...cell].length)).join('  ').trimEnd();
    const [head, ...body] = grid;
    return `<pre>${escapeHtml([line(head), '─'.repeat(total), ...body.map(line)].join('\n'))}</pre>`;
  }
  // Wide: one line per data row; the header is dropped, the cells speak for themselves.
  return grid.slice(1).map(r => r.filter(Boolean))
    .map(r => `• <b>${escapeHtml(r[0] || '')}</b>${r.length > 1 ? ` · ${r.slice(1).map(escapeHtml).join(' · ')}` : ''}`).join('\n');
}

function extractTables(markdown, mark) {
  const lines = String(markdown).split('\n');
  const out = [], tables = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes('|') && i + 1 < lines.length && TABLE_RULE.test(lines[i + 1]) && lines[i + 1].includes('-')) {
      const rows = [tableCells(lines[i])];
      let j = i + 2;
      for (; j < lines.length && lines[j].includes('|') && lines[j].trim(); j++) rows.push(tableCells(lines[j]));
      out.push(mark(tables.length));
      tables.push(renderTable(rows));
      i = j - 1;
    } else {
      out.push(lines[i]);
    }
  }
  return { text: out.join('\n'), tables };
}

// Markdown for a rich message (sendRichMessage): there a lone newline joins
// lines into one paragraph, so it becomes a hard break ("  \n"), except inside
// tables and code fences, which need theirs as they are. Same rule as the
// Hermes / Jira-report normalizer.
const RICH_LIMIT = 32768;
function richMarkdown(text) {
  const src = String(text || '');
  const protectedSpans = [];
  for (const m of src.matchAll(/```[\s\S]*?```/g)) protectedSpans.push([m.index, m.index + m[0].length]);
  for (const m of src.matchAll(/^[^\S\n]*\|.*\|[^\S\n]*$(?:\n^[^\S\n]*\|.*\|[^\S\n]*$)*/gm)) protectedSpans.push([m.index, m.index + m[0].length]);
  protectedSpans.sort((a, b) => a[0] - b[0]);
  const breaks = (s) => s.replace(/(?<!\n)\n(?!\n)/g, '  \n');
  let out = '', pos = 0;
  for (const [start, end] of protectedSpans) {
    if (start < pos) continue;
    out += breaks(src.slice(pos, start)) + src.slice(start, end);
    pos = end;
  }
  return out + breaks(src.slice(pos));
}

module.exports = { MESSAGE_EFFECTS, copyKeyboard, codeBlocks, choiceStyle, htmlPage, extractTables, PHONE_COLUMNS, richMarkdown, RICH_LIMIT };

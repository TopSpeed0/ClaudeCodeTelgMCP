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

// Markdown tables in Telegram HTML, which has no tables: each one in
// `markdown` is replaced by a placeholder from `mark(i)` and returned as
// finished HTML. A table up to MONO_MAX_WIDTH characters wide becomes an
// aligned monospace block (with Telegram's Copy header); a wider one becomes
// one line per row, the first cell in bold, so it never shows raw pipes or
// wrapped columns. (In a rich message narrow tables stay native: richTables.)
const MONO_MAX_WIDTH = 60;
const TABLE_RULE = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;
const escapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Characters on screen: an emoji takes two cells of a monospace line, its
// variation selector none, so 🔴 columns stay aligned.
const displayWidth = (s) => [...s].reduce((w, ch) => w + (/\p{Extended_Pictographic}/u.test(ch) ? 2 : /[️‍]/.test(ch) ? 0 : 1), 0);

function tableCells(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|')
    .map(cell => cell.trim().replace(/\*\*|__|`/g, ''));
}

// The table as aligned monospace lines (header, rule, rows), or null when it
// is wider than MONO_MAX_WIDTH.
function alignedTable(rows) {
  const columns = Math.max(...rows.map(r => r.length));
  const grid = rows.map(r => Array.from({ length: columns }, (_, i) => r[i] || ''));
  const widths = Array.from({ length: columns }, (_, i) => Math.max(...grid.map(r => displayWidth(r[i]))));
  const total = widths.reduce((a, b) => a + b, 0) + 2 * (columns - 1);
  if (total > MONO_MAX_WIDTH) return null;
  const line = (r) => r.map((cell, i) => cell + ' '.repeat(widths[i] - displayWidth(cell))).join('  ').trimEnd();
  const [head, ...body] = grid;
  return [line(head), '─'.repeat(total), ...body.map(line)].join('\n');
}

// Too wide even for that: one line per data row; the header is dropped, the cells speak for themselves.
const rowLines = (rows) => rows.slice(1).map(r => r.filter(Boolean));

function renderTable(rows) {
  const aligned = alignedTable(rows);
  if (aligned) return `<pre>${escapeHtml(aligned)}</pre>`;
  return rowLines(rows)
    .map(r => `• <b>${escapeHtml(r[0] || '')}</b>${r.length > 1 ? ` · ${r.slice(1).map(escapeHtml).join(' · ')}` : ''}`).join('\n');
}

// Calls replace(rows, sourceLines) for each Markdown table and puts its result in place.
function eachTable(markdown, replace) {
  const lines = String(markdown).split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes('|') && i + 1 < lines.length && TABLE_RULE.test(lines[i + 1]) && lines[i + 1].includes('-')) {
      const rows = [tableCells(lines[i])];
      let j = i + 2;
      for (; j < lines.length && lines[j].includes('|') && lines[j].trim(); j++) rows.push(tableCells(lines[j]));
      out.push(replace(rows, lines.slice(i, j)));
      i = j - 1;
    } else {
      out.push(lines[i]);
    }
  }
  return out.join('\n');
}

function extractTables(markdown, mark) {
  const tables = [];
  const text = eachTable(markdown, (rows) => { tables.push(renderTable(rows)); return mark(tables.length - 1); });
  return { text, tables };
}

// For a rich message, where Telegram draws Markdown tables itself: a table
// with up to maxColumns columns stays one (text reads well wrapped in cells);
// a wider one, usually data, becomes an aligned code block, or one line per
// row when too wide even for that.
function richTables(markdown, maxColumns) {
  return eachTable(markdown, (rows, source) => {
    if (Math.max(...rows.map(r => r.length)) <= maxColumns) return source.join('\n');
    const aligned = alignedTable(rows);
    if (aligned) return `\`\`\`\n${aligned}\n\`\`\``;
    return rowLines(rows).map(r => `- **${r[0] || ''}**${r.length > 1 ? ` · ${r.slice(1).join(' · ')}` : ''}`).join('\n');
  });
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

module.exports = { MESSAGE_EFFECTS, copyKeyboard, codeBlocks, choiceStyle, htmlPage, extractTables, richTables, MONO_MAX_WIDTH, richMarkdown, RICH_LIMIT };

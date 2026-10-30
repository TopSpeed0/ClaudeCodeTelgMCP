'use strict';

// Full-text search over the conversation archive: archive/YYYY-MM-DD.jsonl
// turns and archive/daily-summaries.json. Every word must appear somewhere in
// a turn (any order, any case); "quoted phrases" must appear as written.
// The archive is small (a few MB a year), so each search reads it directly.

const fs = require('fs');
const path = require('path');

const DAY_FILE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;

// 'a1k-prd "snapmirror lag"' → ['snapmirror lag', 'a1k-prd']
function parseQuery(query) {
  const terms = [];
  const rest = String(query || '').replace(/"([^"]+)"/g, (_m, phrase) => { terms.push(phrase); return ' '; });
  terms.push(...rest.split(/\s+/));
  return [...new Set(terms.map(t => t.trim().toLowerCase()).filter(Boolean))];
}

// Archived replies may be Telegram HTML (recovered from tg_send): search and
// show them as plain text.
function plain(text) {
  return String(text || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

const htmlEscape = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Up to `width` characters around the first term found, as HTML with every
// term in bold. Null when no term is in the text.
function snippet(text, terms, width = 150) {
  const lower = text.toLowerCase();
  const at = Math.min(...terms.map(t => lower.indexOf(t)).filter(i => i >= 0));
  if (!Number.isFinite(at)) return null;
  const start = Math.max(0, at - Math.floor(width / 3));
  const end = Math.min(text.length, start + width);
  const cut = `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
  const pattern = new RegExp(terms.map(escapeRegExp).sort((a, b) => b.length - a.length).join('|'), 'gi');
  let html = '', last = 0;
  for (const m of cut.matchAll(pattern)) {
    html += `${htmlEscape(cut.slice(last, m.index))}<b>${htmlEscape(m[0])}</b>`;
    last = m.index + m[0].length;
  }
  return html + htmlEscape(cut.slice(last));
}

const hasAll = (text, terms) => { const lower = text.toLowerCase(); return terms.every(t => lower.includes(t)); };

function readTurns(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
      .map(line => { try { return JSON.parse(line); } catch (_) { return null; } })
      .filter(Boolean);
  } catch (_) { return []; }
}

// → { terms, hits }, newest first. A hit is
//   { kind: 'turn', day, ts, source, user, assistant, sessionId } or
//   { kind: 'summary', day, ts, text }, with plain-text fields.
function searchArchive(dir, query) {
  const terms = parseQuery(query);
  const hits = [];
  if (!terms.length) return { terms, hits };
  let files = [];
  try { files = fs.readdirSync(dir).filter(f => DAY_FILE.test(f)); } catch (_) {}
  for (const file of files) {
    const day = DAY_FILE.exec(file)[1];
    for (const turn of readTurns(path.join(dir, file))) {
      const user = plain(turn.user), assistant = plain(turn.assistant);
      if (!hasAll(`${user}\n${assistant}`, terms)) continue;
      hits.push({ kind: 'turn', day: turn.day || day, ts: turn.ts || `${day}T12:00:00.000Z`, source: turn.source || null, user, assistant, sessionId: turn.sessionId || null });
    }
  }
  let summaries = {};
  try { summaries = JSON.parse(fs.readFileSync(path.join(dir, 'daily-summaries.json'), 'utf8')); } catch (_) {}
  for (const [day, summary] of Object.entries(summaries)) {
    const text = plain(summary);
    // Sorts after that day's turns: it was written once the day was over.
    if (hasAll(text, terms)) hits.push({ kind: 'summary', day, ts: `${day}T23:59:59.999Z`, text });
  }
  hits.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
  return { terms, hits };
}

module.exports = { parseQuery, plain, snippet, searchArchive };

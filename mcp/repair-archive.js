#!/usr/bin/env node
// repair-archive.js — put the real reply text back into archived turns.
//
// When the agent answers through tg_send, stdout is only "[sent-via-tg]" and the
// daemon reads the real reply back from Claude's session transcript. Until the
// transcript folder name was fixed, that read could fail and the archive kept the
// placeholder, so restored context showed the user's side of a turn but not the
// bot's. This finds each such turn's prompt in its session transcript and copies
// the reply that followed it.
//
// Usage:
//   node mcp/repair-archive.js           # dry run: report what would change
//   node mcp/repair-archive.js --apply   # rewrite archive/*.jsonl (keeps a .bak of each)

'use strict';
const fs = require('fs');
const path = require('path');

const WORKDIR = path.resolve(__dirname, '..');
const ARCHIVE_DIR = path.join(WORKDIR, 'archive');
const PROJECT_DIR = path.join(process.env.USERPROFILE || process.env.HOME, '.claude', 'projects',
  WORKDIR.replace(/[^a-zA-Z0-9]/g, '-'));
const SENTINEL = /\[sent-via-tg\]/i;
const apply = process.argv.includes('--apply');

const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();

// Split a transcript into prompt -> reply segments. A prompt is a user event
// carrying text (tool results are user events too, but continue the turn).
// The reply is the last tg_send text, or else the last non-sentinel text.
function segments(sessionId) {
  let lines;
  try { lines = fs.readFileSync(path.join(PROJECT_DIR, `${sessionId}.jsonl`), 'utf-8').split('\n'); }
  catch (_) { return null; }
  const out = [];
  let cur = null;
  for (const line of lines) {
    let ev; try { ev = JSON.parse(line); } catch (_) { continue; }
    const content = ev.message && ev.message.content;
    if (ev.type === 'user' && !ev.isMeta) {
      const parts = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : [];
      if (parts.some(c => c && c.type === 'tool_result')) continue;
      const text = parts.filter(c => c && c.type === 'text').map(c => c.text).join('\n');
      if (!text) continue;
      cur = { prompt: norm(text), ts: Date.parse(ev.timestamp) || 0, reply: null, tgReply: null };
      out.push(cur);
    } else if (ev.type === 'assistant' && cur && Array.isArray(content)) {
      cur.ts = Date.parse(ev.timestamp) || cur.ts;
      for (const c of content) {
        if (c && c.type === 'tool_use' && /tg_send/.test(c.name || '') && c.input && c.input.text) cur.tgReply = String(c.input.text);
        else if (c && c.type === 'text' && c.text && !SENTINEL.test(c.text)) cur.reply = String(c.text);
      }
    }
  }
  return out;
}

const cache = new Map();
function findReply(turn) {
  if (!cache.has(turn.sessionId)) cache.set(turn.sessionId, segments(turn.sessionId));
  const segs = cache.get(turn.sessionId);
  if (!segs) return { why: 'no transcript' };
  const needle = norm(String(turn.user || '').replace(/^\/(plan|bg)\s+/, '')).slice(0, 120);
  if (!needle) return { why: 'empty user text' };
  const hits = segs.filter(s => s.prompt.includes(needle) && (s.tgReply || s.reply));
  if (!hits.length) return { why: 'prompt not found' };
  // The same text can be sent twice (e.g. /retry); take the run that ended nearest the archive time.
  const at = Date.parse(turn.ts) || 0;
  hits.sort((a, b) => Math.abs(a.ts - at) - Math.abs(b.ts - at));
  return { reply: hits[0].tgReply || hits[0].reply };
}

let fixed = 0, missed = 0;
const reasons = {};
for (const f of fs.readdirSync(ARCHIVE_DIR).filter(f => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort()) {
  const file = path.join(ARCHIVE_DIR, f);
  const lines = fs.readFileSync(file, 'utf-8').split('\n');
  let changed = 0;
  const next = lines.map((line) => {
    if (!line.trim()) return line;
    let t; try { t = JSON.parse(line); } catch (_) { return line; }
    const a = String(t.assistant || '').trim();
    if (a && !SENTINEL.test(a)) return line;
    const { reply, why } = t.sessionId ? findReply(t) : { why: 'no session id' };
    if (!reply) { missed++; reasons[why] = (reasons[why] || 0) + 1; return line; }
    fixed++; changed++;
    return JSON.stringify({ ...t, assistant: reply, repaired: true });
  });
  if (changed) {
    console.log(`${f}: ${changed} reply(s) recovered`);
    if (apply) {
      fs.copyFileSync(file, `${file}.bak`);
      fs.writeFileSync(file, next.join('\n'));
    }
  }
}
console.log(`\n${apply ? 'Repaired' : 'Would repair'} ${fixed}; left as is ${missed}${missed ? ` ${JSON.stringify(reasons)}` : ''}.`);
if (!apply && fixed) console.log('Run again with --apply to write the changes.');

'use strict';

// Which Claude conversation wrote each bot message, so a reply to an old
// answer can continue in that conversation. One JSON line per fact in
// archive/message-sessions.jsonl (gitignored):
//   { bot, session }  a message the daemon relayed for a known session
//   { bot, task }     a message Claude sent itself (tg_send) while answering
//                     the user's message `task`
//   { task, session } the session that answered the user's message `task`
// Written by the daemon and by the telegram-tg MCP server (another process),
// so lookups read the file rather than a cache.

const fs = require('fs');
const path = require('path');

const FILE = path.join(path.resolve(__dirname, '..'), 'archive', 'message-sessions.jsonl');
const READ_LINES = 20000; // ~1 MB; older answers are no longer resumable

function noteMessage(entry, file = FILE) {
  if (!entry || (!entry.bot && !entry.task)) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify({ ...entry, ts: new Date().toISOString() })}\n`);
  } catch (_) { /* resuming is a convenience; never fail a send over it */ }
}

// The conversation behind a bot message: { session, ts } or null. The last
// fact wins, so a task answered again (/retry) points to its newest session.
function sessionOfMessage(botMessageId, file = FILE) {
  let lines = [];
  try { lines = fs.readFileSync(file, 'utf8').trim().split('\n').slice(-READ_LINES); } catch (_) { return null; }
  const id = Number(botMessageId);
  let direct = null, task = null;
  const taskSession = new Map();
  for (const line of lines) {
    let e; try { e = JSON.parse(line); } catch (_) { continue; }
    if (e.bot === id && e.session) direct = { session: e.session, ts: e.ts };
    if (e.bot === id && e.task) task = { task: e.task, ts: e.ts };
    if (e.task && e.session && !e.bot) taskSession.set(e.task, e.session);
  }
  if (direct) return direct;
  if (task && taskSession.has(task.task)) return { session: taskSession.get(task.task), ts: task.ts };
  return null;
}

module.exports = { noteMessage, sessionOfMessage, MESSAGE_SESSIONS_FILE: FILE };

'use strict';
// Who owns Telegram's getUpdates. Telegram allows one consumer per bot, so the
// task daemon and anything that waits for an operator reply (tg_ask in
// telegram-tg.js, the approval hook) take turns:
//   ASK_FLAG_FILE      — an asker is waiting; the daemon pauses polling.
//   ASK_HANDOFF_FILE   — a reply the daemon caught just before pausing, for the asker.
//   DAEMON_INBOX_FILE  — messages an asker caught that belong to the daemon
//                        (/stop, /status, new tasks); the daemon routes them.
// All files live in the repository root, next to the daemon's own state.

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const ASK_FLAG_FILE = path.join(ROOT, '.telegram-ask.active');
const ASK_HANDOFF_FILE = path.join(ROOT, '.telegram-ask-handoff.json');
const DAEMON_INBOX_FILE = path.join(ROOT, '.telegram-daemon-inbox.json');

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch (_) { return null; }
}

// Read-and-delete; null when there is nothing to take.
function take(file) {
  const value = readJson(file);
  if (value != null) { try { fs.unlinkSync(file); } catch (_) {} }
  return value;
}

function setAskFlag(active) {
  try {
    if (active) fs.writeFileSync(ASK_FLAG_FILE, JSON.stringify({ pid: process.pid, ts: new Date().toISOString() }));
    else if ((readJson(ASK_FLAG_FILE) || {}).pid === process.pid) fs.unlinkSync(ASK_FLAG_FILE);
  } catch (_) { /* best effort; a stale flag is ignored once its pid is gone */ }
}

function askActive() {
  const flag = readJson(ASK_FLAG_FILE);
  return !!(flag && flag.pid && pidAlive(flag.pid));
}

function handOffToAsk(message) {
  fs.writeFileSync(ASK_HANDOFF_FILE, JSON.stringify(message));
}

function takeHandoff() {
  return take(ASK_HANDOFF_FILE);
}

function forwardToDaemon(message) {
  const inbox = readJson(DAEMON_INBOX_FILE) || [];
  inbox.push(message);
  fs.writeFileSync(DAEMON_INBOX_FILE, JSON.stringify(inbox));
}

function takeDaemonInbox() {
  return take(DAEMON_INBOX_FILE) || [];
}

module.exports = {
  ASK_FLAG_FILE, ASK_HANDOFF_FILE, DAEMON_INBOX_FILE,
  pidAlive, setAskFlag, askActive, handOffToAsk, takeHandoff, forwardToDaemon, takeDaemonInbox,
};

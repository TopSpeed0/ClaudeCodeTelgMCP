#!/usr/bin/env node
// telegram-task-daemon.js — Always-on Telegram → Claude Code bridge.
//
// Long-polls Telegram for messages from the authorized chat, spawns
// `claude -p --continue --dangerously-skip-permissions <task>` per message,
// and replies with the agent's output.
//
// Config (same resolution as telegram-tg.js):
//   1. Env vars TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID
//   2. JSON file <workspace>/.telegram-config
//
// State: .telegram-task-state.json (separate from the MCP server's state).

'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');
const {
  parseTelegramCommand, isImmediateCommand, routeTelegramCommand,
  telegramCommandName, mcpCommandNames, skillCommandNames, skillMenuDescription, buildCommandMenu,
} = require('./telegram-command-router');
const { resolveQueueModel } = require('./queue-model');
const handshake = require('./telegram-handshake');
const { createTelegramClient } = require('./telegram-client');
const { MESSAGE_EFFECTS, copyKeyboard, codeBlocks, htmlPage } = require('./telegram-ui');
const { collectMcpServers, discoverMcpServers, mcpMenuDescription } = require('./mcp-discovery');

const WORKDIR = path.resolve(__dirname, '..');
const STATE_FILE = path.join(WORKDIR, '.telegram-task-state.json');
const LOCK_FILE = path.join(WORKDIR, '.telegram-task-daemon.lock');
const EMPTY_MCP = path.join(__dirname, 'daemon-mcp.local.json');

// ---------- Conversation archive / memory ----------
// Continuity lives in OUR files, not Claude's fragile session resume. Every turn
// is appended to a per-day transcript; older context is captured as one summary
// per day. On a silent fork (or daily reboot) we restore from these.
const ARCHIVE_DIR = path.join(WORKDIR, 'archive');
const DAILY_SUMMARIES_FILE = path.join(ARCHIVE_DIR, 'daily-summaries.json');
const RUNTIME_CONFIG_FILE = path.join(WORKDIR, 'agent-runtime.json');

// Runtime policy is local-only. The tracked agent-runtime.example.json documents
// the supported shape; edits apply on the next daemon restart.
const DEFAULT_RUNTIME = {
  defaults: { model: 'gpt-5.6-terra', reasoning_effort: 'high', recent_turns: 10, summary_days: 1 },
  agents: { claude: { model: 'claude-opus-5-5', fallback_model: 'claude-sonnet-5' } },
};
function loadRuntimeConfig() {
  try {
    const parsed = JSON.parse(fs.readFileSync(RUNTIME_CONFIG_FILE, 'utf-8'));
    return {
      ...DEFAULT_RUNTIME,
      ...parsed,
      defaults: { ...DEFAULT_RUNTIME.defaults, ...(parsed.defaults || {}) },
      agents: {
        ...DEFAULT_RUNTIME.agents,
        ...(parsed.agents || {}),
        claude: { ...DEFAULT_RUNTIME.agents.claude, ...((parsed.agents || {}).claude || {}) },
      },
    };
  } catch (e) {
    log(`runtime config unavailable/invalid; using safe defaults (${e.message})`);
    return DEFAULT_RUNTIME;
  }
}
const RUNTIME = loadRuntimeConfig();
const CLAUDE_RUNTIME = { ...RUNTIME.defaults, ...(RUNTIME.agents.claude || {}) };
// Bridge behaviour: { progress: bool, voice: { model, language, python } }.
const TELEGRAM_RUNTIME = RUNTIME.telegram || {};
const DAEMON_STARTED_AT = new Date();
const RECENT_TURNS = Math.max(1, Math.min(50, Number(CLAUDE_RUNTIME.recent_turns) || 10));
const SUMMARY_DAYS = Math.max(0, Math.min(30, Number(CLAUDE_RUNTIME.summary_days) || 1));

const RECALL_DAYS_MAX = 365; // "recall N" upper bound, so a typo can't pull years

function log(msg) {
  process.stderr.write(`[task-daemon ${new Date().toISOString()}] ${msg}\n`);
}

function loadConfig() {
  const envToken = process.env.TELEGRAM_BOT_TOKEN;
  const envChat  = process.env.TELEGRAM_CHAT_ID;
  if (envToken && envChat) return { bot_token: envToken, chat_id: envChat };
  const cfgPath = path.join(WORKDIR, '.telegram-config');
  if (!fs.existsSync(cfgPath)) {
    throw new Error(`No Telegram config (env vars or ${cfgPath}).`);
  }
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
  if (!cfg.bot_token || !cfg.chat_id) throw new Error(`${cfgPath} missing bot_token/chat_id.`);
  return cfg;
}

const config = loadConfig();

let state = { updateOffset: 0, sessionId: null, day: null, summary: '', lastActivity: null, queue: [], lastTask: null, usage: null };
let sessionExpiredAtStart = false; // for the startup banner
try {
  const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
  // Migrate old sessionStarted boolean → sessionId
  if (raw.sessionStarted !== undefined) delete raw.sessionStarted;
  state = { ...state, ...raw };
  // Auto-expire session after 2 hours of inactivity — prevents resuming a dead session.
  const SESSION_TTL_MS = 2 * 60 * 60 * 1000;
  if (state.sessionId && state.lastActivity) {
    const idle = Date.now() - new Date(state.lastActivity).getTime();
    if (idle > SESSION_TTL_MS) {
      log(`session ${state.sessionId} expired after ${Math.round(idle/60000)}m idle — starting fresh`);
      state.sessionId = null;
      sessionExpiredAtStart = true;
    }
  }
} catch (_) {}
function saveState() {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); } catch (e) { log(`saveState: ${e.message}`); }
}

// ---------- Single-instance lock ----------
// Two daemons long-polling the same bot fight over getUpdates (Telegram allows
// only one consumer) and clobber each other's pinned session in the shared
// state file. Refuse to start if a live instance already holds the lock.
function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
function acquireLock() {
  try {
    const prev = parseInt(fs.readFileSync(LOCK_FILE, 'utf-8').trim(), 10);
    if (prev && prev !== process.pid && pidAlive(prev)) {
      log(`another daemon is already running (PID=${prev}); exiting`);
      process.exit(0);
    }
  } catch (_) { /* no lock file yet */ }
  try { fs.writeFileSync(LOCK_FILE, String(process.pid)); } catch (e) { log(`acquireLock: ${e.message}`); }
}
function releaseLock() {
  try {
    if (parseInt(fs.readFileSync(LOCK_FILE, 'utf-8').trim(), 10) === process.pid) fs.unlinkSync(LOCK_FILE);
  } catch (_) {}
}

// ---------- Session tracking ----------
// The daemon owns its session id deterministically: on a fresh start it mints a
// UUID and passes it via --session-id, then always --resume that exact id. This
// avoids guessing "the newest .jsonl in the project dir", which could pick up an
// unrelated interactive Claude session running in the same workspace.

// Where Claude stores this workspace's session transcripts (used only to recover
// the real reply text when the agent answered via tg_send, not for resume).
const PROJECT_DIR = (() => {
  const home = process.env.USERPROFILE || process.env.HOME;
  // Claude Code turns every non-alphanumeric character into '-'
  // (C:\Users\a b -> C--Users-a-b); the other two are older guesses.
  const candidates = [
    WORKDIR.replace(/[^a-zA-Z0-9]/g, '-'),
    WORKDIR.replace(/[/\\]/g, '-').replace(/^-/, '').replace(/:/g, ''),
    WORKDIR.replace(/\\/g, '-').replace(/^-/, '').replace(/:/g, ''),
  ].map(enc => path.join(home, '.claude', 'projects', enc));
  return candidates.find(p => fs.existsSync(p)) || candidates[0];
})();

// ---------- Archive helpers ----------
function localDayKey(d) {
  d = d || new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function ensureArchiveDir() {
  try { fs.mkdirSync(ARCHIVE_DIR, { recursive: true }); } catch (_) {}
}
function archiveFile(day) { return path.join(ARCHIVE_DIR, `${day}.jsonl`); }

function appendArchive(turn) {
  ensureArchiveDir();
  try {
    fs.appendFileSync(archiveFile(turn.day), JSON.stringify(turn) + '\n');
  } catch (e) { log(`appendArchive: ${e.message}`); }
}
function readDayTurns(day) {
  try {
    return fs.readFileSync(archiveFile(day), 'utf-8')
      .split('\n').filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}
function loadDailySummaries() {
  try { return JSON.parse(fs.readFileSync(DAILY_SUMMARIES_FILE, 'utf-8')); } catch { return {}; }
}
function saveDailySummaries(obj) {
  ensureArchiveDir();
  try { fs.writeFileSync(DAILY_SUMMARIES_FILE, JSON.stringify(obj, null, 2)); } catch (e) { log(`saveDailySummaries: ${e.message}`); }
}

// Recover the real assistant reply for the archive. When the agent answered via
// tg_send, stdout is just the "[sent-via-tg]" sentinel, so the true text lives in
// Claude's transcript: either the tg_send tool-call argument or the last assistant
// text block.
function recoverReplyFromTranscript(sessionId) {
  if (!sessionId) return null;
  let lines;
  try { lines = fs.readFileSync(path.join(PROJECT_DIR, `${sessionId}.jsonl`), 'utf-8').split('\n').filter(Boolean); }
  catch { return null; }
  // Track the last meaningful reply in document order. A tg_send tool-call carries
  // the real text; the trailing "[sent-via-tg]" sentinel text block is ignored.
  let lastReply = null;
  for (const line of lines) {
    let ev; try { ev = JSON.parse(line); } catch { continue; }
    const content = ev && ev.message && ev.message.content;
    if (!Array.isArray(content)) continue;
    for (const c of content) {
      if (c && c.type === 'tool_use' && /tg_send/.test(c.name || '') && c.input && c.input.text) {
        lastReply = String(c.input.text);
      } else if (c && c.type === 'text' && c.text && !TG_SENT_SENTINEL.test(c.text)) {
        lastReply = String(c.text);
      }
    }
  }
  return lastReply;
}

// Shared client (telegram-client.js): timeouts, retries, 429 handling, and
// one-at-a-time sends per chat.
const telegram = createTelegramClient({ token: config.bot_token, log });
function tgApi(method, params, options) { return telegram.call(method, params, options); }

function stripAnsi(s) {
  // Drop ANSI CSI sequences (colors, cursor moves) that `claude -p` can emit.
  return s.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
}

function htmlEscape(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Convert common Markdown-ish stdout to Telegram-flavoured HTML so that
// when the agent forgets to use tg_send, its plain stdout still renders as
// rich formatting instead of an ugly <pre> monospace block.
//
// Supported: fenced code, inline code, bold, italic, headers, bullets, numbered lists.
// Out of scope: tables, links, images, Markdown blockquotes.
function markdownToTelegramHTML(text) {
  // Stash fenced code blocks first so their contents are immune to subsequent
  // bold/italic/header rewrites. We replace them back at the very end.
  const codeBlocks = [];
  let html = text.replace(/```[\w-]*\n?([\s\S]*?)```/g, (_m, body) => {
    codeBlocks.push(body.replace(/\n+$/, ''));
    return `\u0000CB${codeBlocks.length - 1}\u0000`;
  });

  // Same trick for inline code spans.
  const inlineCodes = [];
  html = html.replace(/`([^`\n]+?)`/g, (_m, body) => {
    inlineCodes.push(body);
    return `\u0000IC${inlineCodes.length - 1}\u0000`;
  });

  // Escape HTML entities in the remaining (non-code) text.
  html = html.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  // Bold: **x** or __x__
  html = html.replace(/\*\*([^\n*]+?)\*\*/g, '<b>$1</b>');
  html = html.replace(/__([^\n_]+?)__/g, '<b>$1</b>');

  // Italic: *x* / _x_ (avoid touching word-internal underscores/asterisks).
  html = html.replace(/(^|[^\w*])\*([^\n*]+?)\*(?!\w)/g, '$1<i>$2</i>');
  html = html.replace(/(^|[^\w_])_([^\n_]+?)_(?!\w)/g, '$1<i>$2</i>');

  // Headers (#, ##, ###) — Telegram HTML has no <h*>, render bold.
  html = html.replace(/^#{1,6} +(.+)$/gm, '<b>$1</b>');

  // Bullet lists: `- item` / `* item` -> `• item`.
  html = html.replace(/^[ \t]*[-*] +(.+)$/gm, '• $1');

  // Numbered lists: keep `1. item` as plain text (already readable).
  // No transformation needed; HTML escape was already applied.

  // Restore inline code as <code>...</code> (escape inner HTML).
  html = html.replace(/\u0000IC(\d+)\u0000/g, (_m, i) => {
    const body = inlineCodes[Number(i)];
    return `<code>${body.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</code>`;
  });

  // Restore fenced code blocks as <pre>...</pre>; long ones (over 12 lines)
  // collapse into a tap-to-expand quote so the answer stays readable.
  html = html.replace(/\u0000CB(\d+)\u0000/g, (_m, i) => {
    const body = codeBlocks[Number(i)];
    const pre = `<pre>${body.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre>`;
    return body.split('\n').length > 12 ? `<blockquote expandable>${pre}</blockquote>` : pre;
  });

  return html.trim();
}

// Heuristic: text that looks like aligned CLI tables (multiple lines with
// 2+ runs of 2+ consecutive spaces — i.e. column gutters) is better preserved
// verbatim in <pre> than rewritten as rich HTML.
function looksTabular(text) {
  const lines = text.split('\n');
  let hits = 0;
  for (const line of lines) {
    const gutters = line.match(/ {2,}/g);
    if (gutters && gutters.length >= 2) hits++;
    if (hits >= 3) return true;
  }
  return false;
}

// replyTo threads the first chunk under the user's message; the rest follow it.
// Tasks at least this long get 🎉 confetti on the answer the daemon relays.
const EFFECT_CONFETTI = MESSAGE_EFFECTS.confetti;
const CONFETTI_AFTER_MS = 2 * 60 * 1000;

// effect: a message effect id played on the first chunk. Short fenced code
// blocks in a 'rich' answer become one-tap Copy buttons on the last chunk.
// Returns true when everything was delivered. If Telegram stays unreachable
// after the client's retries, the undelivered rest goes to the outbox (or to
// onUnsent, when the outbox itself is resending) and false is returned.
async function sendChunked(text, { mode = 'rich', replyTo, effect, onUnsent } = {}) {
  // Telegram caps messages at 4096 chars. We leave headroom for the <pre>...</pre> wrapper.
  const MAX = 3800;
  let remaining = stripAnsi(text || '(no output)');
  const copyMarkup = mode === 'rich' ? copyKeyboard(codeBlocks(remaining)) : undefined;
  let effectId = effect;
  const threadUnder = replyTo;
  let attachFull = null;
  if (remaining.length > MAX * 2) {
    attachFull = remaining;
    const head = remaining.slice(0, MAX - 200);
    const cutAt = head.lastIndexOf('\n\n') > MAX / 2 ? head.lastIndexOf('\n\n') : head.lastIndexOf('\n');
    remaining = `${head.slice(0, cutAt > MAX / 2 ? cutAt : head.length)}\n\n… continued in the attached page.`;
  }

  // In 'rich' mode, fall back to monospace if the payload looks like a table —
  // alignment matters more than formatting for CLI output.
  let effectiveMode = mode;
  if (mode === 'rich' && looksTabular(remaining)) effectiveMode = 'mono';

  while (remaining.length > 0) {
    let chunk = remaining.slice(0, MAX);
    if (remaining.length > MAX) {
      const lastBreak = Math.max(chunk.lastIndexOf('\n'), chunk.lastIndexOf(' '));
      if (lastBreak > MAX * 0.5) chunk = chunk.slice(0, lastBreak);
    }

    let body, parse_mode;
    if (effectiveMode === 'mono') {
      body = `<pre>${htmlEscape(chunk)}</pre>`;
      parse_mode = 'HTML';
    } else if (effectiveMode === 'html') {
      body = chunk;
      parse_mode = 'HTML';
    } else if (effectiveMode === 'rich') {
      body = markdownToTelegramHTML(chunk);
      parse_mode = 'HTML';
    } else {
      body = chunk;
      parse_mode = undefined;
    }

    // allow_sending_without_reply: a deleted original must not block the answer.
    const reply_parameters = replyTo != null ? { message_id: replyTo, allow_sending_without_reply: true } : undefined;
    const reply_markup = remaining.length === chunk.length ? copyMarkup : undefined;
    const payload = { chat_id: config.chat_id, text: body, parse_mode, reply_parameters, reply_markup, message_effect_id: effectId, disable_web_page_preview: true };
    try {
      try {
        await tgApi('sendMessage', payload);
      } catch (e) {
        // Formatting Telegram rejected (unbalanced tags from a half-baked
        // Markdown conversion, etc.): resend this chunk as plain text. Any
        // other error is a delivery problem, handled below.
        if (!e.isParseError) throw e;
        log(`sendMessage HTML rejected (${e.message}) — resending plain`);
        await tgApi('sendMessage', { ...payload, text: chunk, parse_mode: undefined });
      }
    } catch (e) {
      log(`sendMessage failed after retries (${e.message}) — keeping the rest for later`);
      const rest = attachFull || remaining;
      if (onUnsent) onUnsent(rest, { mode, replyTo });
      else queueUnsent(rest, { mode, replyTo });
      return false;
    }
    replyTo = undefined;
    effectId = undefined;
    remaining = remaining.slice(chunk.length);
  }
  if (attachFull) {
    const file = path.join(require('os').tmpdir(), `claude-answer-${Date.now()}.html`);
    try {
      const page = mode === 'rich' ? markdownToTelegramHTML(attachFull) : `<pre>${htmlEscape(attachFull)}</pre>`;
      fs.writeFileSync(file, htmlPage(page));
      await tgSendFile(file, `📄 Full answer (${attachFull.length.toLocaleString('en-US')} chars)`, threadUnder);
    } catch (e) { log(`full answer page: ${e.message}`); }
    finally { try { fs.unlinkSync(file); } catch (_) {} }
  }
  return true;
}

// ---------- Outbox ----------
// Answers that could not be delivered (network down, Telegram unreachable
// after the client's retries) are kept in state and resent every 30 s and at
// startup, so a dropped connection no longer loses a finished answer.
const OUTBOX_RETRY_MS = Number(process.env.TELEGRAM_OUTBOX_RETRY_MS) || 30 * 1000;
let outboxBusy = false;

function queueUnsent(text, { mode, replyTo }) {
  state.outbox = state.outbox || [];
  state.outbox.push({ text, mode, replyTo, ts: new Date().toISOString() });
  saveState();
  log(`outbox: kept an undelivered answer (${text.length} chars); ${state.outbox.length} waiting`);
}

async function flushOutbox() {
  if (outboxBusy || !state.outbox || !state.outbox.length) return;
  outboxBusy = true;
  try {
    while (state.outbox.length) {
      const item = state.outbox[0];
      const lateText = 'Delivered late: the connection to Telegram was down.';
      const note = item.late ? ''
        : item.mode === 'html' ? `📬 <i>${lateText}</i>\n\n`
        : item.mode === 'rich' ? `📬 _${lateText}_\n\n` : `📬 ${lateText}\n\n`;
      let rest = null;
      const ok = await sendChunked(note + item.text, {
        mode: item.mode, replyTo: item.replyTo,
        onUnsent: (unsent) => { rest = unsent; },
      });
      if (!ok) {
        // Still down. Keep only what did not go out, so nothing is sent twice.
        state.outbox[0] = { ...item, text: rest && rest.startsWith(note) ? rest.slice(note.length) : (rest || item.text), late: item.late || (rest !== note + item.text) };
        saveState();
        return;
      }
      state.outbox.shift();
      saveState();
      log(`outbox: delivered a late answer; ${state.outbox.length} waiting`);
    }
  } finally {
    outboxBusy = false;
  }
}

function quoteForCmd(arg) {
  // cmd.exe-safe quoting: wrap in double quotes if it contains whitespace or quotes;
  // escape embedded quotes and trailing backslashes per Windows command-line rules.
  if (typeof arg !== 'string') arg = String(arg);
  // Newlines inside the argument break cmd.exe command-line parsing — replace with space.
  arg = arg.replace(/\r?\n/g, ' ');
  if (!/[\s"]/.test(arg)) return arg;
  const escaped = arg.replace(/(\\")/g, '$1$1\\"').replace(/(\\+)$/, '$1$1');
  return `"${escaped}"`;
}

const CLAUDE_TIMEOUT_MS = 20 * 60 * 1000; // 20 minutes max per task
// On Windows, invoking `claude.cmd` routes through cmd.exe and inherits its
// ~8K command-line limit. Prefer the native executable from the current
// installer, while retaining compatibility with the legacy npm installation.
function resolveClaudeExecutable() {
  if (process.platform !== 'win32') return 'claude';

  const candidates = [
    process.env.CLAUDE_EXECUTABLE,
    process.env.USERPROFILE && path.join(process.env.USERPROFILE, '.local', 'bin', 'claude.exe'),
    process.env.APPDATA && path.join(process.env.APPDATA, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'),
  ];
  return candidates.find((candidate) => candidate && fs.existsSync(candidate)) || 'claude';
}

const CLAUDE_EXECUTABLE = resolveClaudeExecutable();

// Keep the prompt argument comfortably below Windows' CreateProcess command-line
// limit. Large prompts (archive rollover / restored context) are sent through
// stdin instead; Claude Code's print mode supports a prompt argument plus piped
// input, just like `cat file | claude -p "Review this"`.
const MAX_PROMPT_ARG_CHARS = 12000;

// On Windows, killing only the direct child can leave claude.exe children
// (MCP servers, tools) running as orphans; taskkill /T takes the whole tree.
function killTree(proc) {
  if (process.platform === 'win32') {
    try { execFileSync('taskkill', ['/F', '/T', '/PID', String(proc.pid)], { timeout: 5000, stdio: 'ignore' }); } catch (_) {}
  } else {
    try { proc.kill('SIGTERM'); } catch (_) {}
    setTimeout(() => { try { proc.kill('SIGKILL'); } catch (_) {} }, 5000);
  }
}

// Task-session Claude processes, so /stop can end them. Summaries are not tracked.
let activeTask = null;      // the main conversation (and Hermes queue tasks): { proc, stopped }
const bgTasks = new Map();  // /bg side tasks by Telegram message id: { proc, stopped, text, startedAt }
function stopHandle(handle, why) {
  handle.stopped = true;
  log(`${why}: killing claude PID=${handle.proc.pid}`);
  killTree(handle.proc);
}
function stopActiveTask() {
  if (!activeTask) return false;
  stopHandle(activeTask, '/stop');
  return true;
}

// Daemon-only Claude settings: the Telegram approval gate (PreToolUse hook).
// Written at startup because the hook needs this checkout's absolute path.
const DAEMON_SETTINGS = path.join(__dirname, 'daemon-settings.local.json');
function writeDaemonSettings() {
  const hook = path.join(__dirname, 'telegram-approval-hook.js').replace(/\\/g, '/');
  const settings = {
    hooks: {
      PreToolUse: [{
        matcher: 'Bash|PowerShell|mcp__.*',
        hooks: [{ type: 'command', command: `node --use-system-ca "${hook}"`, timeout: 3700 }],
      }],
    },
  };
  fs.writeFileSync(DAEMON_SETTINGS, JSON.stringify(settings, null, 2));
}

// Low-level spawn of `claude -p` with the given extra args. Pure: collects
// stdout/stderr and performs NO state mutation. Resolves { code, out, errOut, killed, stopped }.
//   onSpawn(handle)  registers the process as a /stop target.
//   replyTo          the Telegram message this task answers; telegram-tg.js threads
//                    its first tg_send under it and the approval hook its question.
//   permissionMode   e.g. 'plan' (read-only) instead of skipping permission checks.
//   onEvent(ev)      live progress: switches to stream-json; `out` is still the
//                    final result envelope, the same shape as --output-format json.
//   nativeMcp        load the MCP servers registered in Claude Code itself (user,
//                    project and local scope, the same set `claude mcp list`
//                    shows) on top of the daemon's own connectors. Summaries
//                    pass false: they need no tools, and connecting to every
//                    server would only slow them down.
function claudeRaw(task, extraArgs, { model = CLAUDE_RUNTIME.model, onSpawn, replyTo, permissionMode, onEvent, nativeMcp = true } = {}) {
  return new Promise((resolve) => {
    const oversized = task.length > MAX_PROMPT_ARG_CHARS;
    const promptArg = oversized
      ? 'Process the complete task content supplied on standard input as the user request. Do not omit or reinterpret it.'
      : task;
    const args = ['-p', promptArg,
                  '--model', String(model),
                  '--output-format', onEvent ? 'stream-json' : 'json',
                  '--mcp-config', EMPTY_MCP,
                  '--settings', DAEMON_SETTINGS];
    if (!nativeMcp) args.push('--strict-mcp-config');
    if (onEvent) args.push('--verbose'); // stream-json in print mode requires it
    // Bypass would override plan mode, so a read-only run must not skip checks.
    if (permissionMode) args.push('--permission-mode', permissionMode);
    else args.push('--dangerously-skip-permissions');
    if (CLAUDE_RUNTIME.fallback_model) args.push('--fallback-model', String(CLAUDE_RUNTIME.fallback_model));
    if (CLAUDE_RUNTIME.reasoning_effort) args.push('--effort', String(CLAUDE_RUNTIME.reasoning_effort));
    args.push(...extraArgs);
    log(`spawn: native=${path.basename(CLAUDE_EXECUTABLE)} model=${model} prompt_chars=${task.length}${oversized ? ' via=stdin' : ''}${permissionMode ? ` mode=${permissionMode}` : ''}`);
    const env = { ...process.env, TELEGRAM_UNDER_DAEMON: '1' };
    delete env.TELEGRAM_REPLY_TO_MESSAGE_ID;
    if (replyTo != null) env.TELEGRAM_REPLY_TO_MESSAGE_ID = String(replyTo);
    const proc = spawn(CLAUDE_EXECUTABLE, args,
      { cwd: WORKDIR, env, stdio: ['pipe', 'pipe', 'pipe'] });
    const handle = { proc, stopped: false };
    if (onSpawn) onSpawn(handle);
    let out = '', errOut = '', killed = false;
    // stream-json: one event per line; keep the final result event as `out`.
    let lineBuf = '', resultEvent = null, strayText = '';
    const takeLine = (line) => {
      if (!line.trim()) return;
      let ev; try { ev = JSON.parse(line); } catch (_) { strayText += `${line}\n`; return; }
      if (ev.type === 'result') resultEvent = ev;
      else { try { onEvent(ev); } catch (e) { log(`progress: ${e.message}`); } }
    };
    proc.stdout.on('data', (d) => {
      if (!onEvent) { out += d.toString(); return; }
      lineBuf += d.toString();
      let nl;
      while ((nl = lineBuf.indexOf('\n')) >= 0) { takeLine(lineBuf.slice(0, nl)); lineBuf = lineBuf.slice(nl + 1); }
    });
    proc.stderr.on('data', (d) => errOut += d.toString());
    proc.on('error', (e) => resolve({ code: -1, out: '', errOut: `spawn error: ${e.message}`, killed: false, stopped: false }));
    // Close stdin explicitly: without this, Claude may wait for more piped input.
    // The 'error' listener is required, not defensive: if the child exits before
    // draining a large piped prompt, the write fails asynchronously with EOF/EPIPE.
    // An unhandled 'error' on stdin would take down the whole daemon, not just
    // this task — a sync try/catch cannot intercept it. The child's own exit is
    // reported by the 'close'/'error' handlers, so swallowing it here is enough.
    proc.stdin.on('error', (e) => log(`stdin write failed (child likely exited early): ${e.code || e.message}`));
    try { proc.stdin.end(oversized ? task : undefined); } catch (_) {}
    // Kill runaway tasks so the daemon stays responsive.
    const timer = setTimeout(() => {
      killed = true;
      log(`timeout: killing claude after ${CLAUDE_TIMEOUT_MS / 1000}s`);
      killTree(proc);
    }, CLAUDE_TIMEOUT_MS);
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (onEvent) {
        takeLine(lineBuf);
        out = resultEvent ? JSON.stringify(resultEvent) : strayText;
      }
      resolve({ code, out, errOut, killed, stopped: handle.stopped });
    });
  });
}

// One-off summarization that never touches the pinned session (uses a throwaway id).
async function summarize(label, body) {
  const prompt = `Summarize the following ${label} concisely in 4-8 short bullet points. `
    + `Capture facts, decisions, names, numbers, and open threads that future context would need. `
    + `Output ONLY the summary, no preamble.\n\n${body}`;
  const { code, out } = await claudeRaw(prompt, ['--session-id', crypto.randomUUID()], { nativeMcp: false });
  if (code !== 0) return null;
  let env = null; try { env = JSON.parse(out.trim()); } catch (_) {}
  return env && typeof env.result === 'string' ? env.result.trim() : null;
}

// /usage bookkeeping from the `--output-format json` envelope: the last task
// plus a per-day total that resets at the first task of a new local day.
// total_cost_usd is Claude's own figure (API-equivalent on a subscription).
function recordUsage(envelope, model, source) {
  const u = envelope.usage || {};
  const last = {
    ts: new Date().toISOString(), source, model,
    costUsd: Number(envelope.total_cost_usd) || 0,
    turns: Number(envelope.num_turns) || 0,
    durationMs: Number(envelope.duration_ms) || 0,
    inputTokens: (Number(u.input_tokens) || 0) + (Number(u.cache_creation_input_tokens) || 0),
    cachedTokens: Number(u.cache_read_input_tokens) || 0,
    outputTokens: Number(u.output_tokens) || 0,
  };
  const day = localDayKey();
  const prev = state.usage && state.usage.day === day ? state.usage : { day, tasks: 0, costUsd: 0, turns: 0, durationMs: 0 };
  state.usage = {
    day,
    tasks: prev.tasks + 1,
    costUsd: prev.costUsd + last.costUsd,
    turns: prev.turns + last.turns,
    durationMs: prev.durationMs + last.durationMs,
    last,
  };
  saveState();
}

function formatUsage() {
  const usage = state.usage;
  if (!usage || !usage.last) return 'No tasks recorded yet.';
  const n = (v) => Number(v || 0).toLocaleString('en-US');
  const usd = (v) => `$${Number(v || 0).toFixed(2)}`;
  const last = usage.last;
  const today = usage.day === localDayKey()
    ? `Tasks: <code>${usage.tasks}</code> · Cost: <code>${usd(usage.costUsd)}</code>\nTurns: <code>${usage.turns}</code> · Time: <code>${formatUptime(usage.durationMs / 1000)}</code>`
    : 'No tasks yet today.';
  return `<b>💸 Usage</b>\n\n<b>Last task</b> (${htmlEscape(last.source)}, <code>${htmlEscape(last.model)}</code>)\n`
    + `Cost: <code>${usd(last.costUsd)}</code> · Turns: <code>${last.turns}</code> · Time: <code>${formatUptime(last.durationMs / 1000)}</code>\n`
    + `Tokens: <code>${n(last.inputTokens)}</code> in · <code>${n(last.cachedTokens)}</code> cached · <code>${n(last.outputTokens)}</code> out\n\n`
    + `<b>Today</b>\n${today}\n\n<i>Cost is Claude's API-equivalent figure.</i>`;
}

// ---------- Warm Claude (main conversation) ----------
// Starting Claude Code costs 15-20 s (skills, plugins, MCP servers) before it
// reads a word, so the main conversation keeps one Claude running between
// messages and feeds each message to it over stdin (stream-json). Follow-ups
// then start in about a second. The process is replaced when the session or
// model changes, and closed by /new, a rotation, a read-only (/plan, voice)
// run on the same conversation, /stop, or 30 idle minutes. Side tasks, the
// Hermes queue and summaries still start their own process. Turn off with
// telegram.warm: false in agent-runtime.json.
const WARM_ENABLED = TELEGRAM_RUNTIME.warm !== false;
const WARM_IDLE_MS = 30 * 60 * 1000;
let warm = null; // { proc, sessionId, model, buf, turn, lastCost, errOut, used, idleTimer }

function startWarm(sessionId, resuming, model) {
  const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--model', String(model), '--mcp-config', EMPTY_MCP, '--settings', DAEMON_SETTINGS, '--dangerously-skip-permissions'];
  if (CLAUDE_RUNTIME.fallback_model) args.push('--fallback-model', String(CLAUDE_RUNTIME.fallback_model));
  if (CLAUDE_RUNTIME.reasoning_effort) args.push('--effort', String(CLAUDE_RUNTIME.reasoning_effort));
  if (CLAUDE_RUNTIME.chrome === true) args.push('--chrome');
  args.push(...(resuming ? ['--resume', sessionId] : ['--session-id', sessionId]));
  log(`warm: starting Claude (${resuming ? 'resume' : 'new'} session ${sessionId}, model ${model})`);
  const env = { ...process.env, TELEGRAM_UNDER_DAEMON: '1' };
  delete env.TELEGRAM_REPLY_TO_MESSAGE_ID; // per message: see handshake.setCurrentTask
  const proc = spawn(CLAUDE_EXECUTABLE, args, { cwd: WORKDIR, env, stdio: ['pipe', 'pipe', 'pipe'] });
  const w = { proc, sessionId, model: String(model), buf: '', turn: null, lastCost: 0, errOut: '', used: false, idleTimer: null };
  const finishTurn = (result) => {
    const turn = w.turn;
    if (!turn) return;
    w.turn = null;
    clearTimeout(turn.timer);
    turn.resolve({ errOut: w.errOut, killed: turn.killed, stopped: turn.stopped, ...result });
  };
  proc.stdout.on('data', (d) => {
    w.buf += d.toString();
    let nl;
    while ((nl = w.buf.indexOf('\n')) >= 0) {
      const line = w.buf.slice(0, nl).trim();
      w.buf = w.buf.slice(nl + 1);
      if (!line) continue;
      let ev; try { ev = JSON.parse(line); } catch (_) { continue; }
      if (ev.type === 'system' && ev.subtype === 'init' && ev.session_id) w.sessionId = ev.session_id;
      if (ev.type === 'result') {
        // total_cost_usd adds up over the process's life; /usage wants this message's share.
        const cost = Number(ev.total_cost_usd) || 0;
        const envelope = { ...ev, total_cost_usd: Math.max(0, cost - w.lastCost) };
        w.lastCost = cost;
        finishTurn({ code: ev.is_error ? 1 : 0, out: JSON.stringify(envelope) });
        armWarmIdle(w);
      } else if (w.turn && w.turn.onEvent) {
        try { w.turn.onEvent(ev); } catch (e) { log(`progress: ${e.message}`); }
      }
    }
  });
  proc.stderr.on('data', (d) => { w.errOut = (w.errOut + d.toString()).slice(-4000); });
  proc.stdin.on('error', (e) => log(`warm stdin: ${e.code || e.message}`));
  proc.on('error', (e) => { if (warm === w) warm = null; finishTurn({ code: -1, out: '', errOut: `spawn error: ${e.message}` }); });
  proc.on('close', (code) => {
    if (warm === w) warm = null;
    clearTimeout(w.idleTimer);
    log(`warm: Claude exited (code ${code})`);
    finishTurn({ code: code == null ? -1 : code, out: '' });
  });
  return w;
}

function armWarmIdle(w) {
  clearTimeout(w.idleTimer);
  w.idleTimer = setTimeout(() => { if (warm === w && !w.turn) closeWarm('idle for 30 min'); }, WARM_IDLE_MS);
}

function closeWarm(reason) {
  const w = warm;
  if (!w) return;
  warm = null;
  clearTimeout(w.idleTimer);
  log(`warm: closing Claude (${reason})`);
  try { w.proc.stdin.end(); } catch (_) {}
  setTimeout(() => { if (w.proc.exitCode == null) killTree(w.proc); }, 5000);
}

// Starts Claude ahead of the first message, so even that one is quick.
function prewarm() {
  if (!WARM_ENABLED || warm) return;
  if (state.sessionId) warm = startWarm(state.sessionId, true, CLAUDE_RUNTIME.model);
  else warm = startWarm(crypto.randomUUID(), false, CLAUDE_RUNTIME.model);
  armWarmIdle(warm);
}

// One message to the warm Claude; resolves like claudeRaw.
function warmTurn(prompt, { sessionId, resuming, model, onEvent, onSpawn, replyTo }) {
  return new Promise((resolve) => {
    if (warm && (warm.model !== String(model) || warm.sessionId !== sessionId || warm.turn)) closeWarm('different session or model');
    if (!warm) warm = startWarm(sessionId, resuming, model);
    const w = warm;
    clearTimeout(w.idleTimer);
    w.used = true;
    handshake.setCurrentTask(replyTo);
    const turn = { resolve, onEvent, stopped: false, killed: false };
    turn.timer = setTimeout(() => {
      turn.killed = true;
      log(`timeout: killing warm Claude after ${CLAUDE_TIMEOUT_MS / 1000}s`);
      killTree(w.proc);
    }, CLAUDE_TIMEOUT_MS);
    w.turn = turn;
    // /stop sees the same shape as a spawned run: { proc, stopped }.
    if (onSpawn) onSpawn({ proc: w.proc, get stopped() { return turn.stopped; }, set stopped(v) { turn.stopped = v; } });
    try {
      w.proc.stdin.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: prompt } })}\n`);
    } catch (e) {
      w.turn = null;
      clearTimeout(turn.timer);
      resolve({ code: -1, out: '', errOut: `warm write: ${e.message}`, killed: false, stopped: false });
    }
  });
}

// ---------- Conversation rotation ----------
// A conversation that has grown huge makes every message slow and costly:
// each one re-reads the whole history. When the context of the last message
// passes the limit (telegram.rotate_tokens, default 150k), the next message
// starts a fresh conversation; recent turns and earlier summaries from the
// archive carry over (buildRestoreContext).
const ROTATE_TOKENS = Number(TELEGRAM_RUNTIME.rotate_tokens) || 150000;

// Unpin the session; the next task restores context from the archive
// (buildRestoreContext) instead of resuming. Also used by /refresh.
function startFreshConversation(reason) {
  closeWarm(reason);
  state.sessionId = null;
  state.lastActivity = null;
  saveState();
}

// /compact: Claude Code's own compaction of the pinned session, run headless
// ("claude -p /compact --resume <id>"). Unlike /refresh it keeps what Claude
// learned from tool calls, folded into its summary, and the session id stays.
// The warm Claude holds the same session, so it is closed first; the next
// message starts a new one on the compacted history.
async function compactConversation() {
  const sessionId = state.sessionId;
  if (!sessionId) return 'Nothing to compact: the next message starts a new conversation.';
  const before = sessionContextTokens(sessionId);
  const w = warm;
  closeWarm('/compact');
  if (w && w.proc.exitCode == null) await Promise.race([new Promise(r => w.proc.once('exit', r)), new Promise(r => setTimeout(r, 6000))]);
  let handle = null;
  const { code, out } = await claudeRaw('/compact', ['--resume', sessionId], {
    nativeMcp: false, onSpawn: (h) => { handle = h; activeTask = h; }, // /stop can cancel it
  });
  if (activeTask === handle) activeTask = null;
  let envelope = null; try { envelope = JSON.parse(out.trim()); } catch (_) {}
  if (code !== 0 || !envelope || envelope.is_error || envelope.local_command !== 'compact') {
    log(`compact failed (exit=${code}): ${String(out).slice(0, 300)}`);
    return '⚠️ Compaction did not run. The conversation is unchanged; /refresh starts fresh with a summary instead.';
  }
  state.lastActivity = new Date().toISOString();
  saveState();
  const after = sessionContextTokens(sessionId);
  const k = (n) => `${Math.round(n / 1000)}k`;
  log(`compacted session ${sessionId}: ${before} -> ${after} tokens`);
  return `🗜 <b>Compacted</b>${before != null && after != null ? `: ${k(before)} → ${k(after)} tokens` : ''}. Same conversation, now carried by Claude's own summary.`;
}

function maybeRotate({ notify = true } = {}) {
  const last = state.usage && state.usage.last;
  if (!last || last.source !== 'telegram' || !state.sessionId) return false;
  const context = (Number(last.inputTokens) + Number(last.cachedTokens)) / Math.max(1, Number(last.turns) || 1);
  if (context < ROTATE_TOKENS) return false;
  log(`rotation: last context ~${Math.round(context / 1000)}k tokens ≥ ${Math.round(ROTATE_TOKENS / 1000)}k — fresh conversation next`);
  startFreshConversation('conversation rotated');
  if (notify) {
    sendChunked(`♻️ <i>Next message starts a fresh conversation: this one reached about ${Math.round(context / 1000)}k tokens, which makes every reply slow. Recent history carries over as a summary.</i>`, { mode: 'html' })
      .catch(e => log(`rotation note: ${e.message}`));
  }
  return true;
}

// Run a Telegram task through Claude with our session management. Optional
// contextPrefix is prepended (used to restore conversation context on a fork
// or for an explicit recall). Returns { ok, text, code, forked, actualId }.
// source labels /usage; permissionMode and onEvent pass through to claudeRaw.
// onSpawn defaults to registering the main /stop target.
async function runClaude(task, { contextPrefix, model = CLAUDE_RUNTIME.model, isolated = false, replyTo, permissionMode, onEvent, onSpawn, source } = {}) {
  const resuming = !isolated && !!state.sessionId;
  const useWarm = WARM_ENABLED && !isolated && !permissionMode;
  // Own the session id ourselves: reuse the pinned one, or mint a UUID for a
  // fresh session (or take the one a pre-started warm Claude already has).
  const sessionId = isolated ? crypto.randomUUID()
    : (state.sessionId || (useWarm && warm && !warm.used ? warm.sessionId : crypto.randomUUID()));
  const prompt = contextPrefix ? `${contextPrefix}\n\n---\nThe user's actual message:\n${task}` : task;
  const sessionArgs = resuming ? ['--resume', sessionId] : ['--session-id', sessionId];
  // Opt-in Claude in Chrome tools for task sessions (not summaries); needs the extension connected.
  if (CLAUDE_RUNTIME.chrome === true) sessionArgs.push('--chrome');
  log(resuming ? `resuming session ${sessionId}` : `starting fresh session ${sessionId}`);

  let mainHandle = null;
  const register = onSpawn || ((handle) => { mainHandle = handle; activeTask = handle; });
  // A separate process on the same conversation must not run beside the warm one.
  if (!isolated && !useWarm) closeWarm('a separate run on the main conversation');
  const { code, out, errOut, killed, stopped } = useWarm
    ? await warmTurn(prompt, { sessionId, resuming, model, onEvent, onSpawn: register, replyTo })
    : await claudeRaw(prompt, sessionArgs, { model, onSpawn: register, replyTo, permissionMode, onEvent });
  if (mainHandle && activeTask === mainHandle) activeTask = null;
  if (stopped) return { ok: false, text: '__STOPPED__', code: -1 };
  if (killed) {
    return { ok: false, text: `Task timed out after ${CLAUDE_TIMEOUT_MS / 1000}s. Partial output:\n${out.trim() || '(none)'}`, code: -1 };
  }

  // Parse the JSON envelope to recover BOTH the answer text and the session id
  // Claude *actually* used — which can differ from the one we asked to resume
  // when Claude silently forks a fresh session after idle (~15 min), exiting 0.
  let envelope = null;
  try { envelope = JSON.parse(out.trim()); } catch (_) {}
  const answer   = (envelope && typeof envelope.result === 'string') ? envelope.result : out.trim();
  const actualId = envelope && envelope.session_id;
  if (envelope) recordUsage(envelope, model, source || (isolated ? 'queue' : 'telegram'));

  // Reset to fresh ONLY when --resume genuinely failed loudly (specific message,
  // not any stray "session"/"resume" word that would wipe context on real failures).
  const RESUME_FAILED = /no conversation found|session (id )?.*(not found|invalid|expired)|could not (resume|find session)|unable to resume/i;
  if (code !== 0 && resuming && RESUME_FAILED.test(errOut)) {
    log(`session ${sessionId} rejected — resetting to fresh`);
    state.sessionId = null; saveState();
    return { ok: false, text: '__SESSION_EXPIRED__' };
  }

  // An isolated queue task must never inherit or overwrite the Telegram session.
  let forked = false;
  if (!isolated) {
    if (code === 0 && actualId) {
      if (!state.sessionId) {
        state.sessionId = actualId; saveState();
        log(`pinned session ${actualId}`);
      } else if (resuming && actualId !== sessionId) {
        log(`SILENT FORK: asked to resume ${sessionId}, Claude used ${actualId} — re-pinning (context likely lost)`);
        state.sessionId = actualId; saveState();
        forked = true;
      }
    } else if (code === 0 && !state.sessionId && !actualId) {
      state.sessionId = sessionId; saveState();
      log(`pinned session ${sessionId} (no json envelope)`);
    }
    if (code === 0) { state.lastActivity = new Date().toISOString(); saveState(); }
  }

  const text = answer.trim() || (errOut.trim() ? `(stderr) ${errOut.trim()}` : `(no output, exit=${code})`);
  return { ok: code === 0, text, code, forked, actualId };
}

// ---------- Typing indicator ----------
// Telegram's "typing..." badge lasts ~5 seconds. We re-send every 4s while Claude works.
function startTyping() {
  const send = () => {
    if (handshake.askActive()) return; // waiting for the user: "typing…" would mislead
    tgApi('sendChatAction', { chat_id: config.chat_id, action: 'typing' }, { lowPriority: true })
      .catch(e => log(`typing indicator: ${e.message}`));
  };
  send(); // fire immediately
  const interval = setInterval(send, 4000);
  return () => clearInterval(interval);
}

// ---------- Rich Telegram helpers (reactions, editing, file uploads) ----------
// Emoji reaction — a lightweight "acknowledged" signal (👀 on pickup, 🎉 on done).
// Note: Telegram only allows a fixed emoji set for reactions (👍👀🎉🔥❤️👏🙏 etc).
function tgReact(messageId, emoji) {
  if (messageId == null) return Promise.resolve();
  return tgApi('setMessageReaction', {
    chat_id: config.chat_id,
    message_id: messageId,
    reaction: [{ type: 'emoji', emoji: emoji || '👀' }],
  }, { lowPriority: true }).catch(e => log(`react: ${e.message}`));
}

// Edit a previously sent message in place (live progress, no chat spam).
function tgEdit(messageId, text, { parse_mode } = {}) {
  return tgApi('editMessageText', {
    chat_id: config.chat_id,
    message_id: messageId,
    text,
    parse_mode,
    disable_web_page_preview: true,
  }).catch(e => log(`edit: ${e.message}`));
}

function tgClearReaction(messageId) {
  if (messageId == null) return Promise.resolve();
  return tgApi('setMessageReaction', { chat_id: config.chat_id, message_id: messageId, reaction: [] }, { lowPriority: true })
    .catch(e => log(`clear reaction: ${e.message}`));
}

// Pick the right Telegram method + form field based on file extension.
function pickFileMethod(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(ext)) return { method: 'sendPhoto', field: 'photo' };
  if (ext === '.ogg') return { method: 'sendVoice', field: 'voice' };
  if (['.mp4', '.mov'].includes(ext)) return { method: 'sendVideo', field: 'video' };
  if (['.mp3', '.m4a', '.wav', '.flac'].includes(ext)) return { method: 'sendAudio', field: 'audio' };
  return { method: 'sendDocument', field: 'document' };
}

// Upload a file (screenshot, log, report page), threaded under replyTo.
function tgSendFile(filePath, caption, replyTo) {
  const { method, field } = pickFileMethod(filePath);
  const fields = { chat_id: config.chat_id };
  if (caption) fields.caption = caption;
  if (replyTo != null) fields.reply_parameters = { message_id: replyTo, allow_sending_without_reply: true };
  return telegram.multipart(method, fields, field, filePath);
}

// ---------- Live status message ----------
// One status message per task, edited in place at most every 3 s and deleted
// when the task ends. How much of it you see is the progress mode (/progress):
//   off     no status message (reactions still show progress)
//   quiet   only for tasks that run 30 s or more; time and step count, no steps
//   normal  after 10 s; time, step count and the latest step
//   full    at the first step; time, step count and the last three steps
// Quick answers stay clean in every mode but full. Default: quiet, or
// telegram.progress in agent-runtime.json (true = normal, false = off).
const PROGRESS_MODES = {
  off: { showAfterMs: Infinity, steps: 0, label: 'no status message; reactions only' },
  quiet: { showAfterMs: 30000, steps: 0, label: 'only for tasks over 30 s, time and step count' },
  normal: { showAfterMs: 10000, steps: 1, label: 'after 10 s, with the latest step' },
  full: { showAfterMs: 0, steps: 3, label: 'right away, with the last three steps' },
};
function defaultProgressMode() {
  const configured = TELEGRAM_RUNTIME.progress;
  if (configured === false) return 'off';
  if (configured === true) return 'normal';
  return PROGRESS_MODES[configured] ? configured : 'quiet';
}
function progressMode() {
  return PROGRESS_MODES[state.progressMode] ? state.progressMode : defaultProgressMode();
}

// /progress: show the mode with a button per mode, or set it by name.
function progressCommand(argument) {
  const wanted = String(argument || '').trim().toLowerCase();
  if (wanted) {
    if (!PROGRESS_MODES[wanted]) return { text: `Unknown mode <code>${htmlEscape(wanted)}</code>. Use off, quiet, normal or full.` };
    state.progressMode = wanted;
    saveState();
  }
  const current = progressMode();
  const lines = Object.entries(PROGRESS_MODES)
    .map(([name, mode]) => `${name === current ? '✅' : '▫️'} <b>${name}</b>: ${mode.label}`);
  return {
    text: `<b>⏳ Progress display</b>${wanted ? ' updated' : ''}\n\n${lines.join('\n')}\n\n<i>Tap to switch, or send /progress &lt;mode&gt;.</i>`,
    reply_markup: { inline_keyboard: [Object.keys(PROGRESS_MODES).map(name => ({
      text: name === current ? `✅ ${name}` : name, callback_data: `pm:${name}`, style: name === current ? 'success' : undefined,
    }))] },
  };
}

// A tap on a /progress button. Returns false when it was not ours.
function progressButton(cq) {
  const [tag, name] = String(cq.data || '').split(':');
  if (tag !== 'pm' || !PROGRESS_MODES[name]) return false;
  const view = progressCommand(name);
  tgApi('answerCallbackQuery', { callback_query_id: cq.id, text: `Progress: ${name}` }).catch(() => {});
  if (cq.message) {
    tgApi('editMessageText', {
      chat_id: config.chat_id, message_id: cq.message.message_id, parse_mode: 'HTML', text: view.text, reply_markup: view.reply_markup,
    }, { lowPriority: true }).catch(e => log(`progress edit: ${e.message}`));
  }
  return true;
}

// A plain-language step. Shell steps use the description Claude gives each
// command ("Check the daemon log"); without one, the command without a
// leading "cd <folder> &&".
function toolLine(name, input) {
  const i = input || {};
  const file = (p) => `<code>${htmlEscape(path.basename(String(p || '')))}</code>`;
  const one = (s, max = 70) => `<code>${htmlEscape(shorten(String(s || '').split('\n')[0], max))}</code>`;
  if (/^mcp__telegram-tg__/.test(name) || /^(TodoWrite|ToolSearch|ExitPlanMode|EnterPlanMode)$/.test(name)) return null;
  switch (name) {
    case 'Bash': case 'PowerShell': {
      if (i.description) return `💻 ${htmlEscape(shorten(i.description, 70))}`;
      const command = String(i.command || '').replace(/^\s*(?:cd\s+(?:"[^"]*"|'[^']*'|\S+)\s*(?:&&|;)\s*)+/i, '');
      return `💻 ${one(command)}`;
    }
    case 'Read': return `📖 Read ${file(i.file_path)}`;
    case 'Write': return `📝 Write ${file(i.file_path)}`;
    case 'Edit': case 'MultiEdit': case 'NotebookEdit': return `✏️ Edit ${file(i.file_path || i.notebook_path)}`;
    case 'Grep': return `🔎 Search ${one(i.pattern, 50)}`;
    case 'Glob': return `🔎 Find ${one(i.pattern, 50)}`;
    case 'WebFetch': return `🌐 Fetch ${one(i.url, 60)}`;
    case 'WebSearch': return `🌐 Search ${one(i.query, 60)}`;
    case 'Agent': case 'Task': return `🤖 Agent: ${htmlEscape(shorten(i.description || '', 60))}`;
    case 'Skill': return `🧩 Skill ${one(i.skill, 40)}`;
    default: {
      if (!name.startsWith('mcp__')) return `⚙️ ${htmlEscape(name)}`;
      const [, server, tool] = name.split('__');
      return `🔌 ${htmlEscape(server)}: <code>${htmlEscape(tool || '')}</code>`;
    }
  }
}

// <tg-time> renders a moment in the reader's own time zone; format "r" is
// relative ("5 minutes ago"), "t" a clock time, "wDT" weekday + date + time.
function tgTime(ms, format, fallback) {
  return `<tg-time unix="${Math.floor(ms / 1000)}" format="${format}">${htmlEscape(fallback)}</tg-time>`;
}

// workingReaction: swapped onto the user's message at the first tool step,
// so 👀 (seen) turns into 👨‍💻 (actively working). The mode is read once per
// task, so a /progress change applies from the next task.
function startStatus(replyTo, { title = 'Working', workingReaction } = {}) {
  const t0 = Date.now();
  const mode = PROGRESS_MODES[progressMode()];
  const steps = [];
  let count = 0, messageId = null, creating = false, stopped = false, lastSent = '', editTimer = null;
  const render = () => {
    const secs = Math.floor((Date.now() - t0) / 1000);
    const extra = [`started ${tgTime(t0, 'r', secs >= 60 ? `${Math.floor(secs / 60)} min ago` : 'just now')}`];
    if (count) extra.push(`${count} step${count === 1 ? '' : 's'}`);
    if (state.queue.length) extra.push(`${state.queue.length} queued`);
    // The minute count keeps the text changing, so the periodic edit is not a no-op.
    const shownSteps = mode.steps ? steps.slice(-mode.steps) : [];
    const lines = [`⏳ <b>${htmlEscape(title)}</b> — ${extra.join(' · ')} <i>(${Math.floor(secs / 60)}m)</i>`, ...shownSteps];
    if (handshake.askActive()) lines.push('❓ <i>Waiting for your answer above.</i>');
    lines.push('<i>/stop to cancel</i>');
    return lines.join('\n');
  };
  const flush = async () => {
    editTimer = null;
    if (stopped || Date.now() - t0 < mode.showAfterMs) return;
    const text = render();
    if (text === lastSent) return;
    try {
      if (messageId == null) {
        if (creating) return;
        creating = true;
        const sent = await tgApi('sendMessage', {
          chat_id: config.chat_id, text, parse_mode: 'HTML', disable_notification: true,
          reply_parameters: replyTo != null ? { message_id: replyTo, allow_sending_without_reply: true } : undefined,
        });
        messageId = sent.message_id;
        creating = false;
        setRunningStatus(replyTo, messageId);
        if (stopped) tgApi('deleteMessage', { chat_id: config.chat_id, message_id: messageId }).catch(() => {});
      } else {
        await tgApi('editMessageText', { chat_id: config.chat_id, message_id: messageId, text, parse_mode: 'HTML', disable_web_page_preview: true }, { lowPriority: true });
      }
      lastSent = text;
    } catch (e) {
      creating = false;
      if (/message to edit not found|MESSAGE_ID_INVALID/i.test(e.message)) { messageId = null; lastSent = ''; }
      else if (!/not modified/i.test(e.message)) log(`status: ${e.message}`);
    }
  };
  const schedule = (delayMs) => { if (!editTimer && !stopped) editTimer = setTimeout(flush, delayMs); };
  const minute = setInterval(() => schedule(0), 60000);
  // The first appearance, for modes that wait (quiet, normal).
  const firstShow = Number.isFinite(mode.showAfterMs) && mode.showAfterMs > 0 ? setTimeout(() => schedule(0), mode.showAfterMs) : null;
  return {
    // A stream-json event from claudeRaw's onEvent.
    step(ev) {
      if (!ev || ev.type !== 'assistant' || !ev.message || !Array.isArray(ev.message.content)) return;
      let added = false;
      for (const c of ev.message.content) {
        if (!c || c.type !== 'tool_use') continue;
        const line = toolLine(String(c.name || ''), c.input);
        if (!line) continue;
        if (count === 0 && workingReaction) tgReact(replyTo, workingReaction);
        count++; added = true;
        steps.push(line);
        if (steps.length > 3) steps.shift();
      }
      if (added) schedule(messageId == null ? 0 : 3000);
    },
    stop() {
      stopped = true;
      clearInterval(minute);
      if (firstShow) clearTimeout(firstShow);
      if (editTimer) clearTimeout(editTimer);
      if (messageId != null) tgApi('deleteMessage', { chat_id: config.chat_id, message_id: messageId }).catch(e => log(`status delete: ${e.message}`));
    },
  };
}

// ---------- Incoming media ----------
// Photos and files are saved under inbox/<day>/ (gitignored) and handed to
// Claude as a path to open with Read. Voice notes are transcribed locally
// with faster-whisper (mcp/stt-faster-whisper.py) when it is installed.
const INBOX_DIR = path.join(WORKDIR, 'inbox');
const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024; // the Bot API's getFile limit
const VOICE = TELEGRAM_RUNTIME.voice || {};
const PYTHON = VOICE.python || (process.platform === 'win32' ? 'python' : 'python3');

function mediaOf(m) {
  const id = m.message_id;
  if (Array.isArray(m.photo) && m.photo.length) {
    const p = m.photo[m.photo.length - 1]; // largest size
    return { kind: 'photo', file_id: p.file_id, size: p.file_size, name: `${id}.jpg` };
  }
  if (m.voice) return { kind: 'voice', file_id: m.voice.file_id, size: m.voice.file_size, name: `${id}.ogg` };
  if (m.audio) return { kind: 'audio', file_id: m.audio.file_id, size: m.audio.file_size, name: m.audio.file_name || `${id}.mp3` };
  if (m.video_note) return { kind: 'video', file_id: m.video_note.file_id, size: m.video_note.file_size, name: `${id}.mp4` };
  if (m.video) return { kind: 'video', file_id: m.video.file_id, size: m.video.file_size, name: m.video.file_name || `${id}.mp4` };
  if (m.document) return { kind: 'document', file_id: m.document.file_id, size: m.document.file_size, name: m.document.file_name || `${id}.bin` };
  return null;
}

function formatBytes(n) {
  return n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
}

function httpsDownload(urlPath, dest) {
  return new Promise((resolve, reject) => {
    const req = https.get({ hostname: 'api.telegram.org', port: 443, path: urlPath }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`download HTTP ${res.statusCode}`)); }
      const out = fs.createWriteStream(dest);
      res.pipe(out);
      out.on('finish', () => out.close(() => resolve(dest)));
      out.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(120000, () => req.destroy(new Error('download timeout')));
  });
}

async function downloadMedia(media, msgId) {
  if (media.size && media.size > MAX_DOWNLOAD_BYTES) {
    throw new Error(`the file is ${formatBytes(media.size)}; Telegram bots can only download up to 20 MB`);
  }
  const file = await tgApi('getFile', { file_id: media.file_id });
  const dir = path.join(INBOX_DIR, localDayKey());
  fs.mkdirSync(dir, { recursive: true });
  const name = String(media.name).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 120);
  const dest = path.join(dir, name.startsWith(String(msgId).split('-')[0]) ? `${msgId}${path.extname(name)}` : `${msgId}-${name}`);
  return httpsDownload(`/file/bot${config.bot_token}/${file.file_path}`, dest);
}

// Only a positive answer is cached, so installing faster-whisper needs no restart.
let sttReady = false;
function sttAvailable() {
  if (!sttReady) {
    try { execFileSync(PYTHON, ['-c', 'import faster_whisper'], { stdio: 'ignore', timeout: 60000 }); sttReady = true; }
    catch (_) { sttReady = false; }
  }
  return sttReady;
}

function transcribe(file) {
  return new Promise((resolve, reject) => {
    const script = path.join(__dirname, 'stt-faster-whisper.py');
    const proc = spawn(PYTHON, [script, file, String(VOICE.model || 'small'), String(VOICE.language || '')], {
      stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, STT_HOTWORDS: sttHints() },
    });
    let out = '', err = '';
    proc.stdout.on('data', d => out += d.toString());
    proc.stderr.on('data', d => err += d.toString());
    const timer = setTimeout(() => killTree(proc), 5 * 60 * 1000);
    proc.on('error', (e) => { clearTimeout(timer); reject(e); });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0 && out.trim()) resolve(out.trim());
      else reject(new Error(err.trim().split('\n').slice(-2).join(' ') || `transcriber exit ${code}`));
    });
  });
}

// ---------- Voice: understand, propose, then wait for your OK ----------
// Speech-to-text gets roughly 3 words in 4 right, so a voice note never runs
// as heard. Claude first reads it in read-only plan mode, corrects what was
// probably misheard from context, and proposes a plan; the bot shows
// Heard / You mean / Plan with ▶️ Do it · ✏️ Correct · ❌ Cancel. A typed
// reply works too: yes / no, or a correction, which gets a new plan.
// Turn off with telegram.voice.confirm: false.
const VOICE_CONFIRM = VOICE.confirm !== false;
const VOICE_CONFIRM_TIMEOUT_MS = 10 * 60 * 1000;
const VOICE_MAX_ROUNDS = 4;
const CONFIRM_YES = /^\s*(y|yes|ok|run|do it|go|go ahead|כן|👍|✅|▶️)\s*[.!]?\s*$/i;
const CONFIRM_NO = /^\s*(n|no|cancel|stop|לא|👎|❌)\s*[.!]?\s*$/i;
let pendingVoice = null; // { nonce, messageId, card, resolve, timer }

// Words Whisper should expect: your MCP server names and the product names in
// your skills' descriptions (camel-case and short all-caps words such as
// OpenShift, NetApp, ONTAP, KVM). Built fresh for each note; nothing hard-coded.
const HINT_STOPWORDS = /^(TRIGGER|MCP|API|CLI|HTML|JSON|REST|AI|UI|UX|PDF|CSV|URL|AND|THE|FOR|USE|NOT)$/;
function sttHints() {
  const terms = new Set(mcpNames());
  for (const { description } of installedSkills()) {
    for (const word of String(description).match(/\b(?:[A-Z][a-z]+[A-Z][A-Za-z]*|[a-z]+[A-Z][A-Za-z]*|[A-Z]{2,6})\b/g) || []) {
      if (!HINT_STOPWORDS.test(word)) terms.add(word);
    }
  }
  return [...terms].join(' ').slice(0, 600);
}

function voiceCard({ transcript, meaning, plan }, footer) {
  // The transcriber prefixes the detected language ("[en] …", "[en+he] …"); not needed on the card.
  return `🎙 <b>Heard:</b> <i>${htmlEscape(transcript.replace(/^\[[a-z+]+\]\s*/i, ''))}</i>\n`
    + `🧠 <b>You mean:</b> ${htmlEscape(meaning)}\n`
    + `📋 <b>Plan:</b>\n<blockquote>${htmlEscape(plan)}</blockquote>\n${footer}`;
}

// Claude reads the note in plan mode (it can look things up, never change
// anything) and answers MEANING / PLAN.
async function proposeVoicePlan(msgId, transcript, correction) {
  const prompt = '[Voice note from the user, transcribed by speech-to-text that gets roughly 3 words in 4 right. '
    + 'Read between the lines: fix words that were probably misheard, using this conversation and the user\'s tools '
    + '(skills, MCP servers) as context. This run is read-only: look things up if that helps, but change nothing. '
    + 'Reply in exactly this shape and nothing else:\nMEANING: <one sentence: what the user most likely wants>\n'
    + 'PLAN:\n1. <short step>\n2. <short step>\n(1 to 5 steps)]\n\n'
    + `Transcript: "${transcript}"`
    + (correction ? `\n\nThe user corrected your previous reading: "${correction}". Use that.` : '');
  const status = startStatus(msgId, { title: 'Understanding your voice note (read-only)' });
  let outcome;
  try {
    outcome = await runClaude(prompt, { permissionMode: 'plan', replyTo: msgId, source: 'voice', onEvent: (ev) => status.step(ev) });
  } finally {
    status.stop();
  }
  const { ok, text: result, actualId } = outcome;
  if (!ok && result === '__STOPPED__') return null;
  let answer = stripAnsi(result || '').trim();
  if (TG_SENT_SENTINEL.test(answer)) answer = recoverReplyFromTranscript(actualId) || '';
  if (!ok || !answer) return { transcript, meaning: correction || transcript, plan: '(Could not prepare a plan. ▶️ runs the request as heard.)' };
  const meaning = ((answer.match(/MEANING:\s*(.+)/i) || [])[1] || answer.split('\n')[0]).trim();
  const plan = (answer.split(/PLAN:\s*/i)[1] || '').trim() || '(no steps given)';
  return { transcript, meaning, plan };
}

function confirmVoice(replyTo, card) {
  return new Promise(async (resolve) => {
    const nonce = crypto.randomBytes(4).toString('hex');
    let sent;
    try {
      sent = await tgApi('sendMessage', {
        chat_id: config.chat_id, parse_mode: 'HTML',
        text: voiceCard(card, '<i>Nothing runs until you say so. You can also type yes / no, or a correction.</i>'),
        reply_parameters: { message_id: replyTo, allow_sending_without_reply: true },
        reply_markup: { inline_keyboard: [[
          { text: '▶️ Do it', callback_data: `vc:run:${nonce}`, style: 'success' },
          { text: '✏️ Correct', callback_data: `vc:edit:${nonce}`, style: 'primary' },
          { text: '❌ Cancel', callback_data: `vc:cancel:${nonce}`, style: 'danger' },
        ]] },
      });
    } catch (e) {
      log(`voice confirm: ${e.message}`);
      return resolve({ action: 'cancel', how: 'the confirmation could not be sent' });
    }
    const timer = setTimeout(() => settleVoice({ action: 'cancel', how: 'no answer within 10 min' }), VOICE_CONFIRM_TIMEOUT_MS);
    pendingVoice = { nonce, messageId: sent.message_id, card, resolve, timer };
  });
}

// Ends the pending confirmation: updates its message and releases the task.
function settleVoice(decision) {
  const pending = pendingVoice;
  if (!pending) return false;
  pendingVoice = null;
  clearTimeout(pending.timer);
  const footer = decision.action === 'run' ? '▶️ <b>Doing it.</b>'
    : decision.action === 'edit' ? `✏️ <b>Your correction:</b> ${htmlEscape(decision.text)}\n<i>Re-planning…</i>`
    : `❌ <b>Cancelled</b>: nothing was run${decision.how ? ` (${htmlEscape(decision.how)})` : ''}.`;
  tgApi('editMessageText', {
    chat_id: config.chat_id, message_id: pending.messageId, parse_mode: 'HTML', text: voiceCard(pending.card, footer),
  }, { lowPriority: true }).catch(e => log(`voice confirm edit: ${e.message}`));
  pending.resolve(decision);
  return true;
}

// A button tap on the pending card. Returns false when it was not ours.
function voiceButton(cq) {
  const [tag, action, nonce] = String(cq.data || '').split(':');
  if (tag !== 'vc' || !pendingVoice || nonce !== pendingVoice.nonce) return false;
  if (action === 'edit') {
    // Stays pending: the next typed message is the correction.
    tgApi('answerCallbackQuery', { callback_query_id: cq.id, text: '✏️ Type what you meant and send it.' }).catch(() => {});
    return true;
  }
  tgApi('answerCallbackQuery', { callback_query_id: cq.id }).catch(() => {});
  settleVoice({ action: action === 'run' ? 'run' : 'cancel' });
  return true;
}

// A typed reply while a card waits: yes / no, or a correction.
function voiceTyped(text) {
  if (!pendingVoice) return false;
  if (CONFIRM_YES.test(text)) return settleVoice({ action: 'run' });
  if (CONFIRM_NO.test(text)) return settleVoice({ action: 'cancel', how: 'you said no' });
  return settleVoice({ action: 'edit', text });
}

// The whole voice round: plan, show, and loop on corrections. Returns the
// task to run, or null when cancelled.
async function interpretVoice(msgId, transcript) {
  let correction = '';
  for (let round = 0; round < VOICE_MAX_ROUNDS; round++) {
    tgReact(msgId, '🤔');
    const card = await proposeVoicePlan(msgId, transcript, correction);
    if (!card) return null; // /stop during planning
    const decision = await confirmVoice(msgId, card);
    if (decision.action === 'cancel') return null;
    if (decision.action === 'run') {
      return '[Voice request. You proposed this reading and plan in read-only mode and the user approved it.]\n'
        + `What they want: ${card.meaning}\nAgreed plan:\n${card.plan}\n`
        + `(Raw transcript, about 3 words in 4 right: "${transcript}")\nCarry out the agreed plan now.`;
    }
    correction = decision.text;
  }
  await sendChunked('✏️ Too many corrections for one voice note. Please type the request instead.', { mode: 'plain', replyTo: msgId });
  return null;
}

// Turns a media queue item into the task text for Claude, or { error } to
// reply instead. item.media is a list: one attachment, or a whole album.
async function buildMediaTask(item) {
  const list = Array.isArray(item.media) ? item.media : [item.media];
  const caption = item.text || '';
  const media = list[0];
  const isSpeech = list.length === 1 && (media.kind === 'voice' || (media.kind === 'audio' && !caption));
  if (isSpeech && !sttAvailable()) {
    return { error: '🎙 Voice notes need a speech-to-text engine (faster-whisper), which is not installed yet. Type the message instead, or ask me to install voice support.' };
  }
  if (isSpeech) {
    const file = await downloadMedia(media, item.msgId);
    tgApi('sendChatAction', { chat_id: config.chat_id, action: 'typing' }, { lowPriority: true }).catch(() => {});
    const transcript = await transcribe(file);
    if (!VOICE_CONFIRM) await sendChunked(`🎙 <i>${htmlEscape(transcript)}</i>`, { mode: 'html', replyTo: item.msgId });
    return { transcript, confirm: VOICE_CONFIRM, taskText: `${caption ? `${caption}\n\n` : ''}[Voice message from the user, transcribed locally]: ${transcript}` };
  }
  const names = { photo: 'a photo', document: 'a file', video: 'a video', audio: 'an audio file', voice: 'a voice note' };
  const lines = [];
  for (const [i, entry] of list.entries()) {
    const file = await downloadMedia(entry, list.length > 1 ? `${item.msgId}-${i + 1}` : item.msgId);
    lines.push(`- ${names[entry.kind] || 'a file'} saved at ${file} (${formatBytes(fs.statSync(file).size)})`);
  }
  const what = list.length > 1 ? `${list.length} attachments (an album)` : (names[media.kind] || 'a file');
  const ask = caption || `The user sent ${what} without a message. Look at ${list.length > 1 ? 'them' : 'it'} and respond to what ${list.length > 1 ? 'they show' : 'it shows'}.`;
  const how = list.every(e => e.kind === 'photo') ? 'Open them with the Read tool to see the images.' : 'Open them with the Read tool (or a suitable command for the type).';
  return { taskText: `${ask}\n\n[Telegram attachment${list.length > 1 ? 's' : ''}:\n${lines.join('\n')}\n${how}]` };
}


// Sentinel the agent prints to stdout when it has already delivered the answer via tg_send.
// Daemon then suppresses the stdout relay entirely. See feedback_no_double_send_via_daemon.md.
const TG_SENT_SENTINEL = /\[sent-via-tg\]/i;

function turnsToText(turns) {
  return turns.map(t => `User: ${t.user}\nAssistant: ${t.assistant}`).join('\n\n');
}

// At the first message of a new day, fold the day that just ended into a single
// daily summary so past chats stay recallable without keeping everything verbatim.
async function rolloverIfNewDay() {
  const today = localDayKey();
  if (state.day && state.day !== today) {
    const prev = state.day;
    const turns = readDayTurns(prev);
    if (turns.length) {
      const summary = await summarize(`conversation from ${prev}`, turnsToText(turns));
      if (summary) {
        const all = loadDailySummaries();
        all[prev] = summary;
        saveDailySummaries(all);
        log(`daily rollover: summarized ${prev} (${turns.length} turns)`);
      }
    }
  }
  if (state.day !== today) { state.day = today; saveState(); }
}

// "recall" (=1 day) or "recall N" → number of past days to pull back. Any N.
function parseRecall(text) {
  const m = text.trim().match(/^recall(?:\s+(\d+))?$/i);
  if (!m) return null;
  const n = m[1] ? parseInt(m[1], 10) : 1;
  return Math.min(Math.max(n, 1), RECALL_DAYS_MAX);
}

// Context block of the last N days' daily summaries (most recent days, oldest-first).
function buildRecallContext(days) {
  const all = loadDailySummaries();
  const dates = Object.keys(all).sort().slice(-days);
  if (!dates.length) return null;
  const block = dates.map(d => `### ${d}\n${all[d]}`).join('\n\n');
  return `[Memory recall — summaries of our conversations over the last ${days} day(s)]\n\n${block}`;
}

// Context block used to restore continuity after a silent fork / reboot:
// yesterday's summary + a summary of earlier-today + the last RECENT_TURNS verbatim.
async function buildRestoreContext() {
  const parts = [];
  // /clear creates a hard context boundary without deleting the audit archive.
  const cutoff = state.contextResetAt ? Date.parse(state.contextResetAt) : null;
  const all = cutoff ? {} : loadDailySummaries();
  const pastDates = Object.keys(all).sort().slice(-SUMMARY_DAYS);
  for (const day of pastDates) {
    parts.push(`[Summary of our previous conversation day (${day})]\n${all[day]}`);
  }
  const turns = readDayTurns(state.day).filter(turn => !cutoff || Date.parse(turn.ts || 0) > cutoff);
  if (turns.length > RECENT_TURNS) {
    const sum = await summarize("earlier part of today's conversation", turnsToText(turns.slice(0, turns.length - RECENT_TURNS)));
    if (sum) parts.push(`[Summary of earlier today]\n${sum}`);
  }
  const recent = turns.slice(-RECENT_TURNS);
  if (recent.length) parts.push(`[Most recent ${recent.length} turn(s), verbatim]\n${turnsToText(recent)}`);
  if (!parts.length) return null;
  return `[Context restore — the previous session could not be resumed; here is our conversation so far so you can continue seamlessly]\n\n${parts.join('\n\n')}`;
}

const SKILLS_DIR = path.join(process.env.USERPROFILE || process.env.HOME, '.claude', 'skills');

function installedSkillNames() {
  try { return fs.readdirSync(SKILLS_DIR).filter(name => fs.existsSync(path.join(SKILLS_DIR, name, 'SKILL.md'))).sort(); }
  catch (_) { return []; }
}

// ---------- MCP servers in the "/" menu ----------
// Names come straight from the MCP configs that task sessions load (Claude
// Code's own registrations plus the daemon's connectors), so menu names are
// stable from the first second; tools come from asking each server
// (mcp-discovery.js) at startup and on /mcp.
let mcpCatalog = { servers: [], at: null };

function mcpNames() {
  return Object.keys(collectMcpServers(WORKDIR, EMPTY_MCP));
}

async function refreshMcpCatalog() {
  const t0 = Date.now();
  mcpCatalog = await discoverMcpServers(EMPTY_MCP, WORKDIR);
  const summary = mcpCatalog.servers.map(s => `${s.name}=${s.error ? 'error' : s.tools.length}`).join(' ');
  log(`MCP discovery (${((Date.now() - t0) / 1000).toFixed(1)}s): ${summary || mcpCatalog.error || 'none'}`);
}

// The reply to a bare MCP tap: the server's own tool list, straight from discovery.
function formatMcpServer(name, command) {
  const server = mcpCatalog.servers.find(s => s.name === name);
  const usage = `\n\nAdd a request to use it: <code>/${htmlEscape(command)} &lt;what you need&gt;</code>`;
  if (!server) return `🔌 <b>${htmlEscape(name)}</b>: tools not discovered yet. Try again in a few seconds, or send /mcp.${usage}`;
  if (server.error) return `🔌 <b>${htmlEscape(name)}</b> is not answering: <code>${htmlEscape(server.error)}</code>\nSend /mcp to check again.${usage}`;
  if (server.remote) return `🔌 <b>${htmlEscape(name)}</b> is a remote MCP server; its tools are discovered when Claude uses it.${usage}`;
  const tools = server.tools.map(t => `• <code>${htmlEscape(t.name)}</code>${t.description ? ` — ${htmlEscape(t.description)}` : ''}`).join('\n');
  return `🔌 <b>${htmlEscape(name)}</b> — ${server.tools.length} tools\n<blockquote expandable>${tools}</blockquote>${usage}`;
}

// [{ name, description }] for the "/" menu, the description taken from SKILL.md.
function installedSkills() {
  return installedSkillNames().map((name) => {
    let markdown = '';
    try { markdown = fs.readFileSync(path.join(SKILLS_DIR, name, 'SKILL.md'), 'utf-8'); } catch (_) {}
    return { name, description: skillMenuDescription(markdown, name) };
  });
}

function daemonBuild() {
  try { return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: WORKDIR, encoding: 'utf8', timeout: 2000 }).trim(); }
  catch (_) { return 'unknown'; }
}

function formatUptime(seconds) {
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h ? `${h}h ${m}m` : m ? `${m}m ${s}s` : `${s}s`;
}

function configuredModels() {
  const names = Object.keys(RUNTIME.models || {}).sort();
  return names.length ? names : [String(CLAUDE_RUNTIME.model)];
}

function persistModelSelection(requested) {
  const model = configuredModels().find(name => name.toLowerCase() === requested.toLowerCase());
  if (!model) return null;
  const runtime = JSON.parse(fs.readFileSync(RUNTIME_CONFIG_FILE, 'utf8'));
  runtime.agents = { ...(runtime.agents || {}) };
  runtime.agents.claude = { ...(runtime.agents.claude || {}), model };
  const temporary = `${RUNTIME_CONFIG_FILE}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(runtime, null, 2) + '\n');
  fs.renameSync(temporary, RUNTIME_CONFIG_FILE);
  CLAUDE_RUNTIME.model = model;
  closeWarm('model changed');
  RUNTIME.agents.claude.model = model;
  state.sessionId = null;
  state.lastActivity = null;
  saveState();
  return model;
}

function mcpReadiness() {
  try {
    const registry = JSON.parse(fs.readFileSync(path.join(WORKDIR, 'mcp-connectors.json'), 'utf8'));
    const enabled = Object.entries(registry.servers || {}).filter(([, server]) => server && server.enabled);
    let generated = {};
    try { generated = JSON.parse(fs.readFileSync(EMPTY_MCP, 'utf8')).mcpServers || {}; }
    catch (_) { /* reported per connector below */ }
    const details = enabled.map(([name, server]) => {
      const ready = Object.prototype.hasOwnProperty.call(generated, name);
      return `<code>${htmlEscape(name)}</code> — ${ready ? 'configured, on-demand' : 'ERROR: not generated'} (${htmlEscape(server.transport || 'unknown')})`;
    });
    return { summary: enabled.length ? `${details.filter(line => !line.includes('ERROR')).length}/${enabled.length} configured` : 'none enabled', details };
  } catch (error) {
    return { summary: 'registry error', details: [`Registry error: ${htmlEscape(error.message)}`] };
  }
}

async function telegramCommand(rawText) {
  const mcp = () => mcpReadiness();
  return routeTelegramCommand(rawText, {
    skillNames: installedSkillNames(),
    mcpNames: mcpNames(),
    handlers: {
      help: () => '<b>📋 Claude Bot Commands</b>\n\n'
        + '<b>Control</b> <i>(answered at once, even mid-task)</i>\n/status — daemon and runtime\n/stop — stop the running task · <code>/stop all</code> also the queue and side tasks · <code>/stop bg</code> side tasks only\n/queue — running task, side tasks and waiting messages\n/usage — cost, turns and time: last task and today\n/progress — how much live progress you see (off · quiet · normal · full)\n/bg &lt;task&gt; — side task in its own session, in parallel\n\n'
        + '<b>Conversation</b> <i>(run in turn)</i>\n/plan &lt;task&gt; — read-only run: looks and proposes, changes nothing\n/retry — run your last message again\n/compact — shrink this conversation with Claude\'s own summary\n/refresh — fresh conversation that keeps a summary of this one\n/new or /clear — fresh session and conversation context\n/model [name] — current model or switch allowed model\n\n'
        + '<b>Info</b>\n/mcp — configured MCP connectors\n/skills — installed skills\n/help — this list\n\n'
        + '📸 Photos and files are passed to Claude to read. 🎙 Voice notes are transcribed when speech-to-text is installed.\n'
        + '🛡 Risky actions (sending mail, cluster writes, deletes, pushes) wait for your ✅ / ❌.\n'
        + 'Reactions: ✍ queued · 👀 working · 🎉 done · 💔 failed. Only installed skills are forwarded as tasks; unknown slash commands are rejected locally.',
      queue: () => formatQueue(),
      progress: (argument) => progressCommand(argument).text,
      usage: () => formatUsage(),
      status: () => {
        const readiness = mcp();
        return `<b>📊 Claude Bot Status</b>\n\n<b>Session</b>\nSession: <code>${htmlEscape(state.sessionId || 'Fresh')}</code>\n\n<b>Runtime</b>\nModel: <code>${htmlEscape(CLAUDE_RUNTIME.model)}</code>\nFallback: <code>${htmlEscape(CLAUDE_RUNTIME.fallback_model || 'none')}</code>\nMCP: <code>${readiness.summary}</code>\n\n<b>Features</b>\nProgress display: <code>${progressMode()}</code> (/progress)\nApproval gate: <code>${(RUNTIME.approval || {}).enabled === false ? 'OFF' : 'on'}</code>\nVoice: <code>${sttAvailable() ? `ready (${htmlEscape(String(VOICE.model || 'small'))})` : 'not installed'}</code>\n\n<b>Daemon</b>\nStatus: <code>Online</code>\nTask: <code>${busy ? 'running' : 'idle'}</code> · Queued: <code>${state.queue.length}</code> · Side tasks: <code>${bgTasks.size}</code>\nPID: <code>${process.pid}</code>\nUptime: <code>${formatUptime((Date.now() - DAEMON_STARTED_AT.getTime()) / 1000)}</code> (since ${tgTime(DAEMON_STARTED_AT.getTime(), 'wDT', DAEMON_STARTED_AT.toISOString())})\nBuild: <code>${daemonBuild()}</code>`;
      },
      model: (argument) => {
        if (!argument) return `<b>Configured model</b>: <code>${htmlEscape(CLAUDE_RUNTIME.model)}</code>\n<b>Allowed models</b>\n<code>${configuredModels().map(htmlEscape).join('\n')}</code>\n\nUse <code>/model &lt;name&gt;</code> to switch. This starts the next task with a fresh Claude session.`;
        const selected = persistModelSelection(argument);
        return selected
          ? `Claude daemon model changed to <code>${htmlEscape(selected)}</code>. The next task starts with a fresh session.`
          : `Model <code>${htmlEscape(argument)}</code> is not in the local allow-list. Use <code>/model</code>.`;
      },
      mcp: async () => {
        await refreshMcpCatalog();
        const commands = await registerTelegramCommandMenu();
        const named = mcpCommandNames(mcpNames());
        const lines = mcpCatalog.servers.map((server) => {
          const command = (named.find(entry => entry.name === server.name) || {}).command || server.name;
          const status = server.error ? `⚠️ ${htmlEscape(server.error)}` : server.remote ? 'remote' : `${server.tools.length} tools`;
          return `🔌 <code>/${htmlEscape(command)}</code> — ${status}`;
        });
        return `<b>MCP servers</b> (discovered from the servers themselves)\n${lines.join('\n') || 'None configured.'}\n\n`
          + 'Tap one alone to see its tools, or add a request: <code>/storage list volumes over 90%</code>.'
          + (commands ? `\n🔄 "/" menu refreshed (${commands.length} commands).` : '\n⚠️ Could not refresh the "/" menu; see the daemon log.');
      },
      skills: async () => {
        const names = installedSkillNames();
        const commands = await registerTelegramCommandMenu();
        let menu = commands ? `\n\n🔄 "/" menu refreshed (${commands.length} commands).` : '\n\n⚠️ Could not refresh the "/" menu; see the daemon log.';
        if (commands && commands.left.length) menu += `\n⚠️ Over Telegram's 100-command limit, so not in the menu (still usable by typing the command): ${commands.left.map(htmlEscape).join(', ')}`;
        // Point out the real name only where it is not just dashes → underscores.
        const lines = skillCommandNames(names, mcpNames()).map(({ name, command }) => htmlEscape(
          command === name.toLowerCase().replace(/-/g, '_') ? `/${command}` : `/${command}  ← ${name}`));
        return names.length
          ? `<b>Installed skills (${names.length})</b>\n<code>${lines.join('\n')}</code>\n\nTap one alone to hear what it does, or add details to run it: <code>/skill_name your request</code>.${menu}`
          : `No installed skills found.${menu}`;
      },
      stop: (argument) => stopCommand(argument),
      compact: () => compactConversation(),
      refresh: () => {
        if (!state.sessionId) return 'Already fresh: the next message starts a new conversation.';
        const ctx = sessionContextTokens(state.sessionId);
        startFreshConversation('/refresh');
        return `♻️ <b>Refreshed</b>${ctx != null ? ` (the conversation was ${Math.round(ctx / 1000)}k tokens)` : ''}. Your next message starts a fresh conversation; the last ${RECENT_TURNS} turns and a summary of earlier ones carry over.`;
      },
      clear: () => {
        closeWarm('/new');
        state.sessionId = null;
        state.lastActivity = null;
        state.contextResetAt = new Date().toISOString();
        saveState();
        return 'Claude session and injected context cleared. Archive files are retained, but pre-clear turns and summaries will not be injected into future tasks.';
      },
    },
  });
}

// The "/" menu: daemon commands plus every installed skill. Returns the size,
// or null when Telegram rejected it.
async function registerTelegramCommandMenu() {
  const servers = mcpNames().map((name) => {
    const found = mcpCatalog.servers.find(server => server.name === name);
    return { name, description: found ? mcpMenuDescription(found) : `🔌 ${name} MCP server` };
  });
  const commands = buildCommandMenu(installedSkills(), servers);
  try {
    await tgApi('setMyCommands', { commands: commands.map(({ command, description }) => ({ command, description })) });
    log(`registered Telegram command menu (${commands.length} commands${commands.left.length ? `; over Telegram's 100 limit: ${commands.left.join(', ')}` : ''})`);
    return commands;
  } catch (error) {
    log(`setMyCommands failed: ${error.message}`);
    return null;
  }
}

function skillMenuName(skill) {
  const entry = skillCommandNames(installedSkillNames(), mcpNames()).find(item => item.name === skill);
  return entry ? entry.command : telegramCommandName(skill);
}

// A skill picked from the menu. With details it runs as a normal skill
// invocation; a bare tap only explains, because some skills act as soon as
// they run (e.g. logging off every server).
function skillTask(skill, argument) {
  if (argument) return `/${skill} ${argument}`;
  return `The user picked the "${skill}" skill from the Telegram command menu without any details. `
    + 'Do not run anything yet. In two or three short lines, say what this skill can do for them and what you need to know, '
    + `then suggest one or two example requests in the form "/${skillMenuName(skill)} <request>".`;
}

function shorten(text, max = 60) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

const PLAN_NOTE = '[Plan mode: this run is read-only. You cannot change anything, and tg_send is unavailable. '
  + 'Investigate as needed, then give your findings and a concrete step-by-step plan as your final message; '
  + 'the daemon relays it. The user can reply "go ahead" to carry it out.]\n\n';

// A queue item is { text, msgId, media?, ts }. Commands are recognised from text.
async function handleMessage(item) {
  const msgId = item.msgId;
  let rawText = item.text || '';
  let permissionMode;
  const parsed = item.media ? null : parseTelegramCommand(rawText);
  if (parsed && parsed.command === 'retry') {
    // /retry re-runs the last task message as if it had just been sent.
    if (!state.lastTask) { await sendChunked('Nothing to retry yet.', { mode: 'plain', replyTo: msgId }); return; }
    rawText = state.lastTask;
    permissionMode = state.lastTaskMode || undefined;
    await sendChunked(`🔁 <b>Retrying${permissionMode ? ' (plan mode)' : ''}:</b> <i>${htmlEscape(shorten(rawText, 120))}</i>`, { mode: 'html', replyTo: msgId });
  } else if (parsed && parsed.command === 'plan') {
    if (!parsed.argument) {
      await sendChunked('Usage: <code>/plan &lt;task&gt;</code>: a read-only run that looks and proposes, and changes nothing.', { mode: 'html', replyTo: msgId });
      return;
    }
    rawText = parsed.argument;
    permissionMode = 'plan';
  } else if (!item.media) {
    const command = await telegramCommand(rawText);
    if (command.handled) { await sendChunked(command.reply, { mode: 'html', replyTo: msgId }); return; }
    if (command.skillCommand) rawText = skillTask(command.skillCommand, command.argument);
    if (command.mcpServer) rawText = `Use the "${command.mcpServer}" MCP server's tools (mcp__${command.mcpServer}__*) for this request, in preference to other tools: ${command.argument}`;
  }
  tgReact(msgId, permissionMode === 'plan' ? '🤔' : '👀');
  if (item.media) {
    let prepared;
    try { prepared = await buildMediaTask(item); }
    catch (e) {
      log(`media: ${e.message}`);
      await tgReact(msgId, '💔');
      await sendChunked(`Could not read the attachment: ${htmlEscape(e.message)}`, { mode: 'html', replyTo: msgId });
      return;
    }
    if (prepared.error) {
      await tgClearReaction(msgId);
      await sendChunked(prepared.error, { mode: 'html', replyTo: msgId });
      return;
    }
    rawText = prepared.taskText;
    if (prepared.confirm) {
      const voiceTask = await interpretVoice(msgId, prepared.transcript);
      if (!voiceTask) { await tgClearReaction(msgId); return; }
      rawText = voiceTask;
      tgReact(msgId, '👀');
    }
  }
  if (item.context) rawText = `${item.context}\n\n${rawText}`;
  state.lastTask = rawText;
  state.lastTaskMode = permissionMode || null;
  saveState();
  await rolloverIfNewDay();
  const stopTyping = startTyping();
  const status = startStatus(msgId, permissionMode === 'plan'
    ? { title: 'Planning (read-only)' }
    : { title: 'Working', workingReaction: '👨‍💻' });
  try {
    await runTask(rawText, msgId, Date.now(), { permissionMode, status });
  } finally {
    stopTyping();
    status.stop();
  }
}

async function runTask(rawText, msgId, t0, { permissionMode, status } = {}) {
  // Explicit deep recall: "recall", "recall 3/5/10".
  const recallDays = parseRecall(rawText);
  let taskText = rawText, contextPrefix;
  if (recallDays) {
    contextPrefix = buildRecallContext(recallDays);
    if (!contextPrefix) {
      await sendChunked('No archived daily summaries yet to recall.', { mode: 'rich', replyTo: msgId });
      return;
    }
    taskText = `Using the recalled summaries above, briefly tell me what you now remember from the last ${recallDays} day(s).`;
  }
  if (permissionMode === 'plan') taskText = PLAN_NOTE + taskText;
  const opts = { replyTo: msgId, permissionMode, onEvent: status ? (ev) => status.step(ev) : undefined };

  let result, ok, code, forked, actualId;
  // A daemon restart or expiry clears the pinned session. Restore archive context
  // before the fresh first turn instead of waiting for Claude to fail visibly.
  if (!contextPrefix && !state.sessionId) contextPrefix = await buildRestoreContext();
  ({ ok, text: result, code, forked, actualId } = await runClaude(taskText, { ...opts, contextPrefix }));

  // Loud resume failure → retry fresh, restoring context from the archive.
  if (!ok && result === '__SESSION_EXPIRED__') {
    log('session expired — retrying fresh with restored context');
    const ctx = await buildRestoreContext();
    ({ ok, text: result, code, forked, actualId } = await runClaude(taskText, { ...opts, contextPrefix: ctx || contextPrefix }));
  }

  // Silent fork (idle / reboot): the first reply was context-less. Restore our
  // history from the archive and re-run so the answer is informed.
  if (ok && forked) {
    const ctx = await buildRestoreContext();
    if (ctx) {
      log('fork detected — re-running with restored context');
      ({ ok, text: result, code, forked, actualId } = await runClaude(taskText, { ...opts, contextPrefix: ctx }));
      if (ok) await sendChunked('↻ The previous session had dropped — I restored our recent history from the archive and continued.', { mode: 'rich' });
    } else {
      await sendChunked('⚠️ **Heads up:** previous session could not be resumed and there is no archive yet to restore from. Continuing fresh.', { mode: 'rich' });
    }
  }
  const dt = ((Date.now() - t0) / 1000).toFixed(1);

  if (!ok && result === '__STOPPED__') {
    log(`task stopped by /stop after ${dt}s`);
    recordJob('stopped');
    await tgClearReaction(msgId);
    await sendChunked(`⏹ <b>Stopped</b> after ${dt}s.`, { mode: 'html', replyTo: msgId });
    return;
  }
  if (!ok) {
    recordJob('failed');
    await tgReact(msgId, '💔');
    await sendChunked(`**Failed** (exit=${code}, ${dt}s):\n${stripAnsi(result || '').trim() || '(no output)'}`, { mode: 'rich', replyTo: msgId });
    return;
  }

  recordJob('success');
  const trimmed = stripAnsi(result || '').trim();

  // Archive the turn with the REAL reply (recover from transcript when tg_send was used).
  let replyForArchive = trimmed;
  if (!replyForArchive || TG_SENT_SENTINEL.test(replyForArchive)) {
    replyForArchive = recoverReplyFromTranscript(actualId) || replyForArchive;
  }
  appendArchive({ day: state.day, ts: new Date().toISOString(), user: permissionMode === 'plan' ? `/plan ${rawText}` : rawText, assistant: replyForArchive, sessionId: state.sessionId, forked: !!forked });

  // Relay to the user. Every successful path ends with the 🎉 "done" reaction,
  // including the usual one where the agent already answered through tg_send.
  if (TG_SENT_SENTINEL.test(trimmed)) {
    log(`relay suppressed: agent used tg_send sentinel (${dt}s, stdout=${trimmed.length} chars)`);
  } else if (!trimmed) {
    log(`relay suppressed: empty stdout (${dt}s)`);
  } else {
    // Agent's stdout IS the answer — relay as rich HTML (Markdown -> Telegram HTML),
    // with the looksTabular() <pre> fallback inside sendChunked.
    const header = permissionMode === 'plan' ? '🧪 **Plan (read-only, nothing was changed).** Reply *go ahead* to carry it out.\n\n' : '';
    await sendChunked(header + trimmed, { mode: 'rich', replyTo: msgId, effect: Date.now() - t0 >= CONFETTI_AFTER_MS ? EFFECT_CONFETTI : undefined });
  }
  await tgReact(msgId, '🎉');
  maybeRotate();
}

// ---------- Restart recovery ----------
// state.running remembers every task in flight (main queue and /bg) with its
// status message. After a crash or restart those tasks are gone, so the
// leftovers are tidied up and the user is told, instead of a 👀 stuck forever.
function markRunning(msgId, info) {
  state.running = state.running || {};
  state.running[msgId] = { ...info, startedAt: Date.now() };
  saveState();
}
function setRunningStatus(msgId, statusMessageId) {
  if (state.running && state.running[msgId]) { state.running[msgId].statusMessageId = statusMessageId; saveState(); }
}
function clearRunning(msgId) {
  if (state.running && state.running[msgId]) { delete state.running[msgId]; saveState(); }
}
async function recoverInterrupted() {
  const entries = Object.entries(state.running || {});
  if (!entries.length) return;
  state.running = {};
  saveState();
  for (const [msgId, task] of entries) {
    const id = Number(msgId);
    log(`recovery: task ${id} (${task.kind}) was interrupted by a restart`);
    if (task.kind === 'main') recordJob('interrupted', task.startedAt);
    await tgClearReaction(id);
    if (task.statusMessageId) await tgApi('deleteMessage', { chat_id: config.chat_id, message_id: task.statusMessageId }).catch(() => {});
    const again = task.kind === 'bg'
      ? `Send <code>/bg ${htmlEscape(shorten(task.text, 80))}</code> to run it again.`
      : 'Send /retry to run it again.';
    await sendChunked(`⚠️ <b>Interrupted</b>: the bot restarted while this was running (started ${tgTime(task.startedAt, 'r', 'earlier')}). ${again}`, { mode: 'html', replyTo: id });
  }
}

// ---------- Task queue ----------
// Messages that arrive while a task runs wait here (persisted in state, so a
// daemon restart keeps them) and run in order. One task at a time: Telegram
// tasks share one Claude session, and the Hermes queue shares the same `busy`.
let busy = false;
let currentItem = null; // { text, msgId, startedAt }

function itemLabel(item) {
  const media = Array.isArray(item.media) ? item.media : item.media ? [item.media] : [];
  if (!media.length) return item.text;
  const icon = { photo: '📸', voice: '🎙', audio: '🎵', video: '🎬' }[media[0].kind] || '📎';
  return `${icon}${media.length > 1 ? ` ×${media.length}` : ''} ${item.text || media[0].name}`;
}

function enqueue(item) {
  state.queue.push({ ...item, ts: new Date().toISOString() });
  saveState();
  if (busy || state.queue.length > 1) {
    tgReact(item.msgId, '✍');
    tgApi('sendMessage', {
      chat_id: config.chat_id,
      text: `📥 Queued #${state.queue.length} — runs after the current task. /queue to see, /stop all to drop.`,
      disable_notification: true,
      reply_parameters: { message_id: item.msgId, allow_sending_without_reply: true },
    }).catch(e => log(`queue ack: ${e.message}`));
  }
  drainQueue();
}

async function drainQueue() {
  while (!busy && state.queue.length) {
    busy = true;
    const item = state.queue.shift();
    saveState();
    currentItem = { ...item, startedAt: Date.now() };
    markRunning(item.msgId, { kind: 'main', text: itemLabel(item) });
    try { await handleMessage(item); }
    catch (e) { log(`handle: ${e.stack || e.message}`); try { await sendChunked(`Daemon error: ${e.message}`, { mode: 'plain', replyTo: item.msgId }); } catch (_) {} }
    clearRunning(item.msgId);
    currentItem = null;
    busy = false;
  }
}

// ---------- Side tasks (/bg) ----------
// Isolated sessions that run in parallel with the main conversation. They get
// the archive context but never touch the pinned session or the queue.
const MAX_BG_TASKS = 2;

function startBgTask(argument, msgId) {
  if (!argument) return 'Usage: <code>/bg &lt;task&gt;</code>: runs in its own session, in parallel with the main chat.';
  if (bgTasks.size >= MAX_BG_TASKS) return `⚡ ${MAX_BG_TASKS} side tasks are already running. Wait for one, or <code>/stop bg</code>.`;
  const entry = { handle: null, stopped: false, text: argument, startedAt: Date.now() };
  bgTasks.set(msgId, entry);
  markRunning(msgId, { kind: 'bg', text: argument });
  runBgTask(entry, msgId)
    .catch(e => log(`bg: ${e.stack || e.message}`))
    .finally(() => { bgTasks.delete(msgId); clearRunning(msgId); });
  return '⚡ <b>Side task started</b> in its own session. The main chat stays free; <code>/stop bg</code> cancels it.';
}

async function runBgTask(entry, msgId) {
  tgReact(msgId, '⚡');
  const status = startStatus(msgId, { title: 'Side task' });
  const t0 = Date.now();
  try {
    const contextPrefix = await buildRestoreContext();
    if (entry.stopped) { await tgClearReaction(msgId); return; }
    const task = `[Side task from Telegram (/bg): it runs in its own session, in parallel with the main conversation.]\n\n${entry.text}`;
    const { ok, text: result, code, actualId } = await runClaude(task, {
      contextPrefix, isolated: true, replyTo: msgId, source: 'bg',
      onEvent: (ev) => status.step(ev),
      onSpawn: (handle) => { entry.handle = handle; if (entry.stopped) stopHandle(handle, '/stop bg'); },
    });
    const dt = ((Date.now() - t0) / 1000).toFixed(1);
    if (!ok && result === '__STOPPED__') {
      await tgClearReaction(msgId);
      await sendChunked(`⏹ <b>Side task stopped</b> after ${dt}s.`, { mode: 'html', replyTo: msgId });
      return;
    }
    if (!ok) {
      await tgReact(msgId, '💔');
      await sendChunked(`**Side task failed** (exit=${code}, ${dt}s):\n${stripAnsi(result || '').trim() || '(no output)'}`, { mode: 'rich', replyTo: msgId });
      return;
    }
    const trimmed = stripAnsi(result || '').trim();
    let replyForArchive = trimmed;
    if (!replyForArchive || TG_SENT_SENTINEL.test(replyForArchive)) replyForArchive = recoverReplyFromTranscript(actualId) || replyForArchive;
    appendArchive({ day: state.day || localDayKey(), ts: new Date().toISOString(), source: 'bg', user: `/bg ${entry.text}`, assistant: replyForArchive, sessionId: actualId });
    if (trimmed && !TG_SENT_SENTINEL.test(trimmed)) {
      await sendChunked(`⚡ **Side task done** (${dt}s)\n\n${trimmed}`, { mode: 'rich', replyTo: msgId, effect: Date.now() - t0 >= CONFETTI_AFTER_MS ? EFFECT_CONFETTI : undefined });
    }
    await tgReact(msgId, '🎉');
  } finally {
    status.stop();
  }
}

function formatQueue() {
  const lines = ['<b>📋 Queue</b>', ''];
  if (currentItem) {
    lines.push(`▶️ <b>Running</b> (started ${tgTime(currentItem.startedAt, 'r', `${formatUptime((Date.now() - currentItem.startedAt) / 1000)} ago`)}): <i>${htmlEscape(shorten(itemLabel(currentItem)))}</i>`);
  } else if (busy) {
    lines.push('▶️ <b>Running</b>: a Hermes queue task');
  } else {
    lines.push('💤 Idle — nothing running.');
  }
  for (const entry of bgTasks.values()) {
    lines.push(`⚡ <b>Side task</b> (${formatUptime((Date.now() - entry.startedAt) / 1000)}): <i>${htmlEscape(shorten(entry.text))}</i>`);
  }
  state.queue.forEach((item, i) => lines.push(`${i + 1}. <i>${htmlEscape(shorten(itemLabel(item)))}</i>`));
  if (!state.queue.length) lines.push('', 'Nothing waiting.');
  return lines.join('\n');
}

function stopCommand(argument) {
  const scope = String(argument || '').trim().toLowerCase();
  const parts = [];
  if (scope === 'bg' || scope === 'all') {
    let n = 0;
    for (const entry of bgTasks.values()) {
      if (entry.stopped) continue;
      entry.stopped = true; n++;
      if (entry.handle) stopHandle(entry.handle, '/stop bg');
    }
    parts.push(n ? `⏹ Stopping ${n} side task(s)…` : 'No side task is running.');
    if (scope === 'bg') return parts.join('\n');
  }
  if (settleVoice({ action: 'cancel', how: '/stop' })) parts.push('🎙 Cancelled the voice note waiting for your OK.');
  const dropAll = scope === 'all';
  const dropped = dropAll ? state.queue.splice(0) : [];
  if (dropped.length) {
    saveState();
    for (const item of dropped) tgClearReaction(item.msgId);
  }
  parts.unshift(stopActiveTask() ? '⏹ Stopping the running task…' : 'No main task is running.');
  if (dropAll) parts.push(dropped.length ? `🗑 Dropped ${dropped.length} queued message(s).` : 'The queue was already empty.');
  else if (state.queue.length) parts.push(`${state.queue.length} queued message(s) will still run. Use /stop all to drop them.`);
  return parts.join('\n');
}

// ---------- Inbound batching and reply context ----------
// Telegram splits a long paste into several messages and delivers a photo
// album as one message per photo. Both are gathered into one task: text that
// arrives within a short window (longer when a part looks cut at Telegram's
// size limit), and album items that share a media_group_id.
const PASTE_WINDOW_MS = 400;
const SPLIT_PASTE_WINDOW_MS = 2000; // the last part was near 4096 chars, so more is likely coming
const ALBUM_WINDOW_MS = 1200;
let pasteBuffer = null; // { item, timer }
const albumBuffers = new Map(); // media_group_id -> { item, timer }

function flushPaste() {
  if (!pasteBuffer) return;
  const { item, timer } = pasteBuffer;
  clearTimeout(timer);
  pasteBuffer = null;
  enqueue(item);
}

function bufferPaste(item) {
  if (pasteBuffer) {
    clearTimeout(pasteBuffer.timer);
    pasteBuffer.item.text += `\n${item.text}`;
    pasteBuffer.item.parts = (pasteBuffer.item.parts || 1) + 1;
  } else {
    pasteBuffer = { item: { ...item } };
  }
  const wait = item.text.length >= 3500 ? SPLIT_PASTE_WINDOW_MS : PASTE_WINDOW_MS;
  pasteBuffer.timer = setTimeout(flushPaste, wait);
}

function bufferAlbum(groupId, item) {
  const entry = albumBuffers.get(groupId);
  if (entry) {
    clearTimeout(entry.timer);
    entry.item.media.push(...item.media);
    if (!entry.item.text && item.text) entry.item.text = item.text;
  } else {
    albumBuffers.set(groupId, { item: { ...item, media: [...item.media] } });
  }
  const current = albumBuffers.get(groupId);
  current.timer = setTimeout(() => { albumBuffers.delete(groupId); enqueue(current.item); }, ALBUM_WINDOW_MS);
}

// When you reply to (or quote part of) an earlier message, that message is
// what "this" refers to, so it travels with the task.
function replyContext(m) {
  const replied = m.reply_to_message;
  if (!replied) return '';
  const quoted = m.quote && m.quote.text;
  const original = quoted || replied.text || replied.caption || '';
  if (!original.trim()) return '';
  const who = replied.from && replied.from.is_bot ? 'your earlier message' : 'their own earlier message';
  const clipped = original.length > 2000 ? `${original.slice(0, 2000)}…` : original;
  return `[The user is replying to ${who}${quoted ? ' (quoting this part of it)' : ''}:]\n"""\n${clipped}\n"""`;
}

// Old buttons: a tap that arrives when no question or approval is waiting
// for it (it timed out, or the bot restarted) is told so, and the buttons go.
async function handleStaleButton(cq) {
  tgApi('answerCallbackQuery', { callback_query_id: cq.id, text: '⌛ This button has expired.' }).catch(() => {});
  if (cq.message && String(cq.message.chat.id) === String(config.chat_id)) {
    tgApi('editMessageReplyMarkup', { chat_id: config.chat_id, message_id: cq.message.message_id, reply_markup: { inline_keyboard: [] } }, { lowPriority: true })
      .catch(e => log(`stale button: ${e.message}`));
  }
}

// Routes one incoming Telegram message. fromAsker: it came back through the
// daemon inbox from a waiting tg_ask / approval, so it is not their answer.
async function dispatchMessage(m, { fromAsker = false } = {}) {
  if (!m || !m.chat) return;
  if (String(m.chat.id) !== String(config.chat_id)) { log(`ignored msg from chat ${m.chat.id}`); return; }
  const ownMedia = mediaOf(m);
  const text = ownMedia ? (m.caption || '') : (m.text || '');
  if (!ownMedia && !text) return; // stickers, polls, service messages
  // "What's in this?" as a reply to an earlier photo or file: use that attachment.
  const repliedMedia = !ownMedia && m.reply_to_message ? mediaOf(m.reply_to_message) : null;
  const parsed = ownMedia ? null : parseTelegramCommand(text);
  if (!ownMedia && !parsed && voiceTyped(text)) return;
  if (parsed || ownMedia) flushPaste(); // keep arrival order
  if (!ownMedia) {
    // A bare MCP tap is answered at once from the discovered tool list; no Claude run.
    const mcpServer = parsed && !parsed.argument && (mcpCommandNames(mcpNames()).find(entry => entry.command === parsed.command) || {}).name;
    if (mcpServer) {
      await sendChunked(formatMcpServer(mcpServer, parsed.command), { mode: 'html', replyTo: m.message_id }).catch(e => log(`mcp reply: ${e.message}`));
      return;
    }
    if (parsed && parsed.command === 'bg') {
      await sendChunked(startBgTask(parsed.argument, m.message_id), { mode: 'html', replyTo: m.message_id }).catch(e => log(`bg reply: ${e.message}`));
      return;
    }
    if (parsed && parsed.command === 'progress') {
      const view = progressCommand(parsed.argument);
      await tgApi('sendMessage', {
        chat_id: config.chat_id, parse_mode: 'HTML', text: view.text, reply_markup: view.reply_markup,
        reply_parameters: { message_id: m.message_id, allow_sending_without_reply: true },
      }).catch(e => log(`progress reply: ${e.message}`));
      return;
    }
    if (isImmediateCommand(text)) {
      tgReact(m.message_id, '🫡');
      try { await sendChunked((await telegramCommand(text)).reply, { mode: 'html', replyTo: m.message_id }); }
      catch (e) { log(`command: ${e.stack || e.message}`); }
      return;
    }
    if (!fromAsker && handshake.askActive()) {
      try { handshake.handOffToAsk(m); log(`handed message ${m.message_id} to the waiting asker`); return; }
      catch (e) { log(`handoff: ${e.message}`); }
    }
  }
  const media = ownMedia || repliedMedia;
  const item = { text, msgId: m.message_id, media: media ? [media] : undefined, context: replyContext(m) || undefined };
  if (ownMedia && m.media_group_id) return bufferAlbum(m.media_group_id, item);
  if (!media && !parsed && !item.context) return bufferPaste(item);
  enqueue(item);
}

async function pollLoop() {
  log(`ready — workdir=${WORKDIR} chat_id=${config.chat_id} session_resumed=${state.sessionStarted}`);
  drainQueue(); // messages queued before a restart
  while (true) {
    for (const m of handshake.takeDaemonInbox()) await dispatchMessage(m, { fromAsker: true });
    // tg_ask / the approval hook own getUpdates while they wait; a second
    // consumer would steal their reply.
    if (handshake.askActive()) { await new Promise(r => setTimeout(r, 1000)); continue; }
    let updates;
    try {
      updates = await tgApi('getUpdates', {
        offset: state.updateOffset,
        // Short polls while work runs, so a starting tg_ask takes over quickly.
        timeout: busy || bgTasks.size ? 10 : 50,
        allowed_updates: ['message', 'callback_query'],
      }, { httpTimeoutMs: 75 * 1000 });
    } catch (e) {
      // 409 Conflict = tg_ask just started polling; the loop pauses on its flag.
      const conflict = /Conflict/i.test(e.message);
      if (!conflict) log(`getUpdates: ${e.message} — backoff 5s`);
      await new Promise(r => setTimeout(r, conflict ? 1000 : 5000));
      continue;
    }
    for (const u of updates) {
      state.updateOffset = u.update_id + 1;
      saveState();
      if (u.message) await dispatchMessage(u.message);
      else if (u.callback_query && !progressButton(u.callback_query) && !voiceButton(u.callback_query)) await handleStaleButton(u.callback_query);
    }
  }
}

// ---------- Online / Offline in the bot profile ----------
// The bot's short description (shown on its profile and in an empty chat)
// says whether the daemon is up. A hard kill or power loss cannot update it,
// so Online carries a "checked" time refreshed every 10 minutes: a stale time
// means the daemon is gone.
const PRESENCE_EVERY_MS = 10 * 60 * 1000;
function presenceClock() {
  return new Date().toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}
function setPresence(online) {
  const text = online
    ? `🟢 Online — Claude Code bridge · checked ${presenceClock()}`
    : `🔴 Offline since ${presenceClock()} — Claude Code bridge`;
  return tgApi('setMyShortDescription', { short_description: text }, { httpTimeoutMs: 5000 })
    .catch(e => log(`presence: ${e.message}`));
}

async function shutdown(signal) {
  log(`${signal}, exiting`);
  state.cleanStopAt = Date.now(); saveState();
  if (warm) killTree(warm.proc);
  await Promise.race([setPresence(false), new Promise(r => setTimeout(r, 3000))]);
  releaseLock();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('exit', releaseLock);

// ---------- Startup banner ----------
// One message per daemon start, so a restart is visible in the chat along with
// why the previous run ended. A hard kill never runs shutdown(), so the cause is
// found by elimination: the launcher leaves a marker before it kills, a clean
// exit records cleanStopAt, a reboot shows in the boot time, and anything else
// (crash, Task Manager, a parent app taking it down) was unexpected.
const RESTART_MARKER = path.join(WORKDIR, '.telegram-task-daemon.restart');
const HEARTBEAT_MS = 60 * 1000;
const LAUNCH_MODES = { auto: 'Auto (scheduled task)', manual: 'Manual (shortcut)', foreground: 'Foreground (terminal)' };

function heartbeat() { state.aliveAt = Date.now(); saveState(); }

function recordJob(status, at = Date.now()) {
  state.lastJob = { status, at };
  saveState();
}

// Must run before the first heartbeat overwrites aliveAt.
function previousStop() {
  let marker = 0;
  try { marker = Number(fs.readFileSync(RESTART_MARKER, 'utf-8').trim()) || 0; fs.unlinkSync(RESTART_MARKER); } catch (_) {}
  const { cleanStopAt: clean, aliveAt: alive } = state;
  state.cleanStopAt = null;
  if (clean) return `✅ Clean stop ${tgTime(clean, 'r', 'earlier')}`;
  if (!alive) return '🆕 First start';
  if (marker >= alive - HEARTBEAT_MS) return '🔁 Restarted by the launcher';
  const seen = tgTime(alive, 't', shortTime(alive));
  if (Date.now() - os.uptime() * 1000 > alive) return `💤 PC restarted (last seen ${seen})`;
  return `⚠️ Unexpected stop, last seen ${seen} (killed or crashed)`;
}

// Context size of a session = the prompt its last turn sent (fresh + cached
// input), read from the tail of Claude's transcript. A compaction after that
// turn wins: its boundary records the size the summary left behind.
function sessionContextTokens(sessionId) {
  try {
    const file = path.join(PROJECT_DIR, `${sessionId}.jsonl`);
    const size = fs.statSync(file).size;
    const fd = fs.openSync(file, 'r');
    const len = Math.min(size, 512 * 1024);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    fs.closeSync(fd);
    const lines = buf.toString('utf-8').split('\n').reverse();
    for (const line of lines) {
      let ev; try { ev = JSON.parse(line); } catch (_) { continue; }
      if (ev.subtype === 'compact_boundary' && ev.compactMetadata && ev.compactMetadata.postTokens != null) return ev.compactMetadata.postTokens;
      const u = ev.type === 'assistant' && ev.message && ev.message.usage;
      if (u) return (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
    }
  } catch (_) {}
  return null;
}

// Plan limits (5-hour window and week) from the endpoint Claude Code's own
// /usage reads, signed with the subscription token Claude Code keeps fresh.
function planUsage() {
  return new Promise((resolve) => {
    let token;
    try { token = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', '.credentials.json'), 'utf-8')).claudeAiOauth.accessToken; }
    catch (_) { return resolve(null); }
    const req = https.get({
      hostname: 'api.anthropic.com', path: '/api/oauth/usage', timeout: 5000,
      headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20' },
    }, (res) => {
      let body = '';
      res.on('data', d => { body += d; });
      res.on('end', () => {
        if (res.statusCode !== 200) { log(`plan usage: HTTP ${res.statusCode}`); return resolve(null); }
        try { resolve(JSON.parse(body)); } catch (_) { resolve(null); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (e) => { log(`plan usage: ${e.message}`); resolve(null); });
  });
}

// Fallback text inside <tg-time>, shown by clients that do not localize it:
// "15:38", or "Wed 04/11 11:00" with the day.
function shortTime(ms, withDay = false) {
  const d = new Date(ms);
  const hm = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  return withDay ? `${d.toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: '2-digit' })} ${hm}` : hm;
}

function limitText(label, window, format) {
  if (!window || window.utilization == null) return `${label} n/a`;
  const pct = Math.round(window.utilization);
  const dot = pct >= 80 ? '🔴' : pct >= 50 ? '🟡' : '🟢';
  // The API reports resets a fraction before the minute (16:19:59.39); show 16:20.
  const resets = Math.round(Date.parse(window.resets_at) / 60000) * 60000;
  return `${label} ${dot} <b>${pct}%</b>${resets ? ` (resets ${tgTime(resets, format, shortTime(resets, format !== 't'))})` : ''}`;
}

async function motdText(prevStop) {
  const now = Date.now();
  const started = DAEMON_STARTED_AT.getTime();
  // A main task still marked running was cut off by this restart; it is the real last job.
  const cut = Object.values(state.running || {}).find(t => t.kind === 'main');
  const job = cut ? { status: 'interrupted', at: cut.startedAt } : state.lastJob;
  const jobText = job
    ? `${{ success: '✅ Success', failed: '❌ Failed', stopped: '⏹ Stopped', interrupted: '⚠️ Interrupted' }[job.status] || job.status} ${tgTime(job.at, 'r', 'earlier')}`
    : 'none yet';
  const launch = process.env.TG_DAEMON_LAUNCH;
  const mode = LAUNCH_MODES[launch] || launch || (process.stdout.isTTY ? LAUNCH_MODES.foreground : 'Background');
  const user = process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\${os.userInfo().username}` : os.userInfo().username;
  const k = (n) => `${Math.round(n / 1000)}k`;
  let session;
  if (state.sessionId) {
    const ctx = sessionContextTokens(state.sessionId);
    session = `↩️ Resuming <code>${htmlEscape(state.sessionId.slice(0, 8))}</code>`
      + (ctx != null ? ` · context <b>${k(ctx)}</b> (new conversation at ${k(ROTATE_TOKENS)})` : '');
  } else {
    session = `🆕 New session${sessionExpiredAtStart ? ' (the last one was idle over 2h)' : ''}`;
  }
  const plan = await planUsage();
  const limits = plan
    ? `${limitText('5h', plan.five_hour, 't')} | ${limitText('Week', plan.seven_day, 'wt')}`
    : 'n/a (usage not reachable)';
  return `🟢 <b>Claude bridge online</b>\n\n`
    + `Current Time: ${tgTime(now, 'wDT', shortTime(now, true))}\n`
    + `Mode: <code>${htmlEscape(mode)}</code> | TimeStart: ${tgTime(started, 't', shortTime(started))} | PC: <code>${htmlEscape(os.hostname())}</code>\n`
    + `ActiveUser: <code>${htmlEscape(user)}</code> | LastJobStatus: ${jobText}\n`
    + `Session: ${session}\n`
    + `Model: <code>${htmlEscape(CLAUDE_RUNTIME.model)}</code> | Queue: <code>${state.queue.length}</code>\n`
    + `Limits: ${limits}\n`
    + `PrevStop: ${prevStop}`;
}

// Silent: the daily logon start should not buzz the phone. "motd": false in
// agent-runtime.json's telegram section turns the banner off.
async function sendMotd(prevStop) {
  if (TELEGRAM_RUNTIME.motd === false) return;
  try { await tgApi('sendMessage', { chat_id: config.chat_id, parse_mode: 'HTML', text: await motdText(prevStop), disable_notification: true }); }
  catch (e) { log(`motd: ${e.message}`); }
}

// ---------- Hermes queue poller ----------
const HERMES_QUEUE = path.join(WORKDIR, '.claude-queue.json');

function readHermesQueue() {
  try { return JSON.parse(fs.readFileSync(HERMES_QUEUE, 'utf-8')); } catch { return null; }
}
function writeHermesQueue(obj) {
  try { fs.writeFileSync(HERMES_QUEUE, JSON.stringify(obj, null, 2)); } catch (e) { log(`writeHermesQueue: ${e.message}`); }
}

async function hermesQueuePoll() {
  setInterval(async () => {
    if (busy) return;
    const q = readHermesQueue();
    if (!q || q.status !== 'pending') return;
    log(`hermes-queue: picked up task ${q.id}`);
    writeHermesQueue({ ...q, status: 'working', updated: new Date().toISOString() });
    busy = true;
    try {
      // Queue tasks need archive recovery too; a queue call otherwise bypasses
      // Claude's Telegram handler and would arrive without conversation context.
      await rolloverIfNewDay();
      const model = resolveQueueModel(q.model, configuredModels(), CLAUDE_RUNTIME.model);
      let contextPrefix = await buildRestoreContext();
      let { ok, text: result, code, forked, actualId } = await runClaude(q.task, { contextPrefix, model, isolated: true });
      if (!ok && result === '__SESSION_EXPIRED__') {
        contextPrefix = await buildRestoreContext();
        ({ ok, text: result, code, forked, actualId } = await runClaude(q.task, { contextPrefix, model, isolated: true }));
      }
      if (ok && forked) {
        contextPrefix = await buildRestoreContext();
        ({ ok, text: result, code, forked, actualId } = await runClaude(q.task, { contextPrefix, model, isolated: true }));
      }
      if (ok) {
        let replyForArchive = String(result || '').trim();
        if (!replyForArchive || TG_SENT_SENTINEL.test(replyForArchive)) {
          replyForArchive = recoverReplyFromTranscript(actualId) || replyForArchive;
        }
        appendArchive({ day: state.day, ts: new Date().toISOString(), source: 'hermes_queue', model, user: q.task, assistant: replyForArchive, sessionId: actualId, forked: !!forked });
      }
      writeHermesQueue({ ...q, status: ok ? 'done' : 'error', [ok ? 'result' : 'error']: result, updated: new Date().toISOString() });
      log(`hermes-queue: task ${q.id} ${ok ? 'done' : 'error'}`);
    } catch (e) {
      writeHermesQueue({ ...q, status: 'error', error: e.message, updated: new Date().toISOString() });
      log(`hermes-queue: task ${q.id} threw: ${e.message}`);
    }
    busy = false;
    drainQueue(); // Telegram messages that arrived during the queue task
  }, 5000);
}

acquireLock();
const prevStop = previousStop();
heartbeat();
setInterval(heartbeat, HEARTBEAT_MS);
writeDaemonSettings();
registerTelegramCommandMenu()
  .then(() => refreshMcpCatalog())
  .then(() => registerTelegramCommandMenu())
  .catch(e => log(`menu/MCP discovery: ${e.message}`));
setPresence(true);
setInterval(() => setPresence(true), PRESENCE_EVERY_MS);
setInterval(() => flushOutbox().catch(e => log(`outbox: ${e.message}`)), OUTBOX_RETRY_MS);
maybeRotate({ notify: false });
sendMotd(prevStop)
  .then(() => recoverInterrupted())
  .catch(e => log(`recovery: ${e.message}`))
  .then(() => prewarm())
  .then(() => flushOutbox().catch(e => log(`outbox: ${e.message}`)));
pollLoop().catch(async (e) => { log(`fatal: ${e.stack || e.message}`); await setPresence(false); releaseLock(); process.exit(1); });
hermesQueuePoll();

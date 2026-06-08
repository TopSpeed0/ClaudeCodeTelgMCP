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
const https = require('https');
const crypto = require('crypto');
const { spawn } = require('child_process');

const WORKDIR = path.resolve(__dirname, '..');
const STATE_FILE = path.join(WORKDIR, '.telegram-task-state.json');
const LOCK_FILE = path.join(WORKDIR, '.telegram-task-daemon.lock');
const EMPTY_MCP = path.join(__dirname, 'daemon-mcp.json');

// ---------- Conversation archive / memory ----------
// Continuity lives in OUR files, not Claude's fragile session resume. Every turn
// is appended to a per-day transcript; older context is captured as one summary
// per day. On a silent fork (or daily reboot) we restore from these.
const ARCHIVE_DIR = path.join(WORKDIR, 'archive');
const DAILY_SUMMARIES_FILE = path.join(ARCHIVE_DIR, 'daily-summaries.json');
const RECENT_TURNS = 10;     // verbatim turns kept in the recovery window
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

let state = { updateOffset: 0, sessionId: null, day: null, summary: '', lastActivity: null };
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
  const candidates = [
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

function tgApi(method, params, { httpTimeoutMs } = {}) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(params || {});
    const req = https.request({
      hostname: 'api.telegram.org',
      port: 443,
      path: `/bot${config.bot_token}/${method}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (!parsed.ok) reject(new Error(`${method}: ${parsed.description || data}`));
          else resolve(parsed.result);
        } catch (e) {
          reject(new Error(`${method} parse: ${e.message} raw=${data.slice(0,200)}`));
        }
      });
    });
    req.on('error', reject);
    if (httpTimeoutMs) req.setTimeout(httpTimeoutMs, () => req.destroy(new Error(`${method} timeout`)));
    req.write(body);
    req.end();
  });
}

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
// Out of scope: tables, links, images, blockquotes.
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

  // Restore fenced code blocks as <pre>...</pre>.
  html = html.replace(/\u0000CB(\d+)\u0000/g, (_m, i) => {
    const body = codeBlocks[Number(i)];
    return `<pre>${body.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre>`;
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

async function sendChunked(text, { mode = 'rich' } = {}) {
  // Telegram caps messages at 4096 chars. We leave headroom for the <pre>...</pre> wrapper.
  const MAX = 3800;
  let remaining = stripAnsi(text || '(no output)');

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
    } else if (effectiveMode === 'rich') {
      body = markdownToTelegramHTML(chunk);
      parse_mode = 'HTML';
    } else {
      body = chunk;
      parse_mode = undefined;
    }

    try {
      await tgApi('sendMessage', {
        chat_id: config.chat_id,
        text: body,
        parse_mode,
        disable_web_page_preview: true,
      });
    } catch (e) {
      // Fallback to plain text if Telegram rejected the HTML for any reason
      // (unbalanced tags from a half-baked Markdown conversion, etc.).
      log(`sendMessage HTML failed (${e.message}) — retrying plain`);
      await tgApi('sendMessage', {
        chat_id: config.chat_id,
        text: chunk,
        disable_web_page_preview: true,
      });
    }
    remaining = remaining.slice(chunk.length);
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

// Low-level spawn of `claude -p` with the given extra args. Pure: collects
// stdout/stderr and performs NO state mutation. Resolves { code, out, errOut, killed }.
function claudeRaw(task, extraArgs) {
  return new Promise((resolve) => {
    const args = ['-p', task, '--model', 'claude-opus-4-6',
                  '--output-format', 'json',
                  '--dangerously-skip-permissions',
                  '--mcp-config', EMPTY_MCP, '--strict-mcp-config',
                  ...extraArgs];
    // Build the full cmd.exe command line ourselves and pass it verbatim,
    // so Node's spawn doesn't re-escape paths that already contain spaces.
    const cmdLine = ['claude', ...args.map(quoteForCmd)].join(' ');
    log(`spawn: ${cmdLine}`);
    const proc = spawn(process.env.COMSPEC || 'cmd.exe',
      ['/d', '/s', '/c', cmdLine],
      { cwd: WORKDIR, windowsVerbatimArguments: true, env: { ...process.env } });
    let out = '', errOut = '', killed = false;
    proc.stdout.on('data', (d) => out += d.toString());
    proc.stderr.on('data', (d) => errOut += d.toString());
    proc.on('error', (e) => resolve({ code: -1, out: '', errOut: `spawn error: ${e.message}`, killed: false }));
    // Kill runaway tasks so the daemon stays responsive.
    const timer = setTimeout(() => {
      killed = true;
      log(`timeout: killing claude after ${CLAUDE_TIMEOUT_MS / 1000}s`);
      // On Windows, proc is cmd.exe — killing it leaves claude.exe running as an orphan.
      // taskkill /F /T kills the entire process tree (cmd.exe + claude.exe children).
      if (process.platform === 'win32') {
        try { require('child_process').execSync(`taskkill /F /T /PID ${proc.pid}`, { timeout: 5000 }); } catch (_) {}
      } else {
        try { proc.kill('SIGTERM'); } catch (_) {}
        setTimeout(() => { try { proc.kill('SIGKILL'); } catch (_) {} }, 5000);
      }
    }, CLAUDE_TIMEOUT_MS);
    proc.on('close', (code) => { clearTimeout(timer); resolve({ code, out, errOut, killed }); });
  });
}

// One-off summarization that never touches the pinned session (uses a throwaway id).
async function summarize(label, body) {
  const prompt = `Summarize the following ${label} concisely in 4-8 short bullet points. `
    + `Capture facts, decisions, names, numbers, and open threads that future context would need. `
    + `Output ONLY the summary, no preamble.\n\n${body}`;
  const { code, out } = await claudeRaw(prompt, ['--session-id', crypto.randomUUID()]);
  if (code !== 0) return null;
  let env = null; try { env = JSON.parse(out.trim()); } catch (_) {}
  return env && typeof env.result === 'string' ? env.result.trim() : null;
}

// Run a Telegram task through Claude with our session management. Optional
// contextPrefix is prepended (used to restore conversation context on a fork
// or for an explicit recall). Returns { ok, text, code, forked, actualId }.
async function runClaude(task, { contextPrefix } = {}) {
  const resuming = !!state.sessionId;
  // Own the session id ourselves: reuse the pinned one, or mint a UUID for a
  // fresh session and assign it via --session-id.
  const sessionId = state.sessionId || crypto.randomUUID();
  const prompt = contextPrefix ? `${contextPrefix}\n\n---\nThe user's actual message:\n${task}` : task;
  const sessionArgs = resuming ? ['--resume', sessionId] : ['--session-id', sessionId];
  log(resuming ? `resuming session ${sessionId}` : `starting fresh session ${sessionId}`);

  const { code, out, errOut, killed } = await claudeRaw(prompt, sessionArgs);
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

  // Reset to fresh ONLY when --resume genuinely failed loudly (specific message,
  // not any stray "session"/"resume" word that would wipe context on real failures).
  const RESUME_FAILED = /no conversation found|session (id )?.*(not found|invalid|expired)|could not (resume|find session)|unable to resume/i;
  if (code !== 0 && resuming && RESUME_FAILED.test(errOut)) {
    log(`session ${sessionId} rejected — resetting to fresh`);
    state.sessionId = null; saveState();
    return { ok: false, text: '__SESSION_EXPIRED__' };
  }

  // Follow the session Claude actually used.
  let forked = false;
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

  const text = answer.trim() || (errOut.trim() ? `(stderr) ${errOut.trim()}` : `(no output, exit=${code})`);
  return { ok: code === 0, text, code, forked, actualId };
}

// ---------- Typing indicator ----------
// Telegram's "typing..." badge lasts ~5 seconds. We re-send every 4s while Claude works.
function startTyping() {
  const send = () => {
    tgApi('sendChatAction', { chat_id: config.chat_id, action: 'typing' })
      .catch(e => log(`typing indicator: ${e.message}`));
  };
  send(); // fire immediately
  const interval = setInterval(send, 4000);
  return () => clearInterval(interval);
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
  const all = loadDailySummaries();
  const pastDates = Object.keys(all).sort();
  if (pastDates.length) {
    const last = pastDates[pastDates.length - 1];
    parts.push(`[Summary of our previous conversation day (${last})]\n${all[last]}`);
  }
  const turns = readDayTurns(state.day);
  if (turns.length > RECENT_TURNS) {
    const sum = await summarize("earlier part of today's conversation", turnsToText(turns.slice(0, turns.length - RECENT_TURNS)));
    if (sum) parts.push(`[Summary of earlier today]\n${sum}`);
  }
  const recent = turns.slice(-RECENT_TURNS);
  if (recent.length) parts.push(`[Most recent ${recent.length} turn(s), verbatim]\n${turnsToText(recent)}`);
  if (!parts.length) return null;
  return `[Context restore — the previous session could not be resumed; here is our conversation so far so you can continue seamlessly]\n\n${parts.join('\n\n')}`;
}

async function handleMessage(rawText) {
  await rolloverIfNewDay();
  const stopTyping = startTyping();
  const t0 = Date.now();

  // Explicit deep recall: "recall", "recall 3/5/10".
  const recallDays = parseRecall(rawText);
  let taskText = rawText, contextPrefix;
  if (recallDays) {
    contextPrefix = buildRecallContext(recallDays);
    if (!contextPrefix) {
      stopTyping();
      await sendChunked('No archived daily summaries yet to recall.', { mode: 'rich' });
      return;
    }
    taskText = `Using the recalled summaries above, briefly tell me what you now remember from the last ${recallDays} day(s).`;
  }

  let result, ok, code, forked, actualId;
  try {
    ({ ok, text: result, code, forked, actualId } = await runClaude(taskText, { contextPrefix }));
  } finally {
    stopTyping();
  }
  const dt = ((Date.now() - t0) / 1000).toFixed(1);

  // Loud resume failure → retry fresh, restoring context from the archive.
  if (!ok && result === '__SESSION_EXPIRED__') {
    log('session expired — retrying fresh with restored context');
    const ctx = await buildRestoreContext();
    const typing = startTyping();
    try { ({ ok, text: result, code, forked, actualId } = await runClaude(taskText, { contextPrefix: ctx || contextPrefix })); }
    finally { typing(); }
  }

  if (!ok) {
    await sendChunked(`**Failed** (exit=${code}, ${dt}s):\n${stripAnsi(result || '').trim() || '(no output)'}`, { mode: 'rich' });
    return;
  }

  // Silent fork (idle / reboot): the first reply was context-less. Restore our
  // history from the archive and re-run so the answer is informed.
  if (forked) {
    const ctx = await buildRestoreContext();
    if (ctx) {
      log('fork detected — re-running with restored context');
      const typing = startTyping();
      try { ({ ok, text: result, code, forked, actualId } = await runClaude(taskText, { contextPrefix: ctx })); }
      finally { typing(); }
      await sendChunked('↻ The previous session had dropped — I restored our recent history from the archive and continued.', { mode: 'rich' });
    } else {
      await sendChunked('⚠️ **Heads up:** previous session could not be resumed and there is no archive yet to restore from. Continuing fresh.', { mode: 'rich' });
    }
  }

  const trimmed = stripAnsi(result || '').trim();

  // Archive the turn with the REAL reply (recover from transcript when tg_send was used).
  let replyForArchive = trimmed;
  if (!replyForArchive || TG_SENT_SENTINEL.test(replyForArchive)) {
    replyForArchive = recoverReplyFromTranscript(actualId) || replyForArchive;
  }
  appendArchive({ day: state.day, ts: new Date().toISOString(), user: rawText, assistant: replyForArchive, sessionId: state.sessionId, forked: !!forked });

  // Relay to the user.
  if (TG_SENT_SENTINEL.test(trimmed)) {
    log(`relay suppressed: agent used tg_send sentinel (${dt}s, stdout=${trimmed.length} chars)`);
    return;
  }
  if (!trimmed) {
    log(`relay suppressed: empty stdout (${dt}s)`);
    return;
  }
  // Agent's stdout IS the answer — relay as rich HTML (Markdown -> Telegram HTML),
  // with the looksTabular() <pre> fallback inside sendChunked.
  await sendChunked(trimmed, { mode: 'rich' });
}

let busy = false;
async function pollLoop() {
  log(`ready — workdir=${WORKDIR} chat_id=${config.chat_id} session_resumed=${state.sessionStarted}`);
  while (true) {
    let updates;
    try {
      updates = await tgApi('getUpdates', {
        offset: state.updateOffset,
        timeout: 60,
        allowed_updates: ['message'],
      }, { httpTimeoutMs: 75 * 1000 });
    } catch (e) {
      log(`getUpdates: ${e.message} — backoff 5s`);
      await new Promise(r => setTimeout(r, 5000));
      continue;
    }
    for (const u of updates) {
      state.updateOffset = u.update_id + 1;
      saveState();
      const m = u.message;
      if (!m || !m.text) continue;
      if (String(m.chat.id) !== String(config.chat_id)) {
        log(`ignored msg from chat ${m.chat.id}`);
        continue;
      }
      if (busy) {
        await tgApi('sendMessage', { chat_id: config.chat_id, text: `Busy — message queued won't run. Send again after current task completes.` });
        continue;
      }
      busy = true;
      try { await handleMessage(m.text); }
      catch (e) { log(`handle: ${e.stack || e.message}`); try { await sendChunked(`Daemon error: ${e.message}`, { mode: 'plain' }); } catch (_) {} }
      busy = false;
    }
  }
}

process.on('SIGINT', () => { log('SIGINT, exiting'); releaseLock(); process.exit(0); });
process.on('SIGTERM', () => { log('SIGTERM, exiting'); releaseLock(); process.exit(0); });
process.on('exit', releaseLock);

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
      const { ok, text: result } = await runClaude(q.task);
      writeHermesQueue({ ...q, status: ok ? 'done' : 'error', [ok ? 'result' : 'error']: result, updated: new Date().toISOString() });
      log(`hermes-queue: task ${q.id} ${ok ? 'done' : 'error'}`);
    } catch (e) {
      writeHermesQueue({ ...q, status: 'error', error: e.message, updated: new Date().toISOString() });
      log(`hermes-queue: task ${q.id} threw: ${e.message}`);
    }
    busy = false;
  }, 5000);
}

acquireLock();
pollLoop().catch((e) => { log(`fatal: ${e.stack || e.message}`); releaseLock(); process.exit(1); });
hermesQueuePoll();

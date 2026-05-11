#!/usr/bin/env node
// telegram-task-daemon.js — Always-on Telegram -> Claude Code bridge.
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
const { spawn } = require('child_process');

const WORKDIR = path.resolve(__dirname, '..');
const STATE_FILE = path.join(WORKDIR, '.telegram-task-state.json');
const EMPTY_MCP = path.join(__dirname, 'daemon-mcp.json');

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

let state = { updateOffset: 0, sessionStarted: false };
try { state = { ...state, ...JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8')) }; } catch (_) {}
function saveState() {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); } catch (e) { log(`saveState: ${e.message}`); }
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

// ---------- Platform-specific spawn helpers ----------
const IS_WIN = process.platform === 'win32';

function quoteForCmd(arg) {
  // cmd.exe-safe quoting: wrap in double quotes if it contains whitespace or quotes;
  // escape embedded quotes and trailing backslashes per Windows command-line rules.
  if (typeof arg !== 'string') arg = String(arg);
  if (!/[\s"]/.test(arg)) return arg;
  const escaped = arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1');
  return `"${escaped}"`;
}

function runClaude(task) {
  return new Promise((resolve) => {
    const args = ['-p', task, '--dangerously-skip-permissions',
                  '--mcp-config', EMPTY_MCP, '--strict-mcp-config'];
    if (state.sessionStarted) args.push('--continue');

    let proc;
    if (IS_WIN) {
      // Windows: build cmd.exe command line to avoid Node re-escaping paths with spaces.
      const cmdLine = ['claude', ...args.map(quoteForCmd)].join(' ');
      log(`spawn: ${cmdLine}`);
      proc = spawn(process.env.COMSPEC || 'cmd.exe',
        ['/d', '/s', '/c', cmdLine],
        {
          cwd: WORKDIR,
          windowsVerbatimArguments: true,
          env: { ...process.env },
        });
    } else {
      // macOS / Linux: spawn claude directly.
      log(`spawn: claude ${args.join(' ')}`);
      proc = spawn('claude', args, {
        cwd: WORKDIR,
        env: { ...process.env },
      });
    }

    let out = '', errOut = '';
    proc.stdout.on('data', (d) => out += d.toString());
    proc.stderr.on('data', (d) => errOut += d.toString());
    proc.on('error', (e) => resolve({ ok: false, text: `spawn error: ${e.message}` }));
    proc.on('close', (code) => {
      // Only mark the session started on success — otherwise a failed first run
      // would lock us into --continue against a session that never existed.
      if (code === 0 && !state.sessionStarted) { state.sessionStarted = true; saveState(); }
      const text = out.trim() || (errOut.trim() ? `(stderr) ${errOut.trim()}` : `(no output, exit=${code})`);
      resolve({ ok: code === 0, text, code });
    });
  });
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
// Daemon then suppresses the stdout relay entirely.
const TG_SENT_SENTINEL = /\[sent-via-tg\]/i;

async function handleMessage(text) {
  const stopTyping = startTyping();
  const t0 = Date.now();
  let result, ok, code;
  try {
    ({ ok, text: result, code } = await runClaude(text));
  } finally {
    stopTyping();
  }
  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  const trimmed = stripAnsi(result || '').trim();

  if (!ok) {
    // Errors always surface — user needs to know. Use rich mode so prose-style
    // failures (e.g. "You've hit your limit") render cleanly; looksTabular()
    // will auto-fall back to <pre> for stderr that looks like aligned output.
    await sendChunked(`**Failed** (exit=${code}, ${dt}s):\n${trimmed || '(no output)'}`, { mode: 'rich' });
    return;
  }

  // Agent signaled "I already sent the user-facing answer via tg_send" -> suppress relay.
  if (TG_SENT_SENTINEL.test(trimmed)) {
    log(`relay suppressed: agent used tg_send sentinel (${dt}s, stdout=${trimmed.length} chars)`);
    return;
  }

  // Nothing to say -> don't send an empty <pre>.
  if (!trimmed) {
    log(`relay suppressed: empty stdout (${dt}s)`);
    return;
  }

  // Otherwise the agent's stdout IS the answer — relay it as rich HTML (Markdown -> Telegram HTML).
  // Safety net for when the agent forgot to call tg_send. The looksTabular() heuristic inside
  // sendChunked will fall back to <pre> if the payload looks like aligned CLI table output.
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

process.on('SIGINT', () => { log('SIGINT, exiting'); process.exit(0); });
process.on('SIGTERM', () => { log('SIGTERM, exiting'); process.exit(0); });

pollLoop().catch((e) => { log(`fatal: ${e.stack || e.message}`); process.exit(1); });

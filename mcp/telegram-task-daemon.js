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

async function sendChunked(text, { mono = true } = {}) {
  // Telegram caps messages at 4096 chars. We leave headroom for the <pre>...</pre> wrapper.
  const MAX = 3800;
  let remaining = stripAnsi(text || '(no output)');
  while (remaining.length > 0) {
    let chunk = remaining.slice(0, MAX);
    if (remaining.length > MAX) {
      const lastBreak = Math.max(chunk.lastIndexOf('\n'), chunk.lastIndexOf(' '));
      if (lastBreak > MAX * 0.5) chunk = chunk.slice(0, lastBreak);
    }
    const body = mono ? `<pre>${htmlEscape(chunk)}</pre>` : chunk;
    try {
      await tgApi('sendMessage', {
        chat_id: config.chat_id,
        text: body,
        parse_mode: mono ? 'HTML' : undefined,
        disable_web_page_preview: true,
      });
    } catch (e) {
      // Fallback to plain text if Telegram rejected the HTML for any reason.
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
    // Errors always surface — user needs to know.
    await sendChunked(`Failed (exit=${code}, ${dt}s):\n${trimmed || '(no output)'}`, { mono: true });
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

  // Otherwise the agent's stdout IS the answer — relay it as a monospace block.
  await sendChunked(trimmed, { mono: true });
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
      catch (e) { log(`handle: ${e.stack || e.message}`); try { await sendChunked(`Daemon error: ${e.message}`); } catch (_) {} }
      busy = false;
    }
  }
}

process.on('SIGINT', () => { log('SIGINT, exiting'); process.exit(0); });
process.on('SIGTERM', () => { log('SIGTERM, exiting'); process.exit(0); });

pollLoop().catch((e) => { log(`fatal: ${e.stack || e.message}`); process.exit(1); });

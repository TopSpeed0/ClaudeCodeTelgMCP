'use strict';
// CI end-to-end test of the task daemon on the runner's OS: sets the checkout
// up like a fresh install, starts mcp/telegram-task-daemon.js with the test
// bot, hands it one message through its inbox file (a bot cannot message
// itself), and waits until the task has finished and the answer is sent.
// Needs TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID and CLAUDE_CODE_OAUTH_TOKEN.
// Only one poller per bot is allowed, so runs on several OSes must not overlap.
// Usage: node .github/smoke/daemon-e2e.js "<label for the test chat>"

const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const root = path.resolve(__dirname, '..', '..');
const label = process.argv[2] || process.platform;
const token = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;
if (!token || !chatId) throw new Error('TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are required');

const file = (name) => path.join(root, name);
const READY_TIMEOUT_MS = 90 * 1000;
const TASK_TIMEOUT_MS = 6 * 60 * 1000;

let daemon = null, exited = null, ready = false, recent = '';

// A fresh install: example configs, credentials, generated MCP config.
function setUp() {
  for (const [example, real] of [['agent-runtime.example.json', 'agent-runtime.json'], ['mcp-connectors.example.json', 'mcp-connectors.json']]) {
    if (!fs.existsSync(file(real))) fs.copyFileSync(file(example), file(real));
  }
  fs.writeFileSync(file('.telegram-config'), JSON.stringify({ bot_token: token, chat_id: chatId }));
  execFileSync(process.execPath, [file('mcp/sync-mcp-connectors.js'), 'claude'], { stdio: 'inherit' });
}

// Messages already waiting for the test bot (an earlier "hi") would run as tasks too.
async function dropPendingUpdates() {
  const res = await fetch(`https://api.telegram.org/bot${token}/deleteWebhook`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ drop_pending_updates: true }),
  });
  const body = await res.json();
  if (!body.ok) throw new Error(`deleteWebhook: ${body.description}`);
}

// In its own process group on macOS / Linux, so it can be stopped whole.
function startDaemon() {
  daemon = spawn(process.execPath, [file('mcp/telegram-task-daemon.js')], {
    cwd: root, stdio: ['ignore', 'inherit', 'pipe'], detached: process.platform !== 'win32',
  });
  daemon.stderr.setEncoding('utf8');
  daemon.stderr.on('data', (chunk) => {
    process.stderr.write(chunk);
    recent = (recent + chunk).slice(-500);
    if (recent.includes('] ready — ')) ready = true;
  });
  daemon.on('exit', (code, signal) => { exited = `exit code ${code}${signal ? `, ${signal}` : ''}`; });
}

function stopDaemon() {
  if (!daemon || exited) return;
  if (process.platform === 'win32') {
    try { execFileSync('taskkill', ['/F', '/T', '/PID', String(daemon.pid)], { stdio: 'ignore' }); } catch (_) {}
  } else {
    try { process.kill(-daemon.pid, 'SIGTERM'); } catch (_) {}
  }
}

async function waitFor(what, timeoutMs, check) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (exited) throw new Error(`the daemon stopped (${exited}) while waiting for ${what}`);
    const result = check();
    if (result) return result;
    await new Promise(r => setTimeout(r, 1000));
  }
  throw new Error(`timed out after ${timeoutMs / 1000}s waiting for ${what}`);
}

function lastJob() {
  try { return JSON.parse(fs.readFileSync(file('.telegram-task-state.json'), 'utf8')).lastJob || null; } catch (_) { return null; }
}

(async () => {
  setUp();
  await dropPendingUpdates();
  const t0 = Date.now();
  startDaemon();
  await waitFor('the daemon to be ready', READY_TIMEOUT_MS, () => ready);
  // One message, shaped like a Telegram update from the owner.
  const text = `🧪 CI daemon test on ${label}. Reply with one short sentence that names this operating system `
    + `(${label}) and confirms the task daemon delivered this message. Do not use any tool other than tg_send.`;
  fs.writeFileSync(file('.telegram-daemon-inbox.json'), JSON.stringify([{
    message_id: Math.floor(Date.now() / 1000) % 1e9,
    from: { id: Number(chatId), is_bot: false, first_name: 'CI' },
    chat: { id: Number(chatId), type: Number(chatId) > 0 ? 'private' : 'group' },
    date: Math.floor(Date.now() / 1000),
    text,
  }]));
  console.log(`--- inbox message written (${label}) ---`);
  // The task has run and its answer is out when the daemon records the job.
  const job = await waitFor('the task to finish', TASK_TIMEOUT_MS, () => {
    const j = lastJob();
    return j && j.at >= t0 && j.status !== 'interrupted' ? j : null;
  });
  console.log(`--- job ${job.status} after ${((Date.now() - t0) / 1000).toFixed(0)}s ---`);
  if (job.status !== 'success') throw new Error(`the task ended as ${job.status}`);
})()
  .then(() => { stopDaemon(); process.exit(0); })
  .catch((e) => { console.error(`FAILED: ${e.message}`); stopDaemon(); process.exit(1); });

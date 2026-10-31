'use strict';
// CI smoke test: starts the repo's own MCP server (mcp/telegram-tg.js) over
// stdio, checks tools/list, and sends one message to the test chat through
// tg_send. Needs TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID (the test bot).
// Usage: node .github/smoke/telegram-smoke.js "<html message>"
//        node .github/smoke/telegram-smoke.js --list-only   (no message sent;
//        checks every tool is listed, so dummy credentials are enough)

const { spawn } = require('child_process');
const path = require('path');
const readline = require('readline');

const text = process.argv[2] || '🧪 Smoke test';
const server = spawn(process.execPath, [path.join(__dirname, '..', '..', 'mcp', 'telegram-tg.js')], {
  stdio: ['pipe', 'pipe', 'inherit'],
});
const pending = new Map();
readline.createInterface({ input: server.stdout }).on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch (_) { return; }
  const done = pending.get(msg.id);
  if (done) { pending.delete(msg.id); done(msg); }
});

let nextId = 1;
function request(method, params) {
  const id = nextId++;
  server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  return new Promise((resolve, reject) => {
    pending.set(id, resolve);
    setTimeout(() => reject(new Error(`${method}: no answer in 30s`)), 30000).unref();
  });
}

(async () => {
  await request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'ci-smoke', version: '1' } });
  server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  const tools = (await request('tools/list', {})).result.tools.map(t => t.name);
  console.log(`tools: ${tools.join(', ')}`);
  if (text === '--list-only') {
    const missing = ['tg_send', 'tg_ask', 'tg_edit', 'tg_react', 'tg_typing'].filter(t => !tools.includes(t));
    if (missing.length) throw new Error(`missing from tools/list: ${missing.join(', ')}`);
    return;
  }
  if (!tools.includes('tg_send')) throw new Error('tg_send missing from tools/list');
  const sent = await request('tools/call', { name: 'tg_send', arguments: { text, parse_mode: 'HTML' } });
  const result = sent.result || {};
  console.log(`tg_send: ${(result.content || []).map(c => c.text).join(' ') || JSON.stringify(sent.error)}`);
  if (sent.error || result.isError) throw new Error('tg_send failed');
})()
  .then(() => { server.kill(); process.exit(0); })
  .catch((e) => { console.error(e.message); server.kill(); process.exit(1); });

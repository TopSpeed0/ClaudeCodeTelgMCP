'use strict';
// Native MCP discovery for the Telegram "/" menu. Collects every MCP server
// that a daemon-spawned Claude session loads, the same set `claude mcp list`
// shows in this folder:
//   user scope     ~/.claude.json  mcpServers
//   local scope    ~/.claude.json  projects[<this folder>].mcpServers
//   project scope  <this folder>/.mcp.json
//   the daemon's   mcp/daemon-mcp.local.json (generated from mcp-connectors.json)
// Each server is then asked the standard MCP way (initialize, then
// tools/list) what it offers. Nothing is hard-coded: a server registered with
// `claude mcp add` appears with its own name and its real tools.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const { spawn, execFileSync } = require('child_process');

const BRIDGE_SERVERS = new Set(['telegram-tg']); // the Telegram bridge itself is not a menu entry
const DISCOVERY_TIMEOUT_MS = 30000;
const PROTOCOL_VERSION = '2024-11-05';
const CLIENT_INFO = { name: 'telegram-menu-discovery', version: '1.0.0' };

function firstSentence(text, max = 90) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim().split(/(?<=\.)\s/)[0];
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch (_) { return null; }
}

// ${VAR} and ${VAR:-default}, as Claude Code expands them in MCP configs.
function expandEnv(value) {
  if (typeof value !== 'string') return value;
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_m, name, fallback) => process.env[name] ?? fallback ?? '');
}
const expandAll = (obj) => Object.fromEntries(Object.entries(obj || {}).map(([k, v]) => [k, expandEnv(v)]));

// Every server a task session loads, by name. Later sources win, matching
// Claude Code's precedence (local > project > user); the daemon's own config
// is passed on the command line and wins over all of them.
function collectMcpServers(workdir, daemonConfigFile) {
  const servers = {};
  const add = (map, scope) => { for (const [name, server] of Object.entries(map || {})) servers[name] = { ...server, scope }; };
  const home = readJson(path.join(os.homedir(), '.claude.json')) || {};
  add(home.mcpServers, 'user');
  add((readJson(path.join(workdir, '.mcp.json')) || {}).mcpServers, 'project');
  const projects = home.projects || {};
  const key = Object.keys(projects).find(dir => path.resolve(dir).toLowerCase() === path.resolve(workdir).toLowerCase());
  if (key) add(projects[key].mcpServers, 'local');
  add((readJson(daemonConfigFile) || {}).mcpServers, 'daemon');
  for (const name of BRIDGE_SERVERS) delete servers[name];
  return servers;
}

function stopProcess(proc) {
  if (process.platform === 'win32') {
    try { execFileSync('taskkill', ['/F', '/T', '/PID', String(proc.pid)], { stdio: 'ignore', timeout: 5000 }); } catch (_) {}
  } else {
    try { proc.kill('SIGTERM'); } catch (_) {}
  }
}

// npx, uvx, npm … are .cmd shims on Windows and need cmd.exe; quote each argument.
function spawnServer(server, cwd) {
  const env = { ...process.env, ...expandAll(server.env) };
  const args = (server.args || []).map(expandEnv);
  const command = expandEnv(server.command);
  const opts = { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true };
  if (process.platform === 'win32' && !/[\\/]/.test(command) && !/\.(exe|com)$/i.test(command)
      && ['npx', 'npm', 'pnpm', 'yarn', 'uvx', 'bunx'].includes(command.toLowerCase().replace(/\.cmd$/i, ''))) {
    const quote = (a) => (/[\s"&|<>^]/.test(a) ? `"${String(a).replace(/"/g, '""')}"` : a);
    return spawn([command, ...args].map(quote).join(' '), { ...opts, shell: true });
  }
  return spawn(command, args, opts);
}

// One stdio server: { tools: [{ name, description }], error? }.
async function discoverStdioServer(server, cwd) {
  const { result, error } = await stdioRequest(server, cwd, 'tools/list', {});
  return error ? { tools: [], error } : { tools: toolsOf(result) };
}

// Start a stdio server, initialize it, send one request, stop it:
// { result } or { error }.
function stdioRequest(server, cwd, method, params) {
  return new Promise((resolve) => {
    let proc;
    try { proc = spawnServer(server, cwd); }
    catch (e) { resolve({ error: `could not start: ${e.message}` }); return; }
    let buffer = '', stderr = '', settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stopProcess(proc);
      resolve(result);
    };
    const timer = setTimeout(() => finish({ error: `no answer within ${DISCOVERY_TIMEOUT_MS / 1000}s` }), DISCOVERY_TIMEOUT_MS);
    const send = (msg) => { try { proc.stdin.write(`${JSON.stringify(msg)}\n`); } catch (_) {} };
    proc.on('error', (e) => finish({ error: `could not start: ${e.message}` }));
    proc.on('exit', (code) => finish({ error: `exited (code ${code}) ${stderr.trim().split('\n').pop() || ''}`.trim() }));
    proc.stdin.on('error', () => {});
    proc.stderr.on('data', (d) => { stderr = (stderr + d.toString()).slice(-2000); });
    proc.stdout.on('data', (d) => {
      buffer += d.toString();
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        let msg; try { msg = JSON.parse(line); } catch (_) { continue; }
        if (msg.id === 1) {
          if (msg.error) return finish({ error: `initialize failed: ${msg.error.message}` });
          send({ jsonrpc: '2.0', method: 'notifications/initialized' });
          send({ jsonrpc: '2.0', id: 2, method, params });
        } else if (msg.id === 2) {
          if (msg.error) return finish({ error: `${method} failed: ${msg.error.message}` });
          return finish({ result: msg.result });
        }
      }
    });
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO } });
  });
}

function toolsOf(result) {
  return ((result && result.tools) || []).map(t => ({ name: String(t.name), description: firstSentence(t.description) }));
}

// One JSON-RPC message over MCP streamable HTTP. The reply is plain JSON or an
// SSE stream; returns { message, sessionId, status }.
function postMcp(url, headers, body, sessionId) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const payload = JSON.stringify(body);
    const req = (target.protocol === 'http:' ? http : https).request(target, {
      method: 'POST',
      headers: {
        ...headers,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'Content-Length': Buffer.byteLength(payload),
        ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}),
      },
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        const sid = res.headers['mcp-session-id'] || sessionId;
        if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}${res.statusCode === 401 || res.statusCode === 403 ? ' (token expired or not allowed?)' : ''}`));
        if (!data.trim()) return resolve({ message: null, sessionId: sid, status: res.statusCode });
        let message = null;
        if (/text\/event-stream/.test(res.headers['content-type'] || '')) {
          for (const line of data.split(/\r?\n/)) {
            if (!line.startsWith('data:')) continue;
            try { const m = JSON.parse(line.slice(5).trim()); if (m.id === body.id) message = m; } catch (_) {}
          }
        } else {
          try { message = JSON.parse(data); } catch (_) { return reject(new Error(`not JSON (HTTP ${res.statusCode}); a login page?`)); }
        }
        resolve({ message, sessionId: sid, status: res.statusCode });
      });
    });
    req.on('error', reject);
    req.setTimeout(DISCOVERY_TIMEOUT_MS, () => req.destroy(new Error(`no answer within ${DISCOVERY_TIMEOUT_MS / 1000}s`)));
    req.end(payload);
  });
}

async function discoverHttpServer(server) {
  const { result, error } = await httpRequest(server, 'tools/list', {});
  return error ? { tools: [], error } : { tools: toolsOf(result) };
}

// Initialize an HTTP server's session and send one request: { result } or { error }.
async function httpRequest(server, method, params) {
  const headers = expandAll(server.headers);
  const url = expandEnv(server.url);
  try {
    const init = await postMcp(url, headers, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO } });
    if (init.message && init.message.error) return { error: `initialize failed: ${init.message.error.message}` };
    await postMcp(url, headers, { jsonrpc: '2.0', method: 'notifications/initialized' }, init.sessionId).catch(() => {});
    const reply = await postMcp(url, headers, { jsonrpc: '2.0', id: 2, method, params }, init.sessionId);
    if (!reply.message) return { error: `${method} returned nothing` };
    if (reply.message.error) return { error: `${method} failed: ${reply.message.error.message}` };
    return { result: reply.message.result };
  } catch (e) {
    return { error: e.message };
  }
}

// Call one tool on a configured MCP server, the way a Claude session would,
// and return its data: the structured result when the server sends one,
// else the first text block parsed as JSON (or the text itself). Throws on
// any failure, including a tool that reports isError.
async function callMcpTool(workdir, daemonConfigFile, serverName, tool, args = {}) {
  const server = collectMcpServers(workdir, daemonConfigFile)[serverName];
  if (!server) throw new Error(`no MCP server named "${serverName}"`);
  const transport = server.type || (server.url ? 'http' : 'stdio');
  if (transport !== 'stdio' && transport !== 'http') throw new Error(`${serverName}: transport "${transport}" is not supported here`);
  const params = { name: tool, arguments: args };
  const { result, error } = transport === 'stdio'
    ? await stdioRequest(server, workdir, 'tools/call', params)
    : await httpRequest(server, 'tools/call', params);
  if (error) throw new Error(`${serverName}.${tool}: ${error}`);
  const text = ((result && result.content) || []).filter(c => c && c.type === 'text').map(c => c.text).join('\n');
  if (result && result.isError) throw new Error(`${serverName}.${tool}: ${firstSentence(text, 200) || 'tool error'}`);
  if (result && result.structuredContent) return result.structuredContent;
  try { return JSON.parse(text); } catch (_) { return text; }
}

// Every native server, asked in parallel: [{ name, scope, transport, tools, error? }].
async function discoverMcpServers(daemonConfigFile, workdir) {
  const servers = collectMcpServers(workdir, daemonConfigFile);
  const results = await Promise.all(Object.entries(servers).map(async ([name, server]) => {
    const transport = server.type || (server.url ? 'http' : 'stdio');
    const found = transport === 'stdio'
      ? await discoverStdioServer(server, workdir)
      : transport === 'http' ? await discoverHttpServer(server) : { tools: [], remote: true };
    return { name, scope: server.scope, transport, ...found };
  }));
  return { servers: results, at: new Date().toISOString() };
}

// One menu line for a discovered server.
function mcpMenuDescription(server) {
  const where = server.transport === 'stdio' ? 'MCP' : 'MCP (remote)';
  if (server.error) return firstSentence(`🔌 ${where} — not answering: ${server.error}`, 100);
  if (server.remote) return `🔌 ${where}`;
  const sample = server.tools.slice(0, 3).map(t => t.name).join(', ');
  const more = server.tools.length > 3 ? ', …' : '';
  return firstSentence(`🔌 ${where} · ${server.tools.length} tools: ${sample}${more}`, 100);
}

module.exports = { collectMcpServers, discoverMcpServers, callMcpTool, mcpMenuDescription, BRIDGE_SERVERS };

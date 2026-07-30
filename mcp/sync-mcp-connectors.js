#!/usr/bin/env node
'use strict';

// Compile the private mcp-connectors.json registry into a client-native MCP config.
// The registry and generated output are intentionally gitignored.
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const target = process.argv[2];
const registryFile = path.join(root, 'mcp-connectors.json');

if (!['copilot', 'claude', 'vscode'].includes(target)) {
  throw new Error('Usage: node mcp/sync-mcp-connectors.js <copilot|claude|vscode>');
}
if (!fs.existsSync(registryFile)) {
  throw new Error(`Missing private registry: ${registryFile}. Copy mcp-connectors.example.json first.`);
}

let registry;
try { registry = JSON.parse(fs.readFileSync(registryFile, 'utf8')); }
catch (error) { throw new Error(`Invalid ${registryFile}: ${error.message}`); }
if (!registry || registry.version !== 1 || !registry.servers || typeof registry.servers !== 'object') {
  throw new Error('Registry must contain version: 1 and a servers object.');
}

function enabledServers() {
  return Object.entries(registry.servers).filter(([name, server]) => {
    if (!server || typeof server !== 'object') throw new Error(`Server ${name} must be an object.`);
    if (!server.enabled) return false;
    if (!['stdio', 'sse', 'http'].includes(server.transport)) throw new Error(`Server ${name} has invalid transport.`);
    if (server.transport === 'stdio' && (!server.command || !Array.isArray(server.args))) {
      throw new Error(`stdio server ${name} requires command and args.`);
    }
    if (server.transport !== 'stdio' && !server.url) throw new Error(`remote server ${name} requires url.`);
    if (!Array.isArray(server.tools) || server.tools.length === 0) throw new Error(`Server ${name} requires a non-empty tools allowlist.`);
    return true;
  });
}

function nativeEntry(server, includeTools) {
  if (server.transport === 'stdio') {
    const out = { command: server.command, args: server.args };
    if (server.env && typeof server.env === 'object') out.env = server.env;
    if (includeTools) out.tools = server.tools;
    return out;
  }
  const out = { type: server.transport, url: server.url };
  if (server.headers && typeof server.headers === 'object') out.headers = server.headers;
  if (includeTools) out.tools = server.tools;
  return out;
}

const servers = enabledServers();
let outputFile, output;
if (target === 'copilot') {
  outputFile = path.join(root, '.mcp.json');
  output = Object.fromEntries(servers.map(([name, server]) => [name, {
    type: server.transport === 'stdio' ? 'local' : server.transport,
    ...nativeEntry(server, true),
  }]));
} else if (target === 'claude') {
  const baseFile = path.join(__dirname, 'daemon-mcp.base.json');
  const base = JSON.parse(fs.readFileSync(baseFile, 'utf8'));
  outputFile = path.join(__dirname, 'daemon-mcp.local.json');
  output = { ...base, mcpServers: { ...(base.mcpServers || {}) } };
  for (const [name, server] of servers) output.mcpServers[name] = nativeEntry(server, false);
} else {
  const baseFile = path.join(root, '.vscode', 'mcp.base.json');
  const base = JSON.parse(fs.readFileSync(baseFile, 'utf8'));
  outputFile = path.join(root, '.vscode', 'mcp.json');
  output = { ...base, servers: { ...(base.servers || {}) } };
  for (const [name, server] of servers) output.servers[name] = nativeEntry(server, false);
}

fs.writeFileSync(outputFile, JSON.stringify(output, null, 2) + '\n');
console.log(`generated ${path.relative(root, outputFile)} for ${target}: ${servers.map(([name]) => name).join(', ') || 'no enabled connectors'}`);

#!/usr/bin/env node
// telegram-approval-hook.js — Claude Code PreToolUse hook for daemon-spawned
// sessions. Those run with --dangerously-skip-permissions, so this hook is
// the only gate: a tool call that matches a risky rule (sending mail, cluster
// writes, deletes, pushes, API writes) waits for ✅ / ❌ on Telegram.
// Anything else passes through untouched (no output, exit 0).
//
// The daemon wires it in through `--settings` (see writeDaemonSettings in
// telegram-task-daemon.js). Interactive Claude sessions never load it.
// Fail closed: no answer, or Telegram unreachable, means deny.
//
// Rules: DEFAULT_RULES below, plus `approval.extra_patterns` (regex strings)
// in agent-runtime.json; `approval.enabled: false` turns the gate off and
// `approval.timeout_seconds` (default 600) sets how long to wait.

'use strict';
const fs = require('fs');
const path = require('path');
const { createTelegramClient } = require('./telegram-client');
const crypto = require('crypto');
const handshake = require('./telegram-handshake');

const ROOT = path.resolve(__dirname, '..');

// [label, regex tested against the command text (shell tools) or tool name + input (MCP tools)]
const DEFAULT_RULES = [
  ['send mail or invite', /\b(Send-OutlookMail|Send-OutlookReply|New-OutlookAppointment|Set-OutlookMeetingResponse)\b[^\n]*\s-Send\b/i],
  ['cluster write', /\b(oc|kubectl)(\.exe)?\s+(apply|create|delete|patch|replace|scale|edit|label|annotate|rollout|adm|exec|drain|cordon|set)\b/i],
  ['git history write', /\bgit\s+(push|reset\s+--hard|clean\s+-\w*f|branch\s+-D|rebase)\b/i],
  ['recursive delete', /\brm\s+-\w*(rf|fr)\w*\b|\bRemove-Item\b[^\n]*-Recurse|\brmdir\s+\/s\b|\brd\s+\/s\b/i],
  ['PowerShell remove', /\bRemove-(?!Variable\b|Module\b|Job\b|PSDrive\b|TypeData\b|Event\b)[A-Z]\w+/i],
  ['storage destructive', /\b(volume|vol|lun|snapmirror|vserver|aggr|aggregate|qtree|snapshot|igroup|export-policy)\b[^\n]*\b(delete|destroy|offline|break|restrict|remove)\b/i],
  ['account change', /\b(Disable|Enable|Unlock|Set)-ADAccount\w*|\bSet-ADAccountPassword\b|\bReset-\w*Password\b/i],
  ['stop or restart', /\b(Stop-Computer|Restart-Computer|Stop-Service|Restart-Service|Stop-VM|Restart-VM)\b|\bshutdown(\.exe)?\s+\/[rsp]\b|\bsystemctl\s+(stop|restart|disable)\b|\breboot\b/i],
  ['API write', /\b(Invoke-RestMethod|Invoke-WebRequest|irm|iwr)\b[^\n]*-Method\s+['"]?(Post|Put|Patch|Delete)\b|\bcurl(\.exe)?\b[^\n]*(-X\s*|--request\s+)['"]?(POST|PUT|PATCH|DELETE)\b/i],
];
// MCP tools whose name contains a changing verb as a whole word, so
// break_mirror and addCommentToIssue ask, while k8s_list_daemonsets
// and ipam_free_addresses do not. Telegram's own tools are exempt.
const MCP_WRITE_VERBS = new Set([
  'create', 'delete', 'update', 'send', 'post', 'put', 'patch', 'apply', 'remove', 'edit', 'write', 'set', 'add',
  'transition', 'approve', 'reject', 'break', 'initialize', 'init', 'restore', 'resync', 'resize', 'modify', 'rename',
  'move', 'migrate', 'revert', 'rollback', 'start', 'stop', 'restart', 'reboot', 'shutdown', 'poweroff', 'enable',
  'disable', 'mount', 'unmount', 'attach', 'detach', 'clone', 'split', 'abort', 'cancel', 'quiesce', 'resume',
  'promote', 'failover', 'reset', 'truncate', 'purge', 'wipe', 'execute', 'exec', 'invoke', 'upload',
  'import', 'assign', 'unassign', 'grant', 'revoke', 'lock', 'unlock', 'kill', 'terminate', 'destroy', 'offline',
  'online', 'restrict', 'drain', 'cordon', 'scale', 'deploy', 'install', 'uninstall', 'publish', 'merge', 'close',
  'reopen', 'archive', 'unarchive', 'release', 'snooze', 'acknowledge', 'ack', 'clear', 'flush', 'evacuate', 'evict',
]);

function mcpToolWords(toolName) {
  const tool = String(toolName).split('__').pop();
  return tool.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

function isMcpWriteTool(toolName) {
  if (/^mcp__telegram-tg__/i.test(toolName)) return false;
  return mcpToolWords(toolName).some(word => MCP_WRITE_VERBS.has(word));
}

function loadRuntime() {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'agent-runtime.json'), 'utf-8')).approval || {}; }
  catch (_) { return {}; }
}

function loadConfig() {
  const token = process.env.TELEGRAM_BOT_TOKEN, chat = process.env.TELEGRAM_CHAT_ID;
  if (token && chat && !token.startsWith('YOUR_')) return { bot_token: token, chat_id: chat };
  return JSON.parse(fs.readFileSync(path.join(ROOT, '.telegram-config'), 'utf-8'));
}

// Returns { label, text } when the call needs approval, else null.
function classify(toolName, input, extraPatterns) {
  const rules = [...DEFAULT_RULES, ...extraPatterns.map(p => [`custom: ${p}`, new RegExp(p, 'i')])];
  if (/^(Bash|PowerShell)$/.test(toolName)) {
    const text = String((input && input.command) || '');
    const hit = rules.find(([, re]) => re.test(text));
    return hit ? { label: hit[0], text } : null;
  }
  // The bot's own Telegram tools only talk to you; their message text may
  // quote a risky command without running it.
  if (/^mcp__telegram-tg__/i.test(toolName)) return null;
  if (toolName.startsWith('mcp__')) {
    const text = `${toolName} ${JSON.stringify(input || {})}`;
    if (isMcpWriteTool(toolName)) return { label: 'MCP write tool', text };
    const hit = rules.find(([, re]) => re.test(text));
    return hit ? { label: hit[0], text } : null;
  }
  return null;
}

function htmlEscape(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function decide(decision, reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision, permissionDecisionReason: reason },
  }));
  process.exit(0);
}

const YES = /^\s*(y|yes|ok|allow|approve|approved|go|כן|👍|✅)\s*[.!]?\s*$/i;
const NO = /^\s*(n|no|deny|denied|reject|stop|cancel|לא|👎|❌)\s*[.!]?\s*$/i;
const SESSION = /^\s*(session|this session|for this session)\s*[.!]?\s*$/i;
const ALWAYS = /^\s*(always|always allow)\s*[.!]?\s*$/i;

// Remembered approvals (.telegram-approvals.json, gitignored):
//   sessions[<Claude session id>] = rule labels allowed for that session
//     ("✅ This session": e.g. every git push in this conversation);
//   always = exact actions allowed for good ("🔁 Always": the shell command
//     text, or the MCP tool name).
const APPROVALS_FILE = path.join(ROOT, '.telegram-approvals.json');
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

function loadApprovals() {
  try {
    const data = JSON.parse(fs.readFileSync(APPROVALS_FILE, 'utf-8'));
    return { sessions: data.sessions || {}, always: Array.isArray(data.always) ? data.always : [] };
  } catch (_) { return { sessions: {}, always: [] }; }
}

function saveApprovals(data) {
  const now = Date.now();
  for (const [id, entry] of Object.entries(data.sessions)) {
    if (!entry.ts || now - Date.parse(entry.ts) > SESSION_TTL_MS) delete data.sessions[id];
  }
  const tmp = `${APPROVALS_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, APPROVALS_FILE);
}

// What "Always" remembers: an MCP tool by name, a shell command by its exact text.
function alwaysKey(toolName, match) {
  return toolName.startsWith('mcp__') ? toolName : match.text.trim();
}

function rememberedAllow(event, match) {
  const data = loadApprovals();
  const key = alwaysKey(String(event.tool_name || ''), match);
  const always = data.always.find(entry => entry.key === key);
  if (always) return `you chose Always on ${String(always.added).slice(0, 10)}`;
  const session = event.session_id && data.sessions[event.session_id];
  if (session && Array.isArray(session.labels) && session.labels.includes(match.label)) return `you allowed "${match.label}" for this session`;
  return null;
}

function remember(scope, event, match) {
  const data = loadApprovals();
  if (scope === 'session' && event.session_id) {
    const entry = data.sessions[event.session_id] || { labels: [] };
    if (!entry.labels.includes(match.label)) entry.labels.push(match.label);
    entry.ts = new Date().toISOString();
    data.sessions[event.session_id] = entry;
  } else if (scope === 'always') {
    const key = alwaysKey(String(event.tool_name || ''), match);
    if (!data.always.some(entry => entry.key === key)) data.always.push({ key, label: match.label, added: new Date().toISOString() });
  }
  saveApprovals(data);
}

async function main() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  const event = JSON.parse(raw || '{}');
  const settings = loadRuntime();
  if (settings.enabled === false) return process.exit(0);
  const match = classify(String(event.tool_name || ''), event.tool_input, Array.isArray(settings.extra_patterns) ? settings.extra_patterns : []);
  if (!match) return process.exit(0);
  const remembered = rememberedAllow(event, match);
  if (remembered) return decide('allow', `Allowed without asking: ${remembered}.`);

  const timeoutMs = Math.max(30, Math.min(3600, Number(settings.timeout_seconds) || 600)) * 1000;
  let config;
  try { config = loadConfig(); } catch (e) { return decide('deny', `Approval needed (${match.label}) but Telegram is not configured: ${e.message}`); }

  const telegram = createTelegramClient({ token: config.bot_token });
  const api = (method, params, httpTimeoutMs = 20000) => telegram.call(method, params, { httpTimeoutMs });

  const nonce = crypto.randomBytes(4).toString('hex');
  // From the environment, or, for a Claude process that stays running across messages, the daemon's current task.
  const replyTo = Number(process.env.TELEGRAM_REPLY_TO_MESSAGE_ID) || handshake.currentTaskReplyTo() || null;
  const shown = match.text.length > 1500 ? `${match.text.slice(0, 1500)}…` : match.text;
  const question = `🛡 <b>Approval needed</b> — ${htmlEscape(match.label)}\n<b>Tool:</b> <code>${htmlEscape(event.tool_name)}</code>\n<pre>${htmlEscape(shown)}</pre>\n`
    + `<i>Waiting ${Math.round(timeoutMs / 60000)} min, then denied. You can also reply yes / no / session / always, or 👍 / 👎.</i>`;

  handshake.setAskFlag(true);
  process.on('exit', () => handshake.setAskFlag(false));
  let sent;
  try {
    sent = await api('sendMessage', {
      chat_id: config.chat_id, text: question, parse_mode: 'HTML',
      reply_parameters: replyTo ? { message_id: replyTo, allow_sending_without_reply: true } : undefined,
      reply_markup: { inline_keyboard: [
        [
          { text: '✅ Allow once', callback_data: `ap:y:${nonce}`, style: 'success' },
          { text: '✅ This session', callback_data: `ap:s:${nonce}`, style: 'success' },
        ],
        [
          { text: '🔁 Always', callback_data: `ap:a:${nonce}`, style: 'primary' },
          { text: '❌ Deny', callback_data: `ap:n:${nonce}`, style: 'danger' },
        ],
      ] },
    });
  } catch (e) {
    return decide('deny', `Approval needed (${match.label}) but the Telegram request failed: ${e.message}`);
  }

  // answer: 'y' once, 's' this session, 'a' always, 'n' deny.
  const finish = async (answer, how) => {
    const allowed = answer !== 'n';
    if (answer === 's' || answer === 'a') remember(answer === 's' ? 'session' : 'always', event, match);
    const scope = answer === 's' ? ' for this session' : answer === 'a' ? ' — always' : '';
    const verdict = allowed ? `✅ <b>Allowed${scope}</b>` : '❌ <b>Denied</b>';
    await api('editMessageText', {
      chat_id: config.chat_id, message_id: sent.message_id, parse_mode: 'HTML',
      text: `${verdict} — ${htmlEscape(match.label)}\n<pre>${htmlEscape(shown)}</pre>\n<i>${htmlEscape(how)}</i>`,
    }).catch(() => {});
    // Mark the answer as read on Telegram, or the daemon would later run it as a new task.
    await api('getUpdates', { offset, timeout: 0, limit: 1 }, 5000).catch(() => {});
    return decide(allowed ? 'allow' : 'deny', allowed ? `Operator approved on Telegram (${how}).` : `Operator denied this on Telegram (${how}). Do not retry it; tell the user what was blocked.`);
  };

  // Start after everything the daemon already confirmed, so no update is skipped.
  let offset = 0;
  try { offset = JSON.parse(fs.readFileSync(path.join(ROOT, '.telegram-task-state.json'), 'utf-8')).updateOffset || 0; } catch (_) {}
  const textAnswer = (text) => (YES.test(text) ? 'y' : SESSION.test(text) ? 's' : ALWAYS.test(text) ? 'a' : NO.test(text) ? 'n' : null);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const handoff = handshake.takeHandoff();
    if (handoff && handoff.text) {
      const answer = textAnswer(handoff.text);
      if (answer != null) return finish(answer, `reply "${handoff.text.trim()}"`);
      handshake.forwardToDaemon(handoff);
    }
    let updates = [];
    try {
      updates = await api('getUpdates', { offset, timeout: 10, allowed_updates: ['message', 'callback_query'] }, 20000);
    } catch (_) { await new Promise(r => setTimeout(r, 2000)); continue; }
    for (const u of updates) {
      offset = u.update_id + 1;
      if (u.callback_query) {
        const cq = u.callback_query;
        const [tag, verdict, id] = String(cq.data || '').split(':');
        if (tag === 'ap' && id === nonce) {
          await api('answerCallbackQuery', { callback_query_id: cq.id }).catch(() => {});
          return finish(['y', 's', 'a'].includes(verdict) ? verdict : 'n', 'button');
        }
        continue; // someone else's buttons (an old tg_ask); not ours to answer
      }
      const m = u.message;
      if (!m || String(m.chat.id) !== String(config.chat_id)) continue;
      const answer = m.text ? textAnswer(m.text) : null;
      if (answer != null) return finish(answer, `reply "${m.text.trim()}"`);
      // /stop, /status, new tasks, photos: the daemon's business. /stop kills
      // this whole process tree, which ends the wait as a deny.
      handshake.forwardToDaemon(m);
    }
  }
  return finish('n', `no answer within ${Math.round(timeoutMs / 60000)} min`);
}

if (require.main === module) main().catch((e) => decide('deny', `Approval hook error: ${e.message}`));

module.exports = { classify, alwaysKey };

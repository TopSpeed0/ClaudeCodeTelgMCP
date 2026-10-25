'use strict';

const LOCAL_COMMANDS = new Set(['help', 'status', 'model', 'mcp', 'skills', 'clear', 'new', 'stop', 'retry', 'usage', 'queue', 'plan', 'bg']);
// Answered the moment they arrive, even while a task runs. /bg starts its own
// isolated session at once. Everything else (tasks and state-changing commands
// such as /clear, /model, /retry, /plan) waits its turn in the queue, so it
// never races the running task.
const IMMEDIATE_COMMANDS = new Set(['help', 'status', 'mcp', 'skills', 'stop', 'usage', 'queue', 'bg']);
const COMMAND_ALIASES = { new: 'clear' };
const TELEGRAM_COMMANDS = [
  { command: 'status', description: 'Daemon status and runtime' },
  { command: 'stop', description: 'Stop the task (/stop all: also the queue, /stop bg: side tasks)' },
  { command: 'queue', description: 'Running task and waiting messages' },
  { command: 'retry', description: 'Run your last message again' },
  { command: 'plan', description: 'Read-only run: look and propose, change nothing' },
  { command: 'bg', description: 'Side task in its own session, in parallel' },
  { command: 'usage', description: 'Cost, turns and time: last task and today' },
  { command: 'new', description: 'Start a fresh conversation (same as /clear)' },
  { command: 'model', description: 'Show or select an allowed model' },
  { command: 'mcp', description: 'Configured MCP connectors' },
  { command: 'skills', description: 'Installed skills (also refreshes this menu)' },
  { command: 'clear', description: 'Start a fresh conversation context' },
  { command: 'help', description: 'Show supported Telegram commands' },
];
const MAX_MENU_COMMANDS = 100; // Telegram's setMyCommands limit

function parseTelegramCommand(rawText) {
  const text = String(rawText || '').trim();
  // Telegram allows a leading digit (e.g. /3d_tools for a 3d-tools skill).
  const match = text.match(/^\/([a-z0-9][a-z0-9_-]*)(?:@[a-z0-9_]+)?(?:\s+([\s\S]*))?$/i);
  if (!match) return null;
  return { command: match[1].toLowerCase(), argument: (match[2] || '').trim() };
}

function isImmediateCommand(rawText) {
  const parsed = parseTelegramCommand(rawText);
  return !!parsed && IMMEDIATE_COMMANDS.has(parsed.command);
}

// Telegram command names allow only a-z, 0-9 and _ (1-32 chars), so a skill
// such as team-vm-manager is published as /team_vm_manager.
// Accents are folded (über-tool → uber_tool); a name with no Latin letters or
// digits at all (e.g. Hebrew) gets a stable skill_<hash> name instead.
function telegramCommandName(name) {
  const base = String(name).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '').slice(0, 32).replace(/_$/, '');
  if (base) return base;
  let hash = 0;
  for (const ch of String(name)) hash = (hash * 31 + ch.codePointAt(0)) >>> 0;
  return `skill_${hash.toString(36)}`;
}

// One short menu line from a SKILL.md: its frontmatter description up to the
// first sentence, and before any "TRIGGER when ..." keyword list.
function skillMenuDescription(skillMarkdown, name) {
  const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(String(skillMarkdown || ''));
  let text = '';
  if (front) {
    const lines = front[1].split(/\r?\n/);
    const at = lines.findIndex(line => /^description:/.test(line));
    if (at >= 0) {
      text = lines[at].replace(/^description:\s*/, '');
      if (!text || /^[>|][-+]?\s*$/.test(text)) {
        const block = [];
        for (const line of lines.slice(at + 1)) {
          if (!/^\s/.test(line)) break;
          block.push(line.trim());
        }
        text = block.join(' ');
      }
    }
  }
  text = text.replace(/^["']|["']$/g, '')
    .split(/\s+TRIGGER\b/)[0]
    .split(/(?<=\.)\s/)[0]
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) text = `Run the ${name} skill`;
  return `🧩 ${text.length > 90 ? `${text.slice(0, 89)}…` : text}`;
}

// Menu-safe names in input order. A name already taken (a built-in such as
// /status, foo-bar next to foo_bar, two long names cut to the same 32
// characters) gets a _2, _3 … suffix, so nothing disappears. Deterministic
// for the same input, which routing relies on.
function assignCommandNames(names, taken) {
  return names.map((name) => {
    const base = telegramCommandName(name);
    let command = base;
    for (let n = 2; taken.has(command); n++) command = `${base.slice(0, 32 - String(n).length - 1)}_${n}`;
    taken.add(command);
    return { name: String(name), command };
  });
}

const builtinNames = () => new Set(TELEGRAM_COMMANDS.map(item => item.command));

// MCP servers come right after the built-ins and keep their own names (/storage).
function mcpCommandNames(mcpNames = []) {
  return assignCommandNames(mcpNames, builtinNames());
}

// Skills come after the MCP servers.
function skillCommandNames(skillNames, mcpNames = []) {
  const taken = builtinNames();
  for (const { command } of mcpCommandNames(mcpNames)) taken.add(command);
  return assignCommandNames(skillNames, taken);
}

// The full "/" menu: built-in commands, then MCP servers, then skills (each
// { name, description }). Telegram accepts at most 100 commands; entries that
// do not fit are returned in `left` so the caller can say so.
function buildCommandMenu(skills = [], mcpServers = []) {
  const commands = [...TELEGRAM_COMMANDS];
  const left = [];
  const add = (entry, command, fallback) => {
    if (commands.length >= MAX_MENU_COMMANDS) { left.push(entry.name); return; }
    commands.push({ command, description: entry.description || fallback });
  };
  const mcpNames = mcpServers.map(server => server.name);
  mcpCommandNames(mcpNames).forEach(({ command }, i) => add(mcpServers[i], command, `🔌 ${mcpServers[i].name} MCP server`));
  skillCommandNames(skills.map(skill => skill.name), mcpNames)
    .forEach(({ command }, i) => add(skills[i], command, `🧩 Run the ${skills[i].name} skill`));
  return Object.assign(commands, { left });
}

async function routeTelegramCommand(rawText, { skillNames = [], mcpNames = [], handlers = {} } = {}) {
  const parsed = parseTelegramCommand(rawText);
  if (!parsed) return { handled: false };

  const { command, argument } = parsed;
  if (LOCAL_COMMANDS.has(command)) {
    const handler = handlers[COMMAND_ALIASES[command] || command];
    if (typeof handler !== 'function') {
      return { handled: true, reply: `Command /${command} is unavailable in this daemon.` };
    }
    return { handled: true, reply: await handler(argument, parsed) };
  }

  const mcpServer = (mcpCommandNames(mcpNames).find(entry => entry.command === command) || {}).name;
  if (mcpServer) return { handled: false, mcpServer, argument };

  // Tapped in the menu as /team_vm_manager (menu names win), or typed
  // with the real name as /team-vm-manager.
  const skill = (skillCommandNames(skillNames, mcpNames).find(entry => entry.command === command) || {}).name
    || skillNames.find(name => String(name).toLowerCase() === command);
  if (skill) return { handled: false, skillCommand: String(skill), argument };

  return { handled: true, reply: `Unknown Telegram command: /${command}\nUse /help for supported commands.` };
}

module.exports = {
  LOCAL_COMMANDS, IMMEDIATE_COMMANDS, TELEGRAM_COMMANDS,
  parseTelegramCommand, isImmediateCommand, routeTelegramCommand,
  telegramCommandName, mcpCommandNames, skillCommandNames, skillMenuDescription, buildCommandMenu,
};

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
  { command: 'skills', description: 'Installed skills' },
  { command: 'clear', description: 'Start a fresh conversation context' },
  { command: 'help', description: 'Show supported Telegram commands' },
];

function parseTelegramCommand(rawText) {
  const text = String(rawText || '').trim();
  const match = text.match(/^\/([a-z][a-z0-9_-]*)(?:@[a-z0-9_]+)?(?:\s+([\s\S]*))?$/i);
  if (!match) return null;
  return { command: match[1].toLowerCase(), argument: (match[2] || '').trim() };
}

function isImmediateCommand(rawText) {
  const parsed = parseTelegramCommand(rawText);
  return !!parsed && IMMEDIATE_COMMANDS.has(parsed.command);
}

async function routeTelegramCommand(rawText, { skillNames = [], handlers = {} } = {}) {
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

  const normalizedSkills = new Set(skillNames.map(name => String(name).toLowerCase()));
  if (normalizedSkills.has(command)) return { handled: false, skillCommand: command };

  return { handled: true, reply: `Unknown Telegram command: /${command}\nUse /help for supported commands.` };
}

module.exports = { LOCAL_COMMANDS, IMMEDIATE_COMMANDS, TELEGRAM_COMMANDS, parseTelegramCommand, isImmediateCommand, routeTelegramCommand };

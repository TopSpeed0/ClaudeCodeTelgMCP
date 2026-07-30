'use strict';

const LOCAL_COMMANDS = new Set(['help', 'status', 'model', 'mcp', 'skills', 'clear']);
const TELEGRAM_COMMANDS = [
  { command: 'status', description: 'Daemon status and runtime' },
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

async function routeTelegramCommand(rawText, { skillNames = [], handlers = {} } = {}) {
  const parsed = parseTelegramCommand(rawText);
  if (!parsed) return { handled: false };

  const { command, argument } = parsed;
  if (LOCAL_COMMANDS.has(command)) {
    const handler = handlers[command];
    if (typeof handler !== 'function') {
      return { handled: true, reply: `Command /${command} is unavailable in this daemon.` };
    }
    return { handled: true, reply: await handler(argument, parsed) };
  }

  const normalizedSkills = new Set(skillNames.map(name => String(name).toLowerCase()));
  if (normalizedSkills.has(command)) return { handled: false, skillCommand: command };

  return { handled: true, reply: `Unknown Telegram command: /${command}\nUse /help for supported commands.` };
}

module.exports = { LOCAL_COMMANDS, TELEGRAM_COMMANDS, parseTelegramCommand, routeTelegramCommand };

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseTelegramCommand, routeTelegramCommand } = require('../mcp/telegram-command-router');

test('parses local commands, arguments, and bot mentions', () => {
  assert.deepEqual(parseTelegramCommand('/MODEL claude-opus-5'), { command: 'model', argument: 'claude-opus-5' });
  assert.deepEqual(parseTelegramCommand('/status@my_bot'), { command: 'status', argument: '' });
  assert.equal(parseTelegramCommand('status'), null);
});

test('handles local commands without forwarding them to an agent', async () => {
  const result = await routeTelegramCommand('/status', { handlers: { status: async () => 'healthy' } });
  assert.deepEqual(result, { handled: true, reply: 'healthy' });
});

test('forwards only installed skill commands', async () => {
  const skill = await routeTelegramCommand('/workspace-kvm-manager', { skillNames: ['workspace-kvm-manager'] });
  assert.deepEqual(skill, { handled: false, skillCommand: 'workspace-kvm-manager' });
  const unknown = await routeTelegramCommand('/invented-cli-command', { skillNames: ['workspace-kvm-manager'] });
  assert.equal(unknown.handled, true);
  assert.match(unknown.reply, /Unknown Telegram command/);
});

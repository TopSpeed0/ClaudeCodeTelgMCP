'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { TELEGRAM_COMMANDS, parseTelegramCommand, isImmediateCommand, routeTelegramCommand } = require('../mcp/telegram-command-router');

test('parses local commands, arguments, and bot mentions', () => {
  assert.deepEqual(parseTelegramCommand('/MODEL claude-opus-5-5'), { command: 'model', argument: 'claude-opus-5-5' });
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

test('routes /new to the clear handler', async () => {
  const result = await routeTelegramCommand('/new', { handlers: { clear: () => 'cleared' } });
  assert.deepEqual(result, { handled: true, reply: 'cleared' });
});

test('answers control commands immediately and queues the rest', () => {
  for (const text of ['/stop', '/stop all', '/queue', '/status', '/usage@my_bot', '/bg check disks']) assert.equal(isImmediateCommand(text), true, text);
  for (const text of ['/clear', '/new', '/model x', '/retry', '/plan fix it', '/workspace-kvm-manager', 'stop']) assert.equal(isImmediateCommand(text), false, text);
});

test('publishes the exact local Telegram command menu', () => {
  assert.deepEqual(TELEGRAM_COMMANDS.map(item => item.command), ['status', 'stop', 'queue', 'retry', 'plan', 'bg', 'usage', 'new', 'model', 'mcp', 'skills', 'clear', 'help']);
  for (const item of TELEGRAM_COMMANDS) {
    assert.match(item.command, /^[a-z0-9_]{1,32}$/);
    assert.ok(item.description.length > 0 && item.description.length <= 256);
  }
});

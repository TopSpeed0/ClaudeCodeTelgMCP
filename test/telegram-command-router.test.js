'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  TELEGRAM_COMMANDS, parseTelegramCommand, isImmediateCommand, routeTelegramCommand,
  telegramCommandName, mcpCommandNames, skillCommandNames, skillMenuDescription, buildCommandMenu,
} = require('../mcp/telegram-command-router');

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
  const skill = await routeTelegramCommand('/team-vm-manager', { skillNames: ['team-vm-manager'] });
  assert.deepEqual(skill, { handled: false, skillCommand: 'team-vm-manager', argument: '' });
  const unknown = await routeTelegramCommand('/invented-cli-command', { skillNames: ['team-vm-manager'] });
  assert.equal(unknown.handled, true);
  assert.match(unknown.reply, /Unknown Telegram command/);
});

test('maps menu-safe skill names back to the real skill', async () => {
  assert.equal(telegramCommandName('team-vm-manager'), 'team_vm_manager');
  assert.equal(telegramCommandName('Vault-Certificate'), 'vault_certificate');
  const tapped = await routeTelegramCommand('/build_cli list jobs', { skillNames: ['build-CLI'] });
  assert.deepEqual(tapped, { handled: false, skillCommand: 'build-CLI', argument: 'list jobs' });
  const digitFirst = await routeTelegramCommand('/3d_tools', { skillNames: ['3d-tools'] });
  assert.deepEqual(digitFirst, { handled: false, skillCommand: '3d-tools', argument: '' });
});

test('takes a one-line menu description from SKILL.md frontmatter', () => {
  const inline = '---\nname: x\ndescription: Read-only DNS audit for AD. TRIGGER when user mentions DNS.\n---\n# x';
  assert.equal(skillMenuDescription(inline, 'x'), '🧩 Read-only DNS audit for AD.');
  const folded = '---\r\nname: y\r\ndescription: >\r\n  Refresh the cloud OAuth session. Use when a\r\n  tool returns 401.\r\n---\r\n';
  assert.equal(skillMenuDescription(folded, 'y'), '🧩 Refresh the cloud OAuth session.');
  assert.equal(skillMenuDescription('# no frontmatter', 'z'), '🧩 Run the z skill');
  assert.ok(skillMenuDescription(`---\ndescription: ${'a'.repeat(300)}\n---`, 'w').length <= 93);
});

test('adds every skill to the menu within Telegram limits', () => {
  const skills = Array.from({ length: 120 }, (_, i) => ({ name: `skill-${i}`, description: `🧩 skill ${i}` }));
  const menu = buildCommandMenu([{ name: 'status', description: 'clash' }, ...skills]);
  assert.equal(menu.length, 100);
  assert.equal(menu.filter(item => item.command === 'status').length, 1);
  assert.equal(menu[TELEGRAM_COMMANDS.length].command, 'status_2');
  assert.equal(menu.left.length, 121 - (100 - TELEGRAM_COMMANDS.length));
  for (const item of menu) assert.match(item.command, /^[a-z0-9_]{1,32}$/);
});

test('keeps the menu under Telegram\'s total text cap by shortening descriptions', () => {
  const size = (menu) => menu.reduce((n, item) => n + item.command.length + item.description.length, 0);
  const wordy = Array.from({ length: 70 }, (_, i) => ({ name: `skill-${i}`, description: `🧩 ${'Long description of what this skill does. '.repeat(3)}` }));
  const menu = buildCommandMenu(wordy);
  assert.equal(menu.length, TELEGRAM_COMMANDS.length + 70, 'nothing dropped while shortening is enough');
  assert.ok(size(menu) <= 5800, `size ${size(menu)}`);
  assert.deepEqual(menu.slice(0, TELEGRAM_COMMANDS.length), TELEGRAM_COMMANDS, 'built-in descriptions untouched');
  assert.match(menu[menu.length - 1].description, /…$/);
  const huge = buildCommandMenu(Array.from({ length: 79 }, (_, i) => ({ name: `a-very-long-skill-name-number-${i}`, description: `🧩 ${'x'.repeat(90)}` })));
  assert.ok(size(huge) <= 5800, `size ${size(huge)}`);
  assert.equal(huge.length + huge.left.length, TELEGRAM_COMMANDS.length + 79, 'what does not fit is reported in left');
});

test('lists MCP servers by their own names, before skills', async () => {
  const mcp = [{ name: 'storage', description: '🔌 MCP · 11 tools' }, { name: 'hypervisor_lab', description: '🔌 MCP · 25 tools' }];
  const menu = buildCommandMenu([{ name: 'storage', description: '🧩 a skill named storage' }, { name: 'net-audit' }], mcp);
  const after = menu.slice(TELEGRAM_COMMANDS.length).map(item => item.command);
  assert.deepEqual(after, ['storage', 'hypervisor_lab', 'storage_2', 'net_audit']);
  const opts = { skillNames: ['storage', 'net-audit'], mcpNames: ['storage', 'hypervisor_lab'] };
  assert.deepEqual(await routeTelegramCommand('/storage list volumes', opts), { handled: false, mcpServer: 'storage', argument: 'list volumes' });
  assert.deepEqual(await routeTelegramCommand('/storage_2', opts), { handled: false, skillCommand: 'storage', argument: '' });
  assert.deepEqual(await routeTelegramCommand('/hypervisor_lab', opts), { handled: false, mcpServer: 'hypervisor_lab', argument: '' });
  assert.deepEqual(mcpCommandNames(['status']), [{ name: 'status', command: 'status_2' }]);
});

test('never drops a skill because of its name', async () => {
  const long = 'very-long-skill-name-that-goes-past-thirty-two';
  const names = ['foo-bar', 'foo_bar', `${long}-a`, `${long}-b`, 'über-tool', 'תוכנה', 'status'];
  const named = skillCommandNames(names);
  const commands = named.map(entry => entry.command);
  assert.equal(new Set(commands).size, names.length);
  for (const command of commands) assert.match(command, /^[a-z0-9_]{1,32}$/);
  assert.deepEqual(commands.slice(0, 2), ['foo_bar', 'foo_bar_2']);
  assert.equal(commands[4], 'uber_tool');
  assert.match(commands[5], /^skill_[a-z0-9]+$/);
  assert.equal(commands[6], 'status_2');
  for (const { name, command } of named) {
    const routed = await routeTelegramCommand(`/${command} go`, { skillNames: names });
    assert.deepEqual(routed, { handled: false, skillCommand: name, argument: 'go' }, command);
  }
  const typed = await routeTelegramCommand('/foo-bar', { skillNames: names });
  assert.equal(typed.skillCommand, 'foo-bar');
});

test('routes /new to the clear handler', async () => {
  const result = await routeTelegramCommand('/new', { handlers: { clear: () => 'cleared' } });
  assert.deepEqual(result, { handled: true, reply: 'cleared' });
});

test('routes /refresh to its own handler, not to clear', async () => {
  const result = await routeTelegramCommand('/refresh', { handlers: { clear: () => 'cleared', refresh: () => 'refreshed' } });
  assert.deepEqual(result, { handled: true, reply: 'refreshed' });
});

test('answers control commands immediately and queues the rest', () => {
  for (const text of ['/stop', '/stop all', '/queue', '/status', '/usage@my_bot', '/doctor', '/bg check disks', '/remind 45m check', '/every list', '/search a1k-prd', '/progress quiet']) assert.equal(isImmediateCommand(text), true, text);
  for (const text of ['/clear', '/new', '/refresh', '/compact', '/model x', '/retry', '/plan fix it', '/team-vm-manager', 'stop']) assert.equal(isImmediateCommand(text), false, text);
});

test('publishes the exact local Telegram command menu', () => {
  assert.deepEqual(TELEGRAM_COMMANDS.map(item => item.command), ['status', 'stop', 'queue', 'retry', 'plan', 'bg', 'remind', 'every', 'search', 'usage', 'doctor', 'progress', 'compact', 'refresh', 'new', 'model', 'mcp', 'skills', 'clear', 'help']);
  for (const item of TELEGRAM_COMMANDS) {
    assert.match(item.command, /^[a-z0-9_]{1,32}$/);
    assert.ok(item.description.length > 0 && item.description.length <= 256);
  }
});

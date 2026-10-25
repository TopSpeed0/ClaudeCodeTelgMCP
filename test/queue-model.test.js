'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveQueueModel } = require('../mcp/queue-model');

const allowed = ['claude-haiku-4.5', 'claude-sonnet-5', 'claude-opus-5-5'];

test('uses the daemon default when a queue task omits model', () => {
  assert.equal(resolveQueueModel(undefined, allowed, 'claude-sonnet-5'), 'claude-sonnet-5');
});

test('uses an allow-listed queue model without changing its canonical spelling', () => {
  assert.equal(resolveQueueModel('claude-opus-5-5', allowed, 'claude-sonnet-5'), 'claude-opus-5-5');
});

test('rejects untrusted queue model values before an agent is spawned', () => {
  assert.throws(() => resolveQueueModel('not-a-model', allowed, 'claude-sonnet-5'), /local allow-list/);
  assert.throws(() => resolveQueueModel(42, allowed, 'claude-sonnet-5'), /must be a string/);
});

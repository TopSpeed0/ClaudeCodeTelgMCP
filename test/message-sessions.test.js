'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { noteMessage, sessionOfMessage } = require('../mcp/message-sessions');

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'msg-sessions-')), 'archive', 'message-sessions.jsonl');

test('finds the session of a relayed answer and of a tg_send message', () => {
  const file = tmpFile();
  noteMessage({ bot: 101, session: 'S1' }, file);
  noteMessage({ bot: 202, task: 50 }, file); // tg_send while answering message 50
  noteMessage({ task: 50, session: 'S2' }, file);
  assert.equal(sessionOfMessage(101, file).session, 'S1');
  assert.equal(sessionOfMessage('202', file).session, 'S2');
  assert.equal(sessionOfMessage(303, file), null, 'unknown message');
  assert.ok(sessionOfMessage(101, file).ts, 'keeps when it was sent');
});

test('the newest fact wins, and a missing file is no error', () => {
  const file = tmpFile();
  noteMessage({ task: 7, session: 'OLD' }, file);
  noteMessage({ bot: 8, task: 7 }, file);
  noteMessage({ task: 7, session: 'NEW' }, file); // /retry answered it again
  assert.equal(sessionOfMessage(8, file).session, 'NEW');
  assert.equal(sessionOfMessage(1, path.join(os.tmpdir(), 'no-such-dir-xyz', 'x.jsonl')), null);
  noteMessage(null, file);
  noteMessage({}, file);
  assert.equal(fs.readFileSync(file, 'utf8').trim().split('\n').length, 3, 'empty facts are not written');
});

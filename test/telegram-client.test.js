'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { createTelegramClient } = require('../mcp/telegram-client');

// A fake Bot API: each method answers from a script of responses, one per call.
async function fakeTelegram(script) {
  const calls = [];
  const server = http.createServer((req, res) => {
    const method = req.url.split('/').pop();
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      calls.push({ method, body, at: Date.now() });
      const next = (script[method] || []).shift() || { ok: true, result: true };
      if (next === 'reset') { req.socket.destroy(); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(next));
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const client = createTelegramClient({ token: 'T', baseUrl: `http://127.0.0.1:${server.address().port}` });
  return { client, calls, close: () => new Promise(r => server.close(r)) };
}

test('waits out a 429 and then delivers', async () => {
  const t = await fakeTelegram({ sendMessage: [
    { ok: false, error_code: 429, description: 'Too Many Requests: retry after 1', parameters: { retry_after: 1 } },
    { ok: true, result: { message_id: 7 } },
  ] });
  const t0 = Date.now();
  const result = await t.client.call('sendMessage', { chat_id: 1, text: 'hi' });
  assert.equal(result.message_id, 7);
  assert.ok(Date.now() - t0 >= 900, 'waited for retry_after');
  assert.equal(t.calls.length, 2);
  await t.close();
});

test('low-priority calls give up on 429 instead of waiting', async () => {
  const t = await fakeTelegram({ sendChatAction: [{ ok: false, error_code: 429, description: 'Too Many Requests', parameters: { retry_after: 30 } }] });
  await assert.rejects(t.client.call('sendChatAction', { chat_id: 1, action: 'typing' }, { lowPriority: true }), e => e.errorCode === 429);
  assert.equal(t.calls.length, 1);
  await t.close();
});

test('retries a dropped connection for edits but never resends a message', async () => {
  const t = await fakeTelegram({ editMessageText: ['reset', { ok: true, result: true }], sendMessage: ['reset'] });
  assert.equal(await t.client.call('editMessageText', { chat_id: 1, message_id: 2, text: 'x' }), true);
  assert.equal(t.calls.filter(c => c.method === 'editMessageText').length, 2);
  await assert.rejects(t.client.call('sendMessage', { chat_id: 1, text: 'x' }));
  assert.equal(t.calls.filter(c => c.method === 'sendMessage').length, 1, 'a send that may have arrived is not repeated');
  await t.close();
});

test('flags formatting errors and keeps the old error message shape', async () => {
  const t = await fakeTelegram({ sendMessage: [{ ok: false, error_code: 400, description: "Bad Request: can't parse entities: unsupported start tag" }] });
  await assert.rejects(t.client.call('sendMessage', { chat_id: 1, text: '<x>', parse_mode: 'HTML' }), (e) => {
    assert.equal(e.isParseError, true);
    assert.match(e.message, /^sendMessage: Bad Request/);
    return true;
  });
  assert.equal(t.calls.length, 1, 'a 400 is not retried');
  await t.close();
});

test('sends to one chat go out in order, one at a time', async () => {
  const t = await fakeTelegram({});
  await Promise.all([1, 2, 3].map(n => t.client.call('sendMessage', { chat_id: 5, text: String(n) })));
  assert.deepEqual(t.calls.map(c => JSON.parse(c.body).text), ['1', '2', '3']);
  await t.close();
});

test('retries a connection that never got through, for sends too', async () => {
  const client = createTelegramClient({ token: 'T', baseUrl: 'http://no-such-host.invalid' });
  const t0 = Date.now();
  await assert.rejects(client.call('sendMessage', { chat_id: 1, text: 'x' }), /ENOTFOUND|EAI_AGAIN/);
  assert.ok(Date.now() - t0 >= 6500, 'backed off 1 + 2 + 4 s before giving up');
});

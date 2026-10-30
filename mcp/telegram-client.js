'use strict';
// One Telegram Bot API client for the daemon, the MCP server and the approval
// hook (each process makes its own instance). It adds what a bare
// https.request lacks:
//   - a timeout on every call (30 s unless the caller sets one);
//   - retries with backoff (1 s, 2 s, 4 s) on network errors. Calls that are
//     safe to repeat (reads, edits, reactions, deletes, polling) retry on any
//     network error; sends retry only when the connection never got through
//     (DNS, refused, unreachable), because a reset after the request went
//     out may mean Telegram already delivered the message;
//   - Telegram's 429 "Too Many Requests": waits the retry_after it gives,
//     unless the call is lowPriority (typing, status edits), which fail
//     fast instead of holding up real answers;
//   - sends, edits and deletes to the same chat go out one at a time.
// Errors keep the old "<method>: <description>" message and carry
// .errorCode, .retryAfter and .isParseError.

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

const DEFAULT_TIMEOUT_MS = 30000;
const MAX_ATTEMPTS = 4; // the first try plus 3 retries
const MAX_429_WAIT_S = 60;
const CONNECT_ERRORS = /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ENETUNREACH|EHOSTUNREACH|ENETDOWN/;
const NETWORK_ERRORS = /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ENETUNREACH|EHOSTUNREACH|ENETDOWN|ECONNRESET|ETIMEDOUT|EPIPE|socket hang up|HTTP timeout|network/i;
const PARSE_ERROR = /can't parse entities|can't find end tag|unsupported start tag|unexpected end tag|can't parse message text|entity beginning/i;
const SAFE_TO_REPEAT = /^(get|edit|delete|set|answer|sendChatAction$)/;
const PER_CHAT = /^(send|edit|delete|copy|forward)/;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function telegramError(method, description, extra = {}) {
  const error = new Error(`${method}: ${description}`);
  error.description = description;
  error.isParseError = PARSE_ERROR.test(description);
  return Object.assign(error, extra);
}

// baseUrl is for tests; real use talks to https://api.telegram.org.
function createTelegramClient({ token, baseUrl = 'https://api.telegram.org', log = () => {} } = {}) {
  const base = new URL(baseUrl);
  const transport = base.protocol === 'http:' ? http : https;
  const chatQueues = new Map();

  // One HTTP attempt. Resolves the result or rejects with a telegramError
  // (API answered) or a plain network error (it did not).
  function attempt(method, { body, headers }, timeoutMs) {
    return new Promise((resolve, reject) => {
      const req = transport.request({
        protocol: base.protocol, hostname: base.hostname, port: base.port || undefined,
        path: `${base.pathname.replace(/\/$/, '')}/bot${token}/${method}`,
        method: 'POST', headers: { ...headers, 'Content-Length': body.length },
      }, (res) => {
        const chunks = [];
        res.on('data', c => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c))));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf-8');
          let parsed;
          try { parsed = JSON.parse(raw); }
          catch (_) { return reject(telegramError(method, `HTTP ${res.statusCode}, not JSON: ${raw.slice(0, 150)}`, { httpStatus: res.statusCode })); }
          if (parsed.ok) return resolve(parsed.result);
          reject(telegramError(method, parsed.description || raw.slice(0, 200), {
            errorCode: parsed.error_code,
            retryAfter: parsed.parameters && parsed.parameters.retry_after,
          }));
        });
      });
      req.on('error', reject);
      req.setTimeout(timeoutMs, () => req.destroy(new Error(`${method} HTTP timeout after ${timeoutMs}ms`)));
      req.end(body);
    });
  }

  async function withRetries(method, payload, { httpTimeoutMs, lowPriority = false } = {}) {
    const timeoutMs = httpTimeoutMs || DEFAULT_TIMEOUT_MS;
    for (let tryNo = 1; ; tryNo++) {
      try {
        return await attempt(method, payload, timeoutMs);
      } catch (e) {
        const last = tryNo >= MAX_ATTEMPTS;
        if (e.errorCode === 429) {
          const wait = Math.max(1, Number(e.retryAfter) || 1);
          if (lowPriority || last || wait > MAX_429_WAIT_S) throw e;
          log(`telegram ${method}: rate limited, waiting ${wait}s`);
          await sleep(wait * 1000);
          continue;
        }
        if (e.errorCode >= 500 && !last) { await sleep(1000 * 2 ** (tryNo - 1)); continue; }
        if (e.errorCode || last) throw e; // the API answered: retrying will not change it
        const message = `${e.code || ''} ${e.message}`;
        const retryable = SAFE_TO_REPEAT.test(method) ? NETWORK_ERRORS.test(message) : CONNECT_ERRORS.test(message);
        if (!retryable) throw e;
        log(`telegram ${method}: ${message.trim()} — retry ${tryNo}/${MAX_ATTEMPTS - 1}`);
        await sleep(1000 * 2 ** (tryNo - 1));
      }
    }
  }

  // Sends, edits and deletes to one chat run one after another, so a burst
  // (answer chunks plus status edits) does not trip Telegram's flood limit.
  function serialized(chatId, run) {
    if (chatId == null) return run();
    const key = String(chatId);
    const previous = chatQueues.get(key) || Promise.resolve();
    const next = previous.catch(() => {}).then(run);
    chatQueues.set(key, next);
    next.finally(() => { if (chatQueues.get(key) === next) chatQueues.delete(key); }).catch(() => {});
    return next;
  }

  function call(method, params = {}, options = {}) {
    const body = Buffer.from(JSON.stringify(params));
    const payload = { body, headers: { 'Content-Type': 'application/json' } };
    const run = () => withRetries(method, payload, options);
    return PER_CHAT.test(method) ? serialized(params.chat_id, run) : run();
  }

  // multipart/form-data upload of one file; other fields are strings (JSON
  // for objects such as reply_markup).
  function multipart(method, fields, fileField, filePath, options = {}) {
    let fileBuf;
    try { fileBuf = fs.readFileSync(filePath); }
    catch (e) { return Promise.reject(new Error(`Cannot read file "${filePath}": ${e.message}`)); }
    const boundary = `----telegramClient${Date.now()}${Math.random().toString(16).slice(2)}`;
    const parts = [];
    for (const [k, v] of Object.entries(fields)) {
      if (v === undefined || v === null) continue;
      const value = typeof v === 'object' ? JSON.stringify(v) : String(v);
      parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${value}\r\n`));
    }
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${fileField}"; filename="${path.basename(filePath)}"\r\nContent-Type: application/octet-stream\r\n\r\n`));
    parts.push(fileBuf, Buffer.from(`\r\n--${boundary}--\r\n`));
    const payload = { body: Buffer.concat(parts), headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` } };
    return serialized(fields.chat_id, () => withRetries(method, payload, { httpTimeoutMs: 120000, ...options }));
  }

  return { call, multipart };
}

module.exports = { createTelegramClient, telegramError };

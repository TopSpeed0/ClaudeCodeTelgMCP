#!/usr/bin/env node
// telegram-tg.js — Zero-dependency Telegram MCP server (stdio).
// Exposes these tools to the agent:
//   tg_send   — one-way notification (optionally attach a file via file_path)
//   tg_ask    — send a question and block until the user replies (optional
//               inline-keyboard quick replies via choices[]; empty = silent poll)
//   tg_edit   — edit a previously sent message in place (progress updates)
//   tg_react  — put an emoji reaction on a message (lightweight acknowledge)
//   tg_typing — show typing indicator
//
// Config resolution (first match wins):
//   1. Env vars TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID
//   2. JSON file at <workspace>/.telegram-config:
//        { "bot_token": "...", "chat_id": "..." }
//
// Protocol: JSON-RPC 2.0 over stdio (MCP 2024-11-05).
// All non-protocol output (errors, debug) goes to stderr — never stdout.

'use strict';

// Re-exec with --use-system-ca when launched without it (corporate TLS proxy workaround).
if (!process.execArgv.includes('--use-system-ca')) {
  const { spawn } = require('child_process');
  const child = spawn(process.execPath, ['--use-system-ca', ...process.execArgv, __filename, ...process.argv.slice(2)], { stdio: 'inherit' });
  child.on('exit', (code) => process.exit(code ?? 1));
  return;
}

const fs = require('fs');
const path = require('path');
const { createTelegramClient } = require('./telegram-client');
const { MESSAGE_EFFECTS, copyKeyboard, choiceStyle, htmlPage } = require('./telegram-ui');
const readline = require('readline');

// ---------- Config ----------
function loadConfig() {
  const envToken = process.env.TELEGRAM_BOT_TOKEN;
  const envChat  = process.env.TELEGRAM_CHAT_ID;
  const isPlaceholder = (v) => !v || v.startsWith('YOUR_');
  if (envToken && envChat && !isPlaceholder(envToken) && !isPlaceholder(envChat)) {
    return { bot_token: envToken, chat_id: envChat };
  }
  const cfgPath = path.join(process.cwd(), '.telegram-config');
  if (!fs.existsSync(cfgPath)) {
    throw new Error(
      `No Telegram config. Set TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID env vars, ` +
      `or create ${cfgPath} with {"bot_token":"...","chat_id":"..."}.`
    );
  }
  const raw = fs.readFileSync(cfgPath, 'utf-8');
  const cfg = JSON.parse(raw);
  if (!cfg.bot_token || !cfg.chat_id) {
    throw new Error(`${cfgPath} must contain "bot_token" and "chat_id".`);
  }
  return cfg;
}

let config;
try {
  config = loadConfig();
} catch (e) {
  process.stderr.write(`[telegram-tg] ${e.message}\n`);
  process.exit(1);
}

// Persistent state for update offset (so replies aren't double-consumed).
const stateFile = path.join(process.cwd(), '.telegram-state.json');
let updateOffset = 0;
try {
  const s = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
  updateOffset = s.updateOffset || 0;
} catch (_) { /* first run */ }

function saveState() {
  try { fs.writeFileSync(stateFile, JSON.stringify({ updateOffset })); } catch (_) {}
}

// ---------- Telegram API ----------
// Shared client (telegram-client.js): timeouts, retries, 429 handling.
const telegram = createTelegramClient({
  token: config.bot_token,
  log: (msg) => process.stderr.write(`[telegram-tg] ${msg}\n`),
});
function tgApi(method, params, options) { return telegram.call(method, params, options); }
function tgApiMultipart(method, fields, fileField, filePath, options) { return telegram.multipart(method, fields, fileField, filePath, options); }

// Pick the right Telegram method + form field based on file extension.
function pickFileMethod(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(ext)) return { method: 'sendPhoto', field: 'photo' };
  if (ext === '.ogg') return { method: 'sendVoice', field: 'voice' };
  if (['.mp4', '.mov'].includes(ext)) return { method: 'sendVideo', field: 'video' };
  if (['.mp3', '.m4a', '.wav', '.flac'].includes(ext)) return { method: 'sendAudio', field: 'audio' };
  return { method: 'sendDocument', field: 'document' };
}

// Handshake with telegram-task-daemon.js: while tg_ask waits it owns getUpdates
// and the daemon pauses; see telegram-handshake.js.
const { setAskFlag, takeHandoff, forwardToDaemon, currentTaskReplyTo } = require('./telegram-handshake');
const { noteMessage } = require('./message-sessions');

// The Telegram message the daemon's current task answers: from the
// environment (a Claude process started for one task) or from the daemon's
// current-task file (a Claude process that stays running across messages).
// The first tg_send of each task is threaded under it, and tg_react
// defaults to it.
const ENV_REPLY_TO = Number(process.env.TELEGRAM_REPLY_TO_MESSAGE_ID) || null;
const UNDER_DAEMON = Boolean(ENV_REPLY_TO || process.env.TELEGRAM_UNDER_DAEMON);
function taskReplyTo() { return ENV_REPLY_TO || (UNDER_DAEMON ? currentTaskReplyTo() : null); }
// A message sent while answering a daemon task: remember which task, so a
// later reply to it can continue in the conversation that wrote it.
function noteAnswer(msg, task, chatId) {
  if (msg && msg.message_id && task != null && String(chatId) === String(config.chat_id)) noteMessage({ bot: msg.message_id, task });
}
let threadedTask = null; // the task whose first tg_send is already threaded

// Tracks the most recent inbound message id so tg_react can default to it.
let lastReceivedMessageId = null;
const { isImmediateCommand } = require('./telegram-command-router');

process.on('exit', () => setAskFlag(false));

// ---------- Tool implementations ----------
// Accepted parse_mode values per Telegram Bot API.
const PARSE_MODES = new Set(['HTML', 'MarkdownV2', 'Markdown']);

function normalizeParseMode(parseMode) {
  if (!parseMode) return undefined;
  const pm = String(parseMode).trim();
  if (!PARSE_MODES.has(pm)) {
    throw new Error(`Invalid parse_mode "${pm}". Use one of: HTML, MarkdownV2, Markdown.`);
  }
  return pm;
}

// A self-sustaining "typing..." keeper. A single sendChatAction only lasts ~5s,
// so after a message is caught the indicator would fade while the agent is still
// generating its reply. The keeper pulses every 4s until the next outbound
// message is sent, with a 2-min safety cap so it can never leak.
let typingKeeperTimer = null;
function startTypingKeeper(chatId) {
  stopTypingKeeper();
  if (UNDER_DAEMON) return; // the task daemon already keeps "typing…" alive
  const target = chatId || config.chat_id;
  const pulse = () => {
    tgApi('sendChatAction', { chat_id: target, action: 'typing' }, { lowPriority: true }).catch(() => {});
  };
  pulse();
  let elapsed = 0;
  typingKeeperTimer = setInterval(() => {
    elapsed += 4000;
    if (elapsed >= 120000) { stopTypingKeeper(); return; }
    pulse();
  }, 4000);
  if (typingKeeperTimer.unref) typingKeeperTimer.unref();
}
function stopTypingKeeper() {
  if (typingKeeperTimer) {
    clearInterval(typingKeeperTimer);
    typingKeeperTimer = null;
  }
}

async function tgSend(text, parseMode, opts = {}) {
  // Any outbound message ends the "typing..." state.
  stopTypingKeeper();
  const chatId = opts.chat_id || config.chat_id;
  const pm = normalizeParseMode(parseMode);
  const task = taskReplyTo();
  const replyTo = task != null && task !== threadedTask && String(chatId) === String(config.chat_id) && opts.thread_id == null
    ? { message_id: task, allow_sending_without_reply: true }
    : undefined;
  const effect = opts.effect ? MESSAGE_EFFECTS[String(opts.effect).toLowerCase()] : undefined;
  if (opts.effect && !effect) throw new Error(`Unknown effect "${opts.effect}". Use one of: ${Object.keys(MESSAGE_EFFECTS).join(', ')}.`);
  const keyboard = copyKeyboard(opts.copy);

  // File attachment path: pick method by extension and multipart-upload.
  if (opts.file_path) {
    const { method, field } = pickFileMethod(opts.file_path);
    const fields = { chat_id: chatId };
    if (opts.thread_id != null) fields.message_thread_id = opts.thread_id;
    if (text) fields.caption = text;
    if (pm) fields.parse_mode = pm;
    if (replyTo) fields.reply_parameters = replyTo;
    if (effect) fields.message_effect_id = effect;
    if (keyboard) fields.reply_markup = keyboard;
    const msg = await tgApiMultipart(method, fields, field, opts.file_path, { httpTimeoutMs: 120000 });
    if (replyTo) threadedTask = replyTo.message_id;
    noteAnswer(msg, task, chatId);
    return `Sent file via ${method} (message_id=${msg.message_id}).`;
  }

  const payload = {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
  };
  if (opts.thread_id != null) payload.message_thread_id = opts.thread_id;
  if (pm) payload.parse_mode = pm;
  if (replyTo) payload.reply_parameters = replyTo;
  if (effect) payload.message_effect_id = effect;
  if (keyboard) payload.reply_markup = keyboard;
  let msg;
  try {
    msg = await tgApi('sendMessage', payload);
  } catch (e) {
    // Effects work in private chats only; send without one rather than fail.
    if (effect && /effect/i.test(e.message)) {
      delete payload.message_effect_id;
      msg = await tgApi('sendMessage', payload);
    } else {
      if (!/too long/i.test(e.message)) throw e;
      return sendAsPage(text, pm, chatId, opts, replyTo);
    }
  }
  if (replyTo) threadedTask = replyTo.message_id;
  noteAnswer(msg, task, chatId);
  return `Sent (message_id=${msg.message_id}${pm ? `, parse_mode=${pm}` : ''}).`;
}

// Over Telegram's 4096-character limit: deliver the whole answer as an .html
// page (opens rendered on the phone) instead of failing or cutting it.
async function sendAsPage(text, pm, chatId, opts, replyTo) {
  const body = pm === 'HTML' ? text : text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const file = path.join(require('os').tmpdir(), `claude-answer-${Date.now()}.html`);
  fs.writeFileSync(file, htmlPage(body));
  try {
    const fields = { chat_id: chatId, caption: `📄 Full answer (${text.length.toLocaleString('en-US')} chars, too long for one message)` };
    if (opts.thread_id != null) fields.message_thread_id = opts.thread_id;
    if (replyTo) fields.reply_parameters = replyTo;
    const msg = await tgApiMultipart('sendDocument', fields, 'document', file, { httpTimeoutMs: 120000 });
    if (replyTo) threadedTask = replyTo.message_id;
    noteAnswer(msg, taskReplyTo(), chatId);
    return `Text was over Telegram's 4096-char limit, so it was sent as an HTML page (message_id=${msg.message_id}). Next time keep messages shorter or put details in <blockquote expandable>.`;
  } finally {
    try { fs.unlinkSync(file); } catch (_) {}
  }
}

// Edit a previously sent message in place — progress updates without chat spam.
async function tgEdit(messageId, text, parseMode, opts = {}) {
  if (messageId == null) throw new Error('tg_edit requires "message_id".');
  const chatId = opts.chat_id || config.chat_id;
  const pm = normalizeParseMode(parseMode);
  const payload = {
    chat_id: chatId,
    message_id: Number(messageId),
    text,
    disable_web_page_preview: true,
  };
  if (pm) payload.parse_mode = pm;
  const msg = await tgApi('editMessageText', payload);
  return `Edited message_id=${msg.message_id}.`;
}

// Put an emoji reaction on a message — a lightweight "acknowledged" signal.
// Defaults to the last inbound message + 👀.
async function tgReact(messageId, emoji, opts = {}) {
  const chatId = opts.chat_id || config.chat_id;
  const id = messageId != null ? Number(messageId) : (taskReplyTo() || lastReceivedMessageId);
  if (id == null) {
    throw new Error('tg_react: no message_id given and no message received yet this session.');
  }
  const e = emoji && String(emoji).trim() ? String(emoji).trim() : '👀';
  await tgApi('setMessageReaction', {
    chat_id: chatId,
    message_id: id,
    reaction: [{ type: 'emoji', emoji: e }],
  });
  return `Reacted ${e} to message_id=${id}.`;
}

// Show a "typing..." indicator for a fixed duration (refreshes every 4s).
async function tgTyping(seconds, action) {
  const total = Math.max(1, Math.min(60, Number(seconds) || 5));
  const act = action && String(action).trim() ? String(action).trim() : 'typing';
  const deadline = Date.now() + total * 1000;
  let pulses = 0;
  while (Date.now() < deadline) {
    await tgApi('sendChatAction', { chat_id: config.chat_id, action: act });
    pulses++;
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await new Promise(r => setTimeout(r, Math.min(4000, remaining)));
  }
  return `Sent ${pulses} "${act}" pulse${pulses === 1 ? '' : 's'} over ${total}s.`;
}

// Telegram marks an update as read only when a later getUpdates asks for a
// higher offset. Returning straight after the answer would leave it unread,
// and the task daemon would pick it up again as a new task, so confirm it.
async function confirmUpdatesBefore(offset) {
  try { await tgApi('getUpdates', { offset, timeout: 0, limit: 1 }, { httpTimeoutMs: 5000 }); }
  catch (e) { process.stderr.write(`[telegram-tg] confirm offset ${offset}: ${e.message}\n`); }
}

async function tgAsk(...args) {
  setAskFlag(true);
  try { return await tgAskWait(...args); }
  finally { setAskFlag(false); }
}

async function tgAskWait(question, timeoutSeconds, parseMode, opts = {}) {
  const timeoutMs = Math.max(5, Math.min(36000, Number(timeoutSeconds) || 300)) * 1000;
  const pm = normalizeParseMode(parseMode);
  const silent = !question || !question.trim();
  const chatId = opts.chat_id || config.chat_id;
  const choices = Array.isArray(opts.choices) && opts.choices.length ? opts.choices.map(String) : null;

  // Drain pending updates ONLY for interactive questions, so a stale, unrelated
  // message isn't mistaken for the reply. For silent polls, NEVER drain: doing
  // so discards messages that arrived in the gap between polls. The persisted
  // updateOffset already prevents re-consuming old messages.
  if (!silent) {
    takeHandoff(); // a leftover from an earlier ask is not this question's answer
    try {
      const drain = await tgApi('getUpdates', { offset: -1, timeout: 0 }, { httpTimeoutMs: 5000 });
      if (drain.length) {
        updateOffset = drain[drain.length - 1].update_id + 1;
        saveState();
      }
    } catch (e) {
      process.stderr.write(`[telegram-tg] drain warning: ${e.message}\n`);
    }
  }

  let questionMessageId = null;
  let sentDate = Math.floor(Date.now() / 1000);

  if (!silent) {
    stopTypingKeeper();
    const sendPayload = {
      chat_id: chatId,
      text: question,
    };
    if (pm) sendPayload.parse_mode = pm;
    if (opts.thread_id != null) sendPayload.message_thread_id = opts.thread_id;
    // Inline-keyboard quick replies: one tappable button per choice.
    if (choices) {
      sendPayload.reply_markup = {
        inline_keyboard: choices.map((c, i) => [{ text: c, callback_data: String(i), ...(choiceStyle(c) ? { style: choiceStyle(c) } : {}) }]),
      };
    }
    const sent = await tgApi('sendMessage', sendPayload);
    questionMessageId = sent.message_id;
    sentDate = sent.date;
  }

  // Long-poll for a reply. When we offered buttons, also listen for the
  // callback_query that fires when the operator taps one.
  const allowedUpdates = choices ? ['message', 'callback_query'] : ['message'];
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // The task daemon may have caught the reply in the second before it paused.
    const handoff = takeHandoff();
    if (handoff && handoff.text && isImmediateCommand(handoff.text)) forwardToDaemon(handoff);
    else if (handoff && (!handoff.date || handoff.date * 1000 >= sentDate * 1000 - 5000)) {
      lastReceivedMessageId = handoff.message_id;
      startTypingKeeper(chatId);
      return handoff.text || '(non-text message)';
    }
    // Short polls, so a handed-over reply is picked up within seconds.
    const remainingSec = Math.max(1, Math.min(10, Math.floor((deadline - Date.now()) / 1000)));
    let updates;
    try {
      updates = await tgApi('getUpdates', {
        offset: updateOffset,
        timeout: remainingSec,
        allowed_updates: allowedUpdates,
      }, { httpTimeoutMs: (remainingSec + 10) * 1000 });
    } catch (e) {
      process.stderr.write(`[telegram-tg] getUpdates: ${e.message} — retrying\n`);
      await new Promise(r => setTimeout(r, 2000));
      continue;
    }
    for (const u of updates) {
      updateOffset = u.update_id + 1;
      saveState();

      // A tapped inline-keyboard button arrives as a callback_query.
      if (u.callback_query) {
        const cq = u.callback_query;
        if (cq.message && String(cq.message.chat.id) !== String(chatId)) continue;
        tgApi('answerCallbackQuery', { callback_query_id: cq.id }).catch(() => {});
        if (cq.message) lastReceivedMessageId = cq.message.message_id;
        startTypingKeeper(chatId);
        await confirmUpdatesBefore(updateOffset);
        const idx = Number(cq.data);
        return choices && Number.isInteger(idx) && choices[idx] != null ? choices[idx] : String(cq.data);
      }

      const m = u.message;
      if (!m) continue;
      if (String(m.chat.id) !== String(chatId)) continue;
      if (m.date && m.date * 1000 < sentDate * 1000 - 5000) continue;
      // /stop, /status, /queue … are for the daemon, not an answer to this question.
      if (m.text && isImmediateCommand(m.text)) { forwardToDaemon(m); continue; }
      lastReceivedMessageId = m.message_id;
      const text = m.text || m.caption || '(non-text message)';
      // Auto-start a sustained typing indicator the instant a message is caught.
      startTypingKeeper(chatId);
      await confirmUpdatesBefore(updateOffset);
      return text;
    }
  }
  throw new Error(`No Telegram reply within ${timeoutMs / 1000}s${questionMessageId ? ` (question message_id=${questionMessageId})` : ' (silent poll)'}. Timed out.`);
}

// ---------- MCP stdio JSON-RPC plumbing ----------
const PARSE_MODE_SCHEMA = {
  type: 'string',
  enum: ['HTML', 'MarkdownV2', 'Markdown'],
  description: 'Optional Telegram parse mode. Omit for plain text (default). Recommended: "HTML" — escape <, >, & in dynamic content and use <b>bold</b>, <i>italic</i>, <code>mono</code>, <pre>block</pre>, <a href="url">link</a>, <blockquote>quote</blockquote>, <tg-spoiler>hidden</tg-spoiler>. Put long details (logs, full lists, command output) in <blockquote expandable>…</blockquote>: it shows a few lines and expands on tap; <pre> and <code> work inside it. Messages are capped at 4096 characters; longer text is delivered as an HTML page attachment. "MarkdownV2" requires escaping many chars (_*[]()~`>#+-=|{}.!) and is more error-prone. Avoid Markdown literals like **bold** without setting parse_mode — they render as literal asterisks.',
};

const TOOLS = [
  {
    name: 'tg_send',
    description: 'Send a one-way notification to the operator via Telegram. Use when the agent needs human attention (e.g., approval pending, long task finished, error needs eyes). Fire-and-forget — does not wait for a reply. Pass parse_mode:"HTML" to use rich formatting. Pass file_path to attach an image/video/audio/document (rendered inline by type). Returns the sent message_id (usable with tg_edit / tg_react).',
    inputSchema: {
      type: 'object',
      properties: {
        text:       { type: 'string', description: 'Notification text. When file_path is set this becomes the file caption. If parse_mode is set, callers must escape per Telegram rules.' },
        parse_mode: PARSE_MODE_SCHEMA,
        file_path:  { type: 'string', description: 'Optional absolute path to a file to attach. Type is auto-detected: .png/.jpg/.webp/.gif → photo, .mp4/.mov → video, .ogg → voice, .mp3/.m4a/.wav → audio, anything else → document.' },
        chat_id:    { type: 'string', description: 'Optional target chat id. Defaults to the configured operator chat.' },
        thread_id:  { type: 'number', description: 'Optional Telegram Topic (message_thread_id) to post into.' },
        effect:     { type: 'string', enum: Object.keys(MESSAGE_EFFECTS), description: 'Optional full-screen animation on the message. Use sparingly: "confetti" when a long or important task finished well, "fire" for a big win; "like", "heart", "dislike", "poop" also exist. Private chats only.' },
        copy:       { type: 'array', items: { type: 'string' }, description: 'Optional texts (max 3, each 1-256 chars) shown as one-tap "📋 Copy" buttons under the message, e.g. a command or ID the user will want to paste.' },
      },
      required: ['text'],
    },
  },
  {
    name: 'tg_ask',
    description: 'Ask the operator a question via Telegram and BLOCK until they reply. Returns the reply text. Use for confirmations, choices, or clarifications when the agent is uncertain. Pass parse_mode:"HTML" to render bold/code/links. Pass choices:[...] to show tappable quick-reply buttons — the tapped option is returned. If question is empty or omitted, silently waits for the next message without sending anything.',
    inputSchema: {
      type: 'object',
      properties: {
        question:       { type: 'string', description: 'The question to send. If empty or omitted, silently polls for the next message.' },
        timeoutSeconds: { type: 'number', description: 'Max seconds to wait for a reply (default 300, max 36000).' },
        parse_mode:     PARSE_MODE_SCHEMA,
        choices:        { type: 'array', items: { type: 'string' }, description: 'Optional list of quick-reply options. Renders as inline-keyboard buttons; the tapped option text is returned.' },
        chat_id:        { type: 'string', description: 'Optional target chat id. Defaults to the configured operator chat.' },
        thread_id:      { type: 'number', description: 'Optional Telegram Topic (message_thread_id) to post the question into.' },
      },
    },
  },
  {
    name: 'tg_edit',
    description: 'Edit a previously sent message in place. Use for progress updates: tg_send "⏳ Working..." → capture the message_id → tg_edit it to "✅ Done". Keeps the chat clean instead of posting a new message each step.',
    inputSchema: {
      type: 'object',
      properties: {
        message_id: { type: 'number', description: 'The message_id returned by a prior tg_send.' },
        text:       { type: 'string', description: 'The new text for the message.' },
        parse_mode: PARSE_MODE_SCHEMA,
        chat_id:    { type: 'string', description: 'Optional chat id if the message is not in the default operator chat.' },
      },
      required: ['message_id', 'text'],
    },
  },
  {
    name: 'tg_react',
    description: 'Put an emoji reaction on a message — a lightweight "acknowledged" signal without sending a reply. Defaults to the most recent inbound message and the 👀 emoji if not specified.',
    inputSchema: {
      type: 'object',
      properties: {
        message_id: { type: 'number', description: 'Message to react to. Defaults to the last message received this session.' },
        emoji:      { type: 'string', description: 'Reaction emoji (default 👀). Must be one Telegram supports, e.g. 👍 ❤️ 🔥 👀 🎉 👏 🙏.' },
        chat_id:    { type: 'string', description: 'Optional chat id if not the default operator chat.' },
      },
    },
  },
  {
    name: 'tg_typing',
    description: 'Show a "typing..." indicator in the operator\'s Telegram chat. Blocks for the requested duration, refreshing every 4s.',
    inputSchema: {
      type: 'object',
      properties: {
        seconds: { type: 'number', description: 'How long to keep the indicator visible (1-60, default 5).' },
        action:  { type: 'string', enum: ['typing', 'upload_photo', 'record_video', 'upload_video', 'record_voice', 'upload_voice', 'upload_document', 'choose_sticker', 'find_location', 'record_video_note', 'upload_video_note'], description: 'Telegram chat action. Default "typing".' },
      },
    },
  },
];

function write(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function ok(id, result)   { write({ jsonrpc: '2.0', id, result }); }
function err(id, message, code = -32000) { write({ jsonrpc: '2.0', id, error: { code, message } }); }

async function handle(req) {
  const { id, method, params } = req;
  if (method === 'initialize') {
    return ok(id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'telegram-tg', version: '1.0.0' },
    });
  }
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') {
    return; // notifications don't get responses
  }
  if (method === 'tools/list') {
    return ok(id, { tools: TOOLS });
  }
  if (method === 'tools/call') {
    const name = params && params.name;
    const args = (params && params.arguments) || {};
    try {
      let text;
      if (name === 'tg_send') {
        if (!args.text && !args.file_path) throw new Error('tg_send requires "text" or "file_path".');
        text = await tgSend(args.text ? String(args.text) : '', args.parse_mode, {
          file_path: args.file_path,
          chat_id: args.chat_id,
          thread_id: args.thread_id,
          effect: args.effect,
          copy: args.copy,
        });
      } else if (name === 'tg_ask') {
        text = await tgAsk(args.question ? String(args.question) : '', args.timeoutSeconds, args.parse_mode, {
          choices: args.choices,
          chat_id: args.chat_id,
          thread_id: args.thread_id,
        });
      } else if (name === 'tg_edit') {
        text = await tgEdit(args.message_id, String(args.text), args.parse_mode, { chat_id: args.chat_id });
      } else if (name === 'tg_react') {
        text = await tgReact(args.message_id, args.emoji, { chat_id: args.chat_id });
      } else if (name === 'tg_typing') {
        text = await tgTyping(args.seconds, args.action);
      } else {
        throw new Error(`Unknown tool: ${name}`);
      }
      return ok(id, { content: [{ type: 'text', text }] });
    } catch (e) {
      return ok(id, { content: [{ type: 'text', text: `ERROR: ${e.message}` }], isError: true });
    }
  }
  if (method === 'ping') {
    return ok(id, {});
  }
  err(id, `Method not found: ${method}`, -32601);
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let req;
  try { req = JSON.parse(trimmed); }
  catch (e) {
    process.stderr.write(`[telegram-tg] bad JSON: ${e.message}\n`);
    return;
  }
  handle(req).catch((e) => {
    process.stderr.write(`[telegram-tg] handler crash: ${e.stack || e.message}\n`);
    if (req && req.id != null) err(req.id, e.message);
  });
});

process.stderr.write(`[telegram-tg] ready (chat_id=${config.chat_id})\n`);

'use strict';
// Telegram presentation helpers shared by the daemon and the MCP server, so
// both decorate messages the same way.

// Full-screen animations Telegram plays on a message: built-in effects, free,
// private chats only.
const MESSAGE_EFFECTS = {
  confetti: '5046509860389126442', // 🎉
  fire: '5104841245755180586',     // 🔥
  like: '5107584321108051014',     // 👍
  heart: '5159385139981059251',    // ❤️
  dislike: '5104858069142078462',  // 👎
  poop: '5046589136895476101',     // 💩
};

// Up to three one-tap "📋 Copy" buttons (Telegram's copy_text allows 1-256 characters).
function copyKeyboard(texts) {
  const items = [...new Set((Array.isArray(texts) ? texts : []).map(String))]
    .filter(t => t.length >= 1 && t.length <= 256).slice(0, 3);
  if (!items.length) return undefined;
  return {
    inline_keyboard: items.map((text) => {
      const first = text.split('\n')[0];
      const label = items.length === 1 ? '📋 Copy' : `📋 ${first.length > 28 ? `${first.slice(0, 27)}…` : first}`;
      return [{ text: label, copy_text: { text }, style: 'primary' }];
    }),
  };
}

// The short fenced code blocks of a Markdown answer, as candidates for copyKeyboard.
function codeBlocks(markdown) {
  const blocks = [];
  for (const m of String(markdown).matchAll(/```[\w-]*\n?([\s\S]*?)```/g)) {
    const code = m[1].replace(/\n+$/, '').trim();
    if (code) blocks.push(code);
  }
  return blocks;
}

// Green for agreeing choices, red for refusing ones (Telegram button styles).
function choiceStyle(choice) {
  if (/^\s*(✅|✔|👍|🟢)|\b(yes|allow|approve|confirm|go ahead|publish|push|send|install|deploy)\b/i.test(choice)) return 'success';
  if (/^\s*(❌|✖|🛑|🔴|⛔)|\b(no|deny|cancel|stop|abort|reject|don't|do not)\b/i.test(choice)) return 'danger';
  return undefined;
}

// A standalone page for an answer too long for one Telegram message. Telegram
// HTML is a subset of HTML, so it renders as is; newlines stay line breaks.
function htmlPage(telegramHtml) {
  return '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<body style="font-family:system-ui,sans-serif;line-height:1.5;padding:12px;max-width:900px;margin:auto">'
    + `<div style="white-space:pre-wrap">${telegramHtml}</div></body>`;
}

module.exports = { MESSAGE_EFFECTS, copyKeyboard, codeBlocks, choiceStyle, htmlPage };

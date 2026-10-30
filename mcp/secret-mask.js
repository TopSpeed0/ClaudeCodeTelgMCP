'use strict';

// Hide secrets in text that is about to be shown on Telegram (an approval
// question, a progress line) or written to a log. Only the shown copy is
// masked; the command itself runs unchanged. Best effort: it catches the
// usual shapes (password/token parameters, Authorization headers, user:pass
// in URLs, well-known token formats), not every secret there could be.

const MASK = '[REDACTED]';
const NAMES = 'password|passwd|passwort|pwd|pass|secret|client[_-]?secret|token|access[_-]?token|refresh[_-]?token|api[_-]?key|apikey|access[_-]?key|secret[_-]?key|private[_-]?key|credential';

const RULES = [
  // Well-known token formats, wherever they appear.
  [/\bsk-ant-[A-Za-z0-9_-]{10,}/g, MASK],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g, MASK],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, MASK],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, MASK],
  [/\bAKIA[0-9A-Z]{16}\b/g, MASK],
  [/\b\d{8,10}:[A-Za-z0-9_-]{30,}\b/g, MASK], // Telegram bot token
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, MASK], // JWT
  [/\b21st_sk_[0-9a-f]{20,}\b/g, MASK],
  // Authorization headers: keep the scheme, hide the credential.
  [/\b(Authorization\s*[:=]\s*['"]?(?:Bearer|Basic|Token|Negotiate)?\s*)[^\s'",;]+/gi, `$1${MASK}`],
  [/\b(X-[\w-]*(?:Key|Token|Auth)[\w-]*['"]?\s*[:=]\s*['"]?)[^\s'",;]+/gi, `$1${MASK}`],
  // user:password@host in URLs.
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@'"]+:)[^\s@/'"]+@/gi, `$1${MASK}@`],
  // JSON fields (MCP tool input): "password": "..."
  [new RegExp(`("(?:[\\w-]*?)(?:${NAMES})"\\s*:\\s*")(?:[^"\\\\]|\\\\.)*"`, 'gi'), `$1${MASK}"`],
  // PowerShell / CLI parameters: -Password 'x', -NewPassword "x", --token=x
  // (a $variable is a name, not a secret, so it stays readable)
  [new RegExp(`((?:^|\\s)--?[\\w-]*?(?:${NAMES})(?:\\s+|[=:]))('[^']*'|"[^"]*"|(?!\\$)[^\\s'"]+)`, 'gi'), `$1${MASK}`],
  // Assignments: password=x, $token = 'x', TOKEN: x
  [new RegExp(`(\\$?\\b[\\w.]*(?:${NAMES})\\b\\s*[=:]\\s*)('[^']*'|"[^"]*"|(?!\\$)[^\\s'",;]+)`, 'gi'), `$1${MASK}`],
  // ConvertTo-SecureString 'plain' -AsPlainText
  [/(ConvertTo-SecureString\s+(?:-String\s+)?)('[^']*'|"[^"]*")/gi, `$1'${MASK}'`],
];

function maskSecrets(text) {
  let out = String(text == null ? '' : text);
  for (const [re, replacement] of RULES) out = out.replace(re, replacement);
  // A masked value already masked by an earlier rule shows once.
  return out.replace(/\[REDACTED\](?:\[REDACTED\])+/g, MASK);
}

module.exports = { maskSecrets, MASK };

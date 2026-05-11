# Claude Code Workspace with Telegram Integration

This workspace provides a ready-to-use Claude Code setup with a Telegram bot bridge, enabling remote task execution and notifications from your phone.

## Components

### MCP Server — `mcp/telegram-tg.js`
Zero-dependency Node.js MCP server (stdio, JSON-RPC 2.0) exposing two tools:
- **`tg_send`** — one-way notification (fire-and-forget)
- **`tg_ask`** — send a question and block until the user replies on Telegram

Both tools support optional `parse_mode` (`HTML`, `MarkdownV2`, `Markdown`) for rich formatting.

### Task Daemon — `mcp/telegram-task-daemon.js`
Always-on bridge that long-polls Telegram for messages and spawns `claude -p <task>` per message. Lets you send tasks to Claude Code from Telegram while you're away from your desk.

Features:
- Automatic session continuation (`--continue`) across messages
- Sentinel-based dedup (see rules below)
- Smart chunking for long outputs (respects Telegram's 4096-char limit)
- ANSI-strip for clean monospace output
- Cross-platform: auto-detects Windows vs macOS/Linux for process spawning

**Important:** `mcp/daemon-mcp.json` must include the `telegram-tg` server config so daemon-spawned Claude sessions can use `tg_send` for rich formatting. If it's empty (`{}`), the spawned sessions have no MCP tools and fall back to plain stdout — causing ugly monospace replies instead of rich HTML.

### Launcher — `mcp/start-task-daemon.ps1`
PowerShell 7+ script to start the daemon in foreground or background mode. Auto-kills any previous daemon instance on restart.

### Shortcut Installer — `mcp/install-shortcuts.ps1`
Creates Windows Start Menu + Desktop shortcuts for one-click daemon launch.

## Setup

1. **Create a Telegram bot**: Talk to [@BotFather](https://t.me/BotFather), get your bot token
2. **Get your chat ID**: Send a message to your bot, then visit `https://api.telegram.org/bot<TOKEN>/getUpdates` to find your `chat.id`
3. **Configure credentials** (pick one):
   - Copy `.mcp.json.example` to `.mcp.json` and fill in your token/chat_id
   - Or create `.telegram-config` in the repo root (see `mcp/.telegram-config.example`)
   - Or set env vars `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`
4. **Start Claude Code** in this workspace — the MCP server auto-starts via `.mcp.json`
5. **Optional — start the task daemon**:
   ```powershell
   .\mcp\start-task-daemon.ps1              # foreground
   .\mcp\start-task-daemon.ps1 -Background  # detached
   ```

## Shell Notes

- **Shell**: PowerShell 7+ (pwsh) is the default. Use the Bash tool when a POSIX command is genuinely needed.
- **Workspace profile**: If you have a `profile1.ps1` with custom functions, dot-source it:
  ```powershell
  . .\profile1.ps1; <your command>
  ```
  Every pwsh tool call runs in a fresh non-interactive session that does NOT load `$PROFILE`.

## Corporate TLS / Proxy

If your organization intercepts TLS (MITM proxy), Node.js will fail HTTPS calls because it bundles its own CA store. Fix: add `--use-system-ca` to the node args in `.mcp.json`:

```json
{
  "mcpServers": {
    "telegram-tg": {
      "command": "node",
      "args": ["--use-system-ca", "mcp/telegram-tg.js"],
      "env": { ... }
    }
  }
}
```

This requires Node.js 22+. PowerShell/curl already use the OS cert store and are unaffected.

---

## Behavioral Rules for Claude (READ CAREFULLY)

The rules below ensure a seamless Telegram experience. They are critical — without them, users get duplicate messages, broken formatting, and a poor experience.

### Rule 1: Telegram Message Formatting

- **Default: plain text.** Do NOT use Markdown syntax (`**bold**`, `` `code` ``, `[link](url)`) in `tg_send` or `tg_ask` messages — Telegram renders them as literal characters (asterisks, backticks, brackets).
- **For rich formatting**: pass `parse_mode: "HTML"` and use HTML tags:
  - `<b>bold</b>`, `<i>italic</i>`, `<code>inline code</code>`
  - `<pre>code block</pre>`, `<a href="url">link text</a>`
  - Escape `<`, `>`, `&` in dynamic content as `&lt;`, `&gt;`, `&amp;`
- **Never mix** Markdown syntax with HTML parse_mode — pick one.
- When in doubt, use plain text. It always works.

### Rule 2: No Double-Send via Task Daemon

When the task daemon (`telegram-task-daemon.js`) spawns you via `claude -p`, it captures your stdout and relays it to Telegram as a `<pre>`-wrapped monospace message. If you ALSO used `tg_send` to deliver a rich answer, the user sees the same content **twice**.

**Detection — am I running under the daemon?**
- Your prompt is a single task description (typical `claude -p` invocation), not an interactive conversation
- You have access to MCP tools `tg_send` and `tg_ask` (via `telegram-tg`)
- There is no transcript history of prior turns — it's a fresh `-p` invocation

**The rule — pick ONE delivery method per response:**

| If you used `tg_send` to deliver the answer | If you did NOT use `tg_send` |
|---|---|
| Your final stdout MUST end with the literal sentinel `[sent-via-tg]` on its own line, and contain nothing else of substance | Your stdout IS the answer — write it as a clean, monospace-friendly block. The daemon wraps it in `<pre>` |

**The sentinel `[sent-via-tg]`** is matched case-insensitively by the daemon. When detected, the daemon suppresses the entire stdout relay.

**Correct examples:**
```
# Used tg_send for rich content — stdout is just the sentinel:
[sent-via-tg]

# Did NOT use tg_send — stdout is the full answer:
Top results:
  item_a: 447
  item_b: 233
```

**Anti-pattern (causes double-message):**
```
# DON'T do this — both tg_send AND a verbose stdout:
Sent message_id=119 with rich formatting.
The user should now see the report in Telegram.
```

**Edge cases:**
- If `tg_send` was used, keep stdout minimal. The sentinel must be present for suppression.
- Errors: don't suppress error info with the sentinel — let the daemon surface errors naturally.
- `tg_ask` counts as "used tg_send" — you already had a Telegram interaction. Sentinel applies.

### Rule 3: When to Use Which Tool

| Situation | Tool | Why |
|-----------|------|-----|
| Long task finished, user needs to know | `tg_send` | Fire-and-forget notification |
| Need user approval before destructive action | `tg_ask` | Blocks until user replies yes/no |
| Error or unexpected state, need guidance | `tg_ask` | Get human input before proceeding |
| Quick status check the user requested | stdout (no `tg_send`) | Daemon relays it as monospace — perfect for tables/data |
| Rich formatted report with links/bold | `tg_send` with `parse_mode: "HTML"` | Then print `[sent-via-tg]` to stdout |

### Rule 4: Safety

Always confirm destructive operations before executing. Use `tg_ask` to get remote approval when the user isn't at their desk. Never run dangerous commands without explicit user confirmation.

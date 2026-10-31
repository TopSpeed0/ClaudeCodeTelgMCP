# Claude Code Workspace with Telegram Integration

This workspace provides a ready-to-use Claude Code setup with a Telegram bot bridge, enabling remote task execution and notifications from your phone.

## Skills & local instructions

This repo ships **only** the Telegram bridge — it is intentionally lean. Domain knowledge lives in your **installed skills** (`~/.claude/skills` plus built-ins): look up the relevant skill for the task instead of expecting it documented here. When the task daemon spawns a session, every user-level skill is available regardless of which folder the daemon runs from, so a generic launch still "knows" all your tooling.

**Private / local context:** if a `CLAUDE.local.md` file exists in this folder, read it first — it holds personal or internal instructions that are intentionally **not** committed (`CLAUDE.local.md` and `.claude/settings.local.json` are gitignored). Public users are free to drop their own private context here; Claude will pick it up but it will never be pushed to Git.

**Context recovery before limitation:** before saying prior context, a skill, or project knowledge is missing, inspect the injected archive context and applicable installed skills. If that is insufficient, search the local `archive/` summaries/current-day turns and relevant `SKILL.md` files before asking the user to repeat information or declaring that the context is unavailable.

## Components

### MCP Server — `mcp/telegram-tg.js`
Zero-dependency Node.js MCP server (stdio, JSON-RPC 2.0) exposing five tools:
- **`tg_send`** — one-way message, optionally with a file, an `effect` or `copy` buttons
- **`tg_ask`** — send a question and block until the user replies on Telegram
- **`tg_edit`** — edit a sent message in place (progress updates)
- **`tg_react`** — put an emoji reaction on a message
- **`tg_typing`** — show "typing…" for a few seconds

`tg_send`, `tg_ask` and `tg_edit` take an optional `parse_mode` (`HTML`, `MarkdownV2`, `Markdown`); use `HTML`.

### Task Daemon — `mcp/telegram-task-daemon.js`
Always-on bridge that long-polls Telegram for messages and spawns `claude -p <task>` per message. Lets you send tasks to Claude Code from Telegram while you're away from your desk.

Features:
- Automatic session continuation (`--continue`) across messages
- Streams the reply live into a Telegram bubble while Claude writes it
- Sends the final answer as one rich message (native tables, up to 32,768 chars); a longer one also gets an attached HTML page
- Sentinel-based dedup (see rules below)
- Cross-platform: auto-detects Windows vs macOS/Linux for process spawning

**Important:** daemon-spawned sessions load `mcp/daemon-mcp.local.json`, which `mcp/sync-mcp-connectors.js claude` builds (the launcher runs it) from `mcp/daemon-mcp.base.json` plus your `mcp-connectors.json`. The base file starts `telegram-tg` with placeholder env vars (`YOUR_BOT_TOKEN_HERE`) — this is intentional. The server's `loadConfig()` detects placeholders and falls through to `.telegram-config` in the workspace root (which holds your real credentials and is gitignored). If neither source has valid credentials, the server exits with an error.

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
- **Your profile**: every pwsh tool call runs in a fresh non-interactive session that does NOT load `$PROFILE`. If a command needs your profile or a personal function script (this repo ships none), dot-source them first:
  ```powershell
  . $PROFILE; . <path-to-your-functions.ps1>; <your command>
  ```

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

This requires Node.js 22.15+. PowerShell/curl already use the OS cert store and are unaffected.

---

## Telegram Behavioral Rules (CRITICAL — READ EVERY SESSION)

### RULE: When running under the task daemon (`claude -p`), write your final answer as plain Markdown — the daemon delivers it.

**Detection — am I running under the daemon?** Only if your system prompt says "You are running under the Telegram task daemon" (the daemon adds that line to every session it starts). Having `tg_send`, or a conversation history, proves nothing: interactive sessions in this folder have `tg_send` too, and daemon sessions carry history.

**Why:** the daemon streams your reply live into a Telegram bubble while you write it, then sends it formatted: Markdown tables become real Telegram tables, headings / bold / lists / code / links / `>` quotes are converted, long code blocks collapse, short ones get 📋 Copy buttons, a very long answer gets an attached page, and long tasks finish with 🎉. An answer inside a `tg_send` call can do none of that: it arrives all at once and tables become monospace blocks.

**The rule:**
- Your final answer = your normal reply text, in Markdown. Do NOT also send it with `tg_send`.
- `tg_send` is for messages *during* a task, not for the final answer:
  - progress or an early result on a long task ("⏳ 3 of 8 clusters checked…", then `tg_edit` it)
  - a file (`file_path`) — a report, screenshot, export
  - a one-off `effect` or `copy` buttons on something you send mid-task
- If you did deliver the whole answer with `tg_send` anyway, your stdout must then be only `[sent-via-tg]` (the daemon skips its own relay, so nothing is sent twice).

**Formatting (Markdown):**
- Bottom line first: the answer or the decision needed goes in the first line, then one line per point. No closing summary.
- Make it vivid: emoji section headers, **bold** key facts, bullets, `code` for names/commands/IDs.
- Tables are welcome here (unlike in a terminal): use one for anything with rows and columns; use bullets for a plain list.
- Tables: up to 4 columns show as a real Telegram table (good for text such as practice / why / priority); 5 or more show as an aligned monospace block (good for data such as a volume list), so keep those compact: short cells, under ~60 characters a row, numbers with units (`171 GB`, `91%`).
- Fenced code blocks for commands and CLI output; a fence over 12 lines collapses into a tap-to-expand quote.
- Links as `[text](https://…)`; quotes as `> …` (over 4 lines they become tap-to-expand).
- Telegram HTML tags may be mixed in where Markdown has no equivalent — `<blockquote expandable>…</blockquote>` for long details, `<tg-time unix="…" format="r">…</tg-time>` for times — **but not in an answer that has a table**: a table renders natively only in pure Markdown.
- Do not escape `<`, `>`, `&` yourself; the daemon does.

**Correct:**
```
stdout = 🗄️ **a1k-prd: 10 volumes**
| Volume | SVM | Used |
|---|---|---|
| PRD_applog | prod | 91% 🔴 |
```

**WRONG:**
```
Call tg_send with the whole answer as HTML → no live streaming, table drawn as monospace
```

### When to use `tg_ask`
- Need user approval before a destructive action → `tg_ask`
- Need clarification or a choice → `tg_ask`
- After `tg_ask`, carry on; the final answer is still your plain reply

### When running interactively (not daemon), respond normally in chat. These rules only apply to daemon-spawned sessions.
Interactive sessions do not copy their replies to Telegram; use `tg_send` there only when the user asks for it (or `tg_ask` when they are away and you need an answer).

### Safety

Always confirm destructive operations before executing. Use `tg_ask` to get remote approval when the user isn't at their desk.

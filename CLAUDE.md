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
- Sentinel-based dedup: if the agent already sent the answer via `tg_send`, it prints `[sent-via-tg]` to stdout and the daemon suppresses the redundant relay
- Smart chunking for long outputs (respects Telegram's 4096-char limit)
- ANSI-strip for clean monospace output

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

## Safety

Always confirm destructive operations before executing. Use `tg_ask` to get remote approval when the user isn't at their desk.

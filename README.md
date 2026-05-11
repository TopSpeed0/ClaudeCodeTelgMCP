# Claude Code Workspace — Telegram Bridge

A ready-to-clone workspace template for [Claude Code](https://claude.com/claude-code) with a built-in Telegram bot integration. Send tasks, receive notifications, and get remote approvals — all from your phone.

## What's Included

| File | Purpose |
|------|---------|
| `mcp/telegram-tg.js` | Zero-dependency MCP server — gives Claude `tg_send` and `tg_ask` tools |
| `mcp/telegram-task-daemon.js` | Always-on bridge: Telegram messages become `claude -p` tasks |
| `mcp/start-task-daemon.ps1` | Launcher with auto-restart (foreground or background) |
| `mcp/install-shortcuts.ps1` | Windows Start Menu + Desktop shortcut creator |
| `mcp/daemon-mcp.json` | Empty MCP config for daemon-spawned sessions |
| `CLAUDE.md` | Workspace instructions for Claude Code |
| `.mcp.json.example` | Template — copy to `.mcp.json` and add your credentials |
| `.claude/settings.local.json` | Pre-configured permissions for PowerShell, Node, Telegram tools |
| `.gitignore` | Excludes credentials and runtime state |

## Quick Start

```bash
# 1. Clone this repo
git clone https://github.com/YOUR_USERNAME/claude-telegram-workspace.git
cd claude-telegram-workspace

# 2. Set up credentials
cp .mcp.json.example .mcp.json
# Edit .mcp.json — add your TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID

# 3. Open in Claude Code
claude

# 4. (Optional) Start the task daemon for remote access
.\mcp\start-task-daemon.ps1
```

## Getting Your Telegram Credentials

1. **Bot Token**: Message [@BotFather](https://t.me/BotFather) on Telegram, create a new bot, copy the token
2. **Chat ID**: Send any message to your new bot, then open:
   ```
   https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates
   ```
   Find `"chat":{"id":123456789}` in the response — that number is your chat ID

## How It Works

### MCP Server (`telegram-tg.js`)
Claude Code launches this as a stdio MCP server. It exposes two tools:
- **`tg_send(text, parse_mode?)`** — fire-and-forget notification
- **`tg_ask(question, timeoutSeconds?, parse_mode?)`** — blocks until the user replies

Both support `parse_mode: "HTML"` for rich formatting (`<b>`, `<i>`, `<code>`, `<pre>`, `<a>`).

### Task Daemon (`telegram-task-daemon.js`)
Runs independently, long-polling Telegram for messages. Each message becomes a `claude -p` invocation. The daemon:
- Maintains session continuity across messages (`--continue`)
- Suppresses duplicate output when the agent already sent via `tg_send` (sentinel: `[sent-via-tg]`)
- Chunks long output to fit Telegram's 4096-char message limit
- Strips ANSI codes for clean monospace display

### Anti-Double-Send Pattern
When Claude uses `tg_send` to deliver a rich-formatted answer, it prints `[sent-via-tg]` to stdout. The daemon detects this sentinel and skips its own relay — so the user sees the message exactly once.

## Customization

- **Add your own tools**: Edit `CLAUDE.md` with domain-specific instructions
- **Add a workspace profile**: Create `profile1.ps1` with custom PowerShell functions, reference it in `CLAUDE.md`
- **Corporate proxy/TLS**: Add `--use-system-ca` to Node args in `.mcp.json` (requires Node 22+)
- **Cross-platform**: The daemon auto-detects Windows vs macOS/Linux for process spawning

## Requirements

- [Claude Code CLI](https://claude.com/claude-code) installed and authenticated
- Node.js 18+ (22+ if you need `--use-system-ca` for corporate TLS)
- PowerShell 7+ (for the launcher and shortcut scripts)
- A Telegram bot token + your chat ID

## License

MIT

# Claude Code Workspace — Telegram Bridge

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js 18+](https://img.shields.io/badge/Node.js-18%2B-339933.svg?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Zero Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen.svg)](#)
[![Claude Code](https://img.shields.io/badge/Claude%20Code-MCP%20Server-7C3AED.svg?logo=anthropic&logoColor=white)](https://claude.com/claude-code)
[![Telegram Bot API](https://img.shields.io/badge/Telegram-Bot%20API-26A5E4.svg?logo=telegram&logoColor=white)](https://core.telegram.org/bots/api)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-0078D4.svg)](#)

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

## Installation

### Prerequisites

Install all three in any order — one line each:

| Tool | Windows | macOS / Linux |
|------|---------|---------------|
| **Node.js 22+** | `winget install OpenJS.NodeJS.LTS` | `curl -fsSL https://fnm.vercel.app/install \| bash && fnm install --lts` |
| **PowerShell 7+** | `winget install Microsoft.PowerShell` | `brew install powershell` / [install docs](https://learn.microsoft.com/en-us/powershell/scripting/install/installing-powershell-on-linux) |
| **Claude Code** | `npm install -g @anthropic-ai/claude-code` | `npm install -g @anthropic-ai/claude-code` |

#### First-Time Claude Code Authentication

After installing, run `claude` once to authenticate. You have two options:

| Method | How |
|--------|-----|
| **Browser login** (recommended) | Run `claude` — it opens a browser for Anthropic OAuth. Sign in, approve, done. |
| **API key** | Set `ANTHROPIC_API_KEY` as an environment variable before running `claude`. Skips the browser flow entirely. |

```powershell
# Option A — browser login (interactive, one-time)
claude

# Option B — API key (headless / CI / servers)
$env:ANTHROPIC_API_KEY = "sk-ant-..."
claude
```

> **Headless servers**: If the machine has no browser (e.g., the task daemon runs on a server), use the API key method.

### One-Prompt Install

Copy-paste this single block — it clones the repo, creates your config, and opens Claude Code:

**Windows (PowerShell):**
```powershell
git clone https://github.com/TopSpeed0/ClaudeCodeTelgMCP.git; cd ClaudeCodeTelgMCP; Copy-Item .mcp.json.example .mcp.json; '{}' | Out-File -Encoding utf8 .claude-queue.json; Write-Host "`nEdit .mcp.json — paste your TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID, then run: claude" -ForegroundColor Cyan
```

**macOS / Linux (bash):**
```bash
git clone https://github.com/TopSpeed0/ClaudeCodeTelgMCP.git && cd ClaudeCodeTelgMCP && cp .mcp.json.example .mcp.json && echo '{}' > .claude-queue.json && echo -e "\n\033[36mEdit .mcp.json — paste your TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID, then run: claude\033[0m"
```

After editing `.mcp.json` with your credentials:
```bash
claude
```

That's it. Claude Code reads `.mcp.json`, auto-launches the Telegram MCP server, and you have `tg_send` + `tg_ask` tools ready.

> **Note:** `.claude-queue.json` is created empty (`{}`) by the install command above.
> The Hermes queue poller (`hermesQueuePoll`) watches this file — it must exist before starting the daemon.

### (Optional) Start the Task Daemon

To receive Telegram messages as Claude tasks while you're away:

```powershell
.\mcp\start-task-daemon.ps1              # foreground — see logs live
.\mcp\start-task-daemon.ps1 -Background  # detached — logs to mcp/task-daemon.log
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

## Hermes Overmind Integration

This repo is part of a **three-worker architecture** with [Hermes Agent](https://hermes-agent.nousresearch.com/) as the Overmind:

```
You (Telegram)
    │
    ▼
Hermes Agent — Overmind (always-on, owns Telegram)
    ├── General tasks → handles directly
    ├── Coding/generic tasks → .copilot-queue.json → Copilot CLI daemon
    │                          → TopSpeed0/Copilot-CLI-Telegram-MCP
    └── Heavy/workspace tasks → .claude-queue.json → Claude Code daemon (this repo)
```

| Repo | Worker | Queue file | Best for |
|------|--------|------------|----------|
| [AI-MCP-telegram-agents](https://github.com/TopSpeed0/AI-MCP-telegram-agents) | VS Code Copilot Agent (v1 foundation) | `.vscode-queue.json` | VS Code-integrated workflows |
| [Copilot-CLI-Telegram-MCP](https://github.com/TopSpeed0/Copilot-CLI-Telegram-MCP) | Copilot CLI daemon | `.copilot-queue.json` | Generic tasks, any directory |
| **This repo** | Claude Code daemon | `.claude-queue.json` | Heavy reasoning, workspace tools |

### Generic + Local design

Each daemon works in **two modes simultaneously** — no config switch needed:
- **Standalone**: receives Telegram messages directly → runs `claude -p` → replies to Telegram
- **Hermes worker**: polls `.claude-queue.json` every 5s → picks up `pending` tasks → writes result back

Hermes writes tasks to `.claude-queue.json` in the workspace root:

```json
{
  "id": "hermes-001",
  "task": "Check disk usage on the NetApp cluster",
  "status": "pending",
  "created": "2026-05-31T10:00:00Z"
}
```

The daemon sets `status: "done"` and writes the result back — Hermes picks it up and delivers it to the user. No bot-to-bot Telegram messaging needed.

## License

MIT

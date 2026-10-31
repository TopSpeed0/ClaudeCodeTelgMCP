# Claude Code Workspace — Telegram Bridge

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js 22.15+](https://img.shields.io/badge/Node.js-22.15%2B-339933.svg?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Zero Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen.svg)](#)
[![Claude Code](https://img.shields.io/badge/Claude%20Code-MCP%20Server-7C3AED.svg?logo=anthropic&logoColor=white)](https://claude.com/claude-code)
[![Telegram Bot API](https://img.shields.io/badge/Telegram-Bot%20API-26A5E4.svg?logo=telegram&logoColor=white)](https://core.telegram.org/bots/api)
[![Platform](https://img.shields.io/badge/platform-Windows-0078D4.svg)](#)

A ready-to-clone workspace template for [Claude Code](https://claude.com/claude-code) with a built-in Telegram bot integration. Send tasks, receive notifications, and get remote approvals — all from your phone.

> **Platform:** built and tested on **Windows**. macOS and Linux are not tested yet — some groundwork exists in the code, but the setup wizard, launcher, autostart and shortcuts are Windows-only.

## What's Included

| File | Purpose |
|------|---------|
| `mcp/telegram-tg.js` | Zero-dependency MCP server — gives Claude `tg_send` and `tg_ask` tools |
| `mcp/telegram-task-daemon.js` | Always-on bridge: Telegram messages become `claude -p` tasks |
| `mcp/start-task-daemon.ps1` | Launcher with auto-restart (foreground or background) |
| `mcp/install-shortcuts.ps1` | Windows Start Menu + Desktop shortcut creator |
| `mcp/daemon-mcp.json` | MCP config for daemon-spawned sessions (placeholder env vars — real creds loaded from `.telegram-config`) |
| `CLAUDE.md` | Workspace instructions for Claude Code |
| `.mcp.json.example` | Template — copy to `.mcp.json` and add your credentials |
| `.claude/settings.local.json` | Pre-configured permissions for PowerShell, Node, Telegram tools |
| `.gitignore` | Excludes credentials and runtime state |

## Installation

### Prerequisites

Install all three in any order — one line each:

| Tool | Windows | macOS / Linux (untested) |
|------|---------|---------------|
| **Node.js 22.15+** | `winget install OpenJS.NodeJS.LTS` | `curl -fsSL https://fnm.vercel.app/install \| bash && fnm install --lts` |
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

### Setup Wizard (Windows, recommended)

Clone the repo and run the wizard. It checks Node.js and Claude Code, tests the connection to Telegram (and turns on `--use-system-ca` when a corporate TLS proxy is in the way), asks for your bot token, finds your chat ID when you send the bot a message, writes the gitignored config files, and offers autostart at sign-in, Start Menu / Desktop shortcuts and a first start with a "Setup done" message:

```powershell
git clone https://github.com/TopSpeed0/claude-telegram-bridge.git; cd claude-telegram-bridge; pwsh -File mcp/setup.ps1
```

Run it again any time to repair a setup: what exists is kept and only missing pieces are fixed (`-Reconfigure` asks for the bot again; `-Yes` accepts every default; `-NoAutostart`, `-NoShortcuts`, `-NoStart` skip those steps). Then send `/doctor` to the bot.

### One-Prompt Install

Manual alternative. Copy-paste this single block — it clones the repo, creates your config, and opens Claude Code:

**Windows (PowerShell):**
```powershell
git clone https://github.com/TopSpeed0/claude-telegram-bridge.git; cd claude-telegram-bridge; Copy-Item .mcp.json.example .mcp.json; '{}' | Out-File -Encoding utf8 .claude-queue.json; Write-Host "`nEdit .mcp.json — paste your TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID, then run: claude" -ForegroundColor Cyan
```

**macOS / Linux (bash, untested):**
```bash
git clone https://github.com/TopSpeed0/claude-telegram-bridge.git && cd claude-telegram-bridge && cp .mcp.json.example .mcp.json && echo '{}' > .claude-queue.json && echo -e "\n\033[36mEdit .mcp.json — paste your TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID, then run: claude\033[0m"
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

### (Optional) Voice Notes

Voice notes are transcribed **locally**, on your machine's CPU; no audio leaves it. This needs a one-time setup. Without it, the bot replies that voice is not installed, and everything else works as usual.

1. **Python 3.9+** with the `faster-whisper` package (about 100 MB with its dependencies, from PyPI):
   ```powershell
   python -m pip install faster-whisper
   ```
2. **ffmpeg** on `PATH` (recommended; for example `winget install Gyan.FFmpeg`). The script uses it to decode Telegram's Opus audio, which avoids PyAV version breakage.
3. **Pick a model** in `agent-runtime.json` under `telegram.voice.model`. The model is a **separate one-time download** from Hugging Face into your user cache:
   - `small`: about 500 MB, fast, fine for English
   - `large-v3-turbo`: about 1.6 GB, much better for other languages such as Hebrew, about 20 s for a short note on a laptop CPU
4. **Download the model before the first voice note.** The daemon gives a transcription 5 minutes, and a slow or proxied connection can take longer than that (the turbo download took about 7 minutes here). Run the script once by hand with any audio file:
   ```powershell
   python mcp\stt-faster-whisper.py C:\path\to\any-audio.ogg large-v3-turbo
   ```
5. Restart the daemon so it reads the model setting.

Optional: `telegram.voice.language` (for example `"he"`) forces one language. Leave it empty to auto-detect, which also handles notes that mix languages.

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
- Threads each answer under your message (including the agent's first `tg_send`)
- Reacts on your message: ✍ queued · 👀 working · 🎉 done · 💔 failed (cleared when stopped)
- Queues messages that arrive while a task runs and runs them in order; the queue survives a daemon restart
- Shows live progress: one silent status message (elapsed time, step count, the last three tool steps), updated in place and deleted when the task ends (`telegram.progress` in `agent-runtime.json`)
- Accepts photos and files: they are saved under `inbox/<day>/` (gitignored) and handed to Claude to read
- Transcribes voice notes locally with faster-whisper (`mcp/stt-faster-whisper.py`) after a one-time setup (see [Voice Notes](#optional-voice-notes)). Audio is decoded with ffmpeg when available. Notes that mix languages (e.g. English and Hebrew) are re-transcribed per segment so each part stays in its own language instead of being translated; that path takes about four times longer
- Collapses long code blocks into tap-to-expand quotes; answers longer than two messages arrive as the first part plus the full text as a file
- Shows 🟢 Online / 🔴 Offline in the bot's profile, with a "checked" time refreshed every 10 minutes
- Gates risky actions: daemon sessions load a PreToolUse hook (`mcp/telegram-approval-hook.js`) that holds sending mail, cluster writes, deletes, pushes and API writes until you tap ✅ / ❌ (no answer in 10 minutes = denied; rules and switch under `approval`). MCP tools ask when their name contains a changing verb as a whole word (`delete_volume`, `break_mirror`, `addCommentToIssue`), so reads such as `k8s_list_daemonsets` run freely
- Uses the same MCP servers as Claude Code on this machine: the ones registered with `claude mcp add` (user, project and local scope, local or remote, such as servers hosted on a Kubernetes cluster) plus the daemon's own connectors in `mcp-connectors.json`

Telegram commands (published to the bot's `/` menu at startup):
- **Answered at once, even mid-task:** `/status`, `/stop` (`/stop all` also empties the queue and stops side tasks, `/stop bg` side tasks only), `/queue`, `/usage` (cost, turns, tokens and time for the last task and today), `/bg <task>` (side task in its own session, in parallel), `/mcp`, `/skills`, `/help`
- **Run in turn with tasks:** `/plan <task>` (read-only run: looks and proposes, changes nothing), `/retry` (re-run your last message), `/new` or `/clear`, `/model [name]`
- **Every MCP server and every skill gets its own entry, found automatically.** Nothing is hard-coded: the menu is rebuilt at startup, on `/mcp` and on `/skills`.
  - **MCP servers** (🔌) come from the same configs Claude Code loads. Each one is asked the standard MCP way (`initialize`, then `tools/list`, over stdio or HTTP) what tools it has (`mcp/mcp-discovery.js`). Tap one alone to list its tools instantly, without starting Claude; add a request (`/storage list volumes over 90%`) to run a task that uses that server.
  - **Skills** (🧩) are every folder in `~/.claude/skills` that has a `SKILL.md`; the menu text is the first sentence of its description. Tap one alone and Claude explains what it does without running anything; add a request to run it.
  - **Names** follow Telegram's rules (`a-z`, `0-9`, `_`, at most 32 characters): `team-vm-manager` → `/team_vm_manager`, `über-tool` → `/uber_tool`. A name that clashes with a built-in or another entry gets `_2`, `_3` …; a name without Latin letters becomes `/skill_<hash>`. `/skills` shows the real name next to any renamed entry.
  - Telegram allows 100 menu commands. Anything past that still works when typed, and `/skills` and the daemon log list what did not fit.

While `tg_ask` or the approval hook waits for your reply it owns Telegram polling (`mcp/telegram-handshake.js`): it writes `.telegram-ask.active`, the daemon pauses, a reply the daemon caught just before pausing is handed over through `.telegram-ask-handoff.json`, and messages meant for the daemon (`/stop`, new tasks) go back through `.telegram-daemon-inbox.json`.

### Runtime model and context policy

Copy `agent-runtime.example.json` to the local, gitignored `agent-runtime.json` before starting the daemon. It controls Claude model selection, fallback model, reasoning effort, recent-turn window, and summary depth; set `agents.claude.chrome: true` to start task sessions with `--chrome` (Claude in Chrome tools; needs Chrome running with the extension connected). Restart the daemon after changing it.

**Sentry mode** (`telegram.sentry`, `/sentry on|off|now`) watches monitoring systems through the MCP servers you already have configured, with no Claude run: every few minutes each source's tool is called (the same servers a task session loads), new alerts are posted with 🔎 Investigate (a side task told to look only; plan mode is not used because it blocks MCP tools, and the approval gate still holds anything risky), 🔕 Mute 24h and 🙈 Ignore type (that title from then on; also `/sentry ignore <text>`, `/sentry ignored`, `/sentry unignore <n>`, or `ignore_titles` per source), and a posted alert that clears gets a silent ✅ reply. Nothing is product-specific: each source names its MCP server, tool, arguments and the fields to read (`list`, `id`, `title`, `object`, `severity`, `time`, optional `skip_if`, `only` and an `object_lookup` tool for friendlier names). Alerts already open when watching starts are counted, not posted. The example config ships it disabled.

The shared catalog includes the currently known Copilot-hosted Opus, Sonnet, and OpenAI/GPT model identifiers, with `gpt-5.6-terra` as the global default for Copilot. Claude Code uses the Claude-specific `agents.claude.model` entry because it cannot natively execute an OpenAI/Copilot model identifier. The initial Claude selection is `claude-opus-5-5` with `claude-sonnet-5` as a fallback. The Claude catalog includes `claude-haiku-4-5`, `claude-sonnet-5`, `claude-opus-5-5`, and `claude-fable-5`; choose only model identifiers accepted by the installed Claude Code CLI.

Direct Telegram messages and `.claude-queue.json` tasks now both perform daily rollover, use archive recovery, and append successful turns to the same archive. That prevents the queue worker from becoming a context-less second agent.

### Anti-Double-Send Pattern
When Claude uses `tg_send` to deliver a rich-formatted answer, it prints `[sent-via-tg]` to stdout. The daemon detects this sentinel and skips its own relay — so the user sees the message exactly once.

## Customization

- **Add your own tools**: Edit `CLAUDE.md` with domain-specific instructions
- **Add a workspace profile**: Create `profile1.ps1` with custom PowerShell functions, reference it in `CLAUDE.md`
- **Corporate proxy/TLS**: Add `--use-system-ca` to Node args in `.mcp.json` (requires Node 22.15+)
- **Other platforms**: Tested on Windows only. The daemon has macOS/Linux code paths (process spawning, paths) but they are untested

## Requirements

- [Claude Code CLI](https://claude.com/claude-code) installed and authenticated
- Node.js 22.15+ (the launcher starts the daemon with `--use-system-ca`)
- PowerShell 7+ (for the launcher and shortcut scripts)
- A Telegram bot token + your chat ID
- Optional, for voice notes: Python 3.9+ with `faster-whisper`, ffmpeg, and a one-time Whisper model download (500 MB – 1.6 GB); see [Voice Notes](#optional-voice-notes)

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

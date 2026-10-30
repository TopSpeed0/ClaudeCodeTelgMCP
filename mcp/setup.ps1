#Requires -Version 7.0
# setup.ps1 — one-command setup (and repair) for the Telegram -> Claude Code bridge.
#
# Usage:
#   pwsh -File mcp/setup.ps1                # asks before each optional step
#   pwsh -File mcp/setup.ps1 -Yes           # accepts every default (autostart, shortcuts, start)
#   pwsh -File mcp/setup.ps1 -Reconfigure   # asks for the bot token and chat again
#
# Safe to run again: what is already set up is kept, and only missing or
# broken pieces are fixed. Everything it writes is gitignored.

param(
  [switch]$Yes,           # accept the default answer to every question
  [switch]$Reconfigure,   # ignore the saved bot token and chat
  [switch]$NoAutostart,   # skip the Windows scheduled task
  [switch]$NoShortcuts,   # skip the Start Menu / Desktop shortcuts
  [switch]$NoStart,       # do not start the bridge at the end
  [string]$TaskName = 'Claude Telegram Task Bridge'
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$launcher = Join-Path $PSScriptRoot 'start-task-daemon.ps1'
$notes = [System.Collections.Generic.List[string]]::new()

function Step($n, $text) { Write-Host "`n[$n/7] $text" -ForegroundColor Cyan }
function Ok($text) { Write-Host "  ✓ $text" -ForegroundColor Green }
function Note($text) { Write-Host "  ! $text" -ForegroundColor Yellow; $notes.Add($text) }
function Fail($text) { Write-Host "  ✗ $text" -ForegroundColor Red; exit 1 }
function Ask($question, [bool]$default = $true) {
  if ($Yes) { return $default }
  $answer = Read-Host "  $question [$(if ($default) { 'Y/n' } else { 'y/N' })]"
  if ([string]::IsNullOrWhiteSpace($answer)) { return $default }
  return $answer -match '^\s*(y|yes)\s*$'
}
function Read-JsonFile($path) {
  if (-not (Test-Path $path)) { return $null }
  try { return Get-Content $path -Raw | ConvertFrom-Json -AsHashtable } catch { return $null }
}
function Write-JsonFile($path, $obj) {
  ConvertTo-Json -InputObject $obj -Depth 20 | Set-Content -Path $path -Encoding utf8NoBOM
}
function Copy-Example($name, $example) {
  $target = Join-Path $repo $name
  if (Test-Path $target) { Ok "$name kept as it is"; return }
  Copy-Item (Join-Path $repo $example) $target
  Ok "$name created from $example"
}
# Bot API call. PowerShell uses the Windows certificate store, so a
# TLS-inspecting proxy does not get in the way here.
function Tg($token, $method, $body = @{}) {
  Invoke-RestMethod -Uri "https://api.telegram.org/bot$token/$method" -Method Post `
    -Body (ConvertTo-Json -InputObject $body -Depth 5) -ContentType 'application/json' -TimeoutSec 70
}
function Daemons() {
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -match 'telegram-task-daemon\.js' }
}
$placeholder = '^\s*$|^YOUR_|^123456789'

Write-Host 'Claude Code Telegram bridge: setup' -ForegroundColor White
Write-Host "Folder: $repo"

# ── 1. Prerequisites ──
Step 1 'Prerequisites'
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Fail 'Node.js not found. Install Node.js 22.15 or newer (https://nodejs.org), then run this again.'
}
$nodeVersion = [version]((node --version).Trim().TrimStart('v'))
if ($nodeVersion -lt [version]'22.15.0') {
  Fail "Node.js $nodeVersion is too old: the bridge needs 22.15 or newer (it starts Node with --use-system-ca)."
}
Ok "Node.js $nodeVersion"
if (-not (Get-Command claude -ErrorAction SilentlyContinue)) {
  Fail 'Claude Code CLI not found. Install it (npm install -g @anthropic-ai/claude-code), run "claude" once to sign in, then run this again.'
}
Ok "Claude Code $((claude --version 2>$null | Select-Object -First 1))"
if (-not $env:ANTHROPIC_API_KEY -and -not (Test-Path (Join-Path $HOME '.claude/.credentials.json'))) {
  Note 'No Claude sign-in found. Run "claude" once in a terminal and sign in, or the bridge cannot answer.'
}

# ── 2. Network ──
Step 2 'Connection to Telegram'
$probe = "fetch('https://api.telegram.org').then(() => process.exit(0), () => process.exit(1))"
node -e $probe 2>$null
$needSystemCa = $false
if ($LASTEXITCODE -eq 0) {
  Ok 'Node reaches api.telegram.org'
} else {
  node --use-system-ca -e $probe 2>$null
  if ($LASTEXITCODE -ne 0) { Fail 'Node cannot reach https://api.telegram.org, not even with the Windows certificate store. Check the network or proxy, then run this again.' }
  $needSystemCa = $true
  Ok 'Node reaches api.telegram.org through the Windows certificate store (a TLS-inspecting proxy is in the way), so --use-system-ca will be used'
}

# ── 3. Bot and chat ──
Step 3 'Telegram bot and your chat'
$configPath = Join-Path $repo '.telegram-config'
$saved = Read-JsonFile $configPath
$token = if ($saved -and -not $Reconfigure) { [string]$saved.bot_token } else { '' }
$chatId = if ($saved -and -not $Reconfigure) { [string]$saved.chat_id } else { '' }
if ($token -match $placeholder) { $token = '' }
if ($chatId -match $placeholder) { $chatId = '' }
$bot = $null
if ($token) {
  try { $bot = (Tg $token 'getMe').result; Ok "Bot @$($bot.username), from the saved .telegram-config" }
  catch { Note "The saved bot token was rejected ($($_.Exception.Message)); asking for a new one."; $token = ''; $chatId = '' }
}
if (-not $token) {
  Write-Host '  In Telegram, open @BotFather, send /newbot, and paste the token it gives you.'
  while (-not $token) {
    $candidate = (Read-Host '  Bot token' -MaskInput).Trim()
    try { $bot = (Tg $candidate 'getMe').result; $token = $candidate; Ok "Token works: @$($bot.username)" }
    catch { Write-Host '  ✗ Telegram rejected that token. Paste it again, or Ctrl+C to stop.' -ForegroundColor Red }
  }
}
if (-not $chatId) {
  # Only one program may read the bot's messages; a running bridge would take the "hi".
  $running = @(Daemons)
  if ($running) {
    Write-Host '  Stopping the running bridge while your chat is found…'
    $running | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Seconds 2
  }
  Write-Host "  Now open @$($bot.username) in Telegram and send it any message (for example: hi). Waiting up to 3 minutes…"
  $offset = 0; $deadline = (Get-Date).AddMinutes(3); $who = ''
  while (-not $chatId -and (Get-Date) -lt $deadline) {
    try { $updates = (Tg $token 'getUpdates' @{ offset = $offset; timeout = 25; allowed_updates = @('message') }).result }
    catch { Fail "Could not read the bot's messages: $($_.Exception.Message). If the bot has a webhook, remove it (deleteWebhook) and run this again." }
    foreach ($u in $updates) {
      $offset = $u.update_id + 1
      if ($u.message -and $u.message.chat.type -eq 'private') { $chatId = [string]$u.message.chat.id; $who = $u.message.from.first_name }
    }
  }
  if (-not $chatId) { Fail 'No message arrived within 3 minutes. Run this again and send the bot a message when asked.' }
  # Mark the "hi" as read, so the bridge does not treat it as a task.
  Tg $token 'getUpdates' @{ offset = $offset; timeout = 0 } | Out-Null
  Ok "Found your chat: $who ($chatId). Only this chat can use the bot."
}
Write-JsonFile $configPath ([ordered]@{ bot_token = $token; chat_id = $chatId })
Ok '.telegram-config saved'

# ── 4. Config files ──
Step 4 'Config files (all gitignored)'
$mcpPath = Join-Path $repo '.mcp.json'
$mcp = Read-JsonFile $mcpPath
if (-not $mcp) { $mcp = Read-JsonFile (Join-Path $repo '.mcp.json.example') }
if (-not $mcp.ContainsKey('mcpServers') -or -not $mcp.mcpServers) { $mcp.mcpServers = [ordered]@{} }
$server = $mcp.mcpServers['telegram-tg']
if (-not $server) { $server = [ordered]@{ command = 'node'; args = @('mcp/telegram-tg.js'); env = [ordered]@{} }; $mcp.mcpServers['telegram-tg'] = $server }
$nodeArgs = @($server.args)
if ($needSystemCa -and $nodeArgs -notcontains '--use-system-ca') { $nodeArgs = @('--use-system-ca') + $nodeArgs }
$server.args = $nodeArgs
if (-not $server.env) { $server.env = [ordered]@{} }
$server.env.TELEGRAM_BOT_TOKEN = $token
$server.env.TELEGRAM_CHAT_ID = $chatId
Write-JsonFile $mcpPath $mcp
Ok '.mcp.json: the telegram-tg server (tg_send, tg_ask) uses your bot; other servers in it are kept'
Copy-Example 'agent-runtime.json' 'agent-runtime.example.json'
Copy-Example 'mcp-connectors.json' 'mcp-connectors.example.json'
# The Hermes queue poller expects this file to exist.
$queueFile = Join-Path $repo '.claude-queue.json'
if (-not (Test-Path $queueFile)) { Set-Content -Path $queueFile -Value '{}' -Encoding utf8NoBOM; Ok '.claude-queue.json created (empty)' }

# ── 5. Autostart ──
Step 5 'Start with Windows'
$existingTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
$taskDir = if ($existingTask) { $existingTask.Actions[0].WorkingDirectory } else { $null }
if ($NoAutostart) {
  Ok 'Skipped (-NoAutostart)'
} elseif ($existingTask -and $taskDir -and $taskDir.TrimEnd('\') -ne $repo.TrimEnd('\') -and -not (Ask "Scheduled task '$TaskName' runs the bridge from $taskDir. Point it to this folder instead?" $false)) {
  Note "Autostart left pointing to $taskDir."
} elseif (Ask "Start the bridge when you sign in to Windows, and restart it if it stops (scheduled task '$TaskName')?") {
  $pwsh = (Get-Command pwsh).Source
  $user = "$env:USERDOMAIN\$env:USERNAME"
  $action = New-ScheduledTaskAction -Execute $pwsh -Argument "-WindowStyle Hidden -File `"$launcher`" -Background -IfNotRunning" -WorkingDirectory $repo
  $atLogon = New-ScheduledTaskTrigger -AtLogOn -User $user
  $watchdog = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 10)
  $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -Hidden
  $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $atLogon, $watchdog -Settings $settings -Principal $principal `
    -Description 'Telegram -> Claude Code bridge: starts at sign-in; every 10 minutes it starts the bridge again if it is not running.' -Force | Out-Null
  Ok "Scheduled task '$TaskName': at sign-in, and every 10 minutes if the bridge stopped"
} else {
  Note 'No autostart: start the bridge with the shortcut or mcp/start-task-daemon.ps1 -Background.'
}

# ── 6. Shortcuts ──
Step 6 'Shortcuts'
if ($NoShortcuts) { Ok 'Skipped (-NoShortcuts)' }
elseif (Ask 'Add Start Menu and Desktop shortcuts (start / restart the bridge)?') { & (Join-Path $PSScriptRoot 'install-shortcuts.ps1') | Out-Null; Ok 'Shortcuts added' }
else { Ok 'Skipped' }

# ── 7. Start ──
Step 7 'Start the bridge'
if ($NoStart -or -not (Ask 'Start (or restart) the bridge now?')) {
  Ok 'Not started. Start it with the shortcut or: pwsh -File mcp/start-task-daemon.ps1 -Background'
} else {
  & $launcher -Background
  if ($LASTEXITCODE -ne 0) { Fail "The bridge did not stay up; see $(Join-Path $PSScriptRoot 'task-daemon.log.err')." }
  Ok 'Bridge running'
  try {
    Tg $token 'sendMessage' @{ chat_id = $chatId; parse_mode = 'HTML'; text = "✅ <b>Setup done</b> on <code>$env:COMPUTERNAME</code>.`nSend /doctor for a health check, or /help for what I can do." } | Out-Null
    Ok 'Sent you a "Setup done" message in Telegram'
  } catch { Note "Could not send the test message: $($_.Exception.Message)" }
}

Write-Host "`nDone." -ForegroundColor Green
if ($notes.Count) { Write-Host 'Worth a look:' -ForegroundColor Yellow; $notes | ForEach-Object { Write-Host "  - $_" } }
Write-Host @'
Optional, any time:
  - Voice notes: pip install faster-whisper (then /doctor shows Voice ready)
  - Models, progress display, sentry alert sources: agent-runtime.json (restart the bridge after editing)
  - Your own instructions for the bot: CLAUDE.local.md in this folder
'@

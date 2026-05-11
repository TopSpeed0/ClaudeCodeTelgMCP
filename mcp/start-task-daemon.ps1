# start-task-daemon.ps1 — launch the Telegram -> Claude Code bridge.
#
# Usage:
#   .\mcp\start-task-daemon.ps1            # runs in foreground (current terminal)
#   .\mcp\start-task-daemon.ps1 -Background # detaches; logs to mcp/task-daemon.log

param(
  [switch]$Background
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$daemon = Join-Path $PSScriptRoot 'telegram-task-daemon.js'
$logFile = Join-Path $PSScriptRoot 'task-daemon.log'

# Kill any existing daemon so the shortcut acts as a clean restart.
# Match by command line so we only touch *our* node process, not unrelated Node apps.
$existing = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and $_.CommandLine -match 'telegram-task-daemon\.js' }
foreach ($p in $existing) {
  Write-Host "Stopping previous daemon (PID=$($p.ProcessId), started $($p.CreationDate))"
  Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
}
if ($existing) {
  # Give Telegram a moment to release the long-poll slot before the new instance binds.
  Start-Sleep -Seconds 2
}

# Pull credentials from .mcp.json so we don't duplicate config.
$mcp = Get-Content (Join-Path $repo '.mcp.json') -Raw | ConvertFrom-Json
$tg = $mcp.mcpServers.'telegram-tg'.env
if (-not $tg.TELEGRAM_BOT_TOKEN -or -not $tg.TELEGRAM_CHAT_ID) {
  throw "telegram-tg env not found in .mcp.json"
}
$env:TELEGRAM_BOT_TOKEN = $tg.TELEGRAM_BOT_TOKEN
$env:TELEGRAM_CHAT_ID   = $tg.TELEGRAM_CHAT_ID

Write-Host "Starting task daemon (chat_id=$($tg.TELEGRAM_CHAT_ID))"
Write-Host "Workspace: $repo"

if ($Background) {
  # Quote the daemon path so spaces in directory names don't split it into multiple args.
  $nodeArgs = "--use-system-ca `"$daemon`""
  $proc = Start-Process -FilePath 'node' -ArgumentList $nodeArgs `
    -WorkingDirectory $repo -WindowStyle Hidden `
    -RedirectStandardOutput $logFile -RedirectStandardError "$logFile.err" `
    -PassThru
  Write-Host "Detached PID=$($proc.Id). Logs: $logFile"
  Write-Host "Stop with: Stop-Process -Id $($proc.Id)"
} else {
  Set-Location $repo
  & node --use-system-ca $daemon
}

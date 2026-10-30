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

# The Start Menu / Desktop shortcuts run this with -WindowStyle Hidden, so an
# unhandled error would disappear with the window and look like "nothing happened".
# Leave a breadcrumb on disk instead.
$startupLog = Join-Path $PSScriptRoot 'start-task-daemon.err.log'
trap {
  "[$(Get-Date -Format s)] start failed: $($_.Exception.Message)`n$($_.ScriptStackTrace)" |
    Add-Content -Path $startupLog -Encoding utf8
  break
}

# ── Requirements check ──
$reqFile = Join-Path $repo 'requirements.txt'
if (Test-Path $reqFile) {
  Write-Host "`n[requirements] Checking dependencies..." -ForegroundColor Cyan
  $failed = @()
  Get-Content $reqFile | Where-Object { $_ -notmatch '^\s*#' -and $_.Trim() -ne '' } | ForEach-Object {
    $parts = $_ -split ':'
    $type = $parts[0].Trim()
    $name = $parts[1].Trim()
    $minVer = $parts[2].Trim()
    $checkCmd = $parts[3].Trim()

    try {
      $verRaw = & cmd /c "$checkCmd 2>&1" | Select-Object -First 1
      $verMatch = [regex]::Match($verRaw, '(\d+\.\d+[\.\d]*)')
      $verStr = if ($verMatch.Success) { $verMatch.Value } else { '?' }

      if ($minVer -and $verMatch.Success) {
        $actual = [Version]$verStr
        $required = [Version]$minVer
        if ($actual -lt $required) {
          Write-Host "  ✗ $name — found $verStr, need >= $minVer" -ForegroundColor Red
          $failed += $name
        } else {
          Write-Host "  ✓ $name $verStr" -ForegroundColor Green
        }
      } else {
        Write-Host "  ✓ $name $verStr" -ForegroundColor Green
      }
    } catch {
      Write-Host "  ✗ $name — NOT FOUND (run: npm install -g $name)" -ForegroundColor Red
      $failed += $name
    }
  }

  if ($failed.Count -gt 0) {
    Write-Host "`n[requirements] Missing: $($failed -join ', ')" -ForegroundColor Red
    Write-Host "[requirements] Fix and re-run." -ForegroundColor Yellow
    exit 1
  }
  Write-Host "[requirements] All OK`n" -ForegroundColor Green
}
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

# A force-killed daemon never runs its exit handler, so .telegram-task-daemon.lock
# keeps pointing at a dead PID. The daemon treats a PID it cannot signal as alive,
# so once Windows recycles that number onto someone else's process the next start
# aborts with "another daemon is already running". Clear the lock unless a real
# daemon still holds it.
$lockFile = Join-Path $repo '.telegram-task-daemon.lock'
if (Test-Path $lockFile) {
  $lockPid = (Get-Content $lockFile -Raw).Trim()
  $holder = $null
  if ($lockPid -match '^\d+$') {
    $holder = Get-CimInstance Win32_Process -Filter "ProcessId=$lockPid" -ErrorAction SilentlyContinue |
      Where-Object { $_.CommandLine -and $_.CommandLine -match 'telegram-task-daemon\.js' }
  }
  if (-not $holder) {
    Write-Host "Clearing stale lock (PID=$lockPid is not a running daemon)" -ForegroundColor Yellow
    Remove-Item $lockFile -Force -ErrorAction SilentlyContinue
  }
}

# Pull credentials from .mcp.json so we don't duplicate config.
$mcp = Get-Content (Join-Path $repo '.mcp.json') -Raw | ConvertFrom-Json
$tg = $mcp.mcpServers.'telegram-tg'.env
if (-not $tg.TELEGRAM_BOT_TOKEN -or -not $tg.TELEGRAM_CHAT_ID) {
  throw "telegram-tg env not found in .mcp.json"
}
$env:TELEGRAM_BOT_TOKEN = $tg.TELEGRAM_BOT_TOKEN
$env:TELEGRAM_CHAT_ID   = $tg.TELEGRAM_CHAT_ID

# Generate the daemon MCP config from this repo's private connector registry.
& node (Join-Path $PSScriptRoot 'sync-mcp-connectors.js') claude
if ($LASTEXITCODE -ne 0) { throw "MCP connector sync failed" }

Write-Host "Starting task daemon (chat_id=$($tg.TELEGRAM_CHAT_ID))"
Write-Host "Workspace: $repo"

if ($Background) {
  # The redirects below truncate, and the reason a daemon died is in the previous
  # run's output — keep one generation so a silent death stays diagnosable.
  foreach ($f in @($logFile, "$logFile.err")) {
    if (Test-Path $f) { Move-Item $f "$f.prev" -Force -ErrorAction SilentlyContinue }
  }
  # Quote the daemon path so spaces in directory names don't split it into multiple args.
  $nodeArgs = "--use-system-ca `"$daemon`""
  $proc = Start-Process -FilePath 'node' -ArgumentList $nodeArgs `
    -WorkingDirectory $repo -WindowStyle Hidden `
    -RedirectStandardOutput $logFile -RedirectStandardError "$logFile.err" `
    -PassThru

  # Spawning is not running: the daemon exits on its own when the lock is held or
  # Telegram rejects the token. Confirm it survived before reporting success.
  Start-Sleep -Seconds 8
  if ($proc.HasExited) {
    $tail = @(Get-Content "$logFile.err" -Tail 20 -ErrorAction SilentlyContinue)
    Write-Host "Daemon exited immediately (code=$($proc.ExitCode))" -ForegroundColor Red
    $tail | ForEach-Object { Write-Host "  $_" }
    "[$(Get-Date -Format s)] daemon exited immediately (code=$($proc.ExitCode))`n$($tail -join [Environment]::NewLine)" |
      Add-Content -Path $startupLog -Encoding utf8
    exit 1
  }
  Write-Host "Detached PID=$($proc.Id). Logs: $logFile" -ForegroundColor Green
  Write-Host "Stop with: Stop-Process -Id $($proc.Id)"
} else {
  Set-Location $repo
  & node --use-system-ca $daemon
}

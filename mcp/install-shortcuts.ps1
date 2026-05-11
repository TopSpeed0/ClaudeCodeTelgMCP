# install-shortcuts.ps1 — create Start Menu + Desktop shortcuts for the Telegram task daemon.
#
# Usage: .\mcp\install-shortcuts.ps1
# Re-run any time to recreate / update icons.

$ErrorActionPreference = 'Stop'

$repo     = Split-Path -Parent $PSScriptRoot
$launcher = Join-Path $PSScriptRoot 'start-task-daemon.ps1'
$pwshCmd  = Get-Command pwsh -ErrorAction SilentlyContinue
if (-not $pwshCmd) { throw "pwsh (PowerShell 7+) not found in PATH." }
$pwsh = $pwshCmd.Source

$startMenu = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
if (-not (Test-Path $startMenu)) { New-Item -ItemType Directory -Path $startMenu | Out-Null }

# Desktop — uses Shell folder API so OneDrive-redirected desktops resolve correctly.
$desktop = [Environment]::GetFolderPath('Desktop')

# Icon picks (change indices if you want a different look — these are stable on Win10/11):
#   imageres.dll,76  -> chat bubble (foreground / live view)
#   imageres.dll,170 -> robot face  (background daemon)
$fgIcon = "$env:SystemRoot\System32\imageres.dll,76"
$bgIcon = "$env:SystemRoot\System32\imageres.dll,170"

$shell = New-Object -ComObject WScript.Shell

function New-AppShortcut {
  param($Path, $ArgString, $Icon, $Description)
  $lnk = $shell.CreateShortcut($Path)
  $lnk.TargetPath       = $pwsh
  $lnk.Arguments        = $ArgString
  $lnk.WorkingDirectory = $repo
  $lnk.IconLocation     = $Icon
  $lnk.Description      = $Description
  $lnk.Save()
  Write-Host "  + $Path"
}

Write-Host "Installing shortcuts (Start Menu + Desktop)..."

$fgArgs = "-NoExit -File `"$launcher`""
$bgArgs = "-WindowStyle Hidden -File `"$launcher`" -Background"

foreach ($folder in @($startMenu, $desktop)) {
  New-AppShortcut -Path (Join-Path $folder 'Telegram Task Bridge.lnk') `
    -ArgString $fgArgs -Icon $fgIcon `
    -Description 'Telegram -> Claude Code bridge (foreground; logs visible)'

  New-AppShortcut -Path (Join-Path $folder 'Telegram Task Bridge (Background).lnk') `
    -ArgString $bgArgs -Icon $bgIcon `
    -Description 'Telegram -> Claude Code bridge (detached; logs to mcp/task-daemon.log)'
}

Write-Host "`nDone. Shortcuts in Start Menu and on Desktop ($desktop)."

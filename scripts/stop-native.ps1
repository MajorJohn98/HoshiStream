# Stops the HoshiStream native server on Windows — the counterpart of
# stop-native.sh. Windows has no SIGTERM: terminating only the supervisor
# would orphan TorrServer, so the whole process tree is terminated instead.
#Requires -Version 5.1
$ErrorActionPreference = "Stop"

$StateDir = if ($env:HOSHISTREAM_STATE_DIR) { $env:HOSHISTREAM_STATE_DIR }
  else { Join-Path $env:LOCALAPPDATA "HoshiStream" }
$PidFile = Join-Path $StateDir "hoshistream.pid"

if (-not (Test-Path $PidFile)) {
  Write-Output "HoshiStream native server is not running."
  exit 0
}

$ServerPid = (Get-Content $PidFile -TotalCount 1).Trim()
if ($ServerPid -notmatch '^\d+$') {
  Write-Error "Invalid native server PID file."
  exit 1
}

if (Get-Process -Id ([int]$ServerPid) -ErrorAction SilentlyContinue) {
  taskkill /PID $ServerPid /T /F | Out-Null
  for ($i = 0; $i -lt 40; $i++) {
    if (-not (Get-Process -Id ([int]$ServerPid) -ErrorAction SilentlyContinue)) { break }
    Start-Sleep -Milliseconds 250
  }
}
Remove-Item $PidFile -ErrorAction SilentlyContinue
Write-Output "HoshiStream native server stopped."

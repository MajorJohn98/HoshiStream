# Starts the HoshiStream native server on Windows — the counterpart of
# start-native.sh. Works from a checkout (builds the add-on first) and from
# the packaged zip (prebuilt dist, bundled Node under bin\).
#Requires -Version 5.1
$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
$StateDir = if ($env:HOSHISTREAM_STATE_DIR) { $env:HOSHISTREAM_STATE_DIR }
  else { Join-Path $env:LOCALAPPDATA "HoshiStream" }
$LogDir = Join-Path $StateDir "logs"
$PidFile = Join-Path $StateDir "hoshistream.pid"

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

if (Test-Path $PidFile) {
  $Existing = (Get-Content $PidFile -TotalCount 1).Trim()
  if ($Existing -match '^\d+$' -and
      (Get-Process -Id ([int]$Existing) -ErrorAction SilentlyContinue)) {
    Write-Output "HoshiStream native server is already running."
    exit 0
  }
  # Stale PID file from a crash or forced shutdown.
  Remove-Item $PidFile -ErrorAction SilentlyContinue
}

# The packaged zip carries Node under bin\; a checkout uses the vendored
# fetch; a dev machine falls back to node on PATH.
$Node = @(
  (Join-Path $Root "bin\node.exe"),
  (Join-Path $Root "vendor\node\win32-x64\node.exe")
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $Node) { $Node = "node" }

# A checkout has add-on sources that must be compiled; the zip ships dist only.
if (Test-Path (Join-Path $Root "addon\src")) {
  Push-Location (Join-Path $Root "addon")
  try { npm run build | Out-Null } finally { Pop-Location }
}

$Server = Join-Path $Root "scripts\native-server.mjs"
$ServerArgs = @(
  "`"$Server`"",
  "--state-dir=`"$StateDir`"",
  "--project-root=`"$StateDir`"",
  "--detached"
) + $args
Start-Process -FilePath $Node -ArgumentList $ServerArgs -WindowStyle Hidden `
  -RedirectStandardOutput (Join-Path $LogDir "hoshistream.log") `
  -RedirectStandardError (Join-Path $LogDir "hoshistream.err.log")

for ($i = 0; $i -lt 60; $i++) {
  if (Test-Path $PidFile) {
    $Started = (Get-Content $PidFile -TotalCount 1 -ErrorAction SilentlyContinue)
    if ($Started -and $Started.Trim() -match '^\d+$' -and
        (Get-Process -Id ([int]$Started.Trim()) -ErrorAction SilentlyContinue)) {
      Write-Output "HoshiStream native server started."
      exit 0
    }
  }
  Start-Sleep -Milliseconds 250
}

Write-Error "HoshiStream native server failed to start. Check $LogDir\hoshistream.log"
exit 1

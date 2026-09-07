# Authenticates the running instance and asks it to flush state and stop.
#Requires -Version 5.1
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$StateDir = if ($env:HOSHISTREAM_STATE_DIR) { $env:HOSHISTREAM_STATE_DIR }
  else { Join-Path $env:LOCALAPPDATA "HoshiStream" }
$Node = @(
  (Join-Path $Root "bin\node.exe"),
  (Join-Path $Root "vendor\node\win32-x64\node.exe")
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $Node) { $Node = (Get-Command node.exe -ErrorAction Stop).Source }
& $Node (Join-Path $Root "scripts\native-control.mjs") stop "--state-dir=$StateDir"
if ($LASTEXITCODE -ne 0) {
  throw "Shutdown was not confirmed. Inspect the logs; no unverified process was killed."
}

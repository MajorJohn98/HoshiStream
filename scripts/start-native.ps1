# Starts the server without the desktop shell. --dev runs TypeScript directly.
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
$Control = Join-Path $Root "scripts\native-control.mjs"

if (Test-Path (Join-Path $StateDir "run\control.json")) {
  $PreviousPreference = $ErrorActionPreference
  try {
    # Windows PowerShell 5.1 promotes redirected native stderr to an error.
    # A stale control file is an expected failed probe, not a launch failure.
    $ErrorActionPreference = "Continue"
    $Status = & $Node $Control status "--state-dir=$StateDir" 2>$null
    $StatusCode = $LASTEXITCODE
  } finally { $ErrorActionPreference = $PreviousPreference }
  if ($StatusCode -eq 0) {
    Write-Output "HoshiStream already owns this state directory. Stop it before starting another instance."
    exit 0
  }
}

if (-not ($args -contains "--dev") -and (Test-Path (Join-Path $Root "addon\src"))) {
  Push-Location (Join-Path $Root "addon")
  try {
    & npm.cmd run build
    if ($LASTEXITCODE -ne 0) { throw "The add-on build failed. No server was started." }
  } finally { Pop-Location }
}
& $Node $Control prepare "--state-dir=$StateDir"
if ($LASTEXITCODE -ne 0) { throw "Could not prepare private runtime logs." }

function Quote-Argument([string]$Value) {
  # Start-Process flattens ArgumentList into one Windows command line.
  return '"' + [regex]::Replace(
    [regex]::Replace($Value, '(\\*)"', '$1$1\"'), '(\\+)$', '$1$1'
  ) + '"'
}
$ServerArgs = @(
  (Join-Path $Root "scripts\native-server.mjs"),
  "--state-dir=$StateDir",
  "--project-root=$StateDir",
  "--detached"
) + $args
$CommandLine = ($ServerArgs | ForEach-Object { Quote-Argument $_ }) -join ' '
$LogDir = Join-Path $StateDir "logs"
$LogName = "hoshistream-" + [DateTime]::UtcNow.ToString("yyyyMMdd-HHmmss-fffffff")
$Started = Start-Process -FilePath $Node -ArgumentList $CommandLine `
  -WindowStyle Hidden -WorkingDirectory $Root -PassThru `
  -RedirectStandardOutput (Join-Path $LogDir "$LogName.log") `
  -RedirectStandardError (Join-Path $LogDir "$LogName.err.log")
& $Node $Control wait "--state-dir=$StateDir" "--pid=$($Started.Id)"
if ($LASTEXITCODE -ne 0) {
  throw "HoshiStream did not become ready. Inspect $LogDir\$LogName.err.log"
}

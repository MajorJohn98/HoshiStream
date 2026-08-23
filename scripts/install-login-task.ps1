# Registers HoshiStream to start at login for the current user (opt-in),
# via the per-user Run key — no administrator rights required.
#Requires -Version 5.1
$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
$Start = Join-Path $Root "scripts\start-native.ps1"
$Command = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$Start`""

Set-ItemProperty -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run" `
  -Name "HoshiStream" -Value $Command
Write-Output "HoshiStream will start at login. Run uninstall-login-task.ps1 to undo."

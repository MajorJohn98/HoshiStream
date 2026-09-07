# Removes the start-at-login registration created by install-login-task.ps1.
#Requires -Version 5.1
$ErrorActionPreference = "Stop"

$Key = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
$Root = Split-Path -Parent $PSScriptRoot
$Existing = (Get-ItemProperty -Path $Key -Name "HoshiStream" -ErrorAction SilentlyContinue).HoshiStream
if ($Existing -and -not (
  $Existing -eq "`"$(Join-Path $Root 'HoshiStream.exe')`"" -or
  $Existing -eq "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$(Join-Path $Root 'scripts\start-native.ps1')`""
)) {
  throw "The login entry belongs to another HoshiStream installation; it was not changed."
}
if ($Existing) { Remove-ItemProperty -Path $Key -Name "HoshiStream" }
Write-Output "HoshiStream start-at-login registration removed."

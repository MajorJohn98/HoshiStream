# Removes the start-at-login registration created by install-login-task.ps1.
#Requires -Version 5.1
$ErrorActionPreference = "Stop"

Remove-ItemProperty -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run" `
  -Name "HoshiStream" -ErrorAction SilentlyContinue
Write-Output "HoshiStream start-at-login registration removed."

param(
    [Parameter(Mandatory = $true)]
    [string] $Installer
)
$ErrorActionPreference = 'Stop'
if (-not $IsWindows) { throw 'Installer smoke requires Windows PowerShell 7 on a disposable CI runner.' }
if ($env:CI -ne 'true') { throw 'Installer smoke is restricted to disposable CI runners.' }

$testRoot = Join-Path $env:RUNNER_TEMP ('HoshiStream install test ' + [char]0x65e5 + ' ' + [guid]::NewGuid())
$install = Join-Path $testRoot 'program'
$state = Join-Path $testRoot 'state'
$external = Join-Path $testRoot 'external-media'
$previousState = $env:HOSHISTREAM_STATE_DIR
$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$foreignLogin = '"' + (Join-Path $external 'OtherInstallation.exe') + '"'

function Run-InstallerCommand([string] $File, [string[]] $Arguments) {
    $process = Start-Process -FilePath $File -ArgumentList $Arguments -PassThru
    try {
        if (-not $process.WaitForExit(120000)) {
            $process.Kill()
            throw 'The owned installer test process timed out.'
        }
        if ($process.ExitCode -ne 0) { throw "Installer command failed with code $($process.ExitCode)." }
    } finally {
        $process.Dispose()
    }
}

New-Item -ItemType Directory -Path $state, $external -Force | Out-Null
Set-Content -LiteralPath (Join-Path $state 'preserve.txt') -Value 'private state sentinel'
Set-Content -LiteralPath (Join-Path $external 'preserve.txt') -Value 'external media sentinel'
$env:HOSHISTREAM_STATE_DIR = $state
if (-not (Test-Path -LiteralPath $runKey)) {
    New-Item -Path $runKey | Out-Null
}
if ($null -ne (Get-Item -LiteralPath $runKey).GetValue('HoshiStream')) {
    throw 'Refusing to overwrite an existing startup registration in an installer fixture.'
}
New-ItemProperty -LiteralPath $runKey -Name 'HoshiStream' -Value $foreignLogin -PropertyType String | Out-Null
try {
    $arguments = @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/SP-', "/DIR=`"$install`"")
    Run-InstallerCommand $Installer $arguments
    if (-not (Test-Path -LiteralPath (Join-Path $install 'HoshiStream.exe'))) { throw 'Installed app missing.' }
    Run-InstallerCommand (Join-Path $install 'HoshiStream.exe') @('--self-test')
    Run-InstallerCommand $Installer ($arguments + @('/TASKS=magnet'))
    $magnetKey = 'HKCU:\Software\Classes\HoshiStream.Magnet\shell\open\command'
    $expectedCommand = '"' + (Join-Path $install 'HoshiStream.exe') + '" "--state-dir=' + $state + '" "--magnet=%1"'
    if ((Get-Item -LiteralPath $magnetKey).GetValue('') -ne $expectedCommand) { throw 'Magnet command is not the quoted installed executable.' }
    Run-InstallerCommand (Join-Path $install 'unins000.exe') @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART')
    if (Test-Path -LiteralPath (Join-Path $install 'HoshiStream.exe')) { throw 'Uninstall left app executable.' }
    if ((Get-Content -LiteralPath (Join-Path $state 'preserve.txt')) -ne 'private state sentinel') { throw 'State changed.' }
    if ((Get-Content -LiteralPath (Join-Path $external 'preserve.txt')) -ne 'external media sentinel') { throw 'External media changed.' }
    if ((Get-Item -LiteralPath $runKey).GetValue('HoshiStream') -ne $foreignLogin) { throw 'An unrelated startup registration changed.' }
    if (Test-Path -LiteralPath $magnetKey) { throw 'Owned magnet registration was not removed.' }
    # Delete only this test's generated, isolated fixture after successful uninstall.
    Remove-Item -LiteralPath $testRoot -Recurse -Force
} finally {
    if ((Get-Item -LiteralPath $runKey).GetValue('HoshiStream') -eq $foreignLogin) {
        Remove-ItemProperty -LiteralPath $runKey -Name 'HoshiStream'
    }
    $env:HOSHISTREAM_STATE_DIR = $previousState
}

#ifndef AppVersion
  #error AppVersion must be supplied by build-windows-app.mjs
#endif
#ifndef PayloadDir
  #error PayloadDir must be supplied by build-windows-app.mjs
#endif
#ifndef OutputDir
  #error OutputDir must be supplied by build-windows-app.mjs
#endif

[Setup]
AppId={{EB20C1C4-E985-461A-A82F-9F4FF2DBB154}
AppName=HoshiStream
AppVersion={#AppVersion}
AppPublisher=HoshiStream
AppPublisherURL=https://github.com/MajorJohn98/HoshiStream
DefaultDirName={localappdata}\Programs\HoshiStream
DefaultGroupName=HoshiStream
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible and not arm64
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0.22000
UninstallDisplayIcon={app}\HoshiStream.exe
OutputDir={#OutputDir}
OutputBaseFilename=HoshiStream-{#AppVersion}-win-x64-setup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
ChangesAssociations=yes
CloseApplications=no
RestartApplications=no
SetupLogging=yes
UsePreviousAppDir=yes
UsePreviousTasks=yes

[Tasks]
Name: desktopicon; Description: "Create a desktop shortcut"; Flags: unchecked
Name: chromebridge; Description: "Register the Chrome bridge now (also refreshed at app startup; extension installed separately)"; Flags: unchecked
Name: magnet; Description: "Make HoshiStream available for magnet links (choose your default separately in Windows Settings)"; Flags: unchecked

[Files]
Source: "{#PayloadDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{userprograms}\HoshiStream\HoshiStream"; Filename: "{app}\HoshiStream.exe"
Name: "{userprograms}\HoshiStream\Uninstall HoshiStream"; Filename: "{uninstallexe}"
Name: "{userdesktop}\HoshiStream"; Filename: "{app}\HoshiStream.exe"; Tasks: desktopicon

[Run]
Filename: "{app}\HoshiStream.exe"; Description: "Open HoshiStream"; Flags: nowait postinstall skipifsilent

[Code]
function Maintenance(Operation: String): Boolean;
var
  ExitCode: Integer;
begin
  ExitCode := -1;
  Result := Exec(ExpandConstant('{app}\bin\node.exe'),
    '"' + ExpandConstant('{app}\packaging\windows-maintenance.mjs') + '" ' + Operation,
    ExpandConstant('{app}'), SW_HIDE, ewWaitUntilTerminated, ExitCode);
  Result := Result and (ExitCode = 0);
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  Result := '';
  if FileExists(ExpandConstant('{app}\HoshiStream.exe')) then
    if not Maintenance('shutdown') then
      Result := 'HoshiStream could not stop safely. Quit this installation and retry. No unrelated process was stopped.';
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if (CurStep = ssPostInstall) and WizardIsTaskSelected('magnet') then
    if not Maintenance('register-magnet') then
      RaiseException('The app was installed, but its optional magnet registration could not be created. Another installation may own it.');
  if (CurStep = ssPostInstall) and WizardIsTaskSelected('chromebridge') then
    if not Maintenance('register-browser') then
      RaiseException('The app was installed, but the Chrome bridge could not be registered. Another installation may own it. Use the Chrome companion guide to resolve the conflict.');
end;

function InitializeUninstall(): Boolean;
begin
  Result := Maintenance('shutdown');
  if Result then Result := Maintenance('unregister-integrations');
  if Result then Result := Maintenance('unregister-browser');
  if not Result then
    MsgBox('HoshiStream could not safely stop or remove its own registrations. Close it and retry. Your state and external media have not been removed.', mbError, MB_OK);
end;

// No [UninstallDelete] section: state is outside {app} and always preserved.
// Login remains a tray opt-in. Magnet registration never changes the default.
// The maintenance hook removes only registrations owned by this executable.

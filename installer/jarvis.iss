; Inno Setup script for the JARVIS Windows installer.
; Build:  ISCC /DAppVersion=0.1.0 installer\jarvis.iss   (after node scripts/package.mjs)
#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif

[Setup]
AppId={{6F0C2C54-8E0A-4D5B-9C0B-4A2B7A7D1E10}
AppName=JARVIS
AppVersion={#AppVersion}
AppPublisher=JARVIS
; Per-user install: no administrator prompt, and user data stays in %APPDATA%\JARVIS.
PrivilegesRequired=lowest
DefaultDirName={localappdata}\Programs\JARVIS
DefaultGroupName=JARVIS
DisableProgramGroupPage=yes
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir=..\dist-installer
OutputBaseFilename=JARVIS-Setup
Compression=lzma2/normal
SolidCompression=yes
WizardStyle=modern
LicenseFile=stage\LICENSE
UninstallDisplayName=JARVIS

[Tasks]
Name: "desktopicon"; Description: "Create a &desktop shortcut"; GroupDescription: "Shortcuts:"

[Files]
Source: "stage\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion

[Icons]
Name: "{autoprograms}\JARVIS"; Filename: "{sys}\wscript.exe"; Parameters: """{app}\JARVIS.vbs"""; WorkingDir: "{app}"
Name: "{autodesktop}\JARVIS"; Filename: "{sys}\wscript.exe"; Parameters: """{app}\JARVIS.vbs"""; WorkingDir: "{app}"; Tasks: desktopicon

[Run]
Filename: "{sys}\wscript.exe"; Parameters: """{app}\JARVIS.vbs"""; WorkingDir: "{app}"; Description: "Start JARVIS now"; Flags: postinstall nowait skipifsilent

[Code]
{ Stop a running JARVIS (our bundled node.exe) so files can be replaced or removed. }
procedure StopJarvis;
var
  ResultCode: Integer;
  Params: String;
begin
  Params := '-NoProfile -WindowStyle Hidden -Command "Get-Process node -ErrorAction SilentlyContinue | ' +
            'Where-Object { $_.Path -like ''' + ExpandConstant('{app}') + '\node\*'' } | Stop-Process -Force"';
  Exec('powershell.exe', Params, '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  StopJarvis;
  Result := '';
end;

function InitializeUninstall: Boolean;
begin
  StopJarvis;
  Result := True;
end;

; Orin Code — Inno Setup installer.
; The Tauri NSIS bundle is primary; this script is the branded fallback used
; when shipping via tauri build --no-bundle plus manual packaging.

#define MyAppName "Orin Code"
#define MyAppVersion GetEnv("ORIN_VERSION")
#if MyAppVersion == ""
#define MyAppVersion "0.1.0"
#endif
#define MyAppExeName "orin-code.exe"

[Setup]
AppId={{8D4B7A62-3C1E-4B5F-9A77-ORINAI0000001}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher=Orin
DefaultDirName={autopf}\{#MyAppName}
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
WizardStyle=modern
WizardSmallImageFile=..\..\resources\win32\inno-orin-small.bmp
WizardImageFile=..\..\resources\win32\inno-orin-large.bmp
SetupIconFile=..\..\resources\win32\orin.ico
UninstallDisplayIcon={app}\{#MyAppExeName}
OutputBaseFilename=Orin-Code-Setup-{#MyAppVersion}
Compression=lzma2/max
SolidCompression=yes
ArchitecturesInstallIn64BitMode=x64compatible
PrivilegesRequired=lowest

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"

[Files]
Source: "..\src-tauri\target\release\{#MyAppExeName}"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "{cm:LaunchProgram,{#MyAppName}}"; Flags: nowait postinstall skipifsilent

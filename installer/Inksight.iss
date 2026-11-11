; ============================================================================
; Inksight (Project Inksight) — Windows 64-bit Setup Installer
; Built with Inno Setup + WinSW Windows Service Wrapper
; ============================================================================

#define MyAppName "Inksight"
#ifndef MyAppVersion
  #define MyAppVersion "1.0.0"
#endif
#define MyAppPublisher "Project Inksight"
#define MyAppURL "https://github.com/project-inksight/inksight"
#define MyAppExeName "Inksight.exe"
#define MyServiceExeName "InksightService.exe"
#define MyServiceName "InksightService"

[Setup]
AppId={{9F6B2D41-3C8A-4E19-B725-4D8E9A1F6C30}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppVerName={#MyAppName} v{#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
AppSupportURL={#MyAppURL}/issues
AppUpdatesURL={#MyAppURL}/releases
VersionInfoVersion={#MyAppVersion}.0
DefaultDirName={autopf}\{#MyAppName}
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
PrivilegesRequired=admin
OutputDir=..\release
OutputBaseFilename=Inksight-Setup-v{#MyAppVersion}
SetupIconFile=inksight.ico
UninstallDisplayIcon={app}\{#MyAppExeName}
UninstallDisplayName={#MyAppName} v{#MyAppVersion} (Local 4K AI NVR)
WizardStyle=modern
Compression=lzma2/fast
SolidCompression=yes
CloseApplications=no

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"
Name: "trayautostart"; Description: "Show Inksight shield icon in Windows System Tray on sign-in"; GroupDescription: "Background Operation:"

[Dirs]
Name: "{commonappdata}\Inksight"; Permissions: users-modify
Name: "{commonappdata}\Inksight\logs"; Permissions: users-modify
Name: "{commonappdata}\Inksight\backups"; Permissions: users-modify

[Files]
Source: "..\release\Inksight-Win64\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; WorkingDir: "{app}"; Comment: "Open Inksight 4K AI NVR Dashboard"
Name: "{group}\Uninstall {#MyAppName}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; WorkingDir: "{app}"; Tasks: desktopicon; Comment: "Open Inksight 4K AI NVR Dashboard"

[Registry]
Root: HKLM; Subkey: "Software\Inksight"; ValueType: string; ValueName: "InstallDir"; ValueData: "{app}"; Flags: uninsdeletekey
Root: HKLM; Subkey: "Software\Inksight"; ValueType: string; ValueName: "StorageDir"; ValueData: "{code:GetStorageDir}"; Flags: uninsdeletekey
Root: HKLM; Subkey: "Software\Inksight"; ValueType: string; ValueName: "Version"; ValueData: "{#MyAppVersion}"; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "InksightTray"; ValueData: """{app}\{#MyAppExeName}"" --tray --silent"; Tasks: trayautostart; Flags: uninsdeletevalue

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "Open {#MyAppName} v{#MyAppVersion} Dashboard now"; Flags: nowait postinstall skipifsilent

[Code]
var
  StorageDirPage: TInputDirWizardPage;

function EscapeXml(const S: String): String;
var
  R: String;
begin
  R := S;
  StringChangeEx(R, '&', '&amp;', True);
  StringChangeEx(R, '<', '&lt;', True);
  StringChangeEx(R, '>', '&gt;', True);
  StringChangeEx(R, '"', '&quot;', True);
  StringChangeEx(R, '''', '&apos;', True);
  Result := R;
end;

procedure InitializeWizard;
var
  ExistingStorageDir: String;
begin
  ExistingStorageDir := 'C:\InksightRecordings';
  RegQueryStringValue(HKLM, 'Software\Inksight', 'StorageDir', ExistingStorageDir);

  StorageDirPage := CreateInputDirPage(
    wpSelectDir,
    'Select Video Footage Storage Folder',
    'Where should 24/7 camera recordings and AI alert clips be saved?',
    'Choose a folder on a drive with plenty of free space (for example, C:\InksightRecordings or a secondary hard drive such as D:\InksightRecordings).' + #13#10 + #13#10 +
    'Your video footage and camera settings are stored separately from the application so future updates never erase your data.',
    False,
    'InksightRecordings'
  );
  StorageDirPage.Add('Video recordings & AI clips folder:');
  StorageDirPage.Values[0] := ExistingStorageDir;
end;

function GetStorageDir(Param: String): String;
begin
  if Assigned(StorageDirPage) and (Trim(StorageDirPage.Values[0]) <> '') then
    Result := Trim(StorageDirPage.Values[0])
  else
    Result := 'C:\InksightRecordings';
end;

procedure StopExistingProcesses;
var
  ResultCode: Integer;
begin
  Exec('sc.exe', 'stop {#MyServiceName}', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Exec('taskkill.exe', '/F /IM {#MyAppExeName}', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Exec('taskkill.exe', '/F /IM go2rtc.exe', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Sleep(1200);
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  DataDir, DbFile, BackupFile: String;
begin
  Result := '';
  StopExistingProcesses;

  DataDir := ExpandConstant('{commonappdata}\Inksight');
  DbFile := DataDir + '\sentinel_vms.sqlite';
  BackupFile := DataDir + '\backups\sentinel_vms_pre_upgrade_v{#MyAppVersion}.sqlite';

  if FileExists(DbFile) then
  begin
    ForceDirectories(DataDir + '\backups');
    CopyFile(DbFile, BackupFile, False);
  end;
end;

procedure ConfigureFirewallAndService;
var
  AppDir, DataDir, StorageDir, XmlPath, XmlContent, ServiceExe: String;
  ResultCode: Integer;
begin
  AppDir := ExpandConstant('{app}');
  DataDir := ExpandConstant('{commonappdata}\Inksight');
  StorageDir := GetStorageDir('');
  ServiceExe := AppDir + '\{#MyServiceExeName}';
  XmlPath := AppDir + '\InksightService.xml';

  ForceDirectories(DataDir);
  ForceDirectories(DataDir + '\logs');
  ForceDirectories(StorageDir);

  { Add clean Windows Defender Firewall rules so users never get scary popups }
  Exec('netsh.exe', 'advfirewall firewall delete rule name="Inksight NVR Engine"', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Exec('netsh.exe', 'advfirewall firewall delete rule name="Inksight WebRTC Engine"', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Exec('netsh.exe', 'advfirewall firewall add rule name="Inksight NVR Engine" dir=in action=allow program="' + AppDir + '\runtime\node.exe" enable=yes profile=private,domain', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Exec('netsh.exe', 'advfirewall firewall add rule name="Inksight WebRTC Engine" dir=in action=allow program="' + AppDir + '\bin\go2rtc.exe" enable=yes profile=private,domain', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);

  { Write WinSW 24/7 Service Definition }
  XmlContent :=
    '<service>' + #13#10 +
    '  <id>{#MyServiceName}</id>' + #13#10 +
    '  <name>Inksight 24/7 NVR &amp; AI Engine</name>' + #13#10 +
    '  <description>Inksight 24/7 4K Direct-to-Disk NVR recorder, go2rtc WebRTC restreamer, and offline YOLO11 AI object detection service.</description>' + #13#10 +
    '  <executable>%BASE%\runtime\node.exe</executable>' + #13#10 +
    '  <arguments>"%BASE%\dist\server\index.js"</arguments>' + #13#10 +
    '  <workingdirectory>%BASE%</workingdirectory>' + #13#10 +
    '  <startmode>Automatic</startmode>' + #13#10 +
    '  <delayedAutoStart>true</delayedAutoStart>' + #13#10 +
    '  <env name="NODE_ENV" value="production" />' + #13#10 +
    '  <env name="PORT" value="3001" />' + #13#10 +
    '  <env name="SENTINEL_DATA_DIR" value="' + EscapeXml(DataDir) + '" />' + #13#10 +
    '  <env name="SENTINEL_STORAGE_DIR" value="' + EscapeXml(StorageDir) + '" />' + #13#10 +
    '  <logpath>' + EscapeXml(DataDir + '\logs') + '</logpath>' + #13#10 +
    '  <log mode="roll-by-size">' + #13#10 +
    '    <sizeThreshold>10240</sizeThreshold>' + #13#10 +
    '    <keepFiles>5</keepFiles>' + #13#10 +
    '  </log>' + #13#10 +
    '  <onfailure action="restart" delay="5 sec" />' + #13#10 +
    '  <onfailure action="restart" delay="15 sec" />' + #13#10 +
    '  <onfailure action="restart" delay="30 sec" />' + #13#10 +
    '  <stopparentprocessfirst>true</stopparentprocessfirst>' + #13#10 +
    '</service>' + #13#10;

  SaveStringsToUTF8FileWithoutBOM(XmlPath, [XmlContent], False);

  if FileExists(ServiceExe) then
  begin
    Exec(ServiceExe, 'uninstall', AppDir, SW_HIDE, ewWaitUntilTerminated, ResultCode);
    Exec(ServiceExe, 'install', AppDir, SW_HIDE, ewWaitUntilTerminated, ResultCode);
    Exec(ServiceExe, 'start', AppDir, SW_HIDE, ewWaitUntilTerminated, ResultCode);
  end;
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then
  begin
    ConfigureFirewallAndService;
  end;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  AppDir, ServiceExe, DataDir: String;
  ResultCode: Integer;
begin
  if CurUninstallStep = usUninstall then
  begin
    AppDir := ExpandConstant('{app}');
    ServiceExe := AppDir + '\{#MyServiceExeName}';

    StopExistingProcesses;

    if FileExists(ServiceExe) then
    begin
      Exec(ServiceExe, 'uninstall', AppDir, SW_HIDE, ewWaitUntilTerminated, ResultCode);
    end
    else
    begin
      Exec('sc.exe', 'delete {#MyServiceName}', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
    end;

    Exec('netsh.exe', 'advfirewall firewall delete rule name="Inksight NVR Engine"', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
    Exec('netsh.exe', 'advfirewall firewall delete rule name="Inksight WebRTC Engine"', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);

    if FileExists(AppDir + '\InksightService.xml') then
      DeleteFile(AppDir + '\InksightService.xml');

    DataDir := ExpandConstant('{commonappdata}\Inksight');
    if DirExists(DataDir) and (not WizardSilent) then
    begin
      if MsgBox(
        'Would you like to KEEP your camera configuration database (' + DataDir + ') and saved video footage so they are preserved if you reinstall later?' + #13#10 + #13#10 +
        'Click YES to keep your settings and recordings safe (Recommended).' + #13#10 +
        'Click NO to delete the camera configuration database (video footage on disk is still never deleted).',
        mbConfirmation, MB_YESNO or MB_DEFBUTTON1) = IDNO then
      begin
        DelTree(DataDir, True, True, True);
      end;
    end;
  end;
end;

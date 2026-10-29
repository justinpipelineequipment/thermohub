; Inno Setup script: installs ThermoHub Hub as an auto-start Windows service.
#define AppVersion "0.1.0"

[Setup]
AppId={{6B0E5C1A-2F4D-4E7B-9C3A-1D8F2A7E5B90}
AppName=ThermoHub Hub
AppVersion={#AppVersion}
AppPublisher=ThermoHub
DefaultDirName={autopf}\ThermoHub Hub
DisableDirPage=yes
PrivilegesRequired=admin
OutputBaseFilename=ThermoHubHubSetup
Compression=lzma2
SolidCompression=yes
ArchitecturesInstallIn64BitMode=x64compatible
UninstallDisplayName=ThermoHub Hub

[Files]
Source: "dist\ThermoHubHub\*"; DestDir: "{app}"; Flags: recursesubdirs ignoreversion

[Icons]
Name: "{autoprograms}\ThermoHub Hub Setup"; Filename: "http://localhost:8787/"

[Run]
; Service: auto start, restart on failure. Firewall: allow local network (HomeKit + mDNS) on private/domain networks.
Filename: "{sys}\sc.exe"; Parameters: "create ThermoHubHub binPath= ""\""{app}\ThermoHubHub.exe\"""" start= delayed-auto DisplayName= ""ThermoHub Hub"""; Flags: runhidden
Filename: "{sys}\sc.exe"; Parameters: "description ThermoHubHub ""Runs ThermoHub thermostat schedules locally and syncs with the ThermoHub cloud."""; Flags: runhidden
Filename: "{sys}\sc.exe"; Parameters: "failure ThermoHubHub reset= 86400 actions= restart/60000/restart/60000/restart/60000"; Flags: runhidden
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall add rule name=""ThermoHub Hub"" dir=in action=allow program=""{app}\ThermoHubHub.exe"" profile=private,domain"; Flags: runhidden
Filename: "{sys}\sc.exe"; Parameters: "start ThermoHubHub"; Flags: runhidden
Filename: "http://localhost:8787/"; Description: "Open the hub setup page"; Flags: postinstall shellexec nowait

[UninstallRun]
Filename: "{sys}\sc.exe"; Parameters: "stop ThermoHubHub"; Flags: runhidden; RunOnceId: "StopSvc"
Filename: "{sys}\cmd.exe"; Parameters: "/c ping -n 4 127.0.0.1 >nul"; Flags: runhidden; RunOnceId: "WaitSvc"
Filename: "{sys}\sc.exe"; Parameters: "delete ThermoHubHub"; Flags: runhidden; RunOnceId: "DeleteSvc"
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall delete rule name=""ThermoHub Hub"""; Flags: runhidden; RunOnceId: "DelFw"

[Code]
// Upgrades: stop the running service before files are replaced (sc create then just reports it exists).
function PrepareToInstall(var NeedsRestart: Boolean): String;
var Code: Integer;
begin
  Exec(ExpandConstant('{sys}\sc.exe'), 'stop ThermoHubHub', '', SW_HIDE, ewWaitUntilTerminated, Code);
  Sleep(3000);
  Result := '';
end;

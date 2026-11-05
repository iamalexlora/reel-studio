; Reel Studio — instalador para Windows (Inno Setup 6)
#ifndef AppVer
  #define AppVer "1.0"
#endif

[Setup]
AppId={{6B1E3F2A-9C4D-4E8B-A7F1-5D2C8E9B0A31}
AppName=Reel Studio
AppVersion={#AppVer}
AppVerName=Reel Studio {#AppVer}
AppPublisher=Reel Studio
DefaultDirName={localappdata}\Programs\Reel Studio
DisableDirPage=yes
DisableProgramGroupPage=yes
DisableReadyPage=yes
PrivilegesRequired=lowest
OutputDir=..\dist
OutputBaseFilename=ReelStudio-Setup
SetupIconFile=..\assets\ReelStudio.ico
UninstallDisplayIcon={app}\ReelStudio.exe
UninstallDisplayName=Reel Studio
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
CloseApplications=yes

[Languages]
Name: "es"; MessagesFile: "compiler:Languages\Spanish.isl"

[Tasks]
Name: "desktopicon"; Description: "Crear un acceso directo en el escritorio"; GroupDescription: "Accesos directos:"

[InstallDelete]
; el programa se reemplaza entero; tus proyectos (proyectos\) no se tocan
Type: filesandordirs; Name: "{%USERPROFILE}\ReelStudio\app"

[Files]
Source: "..\build\win\launcher\*"; DestDir: "{app}"; Flags: recursesubdirs ignoreversion
Source: "..\build\win\ReelStudio\*"; DestDir: "{%USERPROFILE}\ReelStudio"; Flags: recursesubdirs createallsubdirs ignoreversion
Source: "..\build\win\config\update.json"; DestDir: "{%USERPROFILE}\ReelStudio\config"; Flags: onlyifdoesntexist uninsneveruninstall

[Icons]
Name: "{userprograms}\Reel Studio"; Filename: "{app}\ReelStudio.exe"
Name: "{userdesktop}\Reel Studio"; Filename: "{app}\ReelStudio.exe"; Tasks: desktopicon

[Run]
Filename: "{app}\ReelStudio.exe"; Description: "Abrir Reel Studio"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
Type: filesandordirs; Name: "{%USERPROFILE}\ReelStudio\runtime"
Type: filesandordirs; Name: "{%USERPROFILE}\ReelStudio\app"
Type: filesandordirs; Name: "{%USERPROFILE}\ReelStudio\logs"

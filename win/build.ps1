# Construye el instalador de Reel Studio para Windows. Lo corre GitHub Actions (windows-latest).
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
Set-Location (Split-Path $PSScriptRoot -Parent)
$sha  = if ($env:GITHUB_SHA) { $env:GITHUB_SHA } else { (git rev-parse HEAD) }
$repo = if ($env:GITHUB_REPOSITORY) { $env:GITHUB_REPOSITORY } else { "iamalexlora/reel-studio" }
$ver  = "1.$(git rev-list --count HEAD)"

Remove-Item -Recurse -Force build, dist -ErrorAction SilentlyContinue
$rs = "build\win\ReelStudio"
New-Item -ItemType Directory -Force $rs, "$rs\runtime", "dist" | Out-Null

Write-Host "▸ Programa"
git archive --format=zip -o build\code.zip HEAD
Expand-Archive build\code.zip -DestinationPath $rs
Remove-Item -Recurse -Force "$rs\mac", "$rs\.github", "$rs\instalar.command", "$rs\start.sh", "$rs\stop.sh" -ErrorAction SilentlyContinue
Set-Content -NoNewline -Encoding ascii "$rs\VERSION" $sha
New-Item -ItemType Directory -Force "build\win\config" | Out-Null
Set-Content -Encoding utf8 "build\win\config\update.json" "{`n `"repo`": `"$repo`",`n `"branch`": `"main`",`n `"token`": `"`"`n}"

Write-Host "▸ Python"
$pyexe = (Get-Command python).Source
$pydir = Split-Path $pyexe -Parent
Copy-Item -Recurse $pydir "$rs\runtime\python"
$py = "$rs\runtime\python\python.exe"
& $py -m pip install --upgrade --no-warn-script-location -q pip
& $py -m pip install --no-warn-script-location -q faster-whisper pillow numpy huggingface_hub
if ($LASTEXITCODE -ne 0) { throw "pip falló" }
Remove-Item -Recurse -Force "$rs\runtime\python\Lib\test", "$rs\runtime\python\Lib\site-packages\pip\_vendor\rich\__pycache__" -ErrorAction SilentlyContinue

Write-Host "▸ ffmpeg"
Invoke-WebRequest "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip" -OutFile build\ffmpeg.zip
Expand-Archive build\ffmpeg.zip -DestinationPath build\ffmpeg
$ff = Get-ChildItem build\ffmpeg -Recurse -Filter ffmpeg.exe | Select-Object -First 1
New-Item -ItemType Directory -Force "$rs\runtime\ffmpeg\bin" | Out-Null
Copy-Item $ff.FullName, (Join-Path $ff.DirectoryName "ffprobe.exe") "$rs\runtime\ffmpeg\bin\"

Write-Host "▸ Prueba del motor"
& $py win\smoke.py "$rs\app"
if ($LASTEXITCODE -ne 0) { throw "la prueba del motor falló" }
Get-ChildItem "$rs\app" -Recurse -Directory -Filter __pycache__ | Remove-Item -Recurse -Force

Write-Host "▸ App (ventana)"
dotnet build win\launcher\ReelStudio.csproj -c Release -o build\win\launcher -p:Version=$ver.0
if ($LASTEXITCODE -ne 0) { throw "dotnet build falló" }

Write-Host "▸ Instalador"
if (-not (Test-Path "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe")) { choco install innosetup -y --no-progress | Out-Null }
& "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe" "/DAppVer=$ver" win\installer.iss
if ($LASTEXITCODE -ne 0) { throw "Inno Setup falló" }
Get-ChildItem dist

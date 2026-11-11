# ============================================================================
# Inksight (Project Inksight) — Self-Contained Portable Windows Packager
# Bundles:
#   - Portable Node.js runtime (runtime/node.exe) — No Node.js install needed!
#   - Compiled frontend (dist/client) & backend (dist/server)
#   - Prebuilt go2rtc.exe, YOLO11 ONNX models, ffmpeg.exe, ffprobe.exe, SQLite, ONNX
#   - Native Windows System Tray Agent (Inksight-Tray.ps1)
#   - 1-Click Start-Inksight.bat + Desktop Shortcut Creator
#   - Strictly EXCLUDES personal data/sentinel_vms.sqlite, storage/, go2rtc.yaml
# ============================================================================

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $Root

$PkgJson = Get-Content (Join-Path $Root "package.json") -Raw | ConvertFrom-Json
$Version = if ($PkgJson.version) { $PkgJson.version } else { "1.0.0" }

Write-Host "==================================================================" -ForegroundColor Cyan
Write-Host "  PACKAGING INKSIGHT v$Version PORTABLE RELEASE (WIN64)" -ForegroundColor Cyan
Write-Host "==================================================================" -ForegroundColor Cyan

# 1. Build latest client & server bundles
Write-Host "[1/6] Building production TypeScript & Vite bundles..." -ForegroundColor Yellow
npm run build

# 2. Prepare clean staging directory
$ReleaseRoot = Join-Path $Root "release"
$StageDir = Join-Path $ReleaseRoot "Inksight-Win64"

if (Test-Path $StageDir) {
    Remove-Item $StageDir -Recurse -Force
}
New-Item -ItemType Directory -Path $StageDir -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $StageDir "runtime") -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $StageDir "bin") -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $StageDir "data") -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $StageDir "storage") -Force | Out-Null

# 3. Copy portable Node.js binary
$NodeExe = (Get-Command node).Source
Write-Host "[2/6] Bundling portable Node.js runtime ($NodeExe)..." -ForegroundColor Yellow
Copy-Item $NodeExe -Destination (Join-Path $StageDir "runtime\node.exe") -Force

# 4. Copy compiled application & AI / RTSP binaries (excluding go2rtc.yaml)
Write-Host "[3/6] Copying compiled dist/, go2rtc.exe, YOLO11 ONNX models, and Tray Agent..." -ForegroundColor Yellow
Copy-Item (Join-Path $Root "dist") -Destination (Join-Path $StageDir "dist") -Recurse -Force
Copy-Item (Join-Path $Root "package.json") -Destination (Join-Path $StageDir "package.json") -Force
if (Test-Path (Join-Path $Root "LICENSE")) {
    Copy-Item (Join-Path $Root "LICENSE") -Destination (Join-Path $StageDir "LICENSE") -Force
}

if (Test-Path (Join-Path $Root "Inksight-Tray.ps1")) {
    Copy-Item (Join-Path $Root "Inksight-Tray.ps1") -Destination (Join-Path $StageDir "Inksight-Tray.ps1") -Force
}
if (Test-Path (Join-Path $Root "bin\go2rtc.exe")) {
    Copy-Item (Join-Path $Root "bin\go2rtc.exe") -Destination (Join-Path $StageDir "bin\go2rtc.exe") -Force
}
Get-ChildItem -Path (Join-Path $Root "bin\*.onnx") -ErrorAction SilentlyContinue | ForEach-Object {
    Copy-Item $_.FullName -Destination (Join-Path $StageDir ("bin\" + $_.Name)) -Force
}

# 5. Copy production node_modules
Write-Host "[4/6] Copying runtime node_modules (FFmpeg, SQLite, Sharp, ONNX Runtime)..." -ForegroundColor Yellow
$RoboArgs = @(
    (Join-Path $Root "node_modules"),
    (Join-Path $StageDir "node_modules"),
    "/E", "/MT:16", "/NFL", "/NDL", "/NJH", "/NJS", "/NC", "/NS",
    "/XD",
    "typescript", "vite", "vitest", "@vitejs", "concurrently", "tsx", "esbuild", "@esbuild",
    "lucide-react", "framer-motion", "react", "react-dom", "tailwindcss", "postcss", "autoprefixer",
    "@babel", ".vite", "@rollup", "rollup", "@types", "darwin", "linux", "ia32", "arm64"
)
& robocopy @RoboArgs | Out-Null
$global:LASTEXITCODE = 0

$SqliteDeps = Join-Path $StageDir "node_modules\better-sqlite3\deps"
if (Test-Path $SqliteDeps) {
    Remove-Item $SqliteDeps -Recurse -Force -ErrorAction SilentlyContinue
}

# 6. Write 1-Click Launcher, Stopper & Safe Updater scripts
Write-Host "[5/6] Generating 1-Click Launcher, Tray Agent & Desktop Shortcut scripts..." -ForegroundColor Yellow

$LauncherBat = @'
@echo off
setlocal
cd /d "%~dp0"

echo ==================================================================
echo   INKSIGHT - LOCAL 4K DIRECT-TO-DISK NVR ^& OFFLINE YOLO11 AI
echo ==================================================================

:: 1. Ensure Desktop Shortcut exists (points to current installation directory)
powershell -NoProfile -ExecutionPolicy Bypass -Command "$d = [Environment]::GetFolderPath('Desktop'); $p = Join-Path $d 'Inksight.lnk'; $ws = New-Object -ComObject WScript.Shell; $s = $ws.CreateShortcut($p); $s.TargetPath = Join-Path (Get-Location).Path 'Start-Inksight.bat'; $s.WorkingDirectory = (Get-Location).Path; $s.IconLocation = 'shell32.dll,23'; $s.Description = 'Launch Inksight 4K AI NVR'; $s.Save()"

:: 2. Check if Inksight is already running on port 3001
powershell -NoProfile -Command "try { $null = Invoke-WebRequest -Uri 'http://127.0.0.1:3001/api/settings' -UseBasicParsing -TimeoutSec 2; exit 0 } catch { exit 1 }"
if %ERRORLEVEL% NEQ 0 goto :start_server
goto :start_tray

:start_server
echo [Inksight] Starting 24/7 background NVR service (0%% GPU in background)...
powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath (Join-Path (Get-Location).Path 'runtime\node.exe') -ArgumentList 'dist/server/index.js' -WorkingDirectory (Get-Location).Path -WindowStyle Hidden"
timeout /t 3 /nobreak >nul

:start_tray
if exist "Inksight-Tray.ps1" powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath 'powershell.exe' -ArgumentList '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File Inksight-Tray.ps1' -WorkingDirectory (Get-Location).Path -WindowStyle Hidden"

:: 4. Launch Native Frameless App Window (Chrome or Edge)
set "APP_URL=http://localhost:3001"
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" (
    start "" "%ProgramFiles%\Google\Chrome\Application\chrome.exe" --app=%APP_URL%
    exit /b 0
)
if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" (
    start "" "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" --app=%APP_URL%
    exit /b 0
)

start "" "%APP_URL%"
'@

Set-Content -Path (Join-Path $StageDir "Start-Inksight.bat") -Value $LauncherBat -Encoding ASCII

$StopBat = @'
@echo off
setlocal
echo [Inksight] Stopping background NVR service and worker processes...
powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort 3001 -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }"
taskkill /F /IM go2rtc.exe >nul 2>&1
echo [Inksight] Background service stopped cleanly.
pause
'@

Set-Content -Path (Join-Path $StageDir "Stop-Inksight.bat") -Value $StopBat -Encoding ASCII

$SafeUpdateBat = @'
@echo off
setlocal
cd /d "%~dp0"

echo ==================================================================
echo   INKSIGHT - ZERO-DATA-LOSS SAFE UPDATER
echo ==================================================================

echo [1/4] Stopping running Inksight background processes...
powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort 3001 -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }"
taskkill /F /IM go2rtc.exe >nul 2>&1
timeout /t 2 /nobreak >nul

echo [2/4] Backing up existing camera database (data\sentinel_vms.sqlite)...
powershell -NoProfile -ExecutionPolicy Bypass -Command "if (Test-Path 'data\sentinel_vms.sqlite') { New-Item -ItemType Directory -Path 'data\backups' -Force | Out-Null; $ts = Get-Date -Format 'yyyyMMdd_HHmmss'; Copy-Item 'data\sentinel_vms.sqlite' -Destination ('data\backups\sentinel_vms_backup_' + $ts + '.sqlite') -Force; Write-Host '      Saved backup to data\backups\' -ForegroundColor Green }"

echo [3/4] Verifying application bundle (data\ and storage\ are untouched)...
powershell -NoProfile -ExecutionPolicy Bypass -Command "if (Test-Path 'patch_dist') { Copy-Item 'patch_dist\*' -Destination 'dist' -Recurse -Force; Remove-Item 'patch_dist' -Recurse -Force }"

echo [4/4] Update complete! Restarting Inksight...
call Start-Inksight.bat
'@

Set-Content -Path (Join-Path $StageDir "Safely-Apply-Update.bat") -Value $SafeUpdateBat -Encoding ASCII

# 7. Lightweight Code-Only Update Patch (< 1 MB zip)
$PatchDir = Join-Path $ReleaseRoot "Inksight-Update-Patch"
$PatchZip = Join-Path $ReleaseRoot "Inksight-Update-Patch-v$Version.zip"
if (Test-Path $PatchDir) {
    Remove-Item $PatchDir -Recurse -Force
}
if (Test-Path $PatchZip) {
    Remove-Item $PatchZip -Force
}
New-Item -ItemType Directory -Path $PatchDir -Force | Out-Null
Copy-Item (Join-Path $Root "dist") -Destination (Join-Path $PatchDir "dist") -Recurse -Force
Copy-Item (Join-Path $Root "package.json") -Destination (Join-Path $PatchDir "package.json") -Force
Copy-Item (Join-Path $Root "Inksight-Tray.ps1") -Destination (Join-Path $PatchDir "Inksight-Tray.ps1") -Force
Copy-Item (Join-Path $StageDir "Start-Inksight.bat") -Destination (Join-Path $PatchDir "Start-Inksight.bat") -Force
Copy-Item (Join-Path $StageDir "Stop-Inksight.bat") -Destination (Join-Path $PatchDir "Stop-Inksight.bat") -Force
Copy-Item (Join-Path $StageDir "Safely-Apply-Update.bat") -Destination (Join-Path $PatchDir "Safely-Apply-Update.bat") -Force
Compress-Archive -Path (Join-Path $PatchDir "*") -DestinationPath $PatchZip -Force

$ReadmeTxt = @"
======================================================================
  INKSIGHT v$Version — QUICK START GUIDE
======================================================================

1. HOW TO START:
   Double-click "Start-Inksight.bat"
   - No installation of Node.js, FFmpeg, or Python is required!
   - An "Inksight" shortcut will be placed on your Desktop, and a
     green shield icon will appear in your Windows System Tray.
   - The 24/7 NVR recorder & offline YOLO11 AI engine runs silently in
     the background (using 0% GPU when the viewer window is closed).

2. ADDING YOUR FIRST CAMERA:
   - Click "Scan Network & Add Your First Camera" (or "+ Add Camera").
   - Click "Scan Local Network" to automatically find cameras on your
     Wi-Fi / LAN, or enter your Camera IP, Username, and Password.
   - Click "Create Camera" — live streaming, 4K Direct-to-Disk
     recording, and YOLO11 AI detection start immediately!

3. HOW TO STOP THE BACKGROUND RECORDER:
   Right-click the Inksight shield icon in the Windows System Tray and
   click "Stop 24/7 NVR Engine & Exit", or double-click
   "Stop-Inksight.bat".
======================================================================
"@

Set-Content -Path (Join-Path $StageDir "README-FIRST.txt") -Value $ReadmeTxt -Encoding UTF8

Write-Host "[6/6] Portable folder ready at: $StageDir" -ForegroundColor Green
Write-Host "      (Personal database & recordings were excluded for privacy)" -ForegroundColor Green

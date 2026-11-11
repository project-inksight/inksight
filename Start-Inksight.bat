@echo off
setlocal
cd /d "%~dp0"

:: 1. Ensure Desktop Shortcut exists
powershell -NoProfile -ExecutionPolicy Bypass -Command "$d = [Environment]::GetFolderPath('Desktop'); $p = Join-Path $d 'Inksight.lnk'; $ws = New-Object -ComObject WScript.Shell; $s = $ws.CreateShortcut($p); $s.TargetPath = Join-Path (Get-Location).Path 'Start-Inksight.bat'; $s.WorkingDirectory = (Get-Location).Path; $s.IconLocation = 'shell32.dll,23'; $s.Description = 'Launch Inksight 4K AI NVR'; $s.Save()"

:: 2. Ensure production build exists
if not exist "dist\client\index.html" (
    echo [Inksight] Building production bundle...
    call npm run build
)

:: 3. Check if Inksight server is already listening on port 3001
powershell -NoProfile -Command "try { $null = Invoke-WebRequest -Uri 'http://127.0.0.1:3001/api/settings' -UseBasicParsing -TimeoutSec 2; exit 0 } catch { exit 1 }"
if %ERRORLEVEL% NEQ 0 goto :start_server
goto :start_tray

:start_server
echo [Inksight] Starting headless 24/7 NVR service in background...
powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath 'node' -ArgumentList 'dist/server/index.js' -WorkingDirectory (Get-Location).Path -WindowStyle Hidden"
timeout /t 2 /nobreak >nul

:start_tray
if exist "Inksight-Tray.ps1" powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath 'powershell.exe' -ArgumentList '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File Inksight-Tray.ps1' -WorkingDirectory (Get-Location).Path -WindowStyle Hidden"

:: 4. Determine whether dev server (5173) or production server (3001) is active
set "APP_URL=http://localhost:3001"
powershell -NoProfile -Command "try { $null = Invoke-WebRequest -Uri 'http://127.0.0.1:5173' -UseBasicParsing -TimeoutSec 1; exit 0 } catch { exit 1 }"
if %ERRORLEVEL% EQU 0 (
    set "APP_URL=http://localhost:5173"
)

:: 5. Launch native frameless App Window (Chrome or Edge)
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" (
    start "" "%ProgramFiles%\Google\Chrome\Application\chrome.exe" --app=%APP_URL%
    exit /b 0
)
if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" (
    start "" "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" --app=%APP_URL%
    exit /b 0
)

start "" "%APP_URL%"

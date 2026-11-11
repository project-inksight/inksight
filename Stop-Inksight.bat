@echo off
setlocal
echo [Inksight] Stopping background NVR service and worker processes...
powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort 3001 -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }"
taskkill /F /IM go2rtc.exe >nul 2>&1
echo [Inksight] Background NVR service stopped.
pause

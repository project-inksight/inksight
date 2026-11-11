# ============================================================================
# Inksight (Project Inksight) — 1-Click Versioned Windows .EXE Setup Builder
# Produces:
#   - release\Inksight-Setup-v<version>.exe
#   - release\Inksight-Setup.exe
#   - release\Inksight-Setup-v<version>.exe.sha256.txt
#
# Automatically reads version from package.json and stamps it into:
#   - Compiled frontend & backend (dist/)
#   - Native Win32 GUI Launcher & System Tray Agent (Inksight.exe)
#   - Inno Setup Wizard, Windows Installed Apps & output Setup.exe filename
# ============================================================================

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $Root

$PkgJson = Get-Content (Join-Path $Root "package.json") -Raw | ConvertFrom-Json
$Version = if ($PkgJson.version) { $PkgJson.version } else { "1.0.0" }

Write-Host "==================================================================" -ForegroundColor Cyan
Write-Host "  BUILDING INKSIGHT v$Version WINDOWS SETUP.EXE INSTALLER (WIN64)" -ForegroundColor Cyan
Write-Host "==================================================================" -ForegroundColor Cyan

# 1. Build latest production frontend & backend bundles
Write-Host "[1/7] Building production TypeScript & Vite bundles (v$Version)..." -ForegroundColor Yellow
& npm run build
if ($LASTEXITCODE -ne 0) {
    throw "npm run build failed with exit code $LASTEXITCODE"
}

# 2. Generate crisp multi-resolution Shield .ico icon
$IconPath = Join-Path $Root "installer\inksight.ico"
Write-Host "[2/7] Generating multi-resolution Inksight shield icon..." -ForegroundColor Yellow
& npx tsx installer/generateIcon.ts "$IconPath"
if ($LASTEXITCODE -ne 0 -or -not (Test-Path $IconPath)) {
    throw "Failed to generate application icon at $IconPath"
}

# 3. Prepare clean staging directory
$ReleaseRoot = Join-Path $Root "release"
$StageDir = Join-Path $ReleaseRoot "Inksight-Win64"
$BuildToolsDir = Join-Path $Root ".build-tools"

New-Item -ItemType Directory -Path $BuildToolsDir -Force | Out-Null
New-Item -ItemType Directory -Path $ReleaseRoot -Force | Out-Null

if (Test-Path $StageDir) {
    Remove-Item $StageDir -Recurse -Force
}
New-Item -ItemType Directory -Path $StageDir -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $StageDir "runtime") -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $StageDir "bin") -Force | Out-Null

# 4. Compile native Win32 C# GUI Launcher & System Tray Agent (Inksight.exe) with stamped version
Write-Host "[3/7] Compiling native Inksight.exe GUI Launcher & System Tray (v$Version)..." -ForegroundColor Yellow
$CscCandidates = @(
    @(
        "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe",
        "$env:WINDIR\Microsoft.NET\Framework\v4.0.30319\csc.exe"
    ) | Where-Object { Test-Path $_ }
)

if (-not $CscCandidates -or $CscCandidates.Count -eq 0) {
    throw "Could not find built-in Windows .NET C# compiler (csc.exe)."
}
$CscExe = $CscCandidates[0]
$CsSource = Join-Path $Root "installer\InksightLauncher.cs"
$GeneratedVerCs = Join-Path $BuildToolsDir "AssemblyVersion.g.cs"
Set-Content -Path $GeneratedVerCs -Encoding UTF8 -Value @"
using System.Reflection;
[assembly: AssemblyVersion("$Version.0")]
[assembly: AssemblyFileVersion("$Version.0")]
"@
$CompiledLauncherExe = Join-Path $StageDir "Inksight.exe"

& $CscExe /nologo /target:winexe /optimize+ "/out:$CompiledLauncherExe" "/win32icon:$IconPath" /r:System.dll /r:System.Drawing.dll /r:System.Windows.Forms.dll /r:System.ServiceProcess.dll "$CsSource" "$GeneratedVerCs"
if ($LASTEXITCODE -ne 0 -or -not (Test-Path $CompiledLauncherExe)) {
    throw "Failed to compile Inksight.exe"
}

# 5. Bundle Node.js runtime, dist/, go2rtc.exe, YOLO11 ONNX models, WinSW service, and production node_modules
Write-Host "[4/7] Staging portable Node.js runtime, YOLO11 AI models, and WinSW service..." -ForegroundColor Yellow
$NodeExe = (Get-Command node).Source
Copy-Item $NodeExe -Destination (Join-Path $StageDir "runtime\node.exe") -Force
Copy-Item (Join-Path $Root "dist") -Destination (Join-Path $StageDir "dist") -Recurse -Force
Copy-Item (Join-Path $Root "package.json") -Destination (Join-Path $StageDir "package.json") -Force
if (Test-Path (Join-Path $Root "LICENSE")) {
    Copy-Item (Join-Path $Root "LICENSE") -Destination (Join-Path $StageDir "LICENSE") -Force
}

if (Test-Path (Join-Path $Root "Inksight-Tray.ps1")) {
    Copy-Item (Join-Path $Root "Inksight-Tray.ps1") -Destination (Join-Path $StageDir "Inksight-Tray.ps1") -Force
}

$Go2RtcLocal = Join-Path $Root "bin\go2rtc.exe"
if (-not (Test-Path $Go2RtcLocal)) {
    Write-Host "      Downloading go2rtc.exe for Windows x64..." -ForegroundColor DarkCyan
    New-Item -ItemType Directory -Path (Join-Path $Root "bin") -Force | Out-Null
    $Go2RtcZip = Join-Path $BuildToolsDir "go2rtc_win64.zip"
    Invoke-WebRequest -Uri "https://github.com/AlexxIT/go2rtc/releases/latest/download/go2rtc_win64.zip" -OutFile $Go2RtcZip -UseBasicParsing
    Expand-Archive -Path $Go2RtcZip -DestinationPath (Join-Path $Root "bin") -Force
}
Copy-Item $Go2RtcLocal -Destination (Join-Path $StageDir "bin\go2rtc.exe") -Force

$YoloModels = @(
    @{ File = "yolo11n.onnx"; Url = "https://huggingface.co/onnx-community/yolo11n/resolve/main/onnx/model.onnx" },
    @{ File = "yolo11s.onnx"; Url = "https://huggingface.co/onnx-community/yolo11s/resolve/main/onnx/model.onnx" },
    @{ File = "yolo11m.onnx"; Url = "https://huggingface.co/onnx-community/yolo11m/resolve/main/onnx/model.onnx" }
)
foreach ($m in $YoloModels) {
    $LocalModel = Join-Path $Root ("bin\" + $m.File)
    if (-not (Test-Path $LocalModel)) {
        Write-Host "      Downloading $($m.File)..." -ForegroundColor DarkCyan
        New-Item -ItemType Directory -Path (Join-Path $Root "bin") -Force | Out-Null
        Invoke-WebRequest -Uri $m.Url -OutFile $LocalModel -UseBasicParsing
    }
    Copy-Item $LocalModel -Destination (Join-Path $StageDir ("bin\" + $m.File)) -Force
}
if (Test-Path (Join-Path $Root "bin\yolov8n.onnx")) {
    Copy-Item (Join-Path $Root "bin\yolov8n.onnx") -Destination (Join-Path $StageDir "bin\yolov8n.onnx") -Force
}

$WinSwCache = Join-Path $BuildToolsDir "WinSW.NET461.exe"
if (-not (Test-Path $WinSwCache)) {
    Write-Host "      Downloading WinSW v2.12.0 Windows Service Wrapper..." -ForegroundColor DarkCyan
    Invoke-WebRequest -Uri "https://github.com/winsw/winsw/releases/download/v2.12.0/WinSW.NET461.exe" -OutFile $WinSwCache -UseBasicParsing
}
Copy-Item $WinSwCache -Destination (Join-Path $StageDir "InksightService.exe") -Force

Write-Host "[5/7] Copying production runtime node_modules (SQLite, Sharp, ONNX, FFmpeg)..." -ForegroundColor Yellow
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
if ($LASTEXITCODE -ge 8) {
    throw "robocopy failed with exit code $LASTEXITCODE"
}
$global:LASTEXITCODE = 0

$SqliteDeps = Join-Path $StageDir "node_modules\better-sqlite3\deps"
if (Test-Path $SqliteDeps) {
    Remove-Item $SqliteDeps -Recurse -Force -ErrorAction SilentlyContinue
}

# Smoke-test staged runtime native addons before packing
Write-Host "[6/7] Verifying staged native C++ binaries (SQLite, Sharp, ONNX Runtime)..." -ForegroundColor Yellow
Push-Location $StageDir
try {
    & (Join-Path $StageDir "runtime\node.exe") --input-type=module -e "import Database from 'better-sqlite3'; import sharp from 'sharp'; import * as ort from 'onnxruntime-node'; if (!Database || !sharp || !ort) process.exit(1);"
    if ($LASTEXITCODE -ne 0) {
        throw "Native module smoke check failed inside staged directory!"
    }
} finally {
    Pop-Location
}

# 6. Resolve or bootstrap local Inno Setup compiler (ISCC.exe) in user-space (no admin required)
Write-Host "[7/7] Compiling Inksight-Setup-v$Version.exe with Inno Setup..." -ForegroundColor Yellow
$IsccCandidates = @(
    @(
        (Join-Path $BuildToolsDir "InnoSetup\ISCC.exe"),
        "$env:ProgramFiles\Inno Setup 7\ISCC.exe",
        "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe",
        "$env:ProgramFiles\Inno Setup 6\ISCC.exe",
        "$env:LOCALAPPDATA\Programs\Inno Setup 7\ISCC.exe",
        "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe"
    ) | Where-Object { Test-Path $_ }
)

if (-not $IsccCandidates -or $IsccCandidates.Count -eq 0) {
    Write-Host "      Bootstrapping portable Inno Setup compiler into .build-tools\InnoSetup..." -ForegroundColor DarkCyan
    $InnoInstaller = Join-Path $BuildToolsDir "innosetup-x64.exe"
    $InnoTargetDir = Join-Path $BuildToolsDir "InnoSetup"
    $InnoDownloadUrl = "https://github.com/jrsoftware/issrc/releases/download/is-7_1_1/innosetup-7.1.1-x64.exe"
    Invoke-WebRequest -Uri $InnoDownloadUrl -OutFile $InnoInstaller -UseBasicParsing
    $proc = Start-Process -FilePath $InnoInstaller -ArgumentList "/CURRENTUSER", "/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART", "/DIR=`"$InnoTargetDir`"" -Wait -PassThru
    if ($proc.ExitCode -ne 0 -or -not (Test-Path (Join-Path $InnoTargetDir "ISCC.exe"))) {
        throw "Failed to bootstrap Inno Setup compiler (Exit code: $($proc.ExitCode))"
    }
    $IsccExe = Join-Path $InnoTargetDir "ISCC.exe"
} else {
    $IsccExe = $IsccCandidates[0]
}

$IssPath = Join-Path $Root "installer\Inksight.iss"
& $IsccExe /Q "/DMyAppVersion=$Version" "$IssPath"
if ($LASTEXITCODE -ne 0) {
    throw "Inno Setup compilation failed with exit code $LASTEXITCODE"
}

$VersionedSetupExe = Join-Path $ReleaseRoot "Inksight-Setup-v$Version.exe"
$StableSetupExe = Join-Path $ReleaseRoot "Inksight-Setup.exe"
Copy-Item $VersionedSetupExe -Destination $StableSetupExe -Force

$HashHex = (Get-FileHash -Path $VersionedSetupExe -Algorithm SHA256).Hash.ToLowerInvariant()
$ShaFile = "$VersionedSetupExe.sha256.txt"
Set-Content -Path $ShaFile -Encoding ASCII -Value "$HashHex  Inksight-Setup-v$Version.exe"

$SizeMb = [Math]::Round((Get-Item $VersionedSetupExe).Length / 1MB, 1)

Write-Host ""
Write-Host "==================================================================" -ForegroundColor Green
Write-Host "  SUCCESS! INKSIGHT v$Version INSTALLER READY FOR PUBLIC RELEASE:" -ForegroundColor Green
Write-Host "  - Versioned : $VersionedSetupExe ($SizeMb MB)" -ForegroundColor White
Write-Host "  - Latest    : $StableSetupExe" -ForegroundColor White
Write-Host "  - SHA-256   : $HashHex" -ForegroundColor DarkGray
Write-Host "==================================================================" -ForegroundColor Green

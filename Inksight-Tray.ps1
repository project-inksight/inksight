# ============================================================================
# Inksight — Native Windows System Tray & Auto-Start Agent
# Runs with 0% GPU usage using Windows .NET System.Windows.Forms.NotifyIcon
# ============================================================================

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $Root

$Version = "1.0.0"
$PkgPath = Join-Path $Root "package.json"
if (Test-Path $PkgPath) {
    try {
        $Version = (Get-Content $PkgPath -Raw | ConvertFrom-Json).version
    } catch {}
}

# Prevent duplicate tray icons using a named mutex
$MutexName = "Global\InksightTrayMutex"
$CreatedNew = $false
$Mutex = New-Object System.Threading.Mutex($true, $MutexName, [ref]$CreatedNew)
if (-not $CreatedNew) {
    exit 0
}

$StartupShortcutPath = Join-Path ([Environment]::GetFolderPath('Startup')) "Inksight.lnk"

function Test-NvrServerRunning {
    try {
        $null = Invoke-WebRequest -Uri "http://127.0.0.1:3001/api/system/status" -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop
        return $true
    } catch {
        return $false
    }
}

function Start-NvrBackgroundServer {
    if (Test-NvrServerRunning) { return }
    $PortableNode = Join-Path $Root "runtime\node.exe"
    $NodeBin = if (Test-Path $PortableNode) { $PortableNode } else { "node" }
    $DistEntry = Join-Path $Root "dist\server\index.js"
    if (Test-Path $DistEntry) {
        Start-Process -FilePath $NodeBin -ArgumentList "`"$DistEntry`"" -WorkingDirectory $Root -WindowStyle Hidden
    }
}

function Open-InksightDashboard {
    $TargetUrl = "http://localhost:5173"
    try {
        $null = Invoke-WebRequest -Uri "http://127.0.0.1:5173" -UseBasicParsing -TimeoutSec 1 -ErrorAction Stop
    } catch {
        $TargetUrl = "http://localhost:3001"
    }

    $ChromePaths = @(
        "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
        "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe"
    )
    foreach ($p in $ChromePaths) {
        if (Test-Path $p) {
            Start-Process -FilePath $p -ArgumentList "--app=$TargetUrl"
            return
        }
    }

    $EdgePaths = @(
        "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
        "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"
    )
    foreach ($p in $EdgePaths) {
        if (Test-Path $p) {
            Start-Process -FilePath $p -ArgumentList "--app=$TargetUrl"
            return
        }
    }

    Start-Process $TargetUrl
}

function Set-WindowsAutoStart([bool]$Enable) {
    if ($Enable) {
        $WshShell = New-Object -ComObject WScript.Shell
        $Shortcut = $WshShell.CreateShortcut($StartupShortcutPath)
        $Shortcut.TargetPath = "powershell.exe"
        $Shortcut.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$PSCommandPath`""
        $Shortcut.WorkingDirectory = $Root
        $Shortcut.Description = "Inksight 24/7 NVR & Offline YOLO11 AI Background Service"
        $Shortcut.Save()
    } else {
        if (Test-Path $StartupShortcutPath) {
            Remove-Item $StartupShortcutPath -Force -ErrorAction SilentlyContinue
        }
    }
}

# Build a crisp 32x32 Emerald Shield Icon programmatically
$Bitmap = New-Object System.Drawing.Bitmap(32, 32)
$Graphics = [System.Drawing.Graphics]::FromImage($Bitmap)
$Graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$Graphics.Clear([System.Drawing.Color]::Transparent)

$BgBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 15, 23, 42))
$EmeraldPen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(255, 16, 185, 129), 2.5)
$EmeraldBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 16, 185, 129))

$ShieldPoints = @(
    (New-Object System.Drawing.Point(16, 2)),
    (New-Object System.Drawing.Point(28, 7)),
    (New-Object System.Drawing.Point(28, 16)),
    (New-Object System.Drawing.Point(16, 29)),
    (New-Object System.Drawing.Point(4, 16)),
    (New-Object System.Drawing.Point(4, 7))
)
$Graphics.FillPolygon($BgBrush, $ShieldPoints)
$Graphics.DrawPolygon($EmeraldPen, $ShieldPoints)
$Graphics.FillEllipse($EmeraldBrush, 11, 10, 10, 10)

$HIcon = $Bitmap.GetHicon()
$TrayIcon = [System.Drawing.Icon]::FromHandle($HIcon)

# Ensure Desktop Shortcut exists on the user's real Desktop path
try {
    $DesktopDir = [Environment]::GetFolderPath('Desktop')
    $DesktopShortcutPath = Join-Path $DesktopDir "Inksight.lnk"
    $LauncherCandidate = Join-Path $Root "Start-Inksight.bat"
    if (Test-Path $LauncherCandidate) {
        $WshShell = New-Object -ComObject WScript.Shell
        $Shortcut = $WshShell.CreateShortcut($DesktopShortcutPath)
        $Shortcut.TargetPath = $LauncherCandidate
        $Shortcut.WorkingDirectory = $Root
        $Shortcut.IconLocation = "shell32.dll,23"
        $Shortcut.Description = "Launch Inksight 4K AI NVR"
        $Shortcut.Save()
    }
} catch {
    # ignore shortcut errors
}

$NotifyIcon = New-Object System.Windows.Forms.NotifyIcon
$NotifyIcon.Icon = $TrayIcon
$NotifyIcon.Text = "Inksight v$Version — 24/7 4K NVR & YOLO11 AI"
$NotifyIcon.Visible = $true

# Ensure background server is running
Start-NvrBackgroundServer

# Context Menu
$ContextMenu = New-Object System.Windows.Forms.ContextMenuStrip

$OpenItem = New-Object System.Windows.Forms.ToolStripMenuItem("Open Inksight Dashboard (v$Version)")
$OpenItem.Font = New-Object System.Drawing.Font($OpenItem.Font, [System.Drawing.FontStyle]::Bold)
$OpenItem.Add_Click({ Open-InksightDashboard })
$ContextMenu.Items.Add($OpenItem) | Out-Null

$StatusItem = New-Object System.Windows.Forms.ToolStripMenuItem("Status: 24/7 NVR Recording Active (0% GPU)")
$StatusItem.Enabled = $false
$ContextMenu.Items.Add($StatusItem) | Out-Null

$ContextMenu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator)) | Out-Null

$AutoStartItem = New-Object System.Windows.Forms.ToolStripMenuItem("Start Automatically with Windows")
$AutoStartItem.Checked = (Test-Path $StartupShortcutPath)
$AutoStartItem.Add_Click({
    $NewState = -not $AutoStartItem.Checked
    Set-WindowsAutoStart -Enable $NewState
    $AutoStartItem.Checked = (Test-Path $StartupShortcutPath)
})
$ContextMenu.Items.Add($AutoStartItem) | Out-Null

$ContextMenu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator)) | Out-Null

$ExitTrayOnlyItem = New-Object System.Windows.Forms.ToolStripMenuItem("Hide Tray Icon (Keep NVR Running)")
$ExitTrayOnlyItem.Add_Click({
    $NotifyIcon.Visible = $false
    [System.Windows.Forms.Application]::Exit()
})
$ContextMenu.Items.Add($ExitTrayOnlyItem) | Out-Null

$QuitAllItem = New-Object System.Windows.Forms.ToolStripMenuItem("Stop 24/7 NVR Engine & Exit")
$QuitAllItem.Add_Click({
    $NotifyIcon.Visible = $false
    Get-NetTCPConnection -LocalPort 3001 -State Listen -ErrorAction SilentlyContinue | ForEach-Object {
        Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue
    }
    Stop-Process -Name "go2rtc" -Force -ErrorAction SilentlyContinue
    [System.Windows.Forms.Application]::Exit()
})
$ContextMenu.Items.Add($QuitAllItem) | Out-Null

$NotifyIcon.ContextMenuStrip = $ContextMenu
$NotifyIcon.Add_DoubleClick({ Open-InksightDashboard })

$NotifyIcon.ShowBalloonTip(
    3500,
    "Inksight v$Version Active",
    "24/7 Direct-to-Disk 4K recording and offline YOLO11 AI alerts are running in the background (0% GPU). Double-click to open.",
    [System.Windows.Forms.ToolTipIcon]::Info
)

[System.Windows.Forms.Application]::Run()

using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Net;
using System.Reflection;
using System.ServiceProcess;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

[assembly: AssemblyTitle("Inksight")]
[assembly: AssemblyDescription("Inksight — Local 4K Direct-to-Disk NVR & Offline YOLO11 AI VMS")]
[assembly: AssemblyCompany("Project Inksight")]
[assembly: AssemblyProduct("Inksight")]

namespace Inksight
{
    internal static class Program
    {
        private const string ServiceName = "InksightService";
        private const string TrayMutexName = @"Local\InksightTrayAppMutex";
        private const string RunRegistryKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
        private const string RunRegistryValueName = "InksightTray";
        private const string ApiBaseUrl = "http://127.0.0.1:3001";
        private const string DashboardUrl = "http://localhost:3001";

        [STAThread]
        private static void Main(string[] args)
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            bool trayMode = false;
            bool silentMode = false;
            foreach (string rawArg in args)
            {
                string a = (rawArg ?? "").Trim().ToLowerInvariant();
                if (a == "--tray" || a == "/tray") trayMode = true;
                if (a == "--silent" || a == "/silent") silentMode = true;
            }

            if (!trayMode)
            {
                RunDashboardLauncher();
                return;
            }

            bool createdNew;
            using (Mutex mutex = new Mutex(true, TrayMutexName, out createdNew))
            {
                if (!createdNew)
                {
                    return;
                }

                EnsureBackendRunning(false);
                Application.Run(new InksightTrayApplicationContext(silentMode));
            }
        }

        private static string GetAppDirectory()
        {
            return AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\', '/');
        }

        public static string GetDisplayVersion()
        {
            try
            {
                Version v = Assembly.GetExecutingAssembly().GetName().Version;
                if (v != null)
                {
                    return string.Format("v{0}.{1}.{2}", v.Major, v.Minor, v.Build);
                }
            }
            catch
            {
                // fallback
            }
            return "v1.0.0";
        }

        public static bool IsBackendResponding(int timeoutMs)
        {
            try
            {
                HttpWebRequest req = (HttpWebRequest)WebRequest.Create(ApiBaseUrl + "/api/system/status");
                req.Method = "GET";
                req.Timeout = timeoutMs;
                req.ReadWriteTimeout = timeoutMs;
                using (HttpWebResponse resp = (HttpWebResponse)req.GetResponse())
                {
                    return (int)resp.StatusCode >= 200 && (int)resp.StatusCode < 500;
                }
            }
            catch
            {
                return false;
            }
        }

        public static bool IsWindowsServiceInstalled(out ServiceControllerStatus status)
        {
            status = ServiceControllerStatus.Stopped;
            try
            {
                using (ServiceController sc = new ServiceController(ServiceName))
                {
                    status = sc.Status;
                    return true;
                }
            }
            catch
            {
                return false;
            }
        }

        public static void EnsureBackendRunning(bool allowElevationPrompt)
        {
            if (IsBackendResponding(1200))
            {
                return;
            }

            ServiceControllerStatus svcStatus;
            if (IsWindowsServiceInstalled(out svcStatus))
            {
                if (svcStatus != ServiceControllerStatus.Running && svcStatus != ServiceControllerStatus.StartPending)
                {
                    if (allowElevationPrompt)
                    {
                        RunElevatedCommand("sc.exe", "start " + ServiceName);
                    }
                }

                for (int i = 0; i < 16; i++)
                {
                    Thread.Sleep(350);
                    if (IsBackendResponding(1000)) return;
                }
                return;
            }

            // Portable fallback mode (when running outside Windows Service)
            string appDir = GetAppDirectory();
            string portableNode = Path.Combine(appDir, @"runtime\node.exe");
            string nodeExe = File.Exists(portableNode) ? portableNode : "node.exe";
            string entryJs = Path.Combine(appDir, @"dist\server\index.js");

            if (File.Exists(entryJs))
            {
                try
                {
                    ProcessStartInfo psi = new ProcessStartInfo
                    {
                        FileName = nodeExe,
                        Arguments = "\"" + entryJs + "\"",
                        WorkingDirectory = appDir,
                        UseShellExecute = false,
                        CreateNoWindow = true,
                        WindowStyle = ProcessWindowStyle.Hidden
                    };
                    Process.Start(psi);

                    for (int i = 0; i < 14; i++)
                    {
                        Thread.Sleep(300);
                        if (IsBackendResponding(900)) break;
                    }
                }
                catch
                {
                    // ignore startup error
                }
            }
        }

        private static void RunDashboardLauncher()
        {
            EnsureBackendRunning(true);

            // Ensure System Tray icon is active in user's session
            bool trayNotRunning;
            using (Mutex checkMutex = new Mutex(false, TrayMutexName, out trayNotRunning))
            {
                // Immediately release handle if we created it so the spawned --tray child owns it
            }

            if (trayNotRunning)
            {
                try
                {
                    ProcessStartInfo trayPsi = new ProcessStartInfo
                    {
                        FileName = Application.ExecutablePath,
                        Arguments = "--tray --silent",
                        WorkingDirectory = GetAppDirectory(),
                        UseShellExecute = false,
                        CreateNoWindow = true
                    };
                    Process.Start(trayPsi);
                }
                catch
                {
                    // ignore
                }
            }

            OpenDashboardAppWindow();
        }

        public static void OpenDashboardAppWindow()
        {
            string[] browserCandidates = new string[]
            {
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), @"Google\Chrome\Application\chrome.exe"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), @"Google\Chrome\Application\chrome.exe"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), @"Microsoft\Edge\Application\msedge.exe"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), @"Microsoft\Edge\Application\msedge.exe")
            };

            foreach (string browserPath in browserCandidates)
            {
                if (!string.IsNullOrEmpty(browserPath) && File.Exists(browserPath))
                {
                    try
                    {
                        Process.Start(new ProcessStartInfo
                        {
                            FileName = browserPath,
                            Arguments = "--app=" + DashboardUrl,
                            UseShellExecute = true
                        });
                        return;
                    }
                    catch
                    {
                        // try next candidate
                    }
                }
            }

            try
            {
                Process.Start(new ProcessStartInfo
                {
                    FileName = DashboardUrl,
                    UseShellExecute = true
                });
            }
            catch
            {
                // ignore
            }
        }

        public static void OpenRecordingsFolder()
        {
            string targetFolder = null;
            try
            {
                HttpWebRequest req = (HttpWebRequest)WebRequest.Create(ApiBaseUrl + "/api/settings");
                req.Method = "GET";
                req.Timeout = 2000;
                using (HttpWebResponse resp = (HttpWebResponse)req.GetResponse())
                using (StreamReader reader = new StreamReader(resp.GetResponseStream()))
                {
                    string json = reader.ReadToEnd();
                    Match m = Regex.Match(json, "\"storagePath\"\\s*:\\s*\"([^\"]+)\"");
                    if (m.Success)
                    {
                        targetFolder = Regex.Unescape(m.Groups[1].Value);
                    }
                }
            }
            catch
            {
                // fallback
            }

            if (string.IsNullOrEmpty(targetFolder) || !Directory.Exists(targetFolder))
            {
                string localStorage = Path.Combine(GetAppDirectory(), "storage");
                targetFolder = Directory.Exists(localStorage) ? localStorage : GetAppDirectory();
            }

            try
            {
                Process.Start(new ProcessStartInfo
                {
                    FileName = "explorer.exe",
                    Arguments = "\"" + targetFolder + "\"",
                    UseShellExecute = true
                });
            }
            catch
            {
                // ignore
            }
        }

        public static bool RunElevatedCommand(string fileName, string arguments)
        {
            try
            {
                ProcessStartInfo psi = new ProcessStartInfo
                {
                    FileName = fileName,
                    Arguments = arguments,
                    Verb = "runas",
                    WindowStyle = ProcessWindowStyle.Hidden,
                    UseShellExecute = true
                };
                using (Process p = Process.Start(psi))
                {
                    if (p != null) p.WaitForExit(10000);
                }
                return true;
            }
            catch
            {
                return false;
            }
        }

        public static bool IsTrayAutoStartEnabled()
        {
            try
            {
                using (RegistryKey key = Registry.CurrentUser.OpenSubKey(RunRegistryKey, false))
                {
                    if (key == null) return false;
                    object val = key.GetValue(RunRegistryValueName);
                    return val != null && val.ToString().Length > 0;
                }
            }
            catch
            {
                return false;
            }
        }

        public static void SetTrayAutoStart(bool enable)
        {
            try
            {
                using (RegistryKey key = Registry.CurrentUser.OpenSubKey(RunRegistryKey, true))
                {
                    if (key == null) return;
                    if (enable)
                    {
                        string cmd = "\"" + Application.ExecutablePath + "\" --tray --silent";
                        key.SetValue(RunRegistryValueName, cmd, RegistryValueKind.String);
                    }
                    else
                    {
                        key.DeleteValue(RunRegistryValueName, false);
                    }
                }
            }
            catch
            {
                // ignore registry error
            }
        }

        public static Icon LoadBrandShieldIcon()
        {
            try
            {
                Icon assoc = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
                if (assoc != null) return assoc;
            }
            catch
            {
                // fallback to drawn shield
            }

            Bitmap bmp = new Bitmap(32, 32);
            using (Graphics g = Graphics.FromImage(bmp))
            {
                g.SmoothingMode = SmoothingMode.AntiAlias;
                g.Clear(Color.Transparent);
                Point[] shield = new Point[]
                {
                    new Point(16, 2),
                    new Point(28, 7),
                    new Point(28, 16),
                    new Point(16, 29),
                    new Point(4, 16),
                    new Point(4, 7)
                };
                using (SolidBrush bg = new SolidBrush(Color.FromArgb(255, 15, 23, 42)))
                using (Pen border = new Pen(Color.FromArgb(255, 16, 185, 129), 2.5f))
                using (SolidBrush core = new SolidBrush(Color.FromArgb(255, 16, 185, 129)))
                {
                    g.FillPolygon(bg, shield);
                    g.DrawPolygon(border, shield);
                    g.FillEllipse(core, 11, 10, 10, 10);
                }
            }
            return Icon.FromHandle(bmp.GetHicon());
        }
    }

    internal sealed class InksightTrayApplicationContext : ApplicationContext
    {
        private readonly NotifyIcon _notifyIcon;
        private readonly ToolStripMenuItem _statusItem;
        private readonly ToolStripMenuItem _autoStartItem;
        private readonly System.Windows.Forms.Timer _pollTimer;

        public InksightTrayApplicationContext(bool silentStartup)
        {
            string ver = Program.GetDisplayVersion();
            ContextMenuStrip menu = new ContextMenuStrip();

            ToolStripMenuItem openItem = new ToolStripMenuItem("Open Inksight Dashboard (" + ver + ")");
            openItem.Font = new Font(openItem.Font, FontStyle.Bold);
            openItem.Click += (s, e) =>
            {
                Program.EnsureBackendRunning(true);
                Program.OpenDashboardAppWindow();
            };
            menu.Items.Add(openItem);

            _statusItem = new ToolStripMenuItem("Status: Checking 24/7 NVR Engine...");
            _statusItem.Enabled = false;
            menu.Items.Add(_statusItem);

            menu.Items.Add(new ToolStripSeparator());

            ToolStripMenuItem folderItem = new ToolStripMenuItem("Open Video Recordings Folder");
            folderItem.Click += (s, e) => Program.OpenRecordingsFolder();
            menu.Items.Add(folderItem);

            _autoStartItem = new ToolStripMenuItem("Show Tray Icon Automatically on Windows Sign-In");
            _autoStartItem.Checked = Program.IsTrayAutoStartEnabled();
            _autoStartItem.Click += (s, e) =>
            {
                bool next = !_autoStartItem.Checked;
                Program.SetTrayAutoStart(next);
                _autoStartItem.Checked = Program.IsTrayAutoStartEnabled();
            };
            menu.Items.Add(_autoStartItem);

            menu.Items.Add(new ToolStripSeparator());

            ToolStripMenuItem restartItem = new ToolStripMenuItem("Restart 24/7 NVR Engine");
            restartItem.Click += (s, e) => RestartBackend();
            menu.Items.Add(restartItem);

            ToolStripMenuItem hideTrayItem = new ToolStripMenuItem("Hide Tray Icon (Keep 24/7 Recording Active)");
            hideTrayItem.Click += (s, e) => ExitTrayOnly();
            menu.Items.Add(hideTrayItem);

            ToolStripMenuItem stopAllItem = new ToolStripMenuItem("Stop 24/7 NVR Engine && Exit");
            stopAllItem.Click += (s, e) => StopAllAndExit();
            menu.Items.Add(stopAllItem);

            _notifyIcon = new NotifyIcon
            {
                Icon = Program.LoadBrandShieldIcon(),
                Text = "Inksight " + ver + " — 24/7 4K NVR & YOLO11 AI",
                ContextMenuStrip = menu,
                Visible = true
            };

            _notifyIcon.DoubleClick += (s, e) =>
            {
                Program.EnsureBackendRunning(true);
                Program.OpenDashboardAppWindow();
            };

            UpdateStatusAsync();

            _pollTimer = new System.Windows.Forms.Timer { Interval = 15000 };
            _pollTimer.Tick += (s, e) => UpdateStatusAsync();
            _pollTimer.Start();

            if (!silentStartup)
            {
                _notifyIcon.ShowBalloonTip(
                    3000,
                    "Inksight " + ver + " Active",
                    "24/7 Direct-to-Disk 4K recording and offline YOLO11 AI alerts are running in the background (0% GPU). Double-click to open.",
                    ToolTipIcon.Info
                );
            }
        }

        private void UpdateStatusAsync()
        {
            ThreadPool.QueueUserWorkItem(_ =>
            {
                bool online = Program.IsBackendResponding(1500);
                ServiceControllerStatus svcStatus;
                bool isService = Program.IsWindowsServiceInstalled(out svcStatus);
                string text = online
                    ? (isService
                        ? "Status: 24/7 Windows Service Active (0% GPU)"
                        : "Status: 24/7 NVR Engine Active (0% GPU)")
                    : "Status: NVR Engine Stopped (Click Open to Start)";

                try
                {
                    if (_notifyIcon.ContextMenuStrip != null && _notifyIcon.ContextMenuStrip.IsHandleCreated)
                    {
                        _notifyIcon.ContextMenuStrip.BeginInvoke((MethodInvoker)delegate
                        {
                            _statusItem.Text = text;
                        });
                    }
                    else
                    {
                        _statusItem.Text = text;
                    }
                }
                catch
                {
                    // ignore UI race on shutdown
                }
            });
        }

        private void RestartBackend()
        {
            ServiceControllerStatus svcStatus;
            if (Program.IsWindowsServiceInstalled(out svcStatus))
            {
                Program.RunElevatedCommand("cmd.exe", "/c net stop InksightService & net start InksightService");
            }
            else
            {
                StopPortableProcesses();
                Program.EnsureBackendRunning(false);
            }
            UpdateStatusAsync();
        }

        private void StopPortableProcesses()
        {
            try
            {
                ProcessStartInfo psi = new ProcessStartInfo
                {
                    FileName = "powershell.exe",
                    Arguments = "-NoProfile -WindowStyle Hidden -Command \"Get-NetTCPConnection -LocalPort 3001 -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }; Stop-Process -Name go2rtc -Force -ErrorAction SilentlyContinue\"",
                    CreateNoWindow = true,
                    UseShellExecute = false
                };
                using (Process p = Process.Start(psi))
                {
                    if (p != null) p.WaitForExit(5000);
                }
            }
            catch
            {
                // ignore
            }
        }

        private void ExitTrayOnly()
        {
            _pollTimer.Stop();
            _notifyIcon.Visible = false;
            _notifyIcon.Dispose();
            Application.Exit();
        }

        private void StopAllAndExit()
        {
            DialogResult res = MessageBox.Show(
                "Are you sure you want to stop the 24/7 camera recording and AI alert engine?\n\nTip: Choose 'No' and click 'Hide Tray Icon' if you want cameras to keep recording in the background.",
                "Stop Inksight 24/7 Recording?",
                MessageBoxButtons.YesNo,
                MessageBoxIcon.Warning,
                MessageBoxDefaultButton.Button2
            );

            if (res != DialogResult.Yes) return;

            ServiceControllerStatus svcStatus;
            if (Program.IsWindowsServiceInstalled(out svcStatus))
            {
                Program.RunElevatedCommand("sc.exe", "stop InksightService");
            }
            else
            {
                StopPortableProcesses();
            }

            ExitTrayOnly();
        }
    }
}

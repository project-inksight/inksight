import React, { useState, useEffect, useRef } from 'react';
import {
  X,
  Camera as CameraIcon,
  Crosshair,
  Cpu,
  Mail,
  HardDrive,
  Plus,
  Trash2,
  Check,
  RefreshCw,
  Send,
  Activity,
  Server,
  AlertTriangle,
  Radar,
  Smartphone,
  ShieldCheck,
  Download,
  Upload,
} from 'lucide-react';
import {
  AiComputeDevice,
  Camera,
  DiscoveredLanCamera,
  LocalYoloModelId,
  PolygonZone,
  SystemHealthStatus,
  SystemSettings,
} from '@shared/types';
import { PolygonZoneEditor } from './PolygonZoneEditor';

export type SettingsTab = 'cameras' | 'zones' | 'ai' | 'smtp' | 'storage';

interface SettingsModalProps {
  isOpen: boolean;
  initialTab: SettingsTab;
  initialZoneCameraId?: string | null;
  cameras: Camera[];
  settings: SystemSettings | null;
  health: SystemHealthStatus | null;
  go2rtcYaml: string;
  onClose: () => void;
  onSaveCamera: (camera: Partial<Camera> & { id?: string }, isNew: boolean) => Promise<void>;
  onDeleteCamera: (cameraId: string) => Promise<void>;
  onSaveSettings: (patch: Partial<SystemSettings>) => Promise<void>;
  onRefreshSettings: () => Promise<void>;
}

const ALL_AI_CLASSES = ['person', 'car', 'truck', 'bus', 'motorcycle', 'bicycle', 'dog', 'cat'];

const BUNDLED_YOLO_MODELS: Array<{
  id: LocalYoloModelId;
  title: string;
  badge: string;
  metrics: string;
  benefits: string;
  tradeoffs: string;
}> = [
  {
    id: 'yolo11n',
    title: 'YOLO11 Nano — Fast & Lightweight',
    badge: 'Lowest Resource Use',
    metrics: '~22 ms CPU · ~10 MB model · Minimal RAM',
    benefits:
      'Fastest inference speed with the lightest CPU and memory footprint. Ideal for older or low-power mini-PCs and systems monitoring 8+ cameras simultaneously.',
    tradeoffs:
      'Lower sensitivity on distant subjects or partially obstructed people (such as someone walking behind parked vehicles, barrels, or dense foliage).',
  },
  {
    id: 'yolo11s',
    title: 'YOLO11 Small — Balanced Spatial Attention',
    badge: 'Recommended Default',
    metrics: '~44 ms CPU (~22 ms GPU) · ~36 MB model · Moderate RAM',
    benefits:
      '+26% higher accuracy over Nano using C2PSA spatial attention. Reliably detects partially obstructed people (head & shoulders behind cars, fences, or bushes), pets at night, and fast passing vehicles.',
    tradeoffs:
      'Uses ~2x the brief CPU burst of Nano ONLY while active motion is occurring (still 0% AI load when the yard is quiet).',
  },
  {
    id: 'yolo11m',
    title: 'YOLO11 Medium — Maximum Accuracy',
    badge: 'Deep Occlusion & Distance',
    metrics: '~115 ms CPU (~55 ms GPU) · ~77 MB model · Higher RAM',
    benefits:
      '+38% higher accuracy over Nano with deep feature extraction. Best for long driveways, wide yards, heavy tree/object obstruction, and challenging lighting.',
    tradeoffs:
      'Noticeably heavier CPU and memory burst during active motion events. Enabling DirectML GPU acceleration below is recommended when running 4+ cameras.',
  },
];

const COMPUTE_DEVICE_OPTIONS: Array<{
  id: AiComputeDevice;
  title: string;
  badge: string;
  description: string;
}> = [
  {
    id: 'cpu',
    title: 'CPU Only (Strict 0% GPU)',
    badge: 'Default',
    description:
      'Runs neural network inference purely on CPU cores only during motion, keeping dedicated/integrated GPU usage at 0% at all times.',
  },
  {
    id: 'dml',
    title: 'Windows DirectML GPU Acceleration',
    badge: 'Intel / AMD / NVIDIA',
    description:
      'Offloads YOLO11 inference to any DirectX 12 GPU built into Windows 10/11 (no extra drivers needed), cutting Small/Medium latency in half. Uses ~150–300 MB VRAM and brief GPU bursts during motion.',
  },
];

export const SettingsModal: React.FC<SettingsModalProps> = ({
  isOpen,
  initialTab,
  initialZoneCameraId,
  cameras,
  settings,
  health,
  go2rtcYaml,
  onClose,
  onSaveCamera,
  onDeleteCamera,
  onSaveSettings,
  onRefreshSettings,
}) => {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const [activeTab, setActiveTab] = useState<SettingsTab>(initialTab);
  const [selectedCamId, setSelectedCamId] = useState<string>(
    initialZoneCameraId || cameras[0]?.id || 'new'
  );

  // Camera Form State
  const [camForm, setCamForm] = useState<Partial<Camera>>({
    name: 'CAM-05 Perimeter 4K',
    ip_address: '192.168.1.105',
    onvif_port: 80,
    username: 'admin',
    password: 'password123',
    main_stream_url:
      'rtsp://admin:password123@192.168.1.105:554/cam/realmonitor?channel=1&subtype=0',
    sub_stream_url:
      'rtsp://admin:password123@192.168.1.105:554/cam/realmonitor?channel=1&subtype=1',
    record_mode: 'continuous',
    ai_enabled: true,
    ai_classes: ['person', 'car', 'truck', 'dog'],
    min_confidence: 65,
    cooldown_seconds: 60,
    force_h264: false,
    enabled: true,
    schedule_mode: '24/7',
    schedule_start: '20:00',
    schedule_end: '06:00',
    webhook_url: '',
    action_script: '',
    audio_compat: 'aac',
  });

  const [probeResult, setProbeResult] = useState<{
    loading: boolean;
    text?: string;
    ok?: boolean;
  }>({ loading: false });

  // Settings Form State
  const [localSettings, setLocalSettings] = useState<SystemSettings | null>(settings);
  const [statusBanner, setStatusBanner] = useState<{
    type: 'success' | 'error' | 'info';
    message: string;
  } | null>(null);
  const [isTestingSmtp, setIsTestingSmtp] = useState(false);
  const [isTestingPush, setIsTestingPush] = useState(false);
  const [isTestingAi, setIsTestingAi] = useState(false);
  const [isCleaningStorage, setIsCleaningStorage] = useState(false);
  const [isScanningLan, setIsScanningLan] = useState(false);
  const [discoveredCameras, setDiscoveredCameras] = useState<DiscoveredLanCamera[] | null>(null);
  const [windowsAutoStart, setWindowsAutoStart] = useState(false);
  const [isUpdatingWindowsService, setIsUpdatingWindowsService] = useState(false);

  useEffect(() => {
    setActiveTab(initialTab);
    if (initialZoneCameraId) {
      setSelectedCamId(initialZoneCameraId);
    }
  }, [initialTab, initialZoneCameraId]);

  useEffect(() => {
    if (settings) {
      setLocalSettings(settings);
    }
  }, [settings]);

  // Populate camera form when selectedCamId changes
  useEffect(() => {
    if (selectedCamId === 'new') {
      setCamForm({
        name: `CAM-0${cameras.length + 1} IP Camera 4K`,
        ip_address: `192.168.1.${101 + cameras.length}`,
        onvif_port: 80,
        username: 'admin',
        password: 'password123',
        main_stream_url: `rtsp://admin:password123@192.168.1.${
          101 + cameras.length
        }:554/cam/realmonitor?channel=1&subtype=0`,
        sub_stream_url: `rtsp://admin:password123@192.168.1.${
          101 + cameras.length
        }:554/cam/realmonitor?channel=1&subtype=1`,
        record_mode: 'continuous',
        ai_enabled: true,
        ai_classes: ['person', 'car', 'truck', 'dog'],
        min_confidence: 65,
        cooldown_seconds: 60,
        force_h264: false,
        enabled: true,
        schedule_mode: '24/7',
        schedule_start: '20:00',
        schedule_end: '06:00',
        webhook_url: '',
        action_script: '',
        audio_compat: 'aac',
      });
    } else {
      const found = cameras.find((c) => c.id === selectedCamId);
      if (found) {
        setCamForm({
          ...found,
          main_stream_url: syncRtspUrlFields(
            found.main_stream_url,
            found.ip_address,
            found.username,
            found.password
          ),
          sub_stream_url: syncRtspUrlFields(
            found.sub_stream_url,
            found.ip_address,
            found.username,
            found.password
          ),
        });
      }
    }
    setProbeResult({ loading: false });
  }, [selectedCamId, cameras]);

  // Refresh camera list from server whenever modal opens
  useEffect(() => {
    if (isOpen) {
      void onRefreshSettings();
      void fetch('/api/system/windows-service')
        .then((r) => r.json())
        .then((d: { autoStartEnabled?: boolean }) => {
          setWindowsAutoStart(Boolean(d.autoStartEnabled));
        })
        .catch(() => {});
    }
  }, [isOpen, onRefreshSettings]);

  // Manage native <dialog> showModal() and light-dismiss fallback per modern-web-guidance
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (isOpen) {
      if (!dialog.open) {
        dialog.showModal();
      }
    } else if (dialog.open) {
      dialog.close();
    }
  }, [isOpen]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    const handleClose = () => {
      dialog.returnValue = '';
      onClose();
    };
    dialog.addEventListener('close', handleClose);

    // Fallback for browsers without native closedby="any" support
    let handleBackdropClick: ((e: MouseEvent) => void) | null = null;
    if (!('closedBy' in HTMLDialogElement.prototype)) {
      handleBackdropClick = (event: MouseEvent) => {
        if (event.target !== dialog) return;
        const rect = dialog.getBoundingClientRect();
        const isDialogContent =
          rect.top <= event.clientY &&
          event.clientY <= rect.top + rect.height &&
          rect.left <= event.clientX &&
          event.clientX <= rect.left + rect.width;
        if (isDialogContent) return;
        dialog.close();
      };
      dialog.addEventListener('click', handleBackdropClick);
    }

    return () => {
      dialog.removeEventListener('close', handleClose);
      if (handleBackdropClick) {
        dialog.removeEventListener('click', handleBackdropClick);
      }
    };
  }, [onClose]);

  const stripRtspCredentials = (rawUrl: string | undefined): string => {
    if (!rawUrl || (!rawUrl.startsWith('rtsp://') && !rawUrl.startsWith('rtsps://'))) {
      return rawUrl || '';
    }
    try {
      const u = new URL(rawUrl);
      u.username = '';
      u.password = '';
      return u.toString();
    } catch {
      return rawUrl.replace(/(rtsps?:\/\/)([^/@\s]+@)/i, '$1');
    }
  };

  const syncRtspUrlFields = (
    rawUrl: string | undefined,
    nextIp: string,
    nextUser: string,
    nextPass: string
  ): string => {
    if (!rawUrl || (!rawUrl.startsWith('rtsp://') && !rawUrl.startsWith('rtsps://'))) {
      return rawUrl || '';
    }
    try {
      const u = new URL(rawUrl);
      u.username = nextUser;
      u.password = nextPass;
      if (nextIp.trim()) {
        u.hostname = nextIp.trim();
      }
      return u.toString();
    } catch {
      return rawUrl;
    }
  };

  const applyCameraPreset = (
    brand: 'dahua' | 'hikvision' | 'reolink' | 'amcrest' | 'tapo' | 'onvif'
  ) => {
    const ip = camForm.ip_address || '192.168.1.101';
    const u = encodeURIComponent(camForm.username || 'admin');
    const p = encodeURIComponent(camForm.password || 'password123');

    if (brand === 'dahua' || brand === 'amcrest') {
      setCamForm((prev) => ({
        ...prev,
        main_stream_url: `rtsp://${u}:${p}@${ip}:554/cam/realmonitor?channel=1&subtype=0`,
        sub_stream_url: `rtsp://${u}:${p}@${ip}:554/cam/realmonitor?channel=1&subtype=1`,
      }));
    } else if (brand === 'hikvision') {
      setCamForm((prev) => ({
        ...prev,
        main_stream_url: `rtsp://${u}:${p}@${ip}:554/Streaming/Channels/101`,
        sub_stream_url: `rtsp://${u}:${p}@${ip}:554/Streaming/Channels/102`,
      }));
    } else if (brand === 'reolink') {
      setCamForm((prev) => ({
        ...prev,
        main_stream_url: `rtsp://${u}:${p}@${ip}:554/h265Preview_01_main`,
        sub_stream_url: `rtsp://${u}:${p}@${ip}:554/h264Preview_01_sub`,
      }));
    } else if (brand === 'tapo') {
      setCamForm((prev) => ({
        ...prev,
        main_stream_url: `rtsp://${u}:${p}@${ip}:554/stream1`,
        sub_stream_url: `rtsp://${u}:${p}@${ip}:554/stream2`,
      }));
    } else {
      setCamForm((prev) => ({
        ...prev,
        main_stream_url: `rtsp://${u}:${p}@${ip}:554/live/ch0`,
        sub_stream_url: `rtsp://${u}:${p}@${ip}:554/live/ch1`,
      }));
    }
  };

  const handleProbeCamera = async () => {
    if (!camForm.main_stream_url) return;
    setProbeResult({ loading: true });

    const syncedMain = syncRtspUrlFields(
      camForm.main_stream_url,
      camForm.ip_address || '',
      camForm.username || 'admin',
      camForm.password || ''
    );
    const syncedSub = syncRtspUrlFields(
      camForm.sub_stream_url,
      camForm.ip_address || '',
      camForm.username || 'admin',
      camForm.password || ''
    );

    setCamForm((prev) => ({
      ...prev,
      main_stream_url: syncedMain,
      sub_stream_url: syncedSub,
    }));

    try {
      const res = await fetch('/api/cameras/probe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cameraId: selectedCamId !== 'new' ? selectedCamId : undefined,
          ipAddress: camForm.ip_address,
          username: camForm.username,
          password: camForm.password,
          mainStreamUrl: syncedMain,
          subStreamUrl: syncedSub,
        }),
      });
      const data = await res.json();
      if (data.resolvedMainUrl) {
        setCamForm((prev) => ({
          ...prev,
          main_stream_url: data.resolvedMainUrl,
          sub_stream_url: data.resolvedSubUrl || prev.sub_stream_url,
        }));
      }
      const main = data.main;
      if (main) {
        setProbeResult({
          loading: false,
          ok: main.reachable,
          text: main.reachable
            ? `Verified: ${main.videoCodec} ${main.resolution} @ ${main.fps} FPS (${main.bitrateKbps} kbps) • Audio: ${main.audioCodec}`
            : `Stream configured for ${main.videoCodec} ${main.resolution} (LAN Camera offline: ${
                main.error || 'timeout'
              })`,
        });
      }
    } catch (err) {
      setProbeResult({
        loading: false,
        ok: false,
        text: `Probe failed: ${(err as Error).message}`,
      });
    }
  };

  const handleSaveCameraForm = async (e: React.FormEvent) => {
    e.preventDefault();
    const isNew = selectedCamId === 'new';
    await onSaveCamera(
      isNew ? camForm : { ...camForm, id: selectedCamId },
      isNew
    );
    setStatusBanner({
      type: 'success',
      message: `Camera "${camForm.name}" saved and synced with go2rtc & Direct-to-Disk Recorder.`,
    });
  };

  const handleScanLanCameras = async () => {
    setIsScanningLan(true);
    setStatusBanner(null);
    try {
      const res = await fetch('/api/cameras/discover');
      const data = (await res.json()) as { discovered?: DiscoveredLanCamera[]; error?: string };
      if (data.error) {
        setStatusBanner({ type: 'error', message: `LAN Scan failed: ${data.error}` });
      } else {
        const list = data.discovered || [];
        setDiscoveredCameras(list);
        const newCount = list.filter((d) => !d.alreadyConfigured).length;
        setStatusBanner({
          type: list.length > 0 ? 'success' : 'info',
          message:
            list.length > 0
              ? `Discovered ${list.length} RTSP IP camera(s) on your local network (${newCount} new). Click any camera below to auto-fill its settings.`
              : 'No additional devices with RTSP Port 554 open were found on your local /24 subnet.',
        });
      }
    } catch (err) {
      setStatusBanner({ type: 'error', message: (err as Error).message });
    } finally {
      setIsScanningLan(false);
    }
  };

  const handleSelectDiscoveredCamera = (disc: DiscoveredLanCamera) => {
    const existing = cameras.find((c) => c.ip_address === disc.ipAddress);
    if (existing) {
      setSelectedCamId(existing.id);
      return;
    }
    setSelectedCamId('new');
    const u = encodeURIComponent(camForm.username || 'admin');
    const p = encodeURIComponent(camForm.password || 'password123');
    let mainUrl = `rtsp://${u}:${p}@${disc.ipAddress}:${disc.rtspPort}/cam/realmonitor?channel=1&subtype=0`;
    let subUrl = `rtsp://${u}:${p}@${disc.ipAddress}:${disc.rtspPort}/cam/realmonitor?channel=1&subtype=1`;
    if (disc.suggestedBrand === 'hikvision') {
      mainUrl = `rtsp://${u}:${p}@${disc.ipAddress}:${disc.rtspPort}/Streaming/Channels/101`;
      subUrl = `rtsp://${u}:${p}@${disc.ipAddress}:${disc.rtspPort}/Streaming/Channels/102`;
    } else if (disc.suggestedBrand === 'reolink') {
      mainUrl = `rtsp://${u}:${p}@${disc.ipAddress}:${disc.rtspPort}/h265Preview_01_main`;
      subUrl = `rtsp://${u}:${p}@${disc.ipAddress}:${disc.rtspPort}/h264Preview_01_sub`;
    }
    setCamForm((prev) => ({
      ...prev,
      name: `${disc.suggestedBrand.toUpperCase()} Camera (${disc.ipAddress})`,
      ip_address: disc.ipAddress,
      onvif_port: 80,
      main_stream_url: mainUrl,
      sub_stream_url: subUrl,
    }));
  };

  const handleTestPush = async () => {
    if (!localSettings) return;
    setIsTestingPush(true);
    setStatusBanner(null);
    try {
      const res = await fetch('/api/settings/test-push', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(localSettings.smtp),
      });
      const data = (await res.json()) as { success: boolean; message: string };
      setStatusBanner({
        type: data.success ? 'success' : 'error',
        message: data.message,
      });
    } catch (err) {
      setStatusBanner({
        type: 'error',
        message: (err as Error).message,
      });
    } finally {
      setIsTestingPush(false);
    }
  };

  const handleUpdateWindowsService = async (opts: {
    autoStartEnabled?: boolean;
    launchTray?: boolean;
  }) => {
    setIsUpdatingWindowsService(true);
    setStatusBanner(null);
    try {
      const res = await fetch('/api/system/windows-service', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(opts),
      });
      const data = (await res.json()) as {
        success?: boolean;
        autoStartEnabled?: boolean;
        trayLaunched?: boolean;
        error?: string;
      };
      if (data.error) {
        setStatusBanner({ type: 'error', message: data.error });
      } else {
        setWindowsAutoStart(Boolean(data.autoStartEnabled));
        setStatusBanner({
          type: 'success',
          message: data.trayLaunched
            ? 'Launched Inksight Shield Icon in the Windows System Tray (0% GPU).'
            : data.autoStartEnabled
              ? 'Enabled Windows Startup: Inksight 24/7 NVR & Tray Agent will start automatically when you log in.'
              : 'Removed Inksight from Windows Startup.',
        });
      }
    } catch (err) {
      setStatusBanner({ type: 'error', message: (err as Error).message });
    } finally {
      setIsUpdatingWindowsService(false);
    }
  };

  const handleTestSmtp = async () => {
    if (!localSettings) return;
    setIsTestingSmtp(true);
    setStatusBanner(null);
    try {
      const res = await fetch('/api/settings/test-smtp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(localSettings.smtp),
      });
      const data = (await res.json()) as { success: boolean; message: string };
      setStatusBanner({
        type: data.success ? 'success' : 'error',
        message: data.message,
      });
    } catch (err) {
      setStatusBanner({
        type: 'error',
        message: (err as Error).message,
      });
    } finally {
      setIsTestingSmtp(false);
    }
  };

  const handleTestAiServer = async () => {
    if (!localSettings) return;
    setIsTestingAi(true);
    setStatusBanner(null);
    try {
      const endpointUrl =
        localSettings.ai.provider === 'onnx_local'
          ? localSettings.ai.onnxEndpointUrl
          : localSettings.ai.codeProjectUrl;
      const res = await fetch('/api/settings/test-ai', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpointUrl }),
      });
      const data = (await res.json()) as { online: boolean; message: string };
      setStatusBanner({
        type: data.online ? 'success' : 'info',
        message: data.message,
      });
    } catch (err) {
      setStatusBanner({
        type: 'error',
        message: (err as Error).message,
      });
    } finally {
      setIsTestingAi(false);
    }
  };

  const handleRunStorageCleanup = async () => {
    setIsCleaningStorage(true);
    setStatusBanner(null);
    try {
      const res = await fetch('/api/storage/cleanup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ forcePurgeCount: 2 }),
      });
      const data = (await res.json()) as { deletedSegments: number; freedBytes: number };
      const freedMb = (data.freedBytes / (1024 * 1024)).toFixed(2);
      setStatusBanner({
        type: 'success',
        message: `Circular Storage Manager completed: Purged ${data.deletedSegments} oldest unlocked segments (${freedMb} MB freed).`,
      });
      await onRefreshSettings();
    } finally {
      setIsCleaningStorage(false);
    }
  };

  const activeZoneCamera =
    cameras.find((c) => c.id === selectedCamId) || cameras[0] || null;

  return (
    <dialog
      ref={dialogRef}
      {...({ closedby: 'any' } as React.DialogHTMLAttributes<HTMLDialogElement>)}
      aria-labelledby="settings-modal-title"
      className="w-full max-w-6xl rounded-xl bg-[#111827] text-slate-100 border border-slate-700/90 shadow-2xl p-0 overflow-hidden"
    >
      <div className="flex flex-col h-[84vh]">
        {/* Top Modal Header */}
        <div className="px-6 py-4 bg-[#0B0F17] border-b border-slate-800 flex items-center justify-between">
          <div>
            <div className="flex items-center gap-2">
              <h2 id="settings-modal-title" className="text-base font-bold text-white">
                Inksight — System Configuration &amp; Zone Studio
              </h2>
              <span className="px-2 py-0.5 rounded bg-slate-800 border border-slate-700 text-emerald-300 font-mono text-[11px]">
                v{__APP_VERSION__}
              </span>
            </div>
            <p className="text-xs text-slate-400 font-mono">
              Project Inksight • Zero-Cloud 4K NVR • Direct-to-Disk Recording • Offline YOLO11 AI
            </p>
          </div>

          <form method="dialog">
            <button
              type="submit"
              aria-label="Close Settings"
              className="p-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300"
            >
              <X className="w-4 h-4" />
            </button>
          </form>
        </div>

        {/* Navigation Tabs */}
        <div className="px-6 bg-[#0E1420] border-b border-slate-800 flex items-center gap-2 overflow-x-auto">
          {[
            { id: 'cameras', label: 'Cameras & LAN Discovery', icon: CameraIcon },
            { id: 'zones', label: 'Polygon Zone Studio', icon: Crosshair },
            { id: 'ai', label: 'AI & Vision Engine', icon: Cpu },
            { id: 'smtp', label: 'Email & Mobile Push Alerts', icon: Mail },
            { id: 'storage', label: 'Storage, Tray & System', icon: HardDrive },
          ].map((tab) => {
            const Icon = tab.icon;
            const active = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => {
                  setStatusBanner(null);
                  setActiveTab(tab.id as SettingsTab);
                }}
                className={`flex items-center gap-2 px-4 py-3 text-xs font-semibold border-b-2 transition whitespace-nowrap ${
                  active
                    ? 'border-emerald-500 text-emerald-400 bg-emerald-500/5'
                    : 'border-transparent text-slate-400 hover:text-slate-200'
                }`}
              >
                <Icon className="w-4 h-4" />
                <span>{tab.label}</span>
              </button>
            );
          })}
        </div>

        {/* Status Notification Banner */}
        {statusBanner && (
          <div
            className={`mx-6 mt-4 px-4 py-2.5 rounded-lg border text-xs flex items-center justify-between ${
              statusBanner.type === 'success'
                ? 'bg-emerald-500/10 border-emerald-500/40 text-emerald-300'
                : statusBanner.type === 'error'
                  ? 'bg-red-500/10 border-red-500/40 text-red-300'
                  : 'bg-sky-500/10 border-sky-500/40 text-sky-300'
            }`}
          >
            <span>{statusBanner.message}</span>
            <button
              type="button"
              onClick={() => setStatusBanner(null)}
              className="text-slate-400 hover:text-white"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        {/* Main Scrollable Content Area */}
        <div className="flex-1 overflow-y-auto p-6">
          {/* TAB 1: CAMERAS & ONVIF WIZARD */}
          {activeTab === 'cameras' && (
            <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
              {/* Camera Selector List */}
              <div className="space-y-2">
                <button
                  type="button"
                  onClick={() => setSelectedCamId('new')}
                  className={`w-full flex items-center justify-center gap-2 py-2.5 px-3 rounded-lg border text-xs font-bold transition ${
                    selectedCamId === 'new'
                      ? 'bg-emerald-500 text-slate-950 border-emerald-400'
                      : 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30 hover:bg-emerald-500/25'
                  }`}
                >
                  <Plus className="w-4 h-4" />
                  <span>Add New IP Camera</span>
                </button>

                <button
                  type="button"
                  disabled={isScanningLan}
                  onClick={() => void handleScanLanCameras()}
                  className="w-full flex items-center justify-center gap-2 py-2 px-3 rounded-lg bg-sky-500/15 hover:bg-sky-500/25 border border-sky-500/40 text-sky-300 text-xs font-bold transition"
                >
                  <Radar className={`w-4 h-4 ${isScanningLan ? 'animate-spin' : ''}`} />
                  <span>{isScanningLan ? 'Scanning Local /24 LAN...' : 'Scan LAN for Cameras'}</span>
                </button>

                {discoveredCameras && (
                  <div className="p-2.5 rounded-lg bg-[#090D14] border border-sky-500/30 space-y-1.5">
                    <div className="flex items-center justify-between text-[10px] font-mono text-sky-300 uppercase">
                      <span>LAN Port 554 Found ({discoveredCameras.length})</span>
                      <button
                        type="button"
                        onClick={() => setDiscoveredCameras(null)}
                        className="text-slate-500 hover:text-white"
                      >
                        Clear
                      </button>
                    </div>
                    {discoveredCameras.length === 0 ? (
                      <div className="text-[11px] text-slate-400">
                        No open RTSP (554) cameras found.
                      </div>
                    ) : (
                      discoveredCameras.map((d) => (
                        <button
                          key={d.ipAddress}
                          type="button"
                          onClick={() => handleSelectDiscoveredCamera(d)}
                          className="w-full text-left p-2 rounded bg-slate-900/90 hover:bg-slate-800 border border-slate-800 transition flex items-center justify-between gap-2"
                        >
                          <div className="truncate">
                            <div className="text-[11px] font-mono font-bold text-white">
                              {d.ipAddress}:{d.rtspPort}
                            </div>
                            <div className="text-[10px] text-slate-400 truncate">
                              {d.existingCameraName
                                ? `${d.existingCameraName} (${d.serverBanner})`
                                : d.serverBanner}
                            </div>
                          </div>
                          <span
                            className={`px-1.5 py-0.5 rounded text-[9px] font-mono uppercase shrink-0 ${
                              d.alreadyConfigured
                                ? 'bg-slate-800 text-slate-400'
                                : 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 font-bold'
                            }`}
                          >
                            {d.alreadyConfigured ? 'Added' : '+ Fill'}
                          </span>
                        </button>
                      ))
                    )}
                  </div>
                )}

                <div className="space-y-1.5 pt-2">
                  {cameras.map((cam) => (
                    <button
                      key={cam.id}
                      type="button"
                      onClick={() => setSelectedCamId(cam.id)}
                      className={`w-full text-left p-3 rounded-lg border transition flex items-center justify-between ${
                        selectedCamId === cam.id
                          ? 'bg-slate-800 border-emerald-500/60 text-white'
                          : 'bg-[#0B0F17] border-slate-800 text-slate-300 hover:border-slate-700'
                      }`}
                    >
                      <div className="truncate">
                        <div className="text-xs font-bold truncate">{cam.name}</div>
                        <div className="text-[10px] font-mono text-slate-400">
                          {cam.ip_address} • {cam.record_mode}
                        </div>
                      </div>
                      <span
                        className={`w-2 h-2 rounded-full shrink-0 ${
                          cam.enabled ? 'bg-emerald-400' : 'bg-slate-600'
                        }`}
                      />
                    </button>
                  ))}
                </div>
              </div>

              {/* Camera Configuration Form */}
              <form
                onSubmit={(e) => void handleSaveCameraForm(e)}
                className="lg:col-span-3 bg-[#0B0F17] border border-slate-800 rounded-xl p-5 space-y-5"
              >
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 pb-3">
                  <div>
                    <h3 className="text-sm font-bold text-white">
                      {selectedCamId === 'new'
                        ? 'Add New Dual-Stream Camera'
                        : `Configure ${camForm.name}`}
                    </h3>
                    <p className="text-xs text-slate-400">
                      Store both 4K Main Stream (`subtype=0` / `101`) and Sub-Stream (`subtype=1` /
                      `102`) for adaptive grid switching.
                    </p>
                  </div>

                  {/* Quick Brand RTSP Presets */}
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-[11px] font-mono text-slate-400 mr-1">Presets:</span>
                    {[
                      { id: 'dahua', label: 'Dahua / EmpireTech' },
                      { id: 'hikvision', label: 'Hikvision / Annke' },
                      { id: 'reolink', label: 'Reolink' },
                      { id: 'amcrest', label: 'Amcrest / Lorex' },
                      { id: 'tapo', label: 'TP-Link Tapo' },
                      { id: 'onvif', label: 'Generic ONVIF' },
                    ].map((p) => (
                      <button
                        key={p.id}
                        type="button"
                        onClick={() =>
                          applyCameraPreset(
                            p.id as
                              | 'dahua'
                              | 'hikvision'
                              | 'reolink'
                              | 'amcrest'
                              | 'tapo'
                              | 'onvif'
                          )
                        }
                        className="px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 border border-slate-700 text-[11px] font-mono text-emerald-300 transition"
                      >
                        {p.label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Network & Credentials */}
                <div className="grid grid-cols-1 md:grid-cols-4 gap-3 text-xs">
                  <div className="md:col-span-2">
                    <label className="block text-slate-400 mb-1">Camera Name</label>
                    <input
                      type="text"
                      required
                      value={camForm.name || ''}
                      onChange={(e) => setCamForm({ ...camForm, name: e.target.value })}
                      className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-white"
                    />
                  </div>
                  <div>
                    <label className="block text-slate-400 mb-1">IP Address</label>
                    <input
                      type="text"
                      required
                      value={camForm.ip_address || ''}
                      onChange={(e) => {
                        const nextIp = e.target.value;
                        const u = camForm.username || 'admin';
                        const p = camForm.password || '';
                        setCamForm({
                          ...camForm,
                          ip_address: nextIp,
                          main_stream_url: syncRtspUrlFields(camForm.main_stream_url, nextIp, u, p),
                          sub_stream_url: syncRtspUrlFields(camForm.sub_stream_url, nextIp, u, p),
                        });
                      }}
                      className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-white font-mono"
                    />
                  </div>
                  <div>
                    <label className="block text-slate-400 mb-1">ONVIF Port</label>
                    <input
                      type="number"
                      value={camForm.onvif_port ?? 80}
                      onChange={(e) =>
                        setCamForm({ ...camForm, onvif_port: Number(e.target.value) })
                      }
                      className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-white font-mono"
                    />
                  </div>
                  <div>
                    <label className="block text-slate-400 mb-1">RTSP Username</label>
                    <input
                      type="text"
                      value={camForm.username || ''}
                      onChange={(e) => {
                        const nextUser = e.target.value;
                        const ip = camForm.ip_address || '';
                        const p = camForm.password || '';
                        setCamForm({
                          ...camForm,
                          username: nextUser,
                          main_stream_url: syncRtspUrlFields(camForm.main_stream_url, ip, nextUser, p),
                          sub_stream_url: syncRtspUrlFields(camForm.sub_stream_url, ip, nextUser, p),
                        });
                      }}
                      className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-white font-mono"
                    />
                  </div>
                  <div>
                    <label className="block text-slate-400 mb-1">RTSP Password</label>
                    <input
                      type="password"
                      value={camForm.password || ''}
                      onChange={(e) => {
                        const nextPass = e.target.value;
                        const ip = camForm.ip_address || '';
                        const u = camForm.username || 'admin';
                        setCamForm({
                          ...camForm,
                          password: nextPass,
                          main_stream_url: syncRtspUrlFields(camForm.main_stream_url, ip, u, nextPass),
                          sub_stream_url: syncRtspUrlFields(camForm.sub_stream_url, ip, u, nextPass),
                        });
                      }}
                      className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-white font-mono"
                    />
                  </div>
                  <div>
                    <label className="block text-slate-400 mb-1">Recording Mode</label>
                    <select
                      value={camForm.record_mode || 'continuous'}
                      onChange={(e) =>
                        setCamForm({
                          ...camForm,
                          record_mode: e.target.value as Camera['record_mode'],
                        })
                      }
                      className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-white"
                    >
                      <option value="continuous">Continuous Direct-to-Disk</option>
                      <option value="events_only">AI Events Only</option>
                      <option value="off">Live Only (No Recording)</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-slate-400 mb-1">G.711 Audio Transcode</label>
                    <select
                      value={camForm.audio_compat || 'aac'}
                      onChange={(e) =>
                        setCamForm({
                          ...camForm,
                          audio_compat: e.target.value as 'aac' | 'opus' | 'copy',
                        })
                      }
                      className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-white"
                    >
                      <option value="aac">Auto AAC (#audio=aac)</option>
                      <option value="opus">Auto Opus (#audio=opus)</option>
                      <option value="copy">Pass-through (Copy)</option>
                    </select>
                  </div>
                </div>

                {/* Dual RTSP Stream URLs */}
                <div className="space-y-3 bg-slate-900/60 p-3.5 rounded-lg border border-slate-800 text-xs">
                  <div>
                    <label className="block text-emerald-400 font-semibold mb-1">
                      1. Main Stream RTSP URL (Native 4K 3840x2160 H.265/H.264 — Solo View &
                      Direct-to-Disk Recording)
                    </label>
                    <input
                      type="text"
                      required
                      value={stripRtspCredentials(camForm.main_stream_url)}
                      onChange={(e) =>
                        setCamForm({
                          ...camForm,
                          main_stream_url: syncRtspUrlFields(
                            e.target.value,
                            camForm.ip_address || '',
                            camForm.username || 'admin',
                            camForm.password || ''
                          ),
                        })
                      }
                      className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-emerald-200 font-mono text-xs"
                    />
                  </div>

                  <div>
                    <label className="block text-sky-400 font-semibold mb-1">
                      2. Sub Stream RTSP URL (720p/D1 Low-Overhead — Multi-Camera Grid Matrix & AI
                      Frame Sampler)
                    </label>
                    <input
                      type="text"
                      required
                      value={stripRtspCredentials(camForm.sub_stream_url)}
                      onChange={(e) =>
                        setCamForm({
                          ...camForm,
                          sub_stream_url: syncRtspUrlFields(
                            e.target.value,
                            camForm.ip_address || '',
                            camForm.username || 'admin',
                            camForm.password || ''
                          ),
                        })
                      }
                      className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sky-200 font-mono text-xs"
                    />
                  </div>

                  <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                    <button
                      type="button"
                      disabled={probeResult.loading}
                      onClick={() => void handleProbeCamera()}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-xs font-mono text-slate-200 transition"
                    >
                      <Activity className="w-3.5 h-3.5 text-emerald-400" />
                      <span>
                        {probeResult.loading
                          ? 'Probing via ffprobe...'
                          : 'Test Connection & Auto-Detect (ffprobe)'}
                      </span>
                    </button>

                    {probeResult.text && (
                      <span
                        className={`text-[11px] font-mono ${
                          probeResult.ok ? 'text-emerald-400' : 'text-amber-300'
                        }`}
                      >
                        {probeResult.text}
                      </span>
                    )}
                  </div>
                </div>

                {/* Browser Compatibility & AI Rules */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
                  <div className="p-3.5 rounded-lg bg-slate-900/50 border border-slate-800 space-y-3">
                    <div className="font-bold text-slate-200">
                      Codec & Hardware Acceleration Options
                    </div>

                    <label className="flex items-start gap-2.5 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={Boolean(camForm.force_h264)}
                        onChange={(e) =>
                          setCamForm({ ...camForm, force_h264: e.target.checked })
                        }
                        className="mt-0.5"
                      />
                      <div>
                        <span className="font-semibold text-purple-300 block">
                          Force GPU H.264 Transcode (NVENC)
                        </span>
                        <span className="text-[11px] text-slate-400">
                          Appends `#video=h264#hardware` in `go2rtc.yaml` for older browsers that
                          lack native HEVC/H.265 support.
                        </span>
                      </div>
                    </label>

                    <label className="flex items-center gap-2.5 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={camForm.enabled !== false}
                        onChange={(e) =>
                          setCamForm({ ...camForm, enabled: e.target.checked })
                        }
                      />
                      <span className="text-slate-200 font-medium">Camera Enabled</span>
                    </label>
                  </div>

                  {/* AI Verification & Cooldown Rules */}
                  <div className="p-3.5 rounded-lg bg-slate-900/50 border border-slate-800 space-y-3">
                    <div className="flex items-center justify-between">
                      <span className="font-bold text-slate-200">
                        YOLOv8 AI Rule Engine
                      </span>
                      <label className="flex items-center gap-1.5 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={camForm.ai_enabled !== false}
                          onChange={(e) =>
                            setCamForm({ ...camForm, ai_enabled: e.target.checked })
                          }
                        />
                        <span className="text-emerald-400 font-semibold">AI Enabled</span>
                      </label>
                    </div>

                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label className="block text-slate-400 mb-1">
                          Min Confidence ({camForm.min_confidence ?? 65}%)
                        </label>
                        <input
                          type="range"
                          min={25}
                          max={95}
                          value={camForm.min_confidence ?? 65}
                          onChange={(e) =>
                            setCamForm({
                              ...camForm,
                              min_confidence: Number(e.target.value),
                            })
                          }
                          className="w-full"
                        />
                      </div>

                      <div>
                        <label className="block text-slate-400 mb-1">Cooldown (seconds)</label>
                        <input
                          type="number"
                          min={5}
                          max={3600}
                          value={camForm.cooldown_seconds ?? 60}
                          onChange={(e) =>
                            setCamForm({
                              ...camForm,
                              cooldown_seconds: Number(e.target.value),
                            })
                          }
                          className="w-full bg-slate-950 border border-slate-700 rounded px-2.5 py-1 text-white font-mono"
                        />
                      </div>
                    </div>

                    <div>
                      <label className="block text-slate-400 mb-1">Target Object Classes</label>
                      <div className="flex flex-wrap gap-1.5">
                        {ALL_AI_CLASSES.map((cls) => {
                          const selected = (camForm.ai_classes || []).includes(cls);
                          return (
                            <button
                              key={cls}
                              type="button"
                              onClick={() => {
                                const current = camForm.ai_classes || [];
                                const next = selected
                                  ? current.filter((c) => c !== cls)
                                  : [...current, cls];
                                setCamForm({ ...camForm, ai_classes: next });
                              }}
                              className={`px-2 py-0.5 rounded text-[11px] font-mono uppercase border transition ${
                                selected
                                  ? 'bg-emerald-500/20 border-emerald-500/50 text-emerald-300 font-bold'
                                  : 'bg-slate-950 border-slate-800 text-slate-500'
                              }`}
                            >
                              {cls}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                </div>

                {/* Alert Schedule & Action Sets (Webhook / Script) */}
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs">
                  <div>
                    <label className="block text-slate-400 mb-1">Alert Schedule</label>
                    <select
                      value={camForm.schedule_mode || '24/7'}
                      onChange={(e) =>
                        setCamForm({
                          ...camForm,
                          schedule_mode: e.target.value as Camera['schedule_mode'],
                        })
                      }
                      className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-white"
                    >
                      <option value="24/7">24/7 Active Monitoring</option>
                      <option value="night_only">Night Only (20:00 – 06:00)</option>
                      <option value="custom_hours">Custom Hours</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-slate-400 mb-1">
                      Outbound Webhook URL (HTTP POST)
                    </label>
                    <input
                      type="text"
                      placeholder="https://homeassistant.local/api/webhook/..."
                      value={camForm.webhook_url || ''}
                      onChange={(e) =>
                        setCamForm({ ...camForm, webhook_url: e.target.value })
                      }
                      className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-white font-mono"
                    />
                  </div>
                  <div>
                    <label className="block text-slate-400 mb-1">
                      Local Action Script (Python / Batch)
                    </label>
                    <input
                      type="text"
                      placeholder="python C:\scripts\on_alert.py"
                      value={camForm.action_script || ''}
                      onChange={(e) =>
                        setCamForm({ ...camForm, action_script: e.target.value })
                      }
                      className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-white font-mono"
                    />
                  </div>
                </div>

                {/* Submit & Delete Buttons */}
                <div className="flex items-center justify-between pt-2 border-t border-slate-800">
                  {selectedCamId !== 'new' ? (
                    <button
                      type="button"
                      onClick={() => void onDeleteCamera(selectedCamId)}
                      className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-red-500/15 hover:bg-red-500/25 border border-red-500/30 text-red-300 text-xs font-semibold transition"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                      <span>Delete Camera</span>
                    </button>
                  ) : (
                    <div />
                  )}

                  <div className="flex items-center gap-2">
                    {selectedCamId !== 'new' && (
                      <button
                        type="button"
                        onClick={() => setActiveTab('zones')}
                        className="flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold transition"
                      >
                        <Crosshair className="w-3.5 h-3.5 text-emerald-400" />
                        <span>Open Polygon Zone Studio</span>
                      </button>
                    )}

                    <button
                      type="submit"
                      className="flex items-center gap-1.5 px-5 py-2 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold text-xs shadow-lg transition"
                    >
                      <Check className="w-4 h-4" />
                      <span>
                        {selectedCamId === 'new' ? 'Create Camera' : 'Save Camera Changes'}
                      </span>
                    </button>
                  </div>
                </div>
              </form>
            </div>
          )}

          {/* TAB 2: INTERACTIVE POLYGON ZONE STUDIO */}
          {activeTab === 'zones' && (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-2 bg-[#0B0F17] p-3 rounded-lg border border-slate-800">
                <div className="flex items-center gap-3">
                  <span className="text-xs font-bold text-slate-300">Select Camera:</span>
                  <select
                    aria-label="Select Camera for Polygon Zones"
                    value={activeZoneCamera?.id || ''}
                    onChange={(e) => setSelectedCamId(e.target.value)}
                    className="bg-slate-900 border border-slate-700 rounded-lg px-3 py-1.5 text-xs text-white font-semibold"
                  >
                    {cameras.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </div>
                <span className="text-xs text-slate-400 font-mono">
                  Bottom-Center Rule: Point ((x1 + x2)/2, y2) must fall inside an active Inclusion
                  Zone.
                </span>
              </div>

              {activeZoneCamera && (
                <PolygonZoneEditor
                  camera={activeZoneCamera}
                  onSaveZones={async (camId, updatedZones: PolygonZone[]) => {
                    await onSaveCamera({ id: camId, zones: updatedZones }, false);
                    setStatusBanner({
                      type: 'success',
                      message: `Saved ${updatedZones.length} polygon zone(s) for ${activeZoneCamera.name}.`,
                    });
                  }}
                />
              )}
            </div>
          )}

          {/* TAB 3: CODEPROJECT.AI & VISION ENGINE */}
          {activeTab === 'ai' && localSettings && (
            <form
              aria-labelledby="ai-engine-heading"
              onSubmit={async (e) => {
                e.preventDefault();
                await onSaveSettings({ ai: localSettings.ai });
                setStatusBanner({
                  type: 'success',
                  message: 'AI Vision model & pipeline settings saved and applied live.',
                });
              }}
              className="max-w-3xl space-y-6 bg-[#0B0F17] p-5 rounded-xl border border-slate-800 text-xs"
            >
              <div className="flex items-center justify-between border-b border-slate-800 pb-3">
                <div>
                  <h3 id="ai-engine-heading" className="text-sm font-bold text-white">
                    AI & Local YOLO11 ONNX Detection Engine
                  </h3>
                  <p className="text-slate-400">
                    Samples frames from `{`{camera_id}_sub`}` during active motion and renders crisp
                    bounding boxes onto `{`{camera_id}_main`}` 4K snapshots.
                  </p>
                </div>

                <button
                  type="button"
                  disabled={isTestingAi}
                  onClick={() => void handleTestAiServer()}
                  className="flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-emerald-400 font-mono font-semibold transition"
                >
                  <Activity className="w-3.5 h-3.5" />
                  <span>{isTestingAi ? 'Checking...' : 'Test AI Engine Health'}</span>
                </button>
              </div>

              {/* Bundled YOLO11 Model Selector with Benefits & Resource Tradeoffs */}
              <fieldset className="space-y-2.5 border-0 p-0 m-0">
                <legend className="text-xs font-bold text-slate-200 mb-1 flex items-center gap-2">
                  <Cpu className="w-3.5 h-3.5 text-emerald-400" />
                  <span>Bundled Local Detection Model (100% Offline — Switches Live)</span>
                </legend>
                <div className="grid grid-cols-1 gap-3">
                  {BUNDLED_YOLO_MODELS.map((model) => {
                    const currentModel = localSettings.ai.localModel || 'yolo11s';
                    const isSelected = currentModel === model.id;
                    const inputId = `ai-model-${model.id}`;
                    const descId = `ai-model-desc-${model.id}`;
                    return (
                      <div key={model.id} className="relative">
                        <input
                          type="radio"
                          id={inputId}
                          name="localYoloModel"
                          value={model.id}
                          checked={isSelected}
                          aria-describedby={descId}
                          onChange={() =>
                            setLocalSettings({
                              ...localSettings,
                              ai: { ...localSettings.ai, localModel: model.id },
                            })
                          }
                          className="sr-only peer"
                        />
                        <label
                          htmlFor={inputId}
                          className={`block cursor-pointer rounded-xl border p-3.5 transition peer-focus-visible:ring-2 peer-focus-visible:ring-emerald-400 peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-[#0B0F17] ${
                            isSelected
                              ? 'bg-emerald-500/10 border-emerald-500/70 shadow-sm'
                              : 'bg-slate-900/70 border-slate-800 hover:border-slate-700'
                          }`}
                        >
                          <div className="flex flex-wrap items-center justify-between gap-2 mb-1.5">
                            <div className="flex items-center gap-2">
                              <span
                                aria-hidden="true"
                                className={`w-4 h-4 rounded-full border flex items-center justify-center ${
                                  isSelected
                                    ? 'border-emerald-400 bg-emerald-500 text-slate-950'
                                    : 'border-slate-600 bg-slate-950'
                                }`}
                              >
                                {isSelected && <Check className="w-2.5 h-2.5 stroke-[3]" />}
                              </span>
                              <span className="font-bold text-white text-xs">{model.title}</span>
                              <span
                                className={`px-2 py-0.5 rounded-full text-[10px] font-semibold ${
                                  model.id === 'yolo11s'
                                    ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
                                    : 'bg-slate-800 text-slate-300 border border-slate-700'
                                }`}
                              >
                                {model.badge}
                              </span>
                            </div>
                            <div className="flex items-center gap-2">
                              <span className="font-mono text-[11px] text-slate-400">
                                {model.metrics}
                              </span>
                              {isSelected && (
                                <span className="px-2 py-0.5 rounded bg-emerald-500 text-slate-950 font-bold text-[10px] uppercase tracking-wider">
                                  Selected
                                </span>
                              )}
                            </div>
                          </div>

                          <div id={descId} className="pl-6 space-y-1 text-[11px] leading-relaxed">
                            <p className="text-slate-200">
                              <strong className="text-emerald-400 font-semibold">Benefits:</strong>{' '}
                              {model.benefits}
                            </p>
                            <p className="text-slate-400">
                              <strong className="text-amber-300 font-semibold">
                                Resource Tradeoff:
                              </strong>{' '}
                              {model.tradeoffs}
                            </p>
                          </div>
                        </label>
                      </div>
                    );
                  })}
                </div>
              </fieldset>

              {/* Compute Device Selector (CPU vs DirectML GPU) */}
              <fieldset className="space-y-2.5 border-0 p-0 m-0 pt-1">
                <legend className="text-xs font-bold text-slate-200 mb-1">
                  Inference Compute Hardware
                </legend>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {COMPUTE_DEVICE_OPTIONS.map((opt) => {
                    const currentDevice = localSettings.ai.computeDevice || 'cpu';
                    const isSelected = currentDevice === opt.id;
                    const inputId = `ai-device-${opt.id}`;
                    const descId = `ai-device-desc-${opt.id}`;
                    return (
                      <div key={opt.id} className="relative">
                        <input
                          type="radio"
                          id={inputId}
                          name="aiComputeDevice"
                          value={opt.id}
                          checked={isSelected}
                          aria-describedby={descId}
                          onChange={() =>
                            setLocalSettings({
                              ...localSettings,
                              ai: { ...localSettings.ai, computeDevice: opt.id },
                            })
                          }
                          className="sr-only peer"
                        />
                        <label
                          htmlFor={inputId}
                          className={`block h-full cursor-pointer rounded-xl border p-3.5 transition peer-focus-visible:ring-2 peer-focus-visible:ring-emerald-400 peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-[#0B0F17] ${
                            isSelected
                              ? 'bg-emerald-500/10 border-emerald-500/70'
                              : 'bg-slate-900/70 border-slate-800 hover:border-slate-700'
                          }`}
                        >
                          <div className="flex items-center justify-between gap-2 mb-1">
                            <div className="flex items-center gap-2">
                              <span
                                aria-hidden="true"
                                className={`w-4 h-4 rounded-full border flex items-center justify-center ${
                                  isSelected
                                    ? 'border-emerald-400 bg-emerald-500 text-slate-950'
                                    : 'border-slate-600 bg-slate-950'
                                }`}
                              >
                                {isSelected && <Check className="w-2.5 h-2.5 stroke-[3]" />}
                              </span>
                              <span className="font-bold text-white text-xs">{opt.title}</span>
                            </div>
                            <span className="px-2 py-0.5 rounded bg-slate-800 border border-slate-700 text-[10px] text-slate-300 font-semibold">
                              {opt.badge}
                            </span>
                          </div>
                          <p id={descId} className="pl-6 text-[11px] text-slate-400 leading-relaxed">
                            {opt.description}
                          </p>
                        </label>
                      </div>
                    );
                  })}
                </div>
              </fieldset>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-2 border-t border-slate-800/80">
                <div>
                  <label htmlFor="ai-provider-select" className="block text-slate-400 mb-1">
                    AI Vision Provider Mode
                  </label>
                  <select
                    id="ai-provider-select"
                    name="provider"
                    value={localSettings.ai.provider}
                    onChange={(e) =>
                      setLocalSettings({
                        ...localSettings,
                        ai: {
                          ...localSettings.ai,
                          provider: e.target.value as 'codeproject' | 'onnx_local',
                        },
                      })
                    }
                    className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-white"
                  >
                    <option value="codeproject">Built-in Local YOLO11 ONNX + REST Fallback</option>
                    <option value="onnx_local">Custom External ONNX / YOLO REST Endpoint</option>
                  </select>
                </div>

                <div>
                  <label htmlFor="ai-endpoint-url" className="block text-slate-400 mb-1">
                    External AI REST Endpoint URL (Optional)
                  </label>
                  <input
                    id="ai-endpoint-url"
                    name="codeProjectUrl"
                    type="text"
                    autoCorrect="off"
                    autoCapitalize="none"
                    spellCheck={false}
                    value={localSettings.ai.codeProjectUrl}
                    onChange={(e) =>
                      setLocalSettings({
                        ...localSettings,
                        ai: { ...localSettings.ai, codeProjectUrl: e.target.value },
                      })
                    }
                    className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-white font-mono"
                  />
                </div>

                <div>
                  <label htmlFor="ai-idle-fps" className="block text-slate-400 mb-1">
                    Idle Sub-Stream Motion Watch FPS
                  </label>
                  <input
                    id="ai-idle-fps"
                    name="idleSampleFps"
                    type="number"
                    min={1}
                    max={5}
                    value={localSettings.ai.idleSampleFps}
                    onChange={(e) =>
                      setLocalSettings({
                        ...localSettings,
                        ai: { ...localSettings.ai, idleSampleFps: Number(e.target.value) },
                      })
                    }
                    className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-white font-mono"
                  />
                </div>

                <div>
                  <label htmlFor="ai-active-fps" className="block text-slate-400 mb-1">
                    Active Motion / Tracking Sample FPS
                  </label>
                  <input
                    id="ai-active-fps"
                    name="activeSampleFps"
                    type="number"
                    min={2}
                    max={10}
                    value={localSettings.ai.activeSampleFps}
                    onChange={(e) =>
                      setLocalSettings({
                        ...localSettings,
                        ai: { ...localSettings.ai, activeSampleFps: Number(e.target.value) },
                      })
                    }
                    className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-white font-mono"
                  />
                </div>
              </div>

              <div className="flex items-center gap-2.5 pt-1">
                <input
                  id="ai-draw-boxes"
                  name="drawHighResBoxes"
                  type="checkbox"
                  checked={localSettings.ai.drawHighResBoxes}
                  onChange={(e) =>
                    setLocalSettings({
                      ...localSettings,
                      ai: { ...localSettings.ai, drawHighResBoxes: e.target.checked },
                    })
                  }
                  className="rounded border-slate-700"
                />
                <label htmlFor="ai-draw-boxes" className="cursor-pointer text-slate-200 font-medium">
                  Draw anti-aliased bounding boxes, confidence percentages (`Person 94%`), and zone
                  anchors onto saved 4K snapshots
                </label>
              </div>

              <div className="pt-3 border-t border-slate-800 flex justify-end">
                <button
                  type="submit"
                  className="px-5 py-2.5 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold transition"
                >
                  Save AI Settings
                </button>
              </div>
            </form>
          )}

          {/* TAB 4: SMTP VIDEO EMAILER */}
          {activeTab === 'smtp' && localSettings && (
            <div className="max-w-3xl space-y-5 bg-[#0B0F17] p-5 rounded-xl border border-slate-800 text-xs">
              <div className="flex items-center justify-between border-b border-slate-800 pb-3">
                <div>
                  <h3 className="text-sm font-bold text-white">
                    Automated SMTP Video & Snapshot Alert Engine
                  </h3>
                  <p className="text-slate-400">
                    Sends HTML alert emails with inline annotated 4K snapshots and attached 15s
                    Direct-to-Disk MP4 video clips.
                  </p>
                </div>

                <button
                  type="button"
                  disabled={isTestingSmtp}
                  onClick={() => void handleTestSmtp()}
                  className="flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-500/40 text-emerald-300 font-bold transition"
                >
                  <Send className="w-3.5 h-3.5" />
                  <span>{isTestingSmtp ? 'Sending...' : 'Send Test Email'}</span>
                </button>
              </div>

              <label className="flex items-center gap-2.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={localSettings.smtp.enabled}
                  onChange={(e) =>
                    setLocalSettings({
                      ...localSettings,
                      smtp: { ...localSettings.smtp, enabled: e.target.checked },
                    })
                  }
                />
                <span className="font-bold text-emerald-400">
                  Enable Automated SMTP Email Alerts on Verified AI Events
                </span>
              </label>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="md:col-span-2">
                  <label className="block text-slate-400 mb-1">SMTP Server Host</label>
                  <input
                    type="text"
                    value={localSettings.smtp.host}
                    onChange={(e) =>
                      setLocalSettings({
                        ...localSettings,
                        smtp: { ...localSettings.smtp, host: e.target.value },
                      })
                    }
                    className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-white font-mono"
                  />
                </div>
                <div>
                  <label className="block text-slate-400 mb-1">SMTP Port</label>
                  <input
                    type="number"
                    value={localSettings.smtp.port}
                    onChange={(e) =>
                      setLocalSettings({
                        ...localSettings,
                        smtp: { ...localSettings.smtp, port: Number(e.target.value) },
                      })
                    }
                    className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-white font-mono"
                  />
                </div>

                <div>
                  <label className="block text-slate-400 mb-1">SMTP Username</label>
                  <input
                    type="text"
                    value={localSettings.smtp.username}
                    onChange={(e) =>
                      setLocalSettings({
                        ...localSettings,
                        smtp: { ...localSettings.smtp, username: e.target.value },
                      })
                    }
                    className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-white font-mono"
                  />
                </div>
                <div>
                  <label className="block text-slate-400 mb-1">SMTP App Password</label>
                  <input
                    type="password"
                    value={localSettings.smtp.password}
                    onChange={(e) =>
                      setLocalSettings({
                        ...localSettings,
                        smtp: { ...localSettings.smtp, password: e.target.value },
                      })
                    }
                    className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-white font-mono"
                  />
                </div>
                <div>
                  <label className="block text-slate-400 mb-1">Max MP4 Clip Attachment (MB)</label>
                  <input
                    type="number"
                    value={localSettings.smtp.maxAttachmentSizeMb}
                    onChange={(e) =>
                      setLocalSettings({
                        ...localSettings,
                        smtp: {
                          ...localSettings.smtp,
                          maxAttachmentSizeMb: Number(e.target.value),
                        },
                      })
                    }
                    className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-white font-mono"
                  />
                </div>

                <div className="md:col-span-1">
                  <label className="block text-slate-400 mb-1">Sender Address</label>
                  <input
                    type="text"
                    value={localSettings.smtp.sender}
                    onChange={(e) =>
                      setLocalSettings({
                        ...localSettings,
                        smtp: { ...localSettings.smtp, sender: e.target.value },
                      })
                    }
                    className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-white"
                  />
                </div>
                <div className="md:col-span-2">
                  <label className="block text-slate-400 mb-1">
                    Recipients (Comma-separated emails)
                  </label>
                  <input
                    type="text"
                    placeholder="security@domain.com, admin@domain.com"
                    value={localSettings.smtp.recipients}
                    onChange={(e) =>
                      setLocalSettings({
                        ...localSettings,
                        smtp: { ...localSettings.smtp, recipients: e.target.value },
                      })
                    }
                    className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-white font-mono"
                  />
                </div>
              </div>

              <label className="flex items-center gap-2.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={localSettings.smtp.secure}
                  onChange={(e) =>
                    setLocalSettings({
                      ...localSettings,
                      smtp: { ...localSettings.smtp, secure: e.target.checked },
                    })
                  }
                />
                <span className="text-slate-300">Use Implicit TLS/SSL (Port 465)</span>
              </label>

              {/* Instant Mobile Push Notifications Section */}
              <div className="pt-4 border-t border-slate-800 space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <h4 className="text-sm font-bold text-white flex items-center gap-2">
                      <Smartphone className="w-4 h-4 text-emerald-400" />
                      <span>Instant Mobile Push Notifications (Telegram • Ntfy.sh • Pushover)</span>
                    </h4>
                    <p className="text-slate-400">
                      Receive instant phone alerts with inline 4K YOLOv8 bounding-box photos — zero cloud subscriptions required.
                    </p>
                  </div>

                  <button
                    type="button"
                    disabled={isTestingPush}
                    onClick={() => void handleTestPush()}
                    className="flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-sky-500/15 hover:bg-sky-500/25 border border-sky-500/40 text-sky-300 font-bold transition"
                  >
                    <Smartphone className="w-3.5 h-3.5" />
                    <span>{isTestingPush ? 'Pushing...' : 'Send Test Push'}</span>
                  </button>
                </div>

                {/* 1. Telegram Bot API */}
                <div className="p-3.5 rounded-lg bg-slate-900/60 border border-slate-800 space-y-3">
                  <label className="flex items-center gap-2.5 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={Boolean(localSettings.smtp.telegramEnabled)}
                      onChange={(e) =>
                        setLocalSettings({
                          ...localSettings,
                          smtp: { ...localSettings.smtp, telegramEnabled: e.target.checked },
                        })
                      }
                    />
                    <span className="font-bold text-sky-400">
                      Telegram Bot Push (Instant 4K Annotated Photo + Caption)
                    </span>
                  </label>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <div>
                      <label className="block text-slate-400 mb-1">
                        Telegram Bot Token (from @BotFather)
                      </label>
                      <input
                        type="password"
                        placeholder="123456789:ABCdefGHIjklMNOpqrSTUvwxYZ"
                        value={localSettings.smtp.telegramBotToken || ''}
                        onChange={(e) =>
                          setLocalSettings({
                            ...localSettings,
                            smtp: { ...localSettings.smtp, telegramBotToken: e.target.value },
                          })
                        }
                        className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-white font-mono"
                      />
                    </div>
                    <div>
                      <label className="block text-slate-400 mb-1">
                        Telegram Chat ID (User or Group ID)
                      </label>
                      <input
                        type="text"
                        placeholder="e.g. 987654321 or -100123456789"
                        value={localSettings.smtp.telegramChatId || ''}
                        onChange={(e) =>
                          setLocalSettings({
                            ...localSettings,
                            smtp: { ...localSettings.smtp, telegramChatId: e.target.value },
                          })
                        }
                        className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-white font-mono"
                      />
                    </div>
                  </div>
                </div>

                {/* 2. Ntfy.sh Push */}
                <div className="p-3.5 rounded-lg bg-slate-900/60 border border-slate-800 space-y-3">
                  <label className="flex items-center gap-2.5 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={Boolean(localSettings.smtp.ntfyEnabled)}
                      onChange={(e) =>
                        setLocalSettings({
                          ...localSettings,
                          smtp: { ...localSettings.smtp, ntfyEnabled: e.target.checked },
                        })
                      }
                    />
                    <span className="font-bold text-emerald-400">
                      Ntfy.sh Push (Zero-Account iOS / Android App Notifications)
                    </span>
                  </label>

                  <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                    <div>
                      <label className="block text-slate-400 mb-1">Ntfy Server URL</label>
                      <input
                        type="text"
                        placeholder="https://ntfy.sh"
                        value={localSettings.smtp.ntfyServerUrl || 'https://ntfy.sh'}
                        onChange={(e) =>
                          setLocalSettings({
                            ...localSettings,
                            smtp: { ...localSettings.smtp, ntfyServerUrl: e.target.value },
                          })
                        }
                        className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-white font-mono"
                      />
                    </div>
                    <div>
                      <label className="block text-slate-400 mb-1">Secret Topic Name</label>
                      <input
                        type="text"
                        placeholder="inksight-myhome-9921"
                        value={localSettings.smtp.ntfyTopic || ''}
                        onChange={(e) =>
                          setLocalSettings({
                            ...localSettings,
                            smtp: { ...localSettings.smtp, ntfyTopic: e.target.value },
                          })
                        }
                        className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-white font-mono"
                      />
                    </div>
                    <div>
                      <label className="block text-slate-400 mb-1">Access Token (Optional)</label>
                      <input
                        type="password"
                        placeholder="tk_..."
                        value={localSettings.smtp.ntfyToken || ''}
                        onChange={(e) =>
                          setLocalSettings({
                            ...localSettings,
                            smtp: { ...localSettings.smtp, ntfyToken: e.target.value },
                          })
                        }
                        className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-white font-mono"
                      />
                    </div>
                  </div>
                </div>

                {/* 3. Pushover Push */}
                <div className="p-3.5 rounded-lg bg-slate-900/60 border border-slate-800 space-y-3">
                  <label className="flex items-center gap-2.5 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={Boolean(localSettings.smtp.pushoverEnabled)}
                      onChange={(e) =>
                        setLocalSettings({
                          ...localSettings,
                          smtp: { ...localSettings.smtp, pushoverEnabled: e.target.checked },
                        })
                      }
                    />
                    <span className="font-bold text-amber-400">
                      Pushover Mobile Push (High-Priority iOS / Android Alerts)
                    </span>
                  </label>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <div>
                      <label className="block text-slate-400 mb-1">Pushover User Key</label>
                      <input
                        type="text"
                        placeholder="uQiRzpo4DXghDmr9QzzfQu27cmVRsG"
                        value={localSettings.smtp.pushoverUserKey || ''}
                        onChange={(e) =>
                          setLocalSettings({
                            ...localSettings,
                            smtp: { ...localSettings.smtp, pushoverUserKey: e.target.value },
                          })
                        }
                        className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-white font-mono"
                      />
                    </div>
                    <div>
                      <label className="block text-slate-400 mb-1">Pushover API Token</label>
                      <input
                        type="password"
                        placeholder="azGDORePK8gMaC0QOYAMyEEuzJnyUi"
                        value={localSettings.smtp.pushoverApiToken || ''}
                        onChange={(e) =>
                          setLocalSettings({
                            ...localSettings,
                            smtp: { ...localSettings.smtp, pushoverApiToken: e.target.value },
                          })
                        }
                        className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-white font-mono"
                      />
                    </div>
                  </div>
                </div>
              </div>

              <div className="pt-3 border-t border-slate-800 flex justify-end">
                <button
                  type="button"
                  onClick={async () => {
                    await onSaveSettings({ smtp: localSettings.smtp });
                    setStatusBanner({
                      type: 'success',
                      message: 'Email & Mobile Push notification settings saved.',
                    });
                  }}
                  className="px-5 py-2 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold"
                >
                  Save Alert & Push Configuration
                </button>
              </div>
            </div>
          )}

          {/* TAB 5: STORAGE LIFECYCLE & GO2RTC ENGINE */}
          {activeTab === 'storage' && localSettings && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 text-xs">
              {/* Storage Lifecycle Card */}
              <div className="bg-[#0B0F17] p-5 rounded-xl border border-slate-800 space-y-4">
                <div className="flex items-center justify-between border-b border-slate-800 pb-3">
                  <div>
                    <h3 className="text-sm font-bold text-white">
                      Circular Storage Manager & Pre/Post Ring Buffer
                    </h3>
                    <p className="text-slate-400">
                      Runs every 15 minutes. Purges oldest unlocked segments when quota or disk threshold is reached.
                    </p>
                  </div>

                  <button
                    type="button"
                    disabled={isCleaningStorage}
                    onClick={() => void handleRunStorageCleanup()}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-emerald-400 font-mono transition"
                  >
                    <RefreshCw className="w-3.5 h-3.5" />
                    <span>{isCleaningStorage ? 'Running...' : 'Run Cleanup Pass'}</span>
                  </button>
                </div>

                {/* Storage Gauges */}
                {health && (
                  <div className="grid grid-cols-2 gap-3 bg-slate-900/60 p-3.5 rounded-lg border border-slate-800">
                    <div className="space-y-1.5">
                      <div className="flex justify-between font-mono text-[11px]">
                        <span className="text-slate-400">NVR Quota Usage</span>
                        <span className="text-emerald-400">
                          {(health.storageUsedBytes / (1024 * 1024)).toFixed(1)} MB /{' '}
                          {localSettings.storage.maxStorageGb} GB
                        </span>
                      </div>
                      <progress
                        max={100}
                        value={Math.max(2, health.storageUsagePercent)}
                        className="w-full h-2 rounded overflow-hidden"
                      />
                      <div className="text-[10px] font-mono text-slate-500">
                        {health.segmentCount} total segments ({health.lockedSegmentCount} locked
                        bookmarks)
                      </div>
                    </div>

                    <div className="space-y-1.5">
                      <div className="flex justify-between font-mono text-[11px]">
                        <span className="text-slate-400">Physical Volume Usage</span>
                        <span
                          className={
                            health.diskUsagePercent > 85 ? 'text-amber-400' : 'text-sky-400'
                          }
                        >
                          {health.diskUsagePercent}% Full
                        </span>
                      </div>
                      <progress
                        max={100}
                        value={health.diskUsagePercent}
                        className="w-full h-2 rounded overflow-hidden"
                      />
                      <div className="text-[10px] font-mono text-slate-500">
                        {(health.diskFreeBytes / (1024 * 1024 * 1024)).toFixed(1)} GB free on disk
                      </div>
                    </div>
                  </div>
                )}

                <div className="grid grid-cols-2 gap-3">
                  <div className="col-span-2">
                    <label className="block text-slate-400 mb-1">
                      Direct-to-Disk Recording Directory
                    </label>
                    <input
                      type="text"
                      value={localSettings.storage.storagePath}
                      onChange={(e) =>
                        setLocalSettings({
                          ...localSettings,
                          storage: { ...localSettings.storage, storagePath: e.target.value },
                        })
                      }
                      className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-white font-mono"
                    />
                  </div>

                  {/* Selectable Overwrite & Retention Policy */}
                  <div className="col-span-2 p-3.5 rounded-lg bg-slate-900/70 border border-slate-800 space-y-3">
                    <div>
                      <label className="block text-emerald-400 font-semibold mb-1">
                        Circular Overwrite & Retention Policy
                      </label>
                      <select
                        value={localSettings.storage.overwritePolicy || 'days_and_quota'}
                        onChange={(e) =>
                          setLocalSettings({
                            ...localSettings,
                            storage: {
                              ...localSettings.storage,
                              overwritePolicy: e.target.value as
                                | 'days_and_quota'
                                | 'circular_quota'
                                | 'stop_when_full',
                            },
                          })
                        }
                        className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-white"
                      >
                        <option value="days_and_quota">
                          Retain Up to N Days + Overwrite Oldest When Quota Reached (Recommended)
                        </option>
                        <option value="circular_quota">
                          Circular FIFO Only — Retain Whatever the Storage Quota Holds
                        </option>
                        <option value="stop_when_full">
                          Never Overwrite — Keep All Segments Until Manually Purged
                        </option>
                      </select>
                    </div>

                    {(localSettings.storage.overwritePolicy || 'days_and_quota') ===
                      'days_and_quota' && (
                      <div className="space-y-2">
                        <div className="flex items-center justify-between">
                          <label className="text-slate-300">
                            Target Retention Window (Days)
                          </label>
                          <div className="flex items-center gap-1">
                            {[1, 3, 7, 14, 30].map((d) => (
                              <button
                                key={d}
                                type="button"
                                onClick={() =>
                                  setLocalSettings({
                                    ...localSettings,
                                    storage: {
                                      ...localSettings.storage,
                                      retentionDays: d,
                                    },
                                  })
                                }
                                className={`px-2 py-0.5 rounded font-mono text-[11px] border transition ${
                                  localSettings.storage.retentionDays === d
                                    ? 'bg-emerald-500/20 border-emerald-500/50 text-emerald-300 font-bold'
                                    : 'bg-slate-950 border-slate-800 text-slate-400 hover:text-white'
                                }`}
                              >
                                {d}d
                              </button>
                            ))}
                          </div>
                        </div>
                        <input
                          type="number"
                          min={1}
                          max={365}
                          value={localSettings.storage.retentionDays || 7}
                          onChange={(e) =>
                            setLocalSettings({
                              ...localSettings,
                              storage: {
                                ...localSettings.storage,
                                retentionDays: Math.max(1, Number(e.target.value)),
                              },
                            })
                          }
                          className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-1.5 text-white font-mono"
                        />
                      </div>
                    )}

                    <div className="text-[11px] font-mono text-slate-400 bg-slate-950/80 px-3 py-2 rounded border border-slate-800/80">
                      Estimated 4K D2D Capacity (~3.6 GB/hr per camera):{' '}
                      <span className="text-emerald-300 font-bold">
                        ~
                        {(
                          localSettings.storage.maxStorageGb /
                          (Math.max(1, cameras.filter((c) => c.enabled && c.record_mode === 'continuous').length) *
                            3.6 *
                            24)
                        ).toFixed(1)}{' '}
                        days
                      </span>{' '}
                      within {localSettings.storage.maxStorageGb} GB quota (bookmarked/locked clips
                      are always protected).
                    </div>
                  </div>

                  <div>
                    <label className="block text-slate-400 mb-1">Max NVR Quota (GB)</label>
                    <input
                      type="number"
                      min={10}
                      max={50000}
                      value={localSettings.storage.maxStorageGb}
                      onChange={(e) =>
                        setLocalSettings({
                          ...localSettings,
                          storage: {
                            ...localSettings.storage,
                            maxStorageGb: Number(e.target.value),
                          },
                        })
                      }
                      className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-white font-mono"
                    />
                  </div>

                  <div>
                    <label className="block text-slate-400 mb-1">Max Disk Full Limit (%)</label>
                    <input
                      type="number"
                      min={50}
                      max={98}
                      value={localSettings.storage.maxDiskUsagePercent}
                      onChange={(e) =>
                        setLocalSettings({
                          ...localSettings,
                          storage: {
                            ...localSettings.storage,
                            maxDiskUsagePercent: Number(e.target.value),
                          },
                        })
                      }
                      className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-white font-mono"
                    />
                  </div>

                  <div>
                    <label className="block text-slate-400 mb-1">
                      Pre-Event Buffer (Seconds)
                    </label>
                    <input
                      type="number"
                      min={2}
                      max={30}
                      value={localSettings.storage.preBufferSeconds}
                      onChange={(e) =>
                        setLocalSettings({
                          ...localSettings,
                          storage: {
                            ...localSettings.storage,
                            preBufferSeconds: Number(e.target.value),
                          },
                        })
                      }
                      className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-white font-mono"
                    />
                  </div>

                  <div>
                    <label className="block text-slate-400 mb-1">
                      Post-Event Buffer (Seconds)
                    </label>
                    <input
                      type="number"
                      min={5}
                      max={60}
                      value={localSettings.storage.postBufferSeconds}
                      onChange={(e) =>
                        setLocalSettings({
                          ...localSettings,
                          storage: {
                            ...localSettings.storage,
                            postBufferSeconds: Number(e.target.value),
                          },
                        })
                      }
                      className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-white font-mono"
                    />
                  </div>
                </div>

                <div className="pt-2 flex justify-end">
                  <button
                    type="button"
                    onClick={async () => {
                      await onSaveSettings({ storage: localSettings.storage });
                      setStatusBanner({
                        type: 'success',
                        message: 'Storage & Ring Buffer settings saved.',
                      });
                    }}
                    className="px-5 py-2 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold"
                  >
                    Save Storage Policy
                  </button>
                </div>
              </div>

              {/* Right Column: Windows System Tray & Auto-Start + Generated go2rtc.yaml Inspector */}
              <div className="space-y-6">
                <div className="bg-[#0B0F17] p-5 rounded-xl border border-slate-800 space-y-4">
                  <div className="flex items-center justify-between border-b border-slate-800 pb-3">
                    <div>
                      <h3 className="text-sm font-bold text-white flex items-center gap-2">
                        <ShieldCheck className="w-4 h-4 text-emerald-400" />
                        <span>Windows System Tray & Auto-Start Service</span>
                      </h3>
                      <p className="text-slate-400 text-[11px]">
                        Keep 24/7 Direct-to-Disk 4K recording and YOLOv8 AI alerts running in the
                        Windows System Tray with 0% GPU usage when the dashboard window is closed.
                      </p>
                    </div>

                    <button
                      type="button"
                      disabled={isUpdatingWindowsService}
                      onClick={() => void handleUpdateWindowsService({ launchTray: true })}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-500/40 text-emerald-300 font-mono text-[11px] font-bold shrink-0 transition"
                    >
                      <ShieldCheck className="w-3.5 h-3.5" />
                      <span>Launch System Tray Icon</span>
                    </button>
                  </div>

                  <label className="flex items-start gap-2.5 cursor-pointer p-3 rounded-lg bg-slate-900/60 border border-slate-800">
                    <input
                      type="checkbox"
                      disabled={isUpdatingWindowsService}
                      checked={windowsAutoStart}
                      onChange={(e) =>
                        void handleUpdateWindowsService({ autoStartEnabled: e.target.checked })
                      }
                      className="mt-0.5"
                    />
                    <div>
                      <span className="font-bold text-emerald-400 block">
                        Start Inksight Automatically When Windows Starts
                      </span>
                      <span className="text-[11px] text-slate-400">
                        Registers the Inksight Tray &amp; Background NVR Agent in your Windows
                        Startup folder so recording resumes automatically after power outages or
                        reboots.
                      </span>
                    </div>
                  </label>

                  {/* 1-Click Configuration Backup & Restore */}
                  <div className="pt-3 border-t border-slate-800 flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <div className="font-bold text-slate-200 text-xs">
                        Configuration Backup & Restore
                      </div>
                      <div className="text-[11px] text-slate-400">
                        Export or restore all cameras, polygon zones, and notification settings.
                      </div>
                    </div>

                    <div className="flex items-center gap-2">
                      <a
                        href="/api/settings/backup"
                        download
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-emerald-300 font-mono text-[11px] font-bold transition"
                      >
                        <Download className="w-3.5 h-3.5" />
                        <span>Export Backup (.json)</span>
                      </a>

                      <label className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-sky-300 font-mono text-[11px] font-bold cursor-pointer transition">
                        <Upload className="w-3.5 h-3.5" />
                        <span>Restore Backup</span>
                        <input
                          type="file"
                          accept=".json,application/json"
                          className="hidden"
                          onChange={async (e) => {
                            const file = e.target.files?.[0];
                            if (!file) return;
                            try {
                              const text = await file.text();
                              const parsed = JSON.parse(text);
                              const res = await fetch('/api/settings/restore', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify(parsed),
                              });
                              const data = (await res.json()) as {
                                success?: boolean;
                                message?: string;
                                error?: string;
                              };
                              if (data.error) {
                                setStatusBanner({ type: 'error', message: data.error });
                              } else {
                                await onRefreshSettings();
                                setStatusBanner({
                                  type: 'success',
                                  message:
                                    data.message || 'Configuration restored successfully.',
                                });
                              }
                            } catch (err) {
                              setStatusBanner({
                                type: 'error',
                                message: `Failed to restore backup: ${(err as Error).message}`,
                              });
                            } finally {
                              e.target.value = '';
                            }
                          }}
                        />
                      </label>
                    </div>
                  </div>
                </div>

                <div className="bg-[#0B0F17] p-5 rounded-xl border border-slate-800 flex flex-col justify-between space-y-4">
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <Server className="w-4 h-4 text-emerald-400" />
                        <h3 className="text-sm font-bold text-white">
                          Generated `go2rtc.yaml` Configuration
                        </h3>
                      </div>
                      <button
                        type="button"
                        onClick={async () => {
                          await fetch('/api/go2rtc/reload', { method: 'POST' });
                          await onRefreshSettings();
                          setStatusBanner({
                            type: 'success',
                            message: 'Regenerated go2rtc.yaml and reloaded stream ingestion engine.',
                          });
                        }}
                        className="flex items-center gap-1 px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-emerald-400 font-mono text-[11px]"
                      >
                        <RefreshCw className="w-3 h-3" />
                        <span>Reload go2rtc</span>
                      </button>
                    </div>

                    <p className="text-slate-400 text-[11px]">
                      All camera RTSP streams are ingested once on Port 8554 and restreamed via MSE
                      WebSocket on Port 1984 with `#audio=aac` compatibility.
                    </p>

                    <pre className="p-3.5 rounded-lg bg-slate-950 border border-slate-800 font-mono text-[11px] text-emerald-300 overflow-x-auto max-h-60">
                      {(go2rtcYaml || '# Loading go2rtc.yaml...').replace(
                        /(rtsps?:\/\/[^:/@\s]+:)([^@\s#]+)(@)/gi,
                        '$1••••••••$3'
                      )}
                    </pre>
                  </div>

                  {health && !health.nvencSupported && (
                    <div className="p-3 rounded-lg bg-amber-500/10 border border-amber-500/30 flex items-center gap-2 text-amber-300 text-[11px]">
                      <AlertTriangle className="w-4 h-4 shrink-0" />
                      <span>
                        Direct-to-Disk (`-c:v copy`) is active with zero CPU re-encoding.
                      </span>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </dialog>
  );
};


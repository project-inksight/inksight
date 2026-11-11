import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  Shield,
  Grid,
  Settings,
  Crosshair,
  Eye,
  Activity,
  HardDrive,
  Server,
  Cpu,
  PanelRightClose,
  PanelRightOpen,
  Plus,
  Radio,
  Film,
  Lock,
  Download,
  Bell,
} from 'lucide-react';
import {
  AIEvent,
  Camera,
  CameraTelemetry,
  RecordingDaySummary,
  RecordingSegment,
  SystemHealthStatus,
  SystemSettings,
  WSMessage,
} from '@shared/types';
import { LiveMatrixView, GridLayoutSize } from './components/LiveMatrixView';
import { TimelineScrubber } from './components/TimelineScrubber';
import { EventsDrawer } from './components/EventsDrawer';
import { SettingsModal, SettingsTab } from './components/SettingsModal';

interface ToastNotification {
  id: string;
  level: 'info' | 'warning' | 'error' | 'alert';
  title: string;
  message: string;
  timestamp: number;
}

export const App: React.FC = () => {
  const [cameras, setCameras] = useState<Camera[]>([]);
  const [telemetryMap, setTelemetryMap] = useState<Record<string, CameraTelemetry>>({});
  const [health, setHealth] = useState<SystemHealthStatus | null>(null);
  const [settings, setSettings] = useState<SystemSettings | null>(null);
  const [go2rtcYaml, setGo2rtcYaml] = useState<string>('');

  // Matrix & View State
  const [gridSize, setGridSize] = useState<GridLayoutSize>(4);
  const [soloCameraId, setSoloCameraId] = useState<string | null>(null);
  const [selectedCameraId, setSelectedCameraId] = useState<string>('cam_north_driveway');
  const [showTelemetryHud, setShowTelemetryHud] = useState<boolean>(true);
  const [showZonesOverlay, setShowZonesOverlay] = useState<boolean>(true);
  const [showBoxesOverlay, setShowBoxesOverlay] = useState<boolean>(true);
  const [showEventsDrawer, setShowEventsDrawer] = useState<boolean>(true);
  const [drawerCameraFilter, setDrawerCameraFilter] = useState<string>('all');

  // Timeline & Forensic Archive Playback State
  const [segments, setSegments] = useState<RecordingSegment[]>([]);
  const [events, setEvents] = useState<AIEvent[]>([]);
  const [recordingDays, setRecordingDays] = useState<RecordingDaySummary[]>([]);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const selectedDateRef = useRef<string | null>(null);
  const [isPlayingArchive, setIsPlayingArchive] = useState<boolean>(false);
  const [isArchivePaused, setIsArchivePaused] = useState<boolean>(false);
  const [playbackSpeed, setPlaybackSpeed] = useState<number>(1);
  const [activeSegment, setActiveSegment] = useState<RecordingSegment | null>(null);
  const [nextSegment, setNextSegment] = useState<RecordingSegment | null>(null);
  const [playheadTimestampMs, setPlayheadTimestampMs] = useState<number>(Date.now());
  const archiveVideoRef = useRef<HTMLVideoElement | null>(null);
  const pendingOffsetSecRef = useRef<number>(0);

  useEffect(() => {
    selectedDateRef.current = selectedDate;
  }, [selectedDate]);

  // Settings Modal State
  const [isSettingsOpen, setIsSettingsOpen] = useState<boolean>(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('cameras');
  const [zoneEditorCameraId, setZoneEditorCameraId] = useState<string | null>(null);

  // Live Toast Notifications
  const [toasts, setToasts] = useState<ToastNotification[]>([]);

  const addToast = useCallback(
    (level: ToastNotification['level'], title: string, message: string) => {
      const id = `toast_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      setToasts((prev) => [{ id, level, title, message, timestamp: Date.now() }, ...prev.slice(0, 3)]);
      setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
      }, 5500);
    },
    []
  );

  const fetchInitialData = useCallback(async () => {
    try {
      const [camRes, tlRes, setRes] = await Promise.all([
        fetch('/api/cameras'),
        fetch(`/api/recordings/timeline?startTime=${Date.now() - 24 * 60 * 60 * 1000}&endTime=${Date.now() + 60000}`),
        fetch('/api/settings'),
      ]);

      if (camRes.ok) {
        const camData = await camRes.json();
        setCameras(camData.cameras || []);
        if (camData.telemetry) setTelemetryMap(camData.telemetry);
        if (camData.cameras?.length > 0) {
          setSelectedCameraId((prev) =>
            camData.cameras.some((c: Camera) => c.id === prev) ? prev : camData.cameras[0].id
          );
        }
      }

      if (tlRes.ok) {
        const tlData = await tlRes.json();
        if (!selectedDateRef.current) {
          setSegments(tlData.segments || []);
          setEvents(tlData.events || []);
        }
        if (Array.isArray(tlData.days)) {
          setRecordingDays(tlData.days);
        }
      }

      if (setRes.ok) {
        const setData = await setRes.json();
        setSettings(setData.settings || null);
        if (setData.health) setHealth(setData.health);
        if (setData.go2rtcYaml) setGo2rtcYaml(setData.go2rtcYaml);
      }
    } catch (err) {
      console.error('Error loading initial data:', err);
    }
  }, []);

  useEffect(() => {
    void fetchInitialData();
  }, [fetchInitialData]);

  // Keep playhead advancing with wall-clock time when in Live Matrix mode
  useEffect(() => {
    if (isPlayingArchive || selectedDate !== null) return;
    const id = setInterval(() => {
      setPlayheadTimestampMs(Date.now());
    }, 15000);
    return () => clearInterval(id);
  }, [isPlayingArchive, selectedDate]);

  const handleSelectDate = useCallback(async (dateStr: string | null) => {
    setSelectedDate(dateStr);
    selectedDateRef.current = dateStr;

    try {
      if (!dateStr) {
        const endMs = Date.now() + 60000;
        const startMs = Date.now() - 24 * 60 * 60 * 1000;
        const res = await fetch(`/api/recordings/timeline?startTime=${startMs}&endTime=${endMs}`);
        if (res.ok) {
          const data = await res.json();
          setSegments(data.segments || []);
          setEvents(data.events || []);
          if (Array.isArray(data.days)) setRecordingDays(data.days);
          setPlayheadTimestampMs(Date.now());
        }
        return;
      }

      const [yyyy, mm, dd] = dateStr.split('-').map(Number);
      const dayStartMs = new Date(yyyy, mm - 1, dd, 0, 0, 0, 0).getTime();
      const dayEndMs = new Date(yyyy, mm - 1, dd, 23, 59, 59, 999).getTime();

      const res = await fetch(
        `/api/recordings/timeline?startTime=${dayStartMs}&endTime=${dayEndMs}`
      );
      if (res.ok) {
        const data = await res.json();
        const daySegs: RecordingSegment[] = data.segments || [];
        const dayEvts: AIEvent[] = data.events || [];
        setSegments(daySegs);
        setEvents(dayEvts);
        if (Array.isArray(data.days)) setRecordingDays(data.days);

        // Anchor playhead to latest AI event or latest segment on that date (or noon if empty)
        const latestEvt = dayEvts.length > 0 ? dayEvts[0].timestamp : 0;
        const latestSeg = daySegs.length > 0 ? daySegs[daySegs.length - 1].end_time : 0;
        const anchor = Math.max(latestEvt, latestSeg);
        setPlayheadTimestampMs(
          anchor >= dayStartMs && anchor <= dayEndMs
            ? anchor
            : dayStartMs + 12 * 60 * 60 * 1000
        );
      }
    } catch (err) {
      console.error('Failed to load timeline for date:', err);
    }
  }, []);

  // WebSocket Real-Time Telemetry & AI Event Listener
  useEffect(() => {
    let ws: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let unmounted = false;

    const connectWs = () => {
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      ws = new WebSocket(`${proto}//${window.location.host}/ws`);

      ws.onopen = () => {
        void fetchInitialData();
      };

      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data) as WSMessage;
          switch (msg.type) {
            case 'INIT_STATE':
              setTelemetryMap(msg.telemetry);
              setHealth(msg.health);
              break;
            case 'CAMERA_TELEMETRY':
              setTelemetryMap(msg.telemetry);
              break;
            case 'SYSTEM_HEALTH':
              setHealth(msg.health);
              break;
            case 'AI_EVENT_NEW':
              if (!selectedDateRef.current) {
                setEvents((prev) => [msg.event, ...prev.filter((e) => e.id !== msg.event.id)]);
                setPlayheadTimestampMs(Date.now());
              }
              break;
            case 'AI_EVENT_UPDATED':
              setEvents((prev) =>
                prev.map((e) => (e.id === msg.event.id ? msg.event : e))
              );
              break;
            case 'LIVE_DETECTIONS':
              setTelemetryMap((prev) => {
                const existing = prev[msg.cameraId];
                if (!existing) return prev;
                return {
                  ...prev,
                  [msg.cameraId]: {
                    ...existing,
                    isMotionActive: msg.detections.length > 0,
                    activeDetections: msg.detections,
                  },
                };
              });
              break;
            case 'SEGMENT_ADDED':
              if (!selectedDateRef.current) {
                setSegments((prev) => {
                  const filtered = prev.filter((s) => s.id !== msg.segment.id);
                  return [...filtered, msg.segment].sort((a, b) => a.start_time - b.start_time);
                });
                setPlayheadTimestampMs(Date.now());
              }
              break;
            case 'NOTIFICATION':
              addToast(msg.level, msg.title, msg.message);
              break;
          }
        } catch {
          // ignore malformed ws message
        }
      };

      ws.onclose = () => {
        if (!unmounted) {
          reconnectTimer = setTimeout(connectWs, 3000);
        }
      };
    };

    connectWs();

    return () => {
      unmounted = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (ws) ws.close();
    };
  }, [addToast]);

  // Synchronized Timeline Scrubbing Handler
  const handleSeekToTimestamp = async (cameraId: string, timestampMs: number) => {
    setSelectedCameraId(cameraId);
    try {
      const res = await fetch(
        `/api/recordings/seek?cameraId=${encodeURIComponent(cameraId)}&timestamp=${Math.round(
          timestampMs
        )}`
      );
      if (!res.ok) {
        addToast('warning', 'No Segment Found', 'No recorded segment exists near that timestamp.');
        return;
      }

      const data = (await res.json()) as {
        segment: RecordingSegment;
        offsetSeconds: number;
        nextSegment: RecordingSegment | null;
      };

      pendingOffsetSecRef.current = data.offsetSeconds;
      setActiveSegment(data.segment);
      setNextSegment(data.nextSegment);
      setIsPlayingArchive(true);
      setIsArchivePaused(false);
      setPlayheadTimestampMs(
        data.segment.start_time + Math.round(data.offsetSeconds * 1000)
      );
    } catch (err) {
      console.error('Seek error:', err);
    }
  };

  // Apply offsetSeconds and playbackRate when archive video loads
  const handleArchiveVideoLoadedMetadata = () => {
    const v = archiveVideoRef.current;
    if (!v) return;
    v.playbackRate = playbackSpeed;
    if (pendingOffsetSecRef.current > 0 && pendingOffsetSecRef.current < v.duration) {
      v.currentTime = pendingOffsetSecRef.current;
    }
    pendingOffsetSecRef.current = 0;
    void v.play().catch(() => {});
  };

  const handleArchiveTimeUpdate = () => {
    const v = archiveVideoRef.current;
    if (!v || !activeSegment) return;
    setPlayheadTimestampMs(
      activeSegment.start_time + Math.round(v.currentTime * 1000)
    );
  };

  // Seamless Sequential Segment Transition on Ended
  const handleArchiveSegmentEnded = async () => {
    if (nextSegment) {
      pendingOffsetSecRef.current = 0;
      const upcoming = nextSegment;
      setActiveSegment(upcoming);
      // Fetch the next sequential segment after upcoming
      try {
        const res = await fetch(
          `/api/recordings/seek?cameraId=${encodeURIComponent(
            upcoming.camera_id
          )}&timestamp=${upcoming.end_time + 2000}`
        );
        if (res.ok) {
          const data = await res.json();
          if (data.segment && data.segment.id !== upcoming.id) {
            setNextSegment(data.segment);
          } else {
            setNextSegment(null);
          }
        }
      } catch {
        setNextSegment(null);
      }
    } else {
      setIsArchivePaused(true);
    }
  };

  const handleTogglePlayPauseArchive = () => {
    const v = archiveVideoRef.current;
    if (!v) return;
    if (v.paused) {
      void v.play();
      setIsArchivePaused(false);
    } else {
      v.pause();
      setIsArchivePaused(true);
    }
  };

  const handleChangePlaybackSpeed = (spd: number) => {
    setPlaybackSpeed(spd);
    if (archiveVideoRef.current) {
      archiveVideoRef.current.playbackRate = spd;
    }
  };

  const handleToggleLockSegment = async (seg: RecordingSegment) => {
    const res = await fetch(`/api/recordings/segments/${encodeURIComponent(seg.id)}/lock`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isLocked: !seg.is_locked }),
    });
    if (res.ok) {
      const data = await res.json();
      const updated = data.segment as RecordingSegment;
      setSegments((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
      if (activeSegment?.id === updated.id) {
        setActiveSegment(updated);
      }
      addToast(
        'info',
        updated.is_locked ? 'Segment Bookmarked & Locked' : 'Segment Unlocked',
        updated.is_locked
          ? 'Protected from Circular Storage Manager deletion.'
          : 'Segment can be recycled by storage quota.'
      );
    }
  };

  const handleToggleManualRecord = async (cameraId: string) => {
    const res = await fetch(`/api/cameras/${encodeURIComponent(cameraId)}/record`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    if (res.ok) {
      const data = await res.json();
      addToast(
        'info',
        data.isManualRecording ? 'Manual Recording Started' : 'Manual Recording Stopped',
        `Direct-to-Disk stream copy updated for ${cameraId}`
      );
    }
  };

  const handleSimulateAiEvent = async (cameraId: string, objectClass: string) => {
    const res = await fetch(`/api/cameras/${encodeURIComponent(cameraId)}/simulate-event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ objectClass }),
    });
    if (res.ok) {
      const data = await res.json();
      if (!data.triggered && data.reason) {
        addToast('warning', 'Blocked by Polygon Zone', data.reason);
      }
    }
  };

  const handleReorderCameras = (newOrderIds: string[]) => {
    setCameras((prev) => {
      const map = new Map(prev.map((c) => [c.id, c]));
      return newOrderIds.map((id) => map.get(id)!).filter(Boolean);
    });
  };

  const handleSaveCamera = async (
    cameraPatch: Partial<Camera> & { id?: string },
    isNew: boolean
  ) => {
    if (isNew) {
      const res = await fetch('/api/cameras', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cameraPatch),
      });
      if (res.ok) {
        const data = await res.json();
        setCameras((prev) => [...prev, data.camera]);
      }
    } else if (cameraPatch.id) {
      const res = await fetch(`/api/cameras/${encodeURIComponent(cameraPatch.id)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cameraPatch),
      });
      if (res.ok) {
        const data = await res.json();
        setCameras((prev) =>
          prev.map((c) => (c.id === data.camera.id ? data.camera : c))
        );
      }
    }
    await fetchInitialData();
  };

  const handleDeleteCamera = async (cameraId: string) => {
    const res = await fetch(`/api/cameras/${encodeURIComponent(cameraId)}`, {
      method: 'DELETE',
    });
    if (res.ok) {
      setCameras((prev) => prev.filter((c) => c.id !== cameraId));
      setIsSettingsOpen(false);
    }
  };

  const handleSaveSettings = async (patch: Partial<SystemSettings>) => {
    const res = await fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    if (res.ok) {
      const data = await res.json();
      setSettings(data.settings);
    }
  };

  const unacknowledgedCount = events.filter((e) => !e.is_acknowledged).length;

  return (
    <div className="flex flex-col w-screen h-screen bg-[#0B0F17] text-slate-100 overflow-hidden">
      {/* Top Navigation & Telemetry Header */}
      <header className="h-14 px-4 bg-[#111827] border-b border-slate-800/90 flex items-center justify-between gap-4 shrink-0 select-none">
        {/* Left: Brand & Engine Status Badges */}
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-emerald-500/15 border border-emerald-500/40 flex items-center justify-center text-emerald-400 shadow-[0_0_15px_rgba(16,185,129,0.2)]">
              <Shield className="w-4 h-4" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="font-bold text-sm tracking-tight text-white">
                  Inksight
                </span>
                <span className="px-1.5 py-0.5 rounded bg-emerald-500/20 border border-emerald-500/40 text-emerald-300 font-mono text-[10px] font-bold">
                  4K AI NVR
                </span>
                <span
                  className="px-1.5 py-0.5 rounded bg-slate-800/90 border border-slate-700 text-slate-300 font-mono text-[10px]"
                  title="Inksight Release Version"
                >
                  v{__APP_VERSION__}
                </span>
              </div>
            </div>
          </div>

          {/* Real-time Subsystem Telemetry Pills */}
          <div className="hidden lg:flex items-center gap-2 pl-2 border-l border-slate-800 text-[11px] font-mono">
            <div
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-slate-900 border border-slate-800"
              title="go2rtc Ingestion & MSE/WebRTC Restream Engine (Port 1984 / RTSP 8554)"
            >
              <Server className="w-3.5 h-3.5 text-emerald-400" />
              <span className="text-slate-300">go2rtc:</span>
              <span className={health?.go2rtcOnline ? 'text-emerald-400' : 'text-sky-400'}>
                {health?.go2rtcOnline ? '1984/8554 OK' : 'DIRECT RTSP'}
              </span>
            </div>

            <div
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-slate-900 border border-slate-800"
              title="Direct-to-Disk Zero-Transcode FFmpeg Segment Recorders"
            >
              <Activity className="w-3.5 h-3.5 text-red-400" />
              <span className="text-slate-300">Recorders:</span>
              <span className="text-emerald-400">
                {health?.activeRecorders ?? cameras.length} Active
              </span>
            </div>

            <div
              onClick={() => {
                setSettingsTab('ai');
                setIsSettingsOpen(true);
              }}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-slate-900 hover:bg-slate-800 border border-slate-800 cursor-pointer transition"
              title="AI Object Verification Engine"
            >
              <Cpu className="w-3.5 h-3.5 text-amber-400" />
              <span className="text-slate-300">AI:</span>
              <span className="text-amber-300">
                {health?.codeProjectOnline
                  ? `ONLINE (${health.codeProjectLatencyMs ?? 12}ms)`
                  : 'READY'}
              </span>
            </div>

            <div
              onClick={() => {
                setSettingsTab('storage');
                setIsSettingsOpen(true);
              }}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-slate-900 hover:bg-slate-800 border border-slate-800 cursor-pointer transition"
              title="Circular Storage Manager & Disk Quota"
            >
              <HardDrive className="w-3.5 h-3.5 text-sky-400" />
              <span className="text-slate-300">Disk:</span>
              <span className="text-sky-300">{health?.diskUsagePercent ?? 42}%</span>
            </div>
          </div>
        </div>

        {/* Center: Dynamic Grid Layout Selector (1, 2, 4, 6, 9, 16) */}
        <div className="flex items-center gap-1 bg-[#0B0F17] border border-slate-800 rounded-lg p-1">
          <Grid className="w-3.5 h-3.5 text-slate-500 mx-1.5" />
          {(
            [
              { size: 1, label: '1x1 4K' },
              { size: 2, label: '1x2' },
              { size: 4, label: '2x2' },
              { size: 6, label: '1+5' },
              { size: 9, label: '3x3' },
              { size: 16, label: '4x4' },
            ] as Array<{ size: GridLayoutSize; label: string }>
          ).map((item) => {
            const active =
              !isPlayingArchive &&
              ((soloCameraId && item.size === 1) || (!soloCameraId && gridSize === item.size));
            return (
              <button
                key={item.size}
                type="button"
                onClick={() => {
                  setIsPlayingArchive(false);
                  if (item.size === 1) {
                    setSoloCameraId(selectedCameraId || cameras[0]?.id || null);
                  } else {
                    setSoloCameraId(null);
                    setGridSize(item.size);
                  }
                }}
                className={`px-2.5 py-1 rounded text-xs font-mono font-semibold transition ${
                  active
                    ? 'bg-emerald-500 text-slate-950 font-bold shadow'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
                }`}
              >
                {item.label}
              </button>
            );
          })}
        </div>

        {/* Right: HUD Overlay Toggles, Zone Studio, Settings & AI Drawer Button */}
        <div className="flex items-center gap-2">
          {/* HUD / Zones / AI Boxes Overlay Toggles */}
          <div className="hidden md:flex items-center bg-[#0B0F17] border border-slate-800 rounded-lg p-1 gap-1 text-xs">
            <button
              type="button"
              onClick={() => setShowTelemetryHud(!showTelemetryHud)}
              className={`px-2 py-1 rounded font-mono text-[11px] transition ${
                showTelemetryHud
                  ? 'bg-slate-800 text-emerald-400 border border-slate-700'
                  : 'text-slate-500 hover:text-slate-300'
              }`}
              title="Toggle Stream Codec/Bitrate Telemetry HUD"
            >
              HUD
            </button>
            <button
              type="button"
              onClick={() => setShowZonesOverlay(!showZonesOverlay)}
              className={`px-2 py-1 rounded font-mono text-[11px] transition flex items-center gap-1 ${
                showZonesOverlay
                  ? 'bg-slate-800 text-emerald-400 border border-slate-700'
                  : 'text-slate-500 hover:text-slate-300'
              }`}
              title="Toggle Polygon Motion/AI Zones Overlay"
            >
              <Crosshair className="w-3 h-3" />
              <span>Zones</span>
            </button>
            <button
              type="button"
              onClick={() => setShowBoxesOverlay(!showBoxesOverlay)}
              className={`px-2 py-1 rounded font-mono text-[11px] transition flex items-center gap-1 ${
                showBoxesOverlay
                  ? 'bg-slate-800 text-emerald-400 border border-slate-700'
                  : 'text-slate-500 hover:text-slate-300'
              }`}
              title="Toggle Live AI Bounding Boxes Overlay"
            >
              <Eye className="w-3 h-3" />
              <span>Boxes</span>
            </button>
          </div>

          {/* Add Camera Quick Button */}
          <button
            type="button"
            onClick={() => {
              setZoneEditorCameraId('new');
              setSettingsTab('cameras');
              setIsSettingsOpen(true);
            }}
            className="hidden sm:flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-500/30 text-emerald-300 text-xs font-semibold transition"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>Add Camera</span>
          </button>

          {/* Settings & Zone Studio Button */}
          <button
            type="button"
            onClick={() => {
              setSettingsTab('cameras');
              setIsSettingsOpen(true);
            }}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 text-xs font-semibold transition"
          >
            <Settings className="w-3.5 h-3.5 text-emerald-400" />
            <span>Settings</span>
          </button>

          {/* Toggle AI Events Drawer */}
          <button
            type="button"
            onClick={() => setShowEventsDrawer(!showEventsDrawer)}
            className={`relative p-2 rounded-lg border transition ${
              showEventsDrawer
                ? 'bg-slate-800 border-emerald-500/50 text-emerald-400'
                : 'bg-slate-900 border-slate-800 text-slate-400 hover:text-white'
            }`}
            title="Toggle AI Detections Drawer"
          >
            {showEventsDrawer ? (
              <PanelRightClose className="w-4 h-4" />
            ) : (
              <PanelRightOpen className="w-4 h-4" />
            )}
            {unacknowledgedCount > 0 && (
              <span className="absolute -top-1 -right-1 px-1.5 py-0.2 rounded-full bg-red-500 text-white font-mono text-[9px] font-bold">
                {unacknowledgedCount}
              </span>
            )}
          </button>
        </div>
      </header>

      {/* Main Middle Area: Matrix / Forensic Archive Player + Right AI Events Drawer */}
      <div className="flex-1 flex min-h-0 relative overflow-hidden">
        {/* Center Viewport */}
        <main className="flex-1 h-full min-w-0 relative flex flex-col">
          {!isPlayingArchive ? (
            <LiveMatrixView
              cameras={cameras}
              telemetryMap={telemetryMap}
              gridSize={gridSize}
              soloCameraId={soloCameraId}
              selectedCameraId={selectedCameraId}
              showTelemetryHud={showTelemetryHud}
              showZonesOverlay={showZonesOverlay}
              showBoxesOverlay={showBoxesOverlay}
              onSelectCamera={(camId) => setSelectedCameraId(camId)}
              onToggleSoloCamera={(camId) => {
                setSelectedCameraId(camId);
                setSoloCameraId((prev) => (prev === camId ? null : camId));
              }}
              onReorderCameras={handleReorderCameras}
              onToggleManualRecord={(camId) => void handleToggleManualRecord(camId)}
              onSimulateAiEvent={(camId, cls) => void handleSimulateAiEvent(camId, cls)}
              onOpenZoneEditor={(cam) => {
                setZoneEditorCameraId(cam.id);
                setSettingsTab('zones');
                setIsSettingsOpen(true);
              }}
              onAddFirstCamera={() => {
                setSettingsTab('cameras');
                setIsSettingsOpen(true);
              }}
            />
          ) : (
            /* Forensic Byte-Range Archive Playback Viewport */
            <div className="relative w-full h-full bg-[#06090F] flex flex-col">
              {/* Dedicated Archive Top Bar — stacked above video so 0% of camera view or OSD timestamp is covered */}
              <div className="shrink-0 px-3 py-2 bg-[#090D16] border-b border-slate-800/90 z-20 flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <Film aria-hidden="true" className="w-4 h-4 text-emerald-400 shrink-0" />
                  <span className="text-xs font-bold text-white">
                    FORENSIC TIMELINE PLAYBACK —{' '}
                    {activeSegment?.camera_name || selectedCameraId}
                  </span>
                  <span className="px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-300 font-mono text-[10px]">
                    HTTP 206 BYTE-RANGE
                  </span>
                  {nextSegment && (
                    <span className="text-[10px] font-mono text-slate-400">
                      • Next Segment Preloaded
                    </span>
                  )}
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  {activeSegment && (
                    <>
                      <button
                        type="button"
                        aria-pressed={Boolean(activeSegment.is_locked)}
                        onClick={() => void handleToggleLockSegment(activeSegment)}
                        className="min-h-7 min-w-7 flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-mono font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 focus-visible:ring-offset-2 focus-visible:ring-offset-[#090D16] bg-slate-900 border-slate-700 text-slate-200 hover:bg-slate-800 aria-[pressed=true]:bg-amber-500/20 aria-[pressed=true]:border-amber-500/60 aria-[pressed=true]:text-amber-300"
                      >
                        <Lock aria-hidden="true" className="w-3.5 h-3.5" />
                        <span>LOCK SEGMENT</span>
                        {activeSegment.is_locked && (
                          <span
                            aria-hidden="true"
                            className="px-1.5 py-0.2 rounded bg-amber-400/25 text-[9px] uppercase font-bold"
                          >
                            ON
                          </span>
                        )}
                      </button>

                      <a
                        href={`/api/recordings/stream/${encodeURIComponent(
                          activeSegment.id
                        )}?download=1`}
                        download
                        className="min-h-7 min-w-7 flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 border border-slate-700 text-slate-200 text-xs font-mono transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 focus-visible:ring-offset-2 focus-visible:ring-offset-[#090D16]"
                      >
                        <Download aria-hidden="true" className="w-3.5 h-3.5" />
                        <span>Download MP4</span>
                      </a>
                    </>
                  )}

                  <button
                    type="button"
                    onClick={() => setIsPlayingArchive(false)}
                    className="min-h-7 min-w-7 flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold text-xs shadow-lg transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300 focus-visible:ring-offset-2 focus-visible:ring-offset-[#090D16]"
                  >
                    <Radio aria-hidden="true" className="w-3.5 h-3.5" />
                    <span>Return to Live Matrix</span>
                  </button>
                </div>
              </div>

              {/* Unobstructed HTTP 206 Partial Content Video Viewport */}
              <div className="flex-1 min-h-0 w-full relative bg-black">
                {activeSegment && (
                  <video
                    ref={archiveVideoRef}
                    key={activeSegment.id}
                    src={`/api/recordings/stream/${encodeURIComponent(activeSegment.id)}`}
                    controls
                    autoPlay
                    onLoadedMetadata={handleArchiveVideoLoadedMetadata}
                    onTimeUpdate={handleArchiveTimeUpdate}
                    onEnded={() => void handleArchiveSegmentEnded()}
                    className="w-full h-full object-contain"
                  />
                )}
              </div>

              {/* Preload link for next sequential segment */}
              {nextSegment && (
                <link
                  rel="preload"
                  as="video"
                  href={`/api/recordings/stream/${encodeURIComponent(nextSegment.id)}`}
                />
              )}
            </div>
          )}

          {/* Floating Live Toast Notifications */}
          <div className="fixed bottom-24 left-4 z-50 space-y-2 pointer-events-none max-w-sm">
            {toasts.map((t) => (
              <div
                key={t.id}
                className={`pointer-events-auto flex items-start gap-2.5 p-3 rounded-lg border shadow-2xl backdrop-blur-md text-xs ${
                  t.level === 'alert'
                    ? 'bg-red-950/90 border-red-500/60 text-red-100'
                    : t.level === 'error'
                      ? 'bg-red-950/90 border-red-500/60 text-red-200'
                      : t.level === 'warning'
                        ? 'bg-amber-950/90 border-amber-500/60 text-amber-100'
                        : 'bg-slate-900/95 border-emerald-500/50 text-slate-100'
                }`}
              >
                <Bell className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                <div>
                  <div className="font-bold">{t.title}</div>
                  <div className="text-[11px] opacity-90">{t.message}</div>
                </div>
              </div>
            ))}
          </div>
        </main>

        {/* Right Sidebar: Filterable AI Detections Drawer */}
        {showEventsDrawer && (
          <EventsDrawer
            events={events}
            cameras={cameras}
            recordingDays={recordingDays}
            selectedDate={selectedDate}
            onSelectDate={(d) => void handleSelectDate(d)}
            selectedCameraFilter={drawerCameraFilter}
            onCameraFilterChange={setDrawerCameraFilter}
            onJumpToTimeline={(evt) => {
              void handleSeekToTimestamp(evt.camera_id, evt.timestamp);
            }}
            onAcknowledgeEvent={async (eventId) => {
              const res = await fetch(
                `/api/events/${encodeURIComponent(eventId)}/acknowledge`,
                { method: 'POST' }
              );
              if (res.ok) {
                const data = await res.json();
                setEvents((prev) =>
                  prev.map((e) => (e.id === eventId ? data.event : e))
                );
              }
            }}
            onAcknowledgeAll={async () => {
              const res = await fetch('/api/events/acknowledge-all', { method: 'POST' });
              if (res.ok) {
                setEvents((prev) => prev.map((e) => ({ ...e, is_acknowledged: true })));
              }
            }}
            onDeleteEvent={async (eventId) => {
              const res = await fetch(`/api/events/${encodeURIComponent(eventId)}`, {
                method: 'DELETE',
              });
              if (res.ok) {
                setEvents((prev) => prev.filter((e) => e.id !== eventId));
              }
            }}
            onSimulateEvent={(camId, cls) => void handleSimulateAiEvent(camId, cls)}
          />
        )}
      </div>

      {/* Bottom Synchronized Timeline Scrubber */}
      <TimelineScrubber
        cameras={cameras}
        selectedCameraId={selectedCameraId}
        segments={segments}
        events={events}
        recordingDays={recordingDays}
        selectedDate={selectedDate}
        onSelectDate={(d) => void handleSelectDate(d)}
        activeSegment={activeSegment}
        isPlayingArchive={isPlayingArchive}
        isPaused={isArchivePaused}
        playbackSpeed={playbackSpeed}
        playheadTimestampMs={playheadTimestampMs}
        onSelectCamera={(camId) => setSelectedCameraId(camId)}
        onSeekTimestamp={(camId, ts) => void handleSeekToTimestamp(camId, ts)}
        onSelectEvent={(evt) => {
          void handleSeekToTimestamp(evt.camera_id, evt.timestamp);
        }}
        onTogglePlayPause={handleTogglePlayPauseArchive}
        onChangeSpeed={handleChangePlaybackSpeed}
        onToggleLockSegment={(seg) => void handleToggleLockSegment(seg)}
        onExitArchiveMode={() => {
          setIsPlayingArchive(false);
          if (selectedDate !== null) {
            void handleSelectDate(null);
          }
        }}
      />

      {/* Settings & Polygon Zone Studio Modal */}
      <SettingsModal
        isOpen={isSettingsOpen}
        initialTab={settingsTab}
        initialZoneCameraId={zoneEditorCameraId}
        cameras={cameras}
        settings={settings}
        health={health}
        go2rtcYaml={go2rtcYaml}
        onClose={() => setIsSettingsOpen(false)}
        onSaveCamera={handleSaveCamera}
        onDeleteCamera={handleDeleteCamera}
        onSaveSettings={handleSaveSettings}
        onRefreshSettings={fetchInitialData}
      />
    </div>
  );
};


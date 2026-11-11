import React, { useRef, useState, useMemo, useEffect } from 'react';
import {
  Play,
  Pause,
  SkipBack,
  SkipForward,
  Lock,
  Unlock,
  Download,
  Radio,
  Clock,
  ZoomIn,
  Film,
  Calendar,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
} from 'lucide-react';
import { AIEvent, Camera, RecordingDaySummary, RecordingSegment } from '@shared/types';

export type TimelineScale = '24h' | '6h' | '1h' | '15m' | '5m';

const SCALE_MS: Record<TimelineScale, number> = {
  '24h': 24 * 60 * 60 * 1000,
  '6h': 6 * 60 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  '15m': 15 * 60 * 1000,
  '5m': 5 * 60 * 1000,
};

interface TimelineScrubberProps {
  cameras: Camera[];
  selectedCameraId: string;
  segments: RecordingSegment[];
  events: AIEvent[];
  recordingDays?: RecordingDaySummary[];
  selectedDate: string | null;
  onSelectDate: (dateStr: string | null) => void;
  activeSegment: RecordingSegment | null;
  isPlayingArchive: boolean;
  isPaused: boolean;
  playbackSpeed: number;
  playheadTimestampMs: number;
  onSelectCamera: (cameraId: string) => void;
  onSeekTimestamp: (cameraId: string, timestampMs: number) => void;
  onSelectEvent: (event: AIEvent) => void;
  onTogglePlayPause: () => void;
  onChangeSpeed: (speed: number) => void;
  onToggleLockSegment: (segment: RecordingSegment) => void;
  onExitArchiveMode: () => void;
}

export const TimelineScrubber: React.FC<TimelineScrubberProps> = ({
  cameras,
  selectedCameraId,
  segments,
  events,
  recordingDays = [],
  selectedDate,
  onSelectDate,
  activeSegment,
  isPlayingArchive,
  isPaused,
  playbackSpeed,
  playheadTimestampMs,
  onSelectCamera,
  onSeekTimestamp,
  onSelectEvent,
  onTogglePlayPause,
  onChangeSpeed,
  onToggleLockSegment,
  onExitArchiveMode,
}) => {
  const [scale, setScale] = useState<TimelineScale>('1h');
  const [showAllCameraEvents, setShowAllCameraEvents] = useState<boolean>(true);
  const [hoverTimeMs, setHoverTimeMs] = useState<number | null>(null);
  const [hoverXPercent, setHoverXPercent] = useState<number>(0);
  const [showExportPanel, setShowExportPanel] = useState<boolean>(false);
  const [exportStartMs, setExportStartMs] = useState<number>(() => Date.now() - 120000);
  const [exportDurationSec, setExportDurationSec] = useState<number>(60);
  const [panOffsetMs, setPanOffsetMs] = useState<number>(0);
  const trackRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setPanOffsetMs(0);
    if (selectedDate) {
      setScale('24h');
    }
  }, [selectedDate]);

  const toLocalDateStr = (ms: number): string => {
    const d = new Date(ms);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  };

  const toLocalDateTimeInput = (ms: number): string => {
    const d = new Date(ms);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  };

  const stepCalendarDay = (deltaDays: number) => {
    const baseDateStr = selectedDate || toLocalDateStr(Date.now());
    const [yyyy, mm, dd] = baseDateStr.split('-').map(Number);
    const nextDate = new Date(yyyy, mm - 1, dd + deltaDays);
    const nextStr = toLocalDateStr(nextDate.getTime());
    const todayStr = toLocalDateStr(Date.now());
    if (nextStr >= todayStr) {
      onSelectDate(null);
    } else {
      onSelectDate(nextStr);
    }
  };

  const windowDurationMs = SCALE_MS[scale];
  const latestEventTs = events.length > 0 ? events[0].timestamp : 0;

  const { windowStartMs, windowEndMs } = useMemo(() => {
    if (selectedDate) {
      const [yyyy, mm, dd] = selectedDate.split('-').map(Number);
      const dayStart = new Date(yyyy, mm - 1, dd, 0, 0, 0, 0).getTime();
      const dayEnd = new Date(yyyy, mm - 1, dd, 23, 59, 59, 999).getTime();
      if (scale === '24h') {
        return {
          windowStartMs: dayStart + panOffsetMs,
          windowEndMs: dayEnd + panOffsetMs,
        };
      }
      const center = Math.max(dayStart, Math.min(dayEnd, playheadTimestampMs)) + panOffsetMs;
      return {
        windowStartMs: center - windowDurationMs / 2,
        windowEndMs: center + windowDurationMs / 2,
      };
    }

    const nowMs = Math.max(Date.now(), playheadTimestampMs, latestEventTs);
    const end = nowMs + windowDurationMs * 0.02 + panOffsetMs;
    return {
      windowStartMs: end - windowDurationMs,
      windowEndMs: end,
    };
  }, [selectedDate, scale, panOffsetMs, playheadTimestampMs, windowDurationMs, latestEventTs]);

  const jumpToAdjacentAlert = (direction: 'prev' | 'next') => {
    const pool = events
      .filter((e) => showAllCameraEvents || e.camera_id === selectedCameraId)
      .sort((a, b) => a.timestamp - b.timestamp);
    if (pool.length === 0) return;

    if (direction === 'prev') {
      const candidates = pool.filter((e) => e.timestamp < playheadTimestampMs - 1500);
      const target = candidates.length > 0 ? candidates[candidates.length - 1] : pool[pool.length - 1];
      onSelectEvent(target);
    } else {
      const candidates = pool.filter((e) => e.timestamp > playheadTimestampMs + 1500);
      const target = candidates.length > 0 ? candidates[0] : pool[0];
      onSelectEvent(target);
    }
  };

  const cameraSegments = useMemo(
    () =>
      segments.filter(
        (s) =>
          s.camera_id === selectedCameraId &&
          s.end_time >= windowStartMs &&
          s.start_time <= windowEndMs
      ),
    [segments, selectedCameraId, windowStartMs, windowEndMs]
  );

  const cameraEvents = useMemo(
    () =>
      events.filter(
        (e) =>
          (showAllCameraEvents || e.camera_id === selectedCameraId) &&
          e.timestamp >= windowStartMs &&
          e.timestamp <= windowEndMs
      ),
    [events, showAllCameraEvents, selectedCameraId, windowStartMs, windowEndMs]
  );

  const timeTicks = useMemo(() => {
    const count = 8;
    const step = windowDurationMs / count;
    const ticks: Array<{ pct: number; label: string }> = [];
    for (let i = 0; i <= count; i++) {
      const t = windowStartMs + i * step;
      const dt = new Date(t);
      const hh = String(dt.getHours()).padStart(2, '0');
      const mm = String(dt.getMinutes()).padStart(2, '0');
      const ss = String(dt.getSeconds()).padStart(2, '0');
      ticks.push({
        pct: (i / count) * 100,
        label: scale === '5m' || scale === '15m' ? `${hh}:${mm}:${ss}` : `${hh}:${mm}`,
      });
    }
    return ticks;
  }, [windowStartMs, windowDurationMs, scale]);

  const getEventMarkerColor = (objClass: string): string => {
    const l = objClass.toLowerCase();
    if (l.includes('person')) return 'bg-[#EF4444] shadow-[0_0_8px_#EF4444]'; // Red: Person
    if (['dog', 'cat', 'pet', 'animal', 'bird'].some((k) => l.includes(k))) {
      return 'bg-[#F59E0B] shadow-[0_0_8px_#F59E0B]'; // Amber: Animal/Pet
    }
    if (['car', 'truck', 'bus', 'vehicle', 'motorcycle', 'bicycle'].some((k) => l.includes(k))) {
      return 'bg-[#3B82F6] shadow-[0_0_8px_#3B82F6]'; // Blue: Vehicle
    }
    return 'bg-[#A855F7] shadow-[0_0_8px_#A855F7]'; // Purple: Custom ONVIF/Webhook
  };

  const handleTrackMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect) return;
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    setHoverXPercent(ratio * 100);
    setHoverTimeMs(Math.round(windowStartMs + ratio * windowDurationMs));
  };

  const handleTrackClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect) return;
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const targetTimestamp = Math.round(windowStartMs + ratio * windowDurationMs);
    onSeekTimestamp(selectedCameraId, targetTimestamp);
  };

  const playheadPct = Math.max(
    0,
    Math.min(100, ((playheadTimestampMs - windowStartMs) / windowDurationMs) * 100)
  );

  return (
    <div className="w-full bg-[#0E1420] border-t border-slate-800/90 px-4 py-2.5 select-none flex flex-col gap-2">
      {/* Top Controls Row: Transport + Camera Selector + Legend + Time Scale Buttons */}
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
        {/* Left: Transport & Mode */}
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={isPlayingArchive ? onExitArchiveMode : undefined}
            className={`flex items-center gap-1.5 px-2.5 py-1 rounded font-mono font-bold text-[11px] transition ${
              !isPlayingArchive
                ? 'bg-emerald-500 text-slate-950 shadow-[0_0_12px_rgba(16,185,129,0.4)]'
                : 'bg-slate-800 text-slate-300 hover:bg-emerald-500/20 hover:text-emerald-300 border border-slate-700'
            }`}
            title="Switch to Live Matrix Stream"
          >
            <Radio className="w-3.5 h-3.5" />
            <span>{isPlayingArchive ? 'RETURN TO LIVE' : 'LIVE MATRIX'}</span>
          </button>

          {/* Camera Timeline Selector */}
          <select
            aria-label="Timeline Camera"
            value={selectedCameraId}
            onChange={(e) => onSelectCamera(e.target.value)}
            className="bg-slate-900 border border-slate-700/90 rounded px-2.5 py-1 text-xs font-medium text-slate-200 focus:outline-none focus:border-emerald-500"
          >
            {cameras.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>

          {cameras.length > 1 && (
            <button
              type="button"
              onClick={() => setShowAllCameraEvents((prev) => !prev)}
              className={`px-2 py-1 rounded border font-mono text-[10px] transition ${
                showAllCameraEvents
                  ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300'
                  : 'bg-slate-900 border-slate-800 text-slate-400 hover:text-slate-200'
              }`}
              title="Show AI alert markers from all cameras on the timeline track"
            >
              {showAllCameraEvents ? 'Alerts: All Cams' : 'Alerts: Selected Cam'}
            </button>
          )}

          {/* Playback Transport Controls */}
          <div className="flex items-center gap-1 bg-slate-900/90 border border-slate-800 rounded px-1.5 py-0.5">
            <button
              type="button"
              onClick={() => onSeekTimestamp(selectedCameraId, playheadTimestampMs - 10000)}
              className="p-1 text-slate-300 hover:text-white transition"
              title="Step Back 10 Seconds"
            >
              <SkipBack className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              onClick={() => {
                if (!isPlayingArchive) {
                  onSeekTimestamp(selectedCameraId, Date.now() - 120000);
                } else {
                  onTogglePlayPause();
                }
              }}
              className="p-1 text-emerald-400 hover:text-emerald-300 transition"
              title={isPlayingArchive && !isPaused ? 'Pause Playback' : 'Play Forensic Archive'}
            >
              {isPlayingArchive && !isPaused ? (
                <Pause className="w-3.5 h-3.5" />
              ) : (
                <Play className="w-3.5 h-3.5" />
              )}
            </button>
            <button
              type="button"
              onClick={() => onSeekTimestamp(selectedCameraId, playheadTimestampMs + 10000)}
              className="p-1 text-slate-300 hover:text-white transition"
              title="Step Forward 10 Seconds"
            >
              <SkipForward className="w-3.5 h-3.5" />
            </button>

            {/* Playback Speed */}
            {[0.5, 1, 2, 4].map((spd) => (
              <button
                key={spd}
                type="button"
                onClick={() => onChangeSpeed(spd)}
                className={`px-1.5 py-0.5 rounded font-mono text-[10px] transition ${
                  playbackSpeed === spd
                    ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {spd}x
              </button>
            ))}

            {/* Quick Prev / Next AI Event Jump Buttons */}
            <div className="h-3.5 w-px bg-slate-800 mx-0.5" />
            <button
              type="button"
              onClick={() => jumpToAdjacentAlert('prev')}
              className="flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-mono text-amber-300 hover:bg-amber-500/15 transition"
              title="Jump to Previous AI Alert on Timeline"
            >
              <ChevronsLeft className="w-3 h-3" />
              <span>Alert</span>
            </button>
            <button
              type="button"
              onClick={() => jumpToAdjacentAlert('next')}
              className="flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-mono text-amber-300 hover:bg-amber-500/15 transition"
              title="Jump to Next AI Alert on Timeline"
            >
              <span>Alert</span>
              <ChevronsRight className="w-3 h-3" />
            </button>
          </div>

          {/* Custom Time-Range Clip Export Button */}
          <button
            type="button"
            onClick={() => {
              if (!showExportPanel) {
                const anchor = isPlayingArchive ? playheadTimestampMs - 15000 : Date.now() - 90000;
                setExportStartMs(anchor);
              }
              setShowExportPanel((prev) => !prev);
            }}
            className={`flex items-center gap-1 px-2.5 py-1 rounded border text-[11px] font-mono transition ${
              showExportPanel
                ? 'bg-emerald-500 text-slate-950 border-emerald-400 font-bold'
                : 'bg-slate-900 border-slate-700 text-emerald-300 hover:bg-emerald-500/15 hover:border-emerald-500/40'
            }`}
            title="Export custom time-range 4K MP4 clip (Direct-to-Disk lossless stitch)"
          >
            <Film className="w-3.5 h-3.5" />
            <span>EXPORT CLIP</span>
          </button>

          {/* Active Segment Actions (Bookmark Lock & Download) */}
          {activeSegment && (
            <div className="flex items-center gap-1.5 pl-1">
              <button
                type="button"
                onClick={() => onToggleLockSegment(activeSegment)}
                className={`flex items-center gap-1 px-2 py-1 rounded border text-[11px] font-mono transition ${
                  activeSegment.is_locked
                    ? 'bg-amber-500/20 border-amber-500/50 text-amber-300'
                    : 'bg-slate-900 border-slate-700 text-slate-300 hover:border-slate-600'
                }`}
                title="Lock/Bookmark segment so Circular Storage Manager never deletes it"
              >
                {activeSegment.is_locked ? (
                  <Lock className="w-3 h-3" />
                ) : (
                  <Unlock className="w-3 h-3" />
                )}
                <span>{activeSegment.is_locked ? 'LOCKED' : 'LOCK CLIP'}</span>
              </button>

              <a
                href={`/api/recordings/stream/${encodeURIComponent(activeSegment.id)}?download=1`}
                download
                className="flex items-center gap-1 px-2 py-1 rounded bg-slate-900 border border-slate-700 text-slate-300 hover:text-white text-[11px] font-mono transition"
                title="Download 60s Direct-to-Disk MP4 Segment"
              >
                <Download className="w-3 h-3" />
                <span>MP4</span>
              </a>
            </div>
          )}
        </div>

        {/* Center: Color-Coded AI Marker Legend */}
        <div className="hidden xl:flex items-center gap-3 text-[11px] text-slate-400 font-mono">
          <span className="flex items-center gap-1.5">
            <span className="w-2.5 h-2 rounded-sm bg-emerald-500/80 inline-block" />
            Continuous D2D
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-2 h-2.5 rounded-sm bg-[#EF4444] inline-block" />
            Person
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-2 h-2.5 rounded-sm bg-[#3B82F6] inline-block" />
            Vehicle
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-2 h-2.5 rounded-sm bg-[#F59E0B] inline-block" />
            Animal/Pet
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-2 h-2.5 rounded-sm bg-[#A855F7] inline-block" />
            ONVIF
          </span>
        </div>

        {/* Right: Multi-Day Calendar Date Picker, Playhead Timestamp & Zoomable Time Scales */}
        <div className="flex flex-wrap items-center gap-2">
          {/* Calendar Day Stepper & Date Picker */}
          <div className="flex items-center gap-1 bg-slate-900 border border-slate-800 rounded px-1.5 py-0.5">
            <button
              type="button"
              onClick={() => stepCalendarDay(-1)}
              className="p-0.5 text-slate-400 hover:text-white transition"
              title="Previous Calendar Day"
            >
              <ChevronLeft className="w-3.5 h-3.5" />
            </button>

            <Calendar className="w-3.5 h-3.5 text-emerald-400" />
            <input
              type="date"
              aria-label="Timeline Calendar Date"
              max={toLocalDateStr(Date.now())}
              value={selectedDate || toLocalDateStr(playheadTimestampMs)}
              onChange={(e) => {
                const val = e.target.value;
                if (!val || val >= toLocalDateStr(Date.now())) {
                  onSelectDate(null);
                } else {
                  onSelectDate(val);
                }
              }}
              className="bg-transparent font-mono text-[11px] text-slate-200 focus:outline-none cursor-pointer"
            />

            <button
              type="button"
              disabled={!selectedDate}
              onClick={() => stepCalendarDay(1)}
              className={`p-0.5 transition ${
                selectedDate
                  ? 'text-slate-300 hover:text-white'
                  : 'text-slate-700 cursor-not-allowed'
              }`}
              title="Next Calendar Day"
            >
              <ChevronRight className="w-3.5 h-3.5" />
            </button>

            {recordingDays.length > 0 && (
              <select
                aria-label="Jump to Recorded Day"
                value={selectedDate || ''}
                onChange={(e) => {
                  const val = e.target.value;
                  onSelectDate(val || null);
                }}
                className="bg-slate-950 border border-slate-800 rounded px-1.5 py-0.5 font-mono text-[10px] text-emerald-300 focus:outline-none"
                title="Dates with 4K recordings and AI events on disk"
              >
                <option value="">Live (Last 24h)</option>
                {recordingDays.map((d) => (
                  <option key={d.date} value={d.date}>
                    {d.date} ({d.segmentCount} clips • {d.eventCount} alerts)
                  </option>
                ))}
              </select>
            )}

            {(selectedDate || panOffsetMs !== 0) && (
              <button
                type="button"
                onClick={() => {
                  setPanOffsetMs(0);
                  onSelectDate(null);
                }}
                className="px-1.5 py-0.5 rounded bg-emerald-500/20 border border-emerald-500/40 text-emerald-300 font-mono text-[10px] font-bold hover:bg-emerald-500/30 transition"
                title="Reset Calendar & Pan to Live Today"
              >
                Today
              </button>
            )}
          </div>

          <div className="flex items-center gap-1.5 px-2.5 py-1 rounded bg-slate-950 border border-slate-800 font-mono text-[11px] text-emerald-400">
            <Clock className="w-3.5 h-3.5 text-slate-400" />
            <span>
              {selectedDate ? `${selectedDate} ` : ''}
              {new Date(playheadTimestampMs).toLocaleTimeString()}
            </span>
          </div>

          <div className="flex items-center bg-slate-900 border border-slate-800 rounded p-0.5">
            <button
              type="button"
              onClick={() => setPanOffsetMs((prev) => prev - Math.round(windowDurationMs * 0.25))}
              className="px-1.5 py-0.5 text-slate-400 hover:text-white font-mono text-[11px] transition"
              title="Pan Timeline Window Backward"
            >
              ‹
            </button>
            <ZoomIn className="w-3.5 h-3.5 text-slate-500 mx-1" />
            {(['24h', '6h', '1h', '15m', '5m'] as TimelineScale[]).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => {
                  setPanOffsetMs(0);
                  setScale(s);
                }}
                className={`px-2 py-0.5 rounded font-mono text-[11px] font-medium transition ${
                  scale === s
                    ? 'bg-emerald-500 text-slate-950 font-bold'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {s}
              </button>
            ))}
            <button
              type="button"
              onClick={() => setPanOffsetMs((prev) => prev + Math.round(windowDurationMs * 0.25))}
              className="px-1.5 py-0.5 text-slate-400 hover:text-white font-mono text-[11px] transition"
              title="Pan Timeline Window Forward"
            >
              ›
            </button>
          </div>
        </div>
      </div>

      {/* Custom Time-Range Clip Export Bar */}
      {showExportPanel && (
        <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 rounded-md bg-slate-900/95 border border-emerald-500/40 text-xs">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono font-bold text-emerald-400 text-[11px] uppercase tracking-wider flex items-center gap-1.5">
              <Film className="w-3.5 h-3.5" />
              Lossless 4K Clip Export:
            </span>

            <label className="flex items-center gap-1.5 text-slate-300 text-[11px]">
              <span className="text-slate-400">Start:</span>
              <input
                type="datetime-local"
                step="1"
                value={toLocalDateTimeInput(exportStartMs)}
                onChange={(e) => {
                  const parsed = new Date(e.target.value).getTime();
                  if (!Number.isNaN(parsed)) setExportStartMs(parsed);
                }}
                className="bg-slate-950 border border-slate-700 rounded px-2 py-0.5 font-mono text-[11px] text-white focus:outline-none focus:border-emerald-500"
              />
            </label>

            <button
              type="button"
              onClick={() => setExportStartMs(playheadTimestampMs - 15000)}
              className="px-2 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 font-mono text-[10px] border border-slate-700 transition"
              title="Set export start time to 15 seconds before current timeline playhead"
            >
              Use Playhead -15s
            </button>

            <div className="flex items-center gap-1 pl-1">
              <span className="text-slate-400 text-[11px]">Duration:</span>
              {[
                { label: '30s', sec: 30 },
                { label: '1m', sec: 60 },
                { label: '2m', sec: 120 },
                { label: '5m', sec: 300 },
                { label: '10m', sec: 600 },
                { label: '15m', sec: 900 },
              ].map((preset) => (
                <button
                  key={preset.sec}
                  type="button"
                  onClick={() => setExportDurationSec(preset.sec)}
                  className={`px-2 py-0.5 rounded font-mono text-[10px] transition ${
                    exportDurationSec === preset.sec
                      ? 'bg-emerald-500 text-slate-950 font-bold'
                      : 'bg-slate-950 text-slate-400 hover:text-white border border-slate-800'
                  }`}
                >
                  {preset.label}
                </button>
              ))}
            </div>
          </div>

          <div className="flex items-center gap-2">
            <a
              href={`/api/recordings/export-range?cameraId=${encodeURIComponent(selectedCameraId)}&startTimeMs=${exportStartMs}&endTimeMs=${exportStartMs + exportDurationSec * 1000}`}
              download
              className="flex items-center gap-1.5 px-3 py-1 rounded bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-mono font-bold text-[11px] shadow-[0_0_12px_rgba(16,185,129,0.3)] transition"
            >
              <Download className="w-3.5 h-3.5" />
              <span>DOWNLOAD 4K MP4 ({exportDurationSec >= 60 ? `${exportDurationSec / 60}m` : `${exportDurationSec}s`})</span>
            </a>

            <button
              type="button"
              onClick={() => setShowExportPanel(false)}
              className="px-2 py-1 rounded text-slate-400 hover:text-white text-[11px]"
            >
              Close
            </button>
          </div>
        </div>
      )}

      {/* Interactive Scrubbing Track */}
      <div
        ref={trackRef}
        onMouseMove={handleTrackMouseMove}
        onMouseLeave={() => setHoverTimeMs(null)}
        onClick={handleTrackClick}
        className="relative h-12 w-full rounded-md bg-[#080C14] border border-slate-800/90 cursor-pointer overflow-hidden group"
      >
        {/* Background Time Grid Lines & Labels */}
        {timeTicks.map((tick, idx) => (
          <div
            key={idx}
            style={{ left: `${tick.pct}%` }}
            className="absolute top-0 bottom-0 border-l border-slate-800/70 pointer-events-none"
          >
            <span className="absolute top-1 left-1.5 text-[10px] font-mono text-slate-500">
              {tick.label}
            </span>
          </div>
        ))}

        {/* Emerald Green Continuous Direct-to-Disk Recording Bars */}
        <div className="absolute left-0 right-0 bottom-2 h-5 bg-slate-900/60">
          {cameraSegments.map((seg) => {
            const leftPct = Math.max(
              0,
              ((seg.start_time - windowStartMs) / windowDurationMs) * 100
            );
            const rightPct = Math.min(
              100,
              ((seg.end_time - windowStartMs) / windowDurationMs) * 100
            );
            const widthPct = Math.max(0.25, rightPct - leftPct);

            return (
              <div
                key={seg.id}
                style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
                className={`absolute top-0.5 bottom-0.5 rounded-sm transition-opacity ${
                  seg.is_locked
                    ? 'bg-emerald-400 ring-1 ring-amber-400/80'
                    : 'bg-emerald-500/75 hover:bg-emerald-400'
                }`}
                title={`${new Date(seg.start_time).toLocaleTimeString()} (${seg.duration_sec}s)${
                  seg.is_locked ? ' [LOCKED BOOKMARK]' : ''
                }`}
              />
            );
          })}
        </div>

        {/* Color-Coded Vertical AI Event Markers */}
        {cameraEvents.map((evt) => {
          const leftPct = ((evt.timestamp - windowStartMs) / windowDurationMs) * 100;
          if (leftPct < 0 || leftPct > 100) return null;

          return (
            <button
              key={evt.id}
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onSelectEvent(evt);
                onSeekTimestamp(evt.camera_id, evt.timestamp);
              }}
              style={{ left: `${leftPct}%` }}
              className={`absolute top-1.5 bottom-1 w-1.5 -ml-0.5 rounded-full z-20 transition-transform hover:scale-x-150 ${getEventMarkerColor(
                evt.object_class
              )}`}
              title={`[${evt.camera_name || evt.camera_id}] ${evt.object_class.toUpperCase()} (${Math.round(
                evt.confidence
              )}%) @ ${new Date(evt.timestamp).toLocaleTimeString()}`}
            />
          );
        })}

        {/* Current Playhead Indicator */}
        <div
          style={{ left: `${playheadPct}%` }}
          className="absolute top-0 bottom-0 w-0.5 bg-white shadow-[0_0_10px_#FFFFFF] z-30 pointer-events-none"
        >
          <div className="w-2.5 h-2.5 -ml-1 rounded-full bg-emerald-400 border-2 border-white" />
        </div>

        {/* Hover Scrubbing Cursor & Tooltip */}
        {hoverTimeMs !== null && (
          <div
            style={{ left: `${hoverXPercent}%` }}
            className="absolute top-0 bottom-0 w-px bg-slate-400/60 z-30 pointer-events-none"
          >
            <div className="absolute -top-0.5 -translate-x-1/2 px-2 py-0.5 rounded bg-slate-900 border border-slate-700 text-[10px] font-mono text-slate-100 whitespace-nowrap shadow-lg flex items-center gap-1">
              <Film className="w-2.5 h-2.5 text-emerald-400" />
              <span>{new Date(hoverTimeMs).toLocaleTimeString()}</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};


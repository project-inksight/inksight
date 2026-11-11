import React, { useState, useRef, useEffect } from 'react';
import {
  ShieldAlert,
  CheckCircle2,
  Play,
  Download,
  Clock,
  Camera as CameraIcon,
  MailCheck,
  Filter,
  Trash2,
  X,
  Film,
  Sparkles,
  CheckCheck,
  Calendar,
} from 'lucide-react';
import { AIEvent, Camera, RecordingDaySummary } from '@shared/types';

interface EventsDrawerProps {
  events: AIEvent[];
  cameras: Camera[];
  recordingDays?: RecordingDaySummary[];
  selectedDate: string | null;
  onSelectDate: (dateStr: string | null) => void;
  selectedCameraFilter: string;
  onCameraFilterChange: (cameraId: string) => void;
  onJumpToTimeline: (event: AIEvent) => void;
  onAcknowledgeEvent: (eventId: string) => void;
  onAcknowledgeAll: () => void;
  onDeleteEvent: (eventId: string) => void;
  onSimulateEvent: (cameraId: string, objectClass: string) => void;
}

export const EventsDrawer: React.FC<EventsDrawerProps> = ({
  events,
  cameras,
  recordingDays = [],
  selectedDate,
  onSelectDate,
  selectedCameraFilter,
  onCameraFilterChange,
  onJumpToTimeline,
  onAcknowledgeEvent,
  onAcknowledgeAll,
  onDeleteEvent,
  onSimulateEvent,
}) => {
  const [classFilter, setClassFilter] = useState<string>('all');
  const [unackOnly, setUnackOnly] = useState<boolean>(false);
  const [inspectedEvent, setInspectedEvent] = useState<AIEvent | null>(null);
  const [inspectTab, setInspectTab] = useState<'snapshot' | 'clip'>('snapshot');
  const dialogRef = useRef<HTMLDialogElement | null>(null);

  // Open native modal dialog with showModal() and attach light-dismiss fallback per modern-web-guidance
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (inspectedEvent) {
      if (!dialog.open) {
        dialog.showModal();
      }
    } else if (dialog.open) {
      dialog.close();
    }
  }, [inspectedEvent]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    const handleClose = () => {
      dialog.returnValue = '';
      setInspectedEvent(null);
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
  }, []);

  const filteredEvents = events.filter((evt) => {
    if (selectedCameraFilter !== 'all' && evt.camera_id !== selectedCameraFilter) {
      return false;
    }
    if (unackOnly && evt.is_acknowledged) {
      return false;
    }
    if (classFilter !== 'all') {
      const l = evt.object_class.toLowerCase();
      if (classFilter === 'vehicle') {
        return ['car', 'truck', 'bus', 'vehicle', 'motorcycle', 'bicycle'].some((k) =>
          l.includes(k)
        );
      }
      if (classFilter === 'animal') {
        return ['dog', 'cat', 'pet', 'animal', 'bird'].some((k) => l.includes(k));
      }
      return l.includes(classFilter);
    }
    return true;
  });

  const getBadgeStyle = (objClass: string) => {
    const l = objClass.toLowerCase();
    if (l.includes('person')) {
      return 'bg-red-500/20 text-red-300 border-red-500/40';
    }
    if (['dog', 'cat', 'pet', 'animal'].some((k) => l.includes(k))) {
      return 'bg-amber-500/20 text-amber-300 border-amber-500/40';
    }
    if (['car', 'truck', 'bus', 'vehicle'].some((k) => l.includes(k))) {
      return 'bg-blue-500/20 text-blue-300 border-blue-500/40';
    }
    return 'bg-purple-500/20 text-purple-300 border-purple-500/40';
  };

  const getSnapshotUrl = (evt: AIEvent) => {
    const base = evt.snapshot_path.split(/[/\\]/).pop() || '';
    return `/api/media/snapshots/${encodeURIComponent(base)}?cls=${encodeURIComponent(evt.object_class)}`;
  };

  const getClipUrl = (evt: AIEvent, download = false) => {
    if (!evt.clip_path) return null;
    const base = evt.clip_path.split(/[/\\]/).pop() || '';
    return `/api/media/clips/${encodeURIComponent(base)}${download ? '?download=1' : ''}`;
  };

  return (
    <aside className="w-80 xl:w-96 h-full bg-[#111827] border-l border-slate-800/90 flex flex-col shrink-0 select-none">
      {/* Drawer Header */}
      <div className="p-3.5 border-b border-slate-800/90 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="p-1.5 rounded-lg bg-emerald-500/15 border border-emerald-500/30 text-emerald-400">
            <ShieldAlert className="w-4 h-4" />
          </div>
          <div>
            <h2 className="text-xs font-bold uppercase tracking-wider text-slate-100">
              AI Detections
            </h2>
            <p className="text-[11px] text-slate-400 font-mono">
              {filteredEvents.length} verified events
            </p>
          </div>
        </div>

        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => {
              const targetCam =
                selectedCameraFilter !== 'all'
                  ? selectedCameraFilter
                  : cameras[0]?.id || 'cam_north_driveway';
              onSimulateEvent(targetCam, 'person');
            }}
            className="flex items-center gap-1 px-2 py-1 rounded bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-500/30 text-emerald-300 text-[11px] font-mono transition"
            title="Trigger Live AI Verification & Pre/Post Clip Extraction"
          >
            <Sparkles className="w-3 h-3" />
            <span>Test AI</span>
          </button>

          <button
            type="button"
            onClick={onAcknowledgeAll}
            className="p-1.5 rounded bg-slate-800/80 hover:bg-slate-700 text-slate-300 transition"
            title="Acknowledge All Events"
          >
            <CheckCheck className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Filter Bar */}
      <div className="p-2.5 border-b border-slate-800/80 bg-[#0D131F] space-y-2">
        {/* Object Class Pills */}
        <div className="flex items-center gap-1 overflow-x-auto pb-0.5">
          {[
            { id: 'all', label: 'All' },
            { id: 'person', label: 'Person' },
            { id: 'vehicle', label: 'Vehicle' },
            { id: 'animal', label: 'Pet' },
            { id: 'onvif', label: 'ONVIF' },
          ].map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setClassFilter(tab.id)}
              className={`px-2.5 py-1 rounded text-[11px] font-medium transition whitespace-nowrap ${
                classFilter === tab.id
                  ? 'bg-emerald-500 text-slate-950 font-bold'
                  : 'bg-slate-900 text-slate-400 hover:text-slate-200 border border-slate-800'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Camera & Unacknowledged Filter */}
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Filter className="w-3 h-3 text-slate-500 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
            <select
              aria-label="Filter Events by Camera"
              value={selectedCameraFilter}
              onChange={(e) => onCameraFilterChange(e.target.value)}
              className="w-full bg-slate-900 border border-slate-800 rounded pl-7 pr-2 py-1 text-[11px] text-slate-200 focus:outline-none focus:border-emerald-500"
            >
              <option value="all">All Cameras ({cameras.length})</option>
              {cameras.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>

          <label className="flex items-center gap-1.5 text-[11px] text-slate-400 cursor-pointer whitespace-nowrap">
            <input
              type="checkbox"
              checked={unackOnly}
              onChange={(e) => setUnackOnly(e.target.checked)}
              className="rounded border-slate-700"
            />
            <span>Unread</span>
          </label>
        </div>

        {/* Synchronized Multi-Day Date Filter */}
        <div className="flex items-center justify-between gap-2 pt-0.5">
          <div className="relative flex-1 flex items-center">
            <Calendar className="w-3 h-3 text-emerald-400 absolute left-2.5 pointer-events-none" />
            <select
              aria-label="Filter Events by Date"
              value={selectedDate || ''}
              onChange={(e) => onSelectDate(e.target.value || null)}
              className="w-full bg-slate-900 border border-slate-800 rounded pl-7 pr-2 py-1 text-[11px] font-mono text-emerald-300 focus:outline-none focus:border-emerald-500"
            >
              <option value="">Live Window (Last 24 Hours)</option>
              {recordingDays.map((d) => (
                <option key={d.date} value={d.date}>
                  {d.date} ({d.eventCount} alerts • {d.segmentCount} clips)
                </option>
              ))}
            </select>
          </div>

          {selectedDate && (
            <button
              type="button"
              onClick={() => onSelectDate(null)}
              className="px-2 py-1 rounded bg-emerald-500/20 border border-emerald-500/40 text-emerald-300 font-mono text-[10px] font-bold hover:bg-emerald-500/30 transition shrink-0"
            >
              Live 24h
            </button>
          )}
        </div>
      </div>

      {/* Scrollable Event Cards */}
      <div className="flex-1 overflow-y-auto p-2.5 space-y-2.5">
        {filteredEvents.map((evt) => {
          const snapshotUrl = getSnapshotUrl(evt);
          const clipUrl = getClipUrl(evt);

          return (
            <div
              key={evt.id}
              className={`group rounded-lg bg-[#161F30] border transition overflow-hidden ${
                !evt.is_acknowledged
                  ? 'border-slate-700/90 shadow-md'
                  : 'border-slate-800/70 opacity-85 hover:opacity-100'
              }`}
            >
              {/* Annotated High-Res Snapshot Preview */}
              <div
                onClick={() => {
                  setInspectTab('snapshot');
                  setInspectedEvent(evt);
                }}
                className="relative h-36 w-full bg-slate-950 cursor-pointer overflow-hidden"
              >
                <img
                  src={snapshotUrl}
                  alt={`${evt.object_class} detection`}
                  loading="lazy"
                  className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                />

                {/* Top-Left Object Badge + Confidence */}
                <div className="absolute top-2 left-2 flex items-center gap-1.5">
                  <span
                    className={`px-2 py-0.5 rounded text-[10px] font-mono font-bold uppercase border backdrop-blur-md ${getBadgeStyle(
                      evt.object_class
                    )}`}
                  >
                    {evt.object_class} {Math.round(evt.confidence)}%
                  </span>
                  {evt.email_sent && (
                    <span
                      className="p-1 rounded bg-emerald-500/20 border border-emerald-500/40 text-emerald-300"
                      title="SMTP Video Email Dispatched"
                    >
                      <MailCheck className="w-3 h-3" />
                    </span>
                  )}
                </div>

                {/* Bottom Gradient & Play Clip Button */}
                <div className="absolute inset-x-0 bottom-0 p-2 bg-gradient-to-t from-slate-950/95 via-slate-950/50 to-transparent flex items-center justify-between">
                  <span className="text-[11px] font-medium text-slate-200 truncate flex items-center gap-1">
                    <CameraIcon className="w-3 h-3 text-emerald-400 shrink-0" />
                    {evt.camera_name || evt.camera_id}
                  </span>

                  {clipUrl && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setInspectTab('clip');
                        setInspectedEvent(evt);
                      }}
                      className="flex items-center gap-1 px-2 py-0.5 rounded bg-emerald-500 text-slate-950 font-mono font-bold text-[10px] hover:bg-emerald-400 transition"
                    >
                      <Play className="w-2.5 h-2.5 fill-current" />
                      <span>15s CLIP</span>
                    </button>
                  )}
                </div>
              </div>

              {/* Event Metadata & Action Footer */}
              <div className="p-2.5 flex items-center justify-between gap-2 text-[11px]">
                <div className="flex items-center gap-1 text-slate-400 font-mono">
                  <Clock className="w-3 h-3 text-slate-500" />
                  <span>{new Date(evt.timestamp).toLocaleTimeString()}</span>
                </div>

                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => onJumpToTimeline(evt)}
                    className="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-200 font-mono text-[10px] transition"
                    title="Scrub Timeline to Exact Event Second"
                  >
                    Scrub
                  </button>

                  {clipUrl && (
                    <a
                      href={getClipUrl(evt, true) || '#'}
                      download
                      className="p-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white transition"
                      title="Download Pre/Post Event MP4 Clip"
                    >
                      <Download className="w-3.5 h-3.5" />
                    </a>
                  )}

                  {!evt.is_acknowledged && (
                    <button
                      type="button"
                      onClick={() => onAcknowledgeEvent(evt.id)}
                      className="p-1 rounded bg-slate-800 hover:bg-emerald-500/20 text-slate-400 hover:text-emerald-400 transition"
                      title="Mark Acknowledged"
                    >
                      <CheckCircle2 className="w-3.5 h-3.5" />
                    </button>
                  )}

                  <button
                    type="button"
                    onClick={() => onDeleteEvent(evt.id)}
                    className="p-1 rounded bg-slate-800 hover:bg-red-500/20 text-slate-400 hover:text-red-400 transition"
                    title="Delete Event"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            </div>
          );
        })}

        {filteredEvents.length === 0 && (
          <div className="py-12 text-center text-slate-500 text-xs space-y-2">
            <ShieldAlert className="w-8 h-8 mx-auto text-slate-700" />
            <p>No AI detections match the current filter.</p>
          </div>
        )}
      </div>

      {/* Native <dialog closedby="any"> Forensic Lightbox Modal */}
      <dialog
        ref={dialogRef}
        {...({ closedby: 'any' } as React.DialogHTMLAttributes<HTMLDialogElement>)}
        aria-labelledby="forensic-event-dialog-title"
        className="w-full max-w-4xl rounded-xl bg-[#111827] text-slate-100 border border-slate-700 shadow-2xl p-0 overflow-hidden"
      >
        {inspectedEvent && (
          <div className="flex flex-col">
            <div className="px-5 py-3.5 bg-[#0B0F17] border-b border-slate-800 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <span
                  className={`px-2.5 py-1 rounded text-xs font-mono font-bold uppercase border ${getBadgeStyle(
                    inspectedEvent.object_class
                  )}`}
                >
                  {inspectedEvent.object_class} • {Math.round(inspectedEvent.confidence)}%
                </span>
                <div>
                  <h3 id="forensic-event-dialog-title" className="text-sm font-bold text-white">
                    {inspectedEvent.camera_name || inspectedEvent.camera_id}
                  </h3>
                  <p className="text-xs text-slate-400 font-mono">
                    {new Date(inspectedEvent.timestamp).toLocaleString()}
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <div className="flex bg-slate-900 border border-slate-800 rounded-lg p-0.5 text-xs">
                  <button
                    type="button"
                    onClick={() => setInspectTab('snapshot')}
                    className={`px-3 py-1 rounded-md font-medium transition ${
                      inspectTab === 'snapshot'
                        ? 'bg-emerald-500 text-slate-950 font-bold'
                        : 'text-slate-400 hover:text-white'
                    }`}
                  >
                    High-Res 4K Snapshot
                  </button>
                  <button
                    type="button"
                    onClick={() => setInspectTab('clip')}
                    className={`px-3 py-1 rounded-md font-medium flex items-center gap-1.5 transition ${
                      inspectTab === 'clip'
                        ? 'bg-emerald-500 text-slate-950 font-bold'
                        : 'text-slate-400 hover:text-white'
                    }`}
                  >
                    <Film className="w-3.5 h-3.5" />
                    <span>Pre/Post Event MP4 Clip</span>
                  </button>
                </div>

                <form method="dialog">
                  <button
                    type="submit"
                    aria-label="Close Forensic Inspector"
                    className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </form>
              </div>
            </div>

            <div className="bg-black aspect-video w-full flex items-center justify-center overflow-hidden">
              {inspectTab === 'snapshot' ? (
                <img
                  src={getSnapshotUrl(inspectedEvent)}
                  alt="Annotated 4K Snapshot"
                  className="max-w-full max-h-[65vh] object-contain"
                />
              ) : getClipUrl(inspectedEvent) ? (
                <video
                  key={inspectedEvent.id}
                  src={getClipUrl(inspectedEvent) || undefined}
                  controls
                  autoPlay
                  className="w-full h-full max-h-[65vh] object-contain"
                />
              ) : (
                <div className="text-slate-400 text-sm font-mono">
                  Extracting Pre/Post Event MP4 Clip...
                </div>
              )}
            </div>

            <div className="px-5 py-3 bg-[#0E1420] border-t border-slate-800 flex flex-wrap items-center justify-between gap-3 text-xs">
              <div className="font-mono text-slate-400">
                Bottom-Center Zone Anchor:{' '}
                <span className="text-emerald-400">
                  (
                  {(
                    (inspectedEvent.bounding_box.x1 + inspectedEvent.bounding_box.x2) /
                    2
                  ).toFixed(2)}
                  , {inspectedEvent.bounding_box.y2.toFixed(2)})
                </span>
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    const evt = inspectedEvent;
                    setInspectedEvent(null);
                    onJumpToTimeline(evt);
                  }}
                  className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 font-medium transition"
                >
                  Open in Timeline Scrubber
                </button>

                {getClipUrl(inspectedEvent) && (
                  <a
                    href={getClipUrl(inspectedEvent, true) || '#'}
                    download
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold transition"
                  >
                    <Download className="w-3.5 h-3.5" />
                    <span>Download MP4 Clip</span>
                  </a>
                )}
              </div>
            </div>
          </div>
        )}
      </dialog>
    </aside>
  );
};


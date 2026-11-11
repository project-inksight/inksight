import React, { useState, useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Maximize2,
  Minimize2,
  Volume2,
  VolumeX,
  Camera as CameraIcon,
  Circle,
  ZoomIn,
  ZoomOut,
  Sparkles,
  Crosshair,
  GripVertical,
  Expand,
  ShieldAlert,
  ShieldCheck,
  Plus,
  Radar,
  Cpu,
} from 'lucide-react';
import { Camera, CameraTelemetry } from '@shared/types';
import { Go2RtcPlayer } from './Go2RtcPlayer';

export type GridLayoutSize = 1 | 2 | 4 | 6 | 9 | 16;

interface LiveMatrixViewProps {
  cameras: Camera[];
  telemetryMap: Record<string, CameraTelemetry>;
  gridSize: GridLayoutSize;
  soloCameraId: string | null;
  selectedCameraId: string | null;
  showTelemetryHud: boolean;
  showZonesOverlay: boolean;
  showBoxesOverlay: boolean;
  onSelectCamera: (cameraId: string) => void;
  onToggleSoloCamera: (cameraId: string) => void;
  onReorderCameras: (newOrderIds: string[]) => void;
  onToggleManualRecord: (cameraId: string) => void;
  onSimulateAiEvent: (cameraId: string, objectClass: string) => void;
  onOpenZoneEditor: (camera: Camera) => void;
  onAddFirstCamera?: () => void;
}

export const LiveMatrixView: React.FC<LiveMatrixViewProps> = ({
  cameras,
  telemetryMap,
  gridSize,
  soloCameraId,
  selectedCameraId,
  showTelemetryHud,
  showZonesOverlay,
  showBoxesOverlay,
  onSelectCamera,
  onToggleSoloCamera,
  onReorderCameras,
  onToggleManualRecord,
  onSimulateAiEvent,
  onOpenZoneEditor,
  onAddFirstCamera,
}) => {
  const [mutedMap, setMutedMap] = useState<Record<string, boolean>>({});
  const [zoomMap, setZoomMap] = useState<Record<string, number>>({});
  const [draggedCamId, setDraggedCamId] = useState<string | null>(null);
  const [dragOverCamId, setDragOverCamId] = useState<string | null>(null);
  const [triggerMenuCamId, setTriggerMenuCamId] = useState<string | null>(null);
  const [fullscreenCamId, setFullscreenCamId] = useState<string | null>(null);
  const [activeToolbarIdxMap, setActiveToolbarIdxMap] = useState<Record<string, number>>({});
  const tileRefs = useRef<Record<string, HTMLDivElement | null>>({});

  const supportsNativeFocusGroup =
    typeof HTMLElement !== 'undefined' && 'focusGroup' in HTMLElement.prototype;

  const handleToolbarKeyDown = (
    cameraId: string,
    e: React.KeyboardEvent<HTMLDivElement>
  ): void => {
    if (supportsNativeFocusGroup) return;
    const bar = e.currentTarget;
    const items = Array.from(
      bar.querySelectorAll<HTMLButtonElement>('button[data-toolbar-item="true"]')
    );
    if (items.length === 0) return;

    const currentIdx = Math.max(0, items.indexOf(document.activeElement as HTMLButtonElement));
    const rtl = getComputedStyle(bar).direction === 'rtl';
    let nextIdx: number | null = null;

    if (e.key === 'ArrowRight') {
      nextIdx = (currentIdx + (rtl ? -1 : 1) + items.length) % items.length;
    } else if (e.key === 'ArrowLeft') {
      nextIdx = (currentIdx + (rtl ? 1 : -1) + items.length) % items.length;
    } else if (e.key === 'Home') {
      nextIdx = 0;
    } else if (e.key === 'End') {
      nextIdx = items.length - 1;
    }

    if (nextIdx !== null) {
      e.preventDefault();
      setActiveToolbarIdxMap((prev) => ({ ...prev, [cameraId]: nextIdx }));
      items[nextIdx]?.focus();
    }
  };

  useEffect(() => {
    const handleFsChange = () => {
      if (!document.fullscreenElement) {
        setFullscreenCamId(null);
      }
    };
    const handleKeyDown = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') {
        setFullscreenCamId(null);
      }
    };
    document.addEventListener('fullscreenchange', handleFsChange);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('fullscreenchange', handleFsChange);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, []);

  // Determine visible cameras based on Solo mode or Grid size
  const displayedCameras = soloCameraId
    ? cameras.filter((c) => c.id === soloCameraId)
    : cameras.slice(0, gridSize);

  const isSingleTileLayout =
    Boolean(soloCameraId) || displayedCameras.length === 1 || gridSize === 1;
  const isExplicitSolo4K = Boolean(soloCameraId) || gridSize === 1;

  const getGridClass = (): string => {
    if (isSingleTileLayout) return 'grid-cols-1 grid-rows-1';
    switch (gridSize) {
      case 2:
        return 'grid-cols-1 md:grid-cols-2 grid-rows-1';
      case 4:
        return 'grid-cols-2 grid-rows-2';
      case 6:
        return 'grid-cols-3 grid-rows-3';
      case 9:
        return 'grid-cols-3 grid-rows-3';
      case 16:
        return 'grid-cols-4 grid-rows-4';
      default:
        return 'grid-cols-2 grid-rows-2';
    }
  };

  const handleToggleMute = (camId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setMutedMap((prev) => ({
      ...prev,
      [camId]: prev[camId] === false ? true : false,
    }));
  };

  const handleZoomStep = (camId: string, delta: number, e: React.MouseEvent) => {
    e.stopPropagation();
    setZoomMap((prev) => {
      const curr = prev[camId] || 1;
      const next = Math.max(1, Math.min(8, Math.round((curr + delta) * 100) / 100));
      return { ...prev, [camId]: next };
    });
  };

  const handleSnapshotDownload = (camId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const link = document.createElement('a');
    link.href = `/api/cameras/${encodeURIComponent(camId)}/snapshot?tier=main&download=1&t=${Date.now()}`;
    link.download = `${camId}_4K_snapshot_${Date.now()}.jpg`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const handleFullscreenTile = async (camId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const el = tileRefs.current[camId];

    if (fullscreenCamId === camId || document.fullscreenElement) {
      setFullscreenCamId(null);
      if (document.fullscreenElement) {
        await document.exitFullscreen().catch(() => {});
      }
    } else {
      setFullscreenCamId(camId);
      if (el && typeof el.requestFullscreen === 'function') {
        await el.requestFullscreen().catch(() => {});
      }
    }
  };

  const handleDragStart = (camId: string, e: React.DragEvent) => {
    setDraggedCamId(camId);
    e.dataTransfer.effectAllowed = 'move';
  };

  const handleDragOver = (camId: string, e: React.DragEvent) => {
    e.preventDefault();
    if (draggedCamId && draggedCamId !== camId) {
      setDragOverCamId(camId);
    }
  };

  const handleDrop = (targetCamId: string, e: React.DragEvent) => {
    e.preventDefault();
    setDragOverCamId(null);
    if (!draggedCamId || draggedCamId === targetCamId) return;

    const currentIds = cameras.map((c) => c.id);
    const fromIdx = currentIds.indexOf(draggedCamId);
    const toIdx = currentIds.indexOf(targetCamId);
    if (fromIdx === -1 || toIdx === -1) return;

    const updated = [...currentIds];
    const [moved] = updated.splice(fromIdx, 1);
    updated.splice(toIdx, 0, moved);
    onReorderCameras(updated);
    setDraggedCamId(null);
  };

  return (
    <div className="relative w-full h-full p-2 bg-[#0B0F17] overflow-hidden">
      <div className={`grid gap-2 w-full h-full ${getGridClass()}`}>
        <AnimatePresence mode="popLayout">
          {displayedCameras.map((camera, index) => {
            const telemetry = telemetryMap[camera.id];
            const isSelected = selectedCameraId === camera.id;
            const isSolo = soloCameraId === camera.id;
            const isPrimaryHotspot = gridSize === 6 && index === 0 && !isSingleTileLayout;
            const zoom = zoomMap[camera.id] || 1;

            // Connect to {camera_id}_sub in Grid mode (2x2, 3x3, 4x4) even with 1 camera to keep GPU load minimal (~2-5%).
            // Hot-swap immediately to {camera_id}_main (full native 4K) when Solo (1x1 4K / double-click), Fullscreen, or Digital Zoom (>1.05x)!
            const streamTier: 'main' | 'sub' =
              isExplicitSolo4K ||
              isSolo ||
              fullscreenCamId === camera.id ||
              isPrimaryHotspot ||
              zoom > 1.05
                ? 'main'
                : 'sub';

            const isMuted = mutedMap[camera.id] !== false;
            const isMotion = Boolean(telemetry?.isMotionActive);
            const isRecording = Boolean(telemetry?.isRecording);
            const isManualRec = Boolean(telemetry?.isManualRecording);

            const statusLabel = !camera.enabled
              ? 'OFFLINE'
              : isMotion
                ? 'AI MOTION'
                : isRecording
                  ? 'REC D2D'
                  : 'LIVE';

            const statusBadgeStyle = !camera.enabled
              ? 'bg-slate-900/95 text-slate-400 border-slate-700'
              : isMotion
                ? 'bg-amber-950/95 text-amber-300 border-amber-500/50'
                : isRecording
                  ? 'bg-red-950/95 text-red-300 border-red-500/40'
                  : 'bg-emerald-950/95 text-emerald-300 border-emerald-500/40';

            const isFullscreenTile = fullscreenCamId === camera.id;
            const spanClass = isPrimaryHotspot ? 'col-span-2 row-span-2' : '';

            const activeToolbarIdx = activeToolbarIdxMap[camera.id] ?? 0;
            const getToolbarTabIndex = (idx: number): number | undefined =>
              supportsNativeFocusGroup ? undefined : activeToolbarIdx === idx ? 0 : -1;

            return (
              <motion.div
                key={camera.id}
                ref={(el) => {
                  tileRefs.current[camera.id] = el;
                }}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.15 }}
                onDragOver={(e) =>
                  handleDragOver(camera.id, e as unknown as React.DragEvent)
                }
                onDrop={(e) => handleDrop(camera.id, e as unknown as React.DragEvent)}
                onClick={() => onSelectCamera(camera.id)}
                onDoubleClick={() => onToggleSoloCamera(camera.id)}
                className={`group flex flex-col bg-[#0E1420] border transition-colors ${
                  isFullscreenTile
                    ? 'fixed inset-0 z-50 w-screen h-screen rounded-none border-none bg-black'
                    : `relative rounded-lg ${spanClass}`
                } ${
                  dragOverCamId === camera.id
                    ? 'border-emerald-400 ring-2 ring-emerald-400/40'
                    : isMotion
                      ? 'border-amber-500/80'
                      : isSelected
                        ? 'border-emerald-500/80'
                        : 'border-slate-800/90 hover:border-slate-700'
                }`}
              >
                {/* Dedicated Slim Tile Header Bar — stacked above video so 0% of camera view or OSD timestamp is covered */}
                <div className="shrink-0 px-2 py-1 bg-[#090D16] border-b border-slate-800/90 rounded-t-lg z-30 flex items-center justify-between gap-2 min-h-8">
                  {/* Left: Camera Name & Recording / AI Status */}
                  <div className="flex items-center gap-1.5 min-w-0 overflow-hidden">
                    {!isSingleTileLayout && !isFullscreenTile && (
                      <span
                        draggable
                        onDragStart={(e) => handleDragStart(camera.id, e)}
                        title="Drag to reorder camera tile"
                        className="p-0.5 rounded text-slate-400 hover:text-slate-200 cursor-grab active:cursor-grabbing shrink-0"
                      >
                        <GripVertical aria-hidden="true" className="w-3.5 h-3.5" />
                      </span>
                    )}

                    <span
                      aria-hidden="true"
                      className={`inline-flex rounded-full h-2 w-2 shrink-0 ${
                        !camera.enabled
                          ? 'bg-slate-500'
                          : isMotion
                            ? 'bg-amber-400'
                            : isRecording
                              ? 'bg-red-500'
                              : 'bg-emerald-400'
                      }`}
                    />
                    <span className="text-xs font-semibold text-slate-100 tracking-tight truncate">
                      {camera.name}
                    </span>

                    <span
                      className={`px-1.5 py-0.2 rounded text-[10px] font-mono font-bold border shrink-0 ${statusBadgeStyle}`}
                    >
                      {statusLabel}
                    </span>

                    {camera.force_h264 && (
                      <span className="hidden sm:flex items-center gap-1 px-1.5 py-0.2 rounded bg-purple-950/90 border border-purple-500/40 text-purple-300 text-[10px] font-mono shrink-0">
                        <Cpu aria-hidden="true" className="w-2.5 h-2.5" />
                        NVENC
                      </span>
                    )}
                  </div>

                  {/* Right: Camera Action Toolbar */}
                  <div
                    role="toolbar"
                    aria-label={`${camera.name} controls`}
                    {...({ focusgroup: 'toolbar wrap' } as Record<string, string>)}
                    onKeyDown={(e) => handleToolbarKeyDown(camera.id, e)}
                    onFocus={(e) => {
                      const items = Array.from(
                        e.currentTarget.querySelectorAll<HTMLButtonElement>(
                          'button[data-toolbar-item="true"]'
                        )
                      );
                      const idx = items.indexOf(e.target as unknown as HTMLButtonElement);
                      if (idx >= 0) {
                        setActiveToolbarIdxMap((prev) => ({ ...prev, [camera.id]: idx }));
                      }
                    }}
                    className="flex items-center gap-0.5 shrink-0"
                  >
                    {/* Simulate AI Detection Quick Menu */}
                    <div className="relative">
                      <button
                        type="button"
                        data-toolbar-item="true"
                        tabIndex={getToolbarTabIndex(0)}
                        aria-label="Simulate AI detection"
                        aria-haspopup="menu"
                        aria-expanded={triggerMenuCamId === camera.id}
                        onClick={(e) => {
                          e.stopPropagation();
                          setTriggerMenuCamId(
                            triggerMenuCamId === camera.id ? null : camera.id
                          );
                        }}
                        className="min-w-6 min-h-6 p-1 rounded hover:bg-amber-500/20 text-amber-400 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
                        title="Simulate AI Detection / Test Zone Rule"
                      >
                        <Sparkles aria-hidden="true" className="w-3.5 h-3.5" />
                      </button>

                      {triggerMenuCamId === camera.id && (
                        <div
                          onClick={(e) => e.stopPropagation()}
                          className="absolute right-0 mt-1.5 w-44 rounded-lg bg-slate-900 border border-slate-700 shadow-2xl py-1.5 z-50 text-xs"
                        >
                          <div className="px-2.5 py-1 text-[10px] font-mono uppercase text-slate-400 border-b border-slate-800">
                            Trigger AI Verification
                          </div>
                          {[
                            { id: 'person', label: 'Person (94%)', dot: 'bg-red-500' },
                            { id: 'car', label: 'Vehicle / Car (97%)', dot: 'bg-blue-500' },
                            { id: 'dog', label: 'Animal / Pet (86%)', dot: 'bg-amber-500' },
                            { id: 'onvif', label: 'ONVIF Webhook', dot: 'bg-purple-500' },
                          ].map((item) => (
                            <button
                              key={item.id}
                              type="button"
                              onClick={() => {
                                setTriggerMenuCamId(null);
                                onSimulateAiEvent(camera.id, item.id);
                              }}
                              className="w-full px-3 py-1.5 text-left hover:bg-slate-800 flex items-center gap-2 text-slate-200"
                            >
                              <span className={`w-2 h-2 rounded-full ${item.dot}`} />
                              <span>{item.label}</span>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>

                    {/* Polygon Zone Editor Button */}
                    <button
                      type="button"
                      data-toolbar-item="true"
                      tabIndex={getToolbarTabIndex(1)}
                      aria-label="Edit polygon motion and AI zones"
                      onClick={(e) => {
                        e.stopPropagation();
                        onOpenZoneEditor(camera);
                      }}
                      className="min-w-6 min-h-6 p-1 rounded hover:bg-slate-800 text-slate-300 hover:text-emerald-400 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
                      title="Edit Polygon Motion & AI Zones"
                    >
                      <Crosshair aria-hidden="true" className="w-3.5 h-3.5" />
                    </button>

                    {/* Digital Zoom Controls */}
                    <button
                      type="button"
                      data-toolbar-item="true"
                      tabIndex={getToolbarTabIndex(2)}
                      aria-label="Digital zoom out"
                      onClick={(e) => handleZoomStep(camera.id, -0.5, e)}
                      className="min-w-6 min-h-6 p-1 rounded hover:bg-slate-800 text-slate-300 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
                      title="Digital Zoom Out"
                    >
                      <ZoomOut aria-hidden="true" className="w-3.5 h-3.5" />
                    </button>
                    <button
                      type="button"
                      data-toolbar-item="true"
                      tabIndex={getToolbarTabIndex(3)}
                      aria-label="Digital zoom in"
                      onClick={(e) => handleZoomStep(camera.id, 0.5, e)}
                      className="min-w-6 min-h-6 p-1 rounded hover:bg-slate-800 text-slate-300 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
                      title="Digital Zoom In (up to 8x)"
                    >
                      <ZoomIn aria-hidden="true" className="w-3.5 h-3.5" />
                    </button>

                    {/* Mute / Unmute Audio */}
                    <button
                      type="button"
                      data-toolbar-item="true"
                      tabIndex={getToolbarTabIndex(4)}
                      aria-label="Mute camera audio"
                      aria-pressed={isMuted}
                      onClick={(e) => handleToggleMute(camera.id, e)}
                      className="min-w-6 min-h-6 p-1 rounded hover:bg-slate-800 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 text-emerald-400 aria-[pressed=true]:text-slate-400"
                      title={isMuted ? 'Unmute Audio (AAC/Opus)' : 'Mute Audio'}
                    >
                      {isMuted ? (
                        <VolumeX aria-hidden="true" className="w-3.5 h-3.5" />
                      ) : (
                        <Volume2 aria-hidden="true" className="w-3.5 h-3.5" />
                      )}
                    </button>

                    {/* Instant High-Res 4K Snapshot Download */}
                    <button
                      type="button"
                      data-toolbar-item="true"
                      tabIndex={getToolbarTabIndex(5)}
                      aria-label="Download instant 4K snapshot"
                      onClick={(e) => handleSnapshotDownload(camera.id, e)}
                      className="min-w-6 min-h-6 p-1 rounded hover:bg-slate-800 text-slate-300 hover:text-white transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
                      title="Download Instant 4K Snapshot (.jpg)"
                    >
                      <CameraIcon aria-hidden="true" className="w-3.5 h-3.5" />
                    </button>

                    {/* Manual Record Trigger */}
                    <button
                      type="button"
                      data-toolbar-item="true"
                      tabIndex={getToolbarTabIndex(6)}
                      aria-label="Manual direct-to-disk recording"
                      aria-pressed={isManualRec}
                      onClick={(e) => {
                        e.stopPropagation();
                        onToggleManualRecord(camera.id);
                      }}
                      className="min-w-6 min-h-6 p-1 rounded hover:bg-slate-800 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 text-slate-300 aria-[pressed=true]:text-red-500 aria-[pressed=true]:bg-red-500/15"
                      title="Toggle Manual Direct-to-Disk Recording"
                    >
                      <Circle aria-hidden="true" className="w-3.5 h-3.5 fill-current" />
                    </button>

                    {/* Solo 4K Hot-Swap Toggle */}
                    <button
                      type="button"
                      data-toolbar-item="true"
                      tabIndex={getToolbarTabIndex(7)}
                      aria-label="Solo 4K view"
                      aria-pressed={isSolo}
                      onClick={(e) => {
                        e.stopPropagation();
                        onToggleSoloCamera(camera.id);
                      }}
                      className="min-w-6 min-h-6 p-1 rounded hover:bg-slate-800 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 text-slate-300 aria-[pressed=true]:text-emerald-400 aria-[pressed=true]:bg-emerald-500/15"
                      title={
                        isSolo
                          ? 'Return to Multi-Camera Matrix (Sub-Stream)'
                          : 'Expand to Solo Native 4K Main Stream'
                      }
                    >
                      {isSolo ? (
                        <Minimize2 aria-hidden="true" className="w-3.5 h-3.5" />
                      ) : (
                        <Maximize2 aria-hidden="true" className="w-3.5 h-3.5" />
                      )}
                    </button>

                    {/* Browser Fullscreen */}
                    <button
                      type="button"
                      data-toolbar-item="true"
                      tabIndex={getToolbarTabIndex(8)}
                      aria-label="Fullscreen 4K view"
                      aria-pressed={isFullscreenTile}
                      onClick={(e) => void handleFullscreenTile(camera.id, e)}
                      className="min-w-6 min-h-6 p-1 rounded hover:bg-slate-800 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 text-slate-300 aria-[pressed=true]:text-emerald-400 aria-[pressed=true]:bg-emerald-500/15"
                      title={
                        isFullscreenTile
                          ? 'Exit Fullscreen 4K View (Esc)'
                          : 'Fullscreen Native 4K View'
                      }
                    >
                      <Expand aria-hidden="true" className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>

                {/* Unobstructed Video & Zone/Box Canvas Area */}
                <div className="flex-1 min-h-0 relative overflow-hidden bg-black rounded-b-lg">
                  <Go2RtcPlayer
                    camera={camera}
                    streamTier={streamTier}
                    telemetry={telemetry}
                    muted={isMuted}
                    showZonesOverlay={showZonesOverlay}
                    showBoxesOverlay={showBoxesOverlay}
                    zoom={zoom}
                    onZoomChange={(nextZoom) =>
                      setZoomMap((prev) => ({ ...prev, [camera.id]: nextZoom }))
                    }
                  />

                  {/* Stream Telemetry HUD (toggleable via header HUD button) */}
                  {showTelemetryHud && camera.enabled && (
                    <div className="absolute bottom-2 left-2 z-20 pointer-events-none flex flex-wrap items-center gap-1.5 px-2 py-0.5 rounded bg-slate-950/90 border border-slate-800 text-[10px] font-mono text-slate-300">
                      <span
                        className={`font-bold ${
                          streamTier === 'main' ? 'text-emerald-400' : 'text-sky-400'
                        }`}
                      >
                        {streamTier === 'main'
                          ? telemetry?.resolution || '3840x2160'
                          : telemetry?.subResolution || '704x576'}
                      </span>
                      <span className="text-slate-600">|</span>
                      <span>
                        {streamTier === 'main'
                          ? telemetry?.codec || 'H.264 / AVC'
                          : telemetry?.subCodec || 'H.264 / AVC'}
                      </span>
                      <span className="text-slate-600">|</span>
                      <span>{telemetry?.fps || 20} FPS</span>
                      <span className="text-slate-600">|</span>
                      <span className="text-emerald-300">
                        {streamTier === 'main'
                          ? `${((telemetry?.bitrateKbps || 8400) / 1000).toFixed(1)} Mbps`
                          : `${Math.round((telemetry?.bitrateKbps || 8400) * 0.12)} kbps`}
                      </span>
                    </div>
                  )}
                </div>
              </motion.div>
            );
          })}
        </AnimatePresence>
      </div>

      {/* First-Run Onboarding Card when no cameras exist */}
      {cameras.length === 0 && (
        <div className="absolute inset-0 flex items-center justify-center p-6">
          <div className="max-w-lg w-full rounded-2xl bg-[#111827]/95 border border-slate-800 shadow-2xl p-6 text-center space-y-5">
            <div className="w-12 h-12 mx-auto rounded-xl bg-emerald-500/15 border border-emerald-500/40 flex items-center justify-center text-emerald-400 shadow-[0_0_24px_rgba(16,185,129,0.2)]">
              <ShieldCheck aria-hidden="true" className="w-6 h-6" />
            </div>

            <div className="space-y-1.5">
              <h2 className="text-lg font-bold text-white tracking-tight">
                Welcome to Inksight
              </h2>
              <p className="text-xs text-slate-300 leading-relaxed">
                100% Free, Local-First 4K NVR &amp; Offline YOLO11 AI Video Management. Your
                footage stays on your drives with zero cloud fees and zero YAML files to edit.
              </p>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5 text-left text-[11px]">
              <div className="p-2.5 rounded-lg bg-slate-900/90 border border-slate-800">
                <div className="font-bold text-emerald-400 flex items-center gap-1.5 mb-0.5">
                  <Radar aria-hidden="true" className="w-3.5 h-3.5" />
                  <span>Auto-Discover</span>
                </div>
                <p className="text-slate-400">
                  1-click LAN scan finds RTSP &amp; ONVIF cameras on your network.
                </p>
              </div>

              <div className="p-2.5 rounded-lg bg-slate-900/90 border border-slate-800">
                <div className="font-bold text-emerald-400 flex items-center gap-1.5 mb-0.5">
                  <Cpu aria-hidden="true" className="w-3.5 h-3.5" />
                  <span>Offline YOLO11</span>
                </div>
                <p className="text-slate-400">
                  Bundled Nano, Small &amp; Medium AI models with DirectML GPU support.
                </p>
              </div>

              <div className="p-2.5 rounded-lg bg-slate-900/90 border border-slate-800">
                <div className="font-bold text-emerald-400 flex items-center gap-1.5 mb-0.5">
                  <CameraIcon aria-hidden="true" className="w-3.5 h-3.5" />
                  <span>Direct-to-Disk</span>
                </div>
                <p className="text-slate-400">
                  24/7 native 4K recording with 0% background video transcoding.
                </p>
              </div>
            </div>

            {onAddFirstCamera ? (
              <button
                type="button"
                onClick={onAddFirstCamera}
                className="inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold text-xs shadow-lg transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300 focus-visible:ring-offset-2 focus-visible:ring-offset-[#111827]"
              >
                <Plus aria-hidden="true" className="w-4 h-4" />
                <span>Scan Network &amp; Add Your First Camera</span>
              </button>
            ) : (
              <p className="text-xs text-slate-400">
                Click <strong className="text-slate-200">+ Add Camera</strong> in the top toolbar to connect an ONVIF/RTSP camera.
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
};


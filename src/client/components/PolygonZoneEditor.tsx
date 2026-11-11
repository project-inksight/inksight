import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
  Plus,
  Trash2,
  RefreshCw,
  Check,
  ShieldCheck,
  ShieldX,
  Crosshair,
  Eye,
  EyeOff,
} from 'lucide-react';
import { Camera, Point2D, PolygonZone } from '@shared/types';

interface PolygonZoneEditorProps {
  camera: Camera;
  onSaveZones: (cameraId: string, zones: PolygonZone[]) => Promise<void>;
}

function pointInPolyClient(point: Point2D, polygon: Point2D[]): boolean {
  if (polygon.length < 3) return false;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].x;
    const yi = polygon[i].y;
    const xj = polygon[j].x;
    const yj = polygon[j].y;
    const intersect =
      yi > point.y !== yj > point.y &&
      point.x < ((xj - xi) * (point.y - yi)) / (yj - yi + 1e-12) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

export const PolygonZoneEditor: React.FC<PolygonZoneEditorProps> = ({
  camera,
  onSaveZones,
}) => {
  const [zones, setZones] = useState<PolygonZone[]>(camera.zones || []);
  const [selectedZoneId, setSelectedZoneId] = useState<string | null>(
    camera.zones?.[0]?.id || null
  );
  const [editorMode, setEditorMode] = useState<'edit' | 'draw_inclusion' | 'draw_exclusion' | 'test_box'>('edit');
  const [draftPoints, setDraftPoints] = useState<Point2D[]>([]);
  const [draftName, setDraftName] = useState<string>('Custom Zone');
  const [draggingVertex, setDraggingVertex] = useState<{ zoneId: string; ptIndex: number } | null>(null);
  const [testAnchor, setTestAnchor] = useState<Point2D | null>({ x: 0.32, y: 0.72 });
  const [snapshotNonce, setSnapshotNonce] = useState<number>(Date.now());
  const [isSaving, setIsSaving] = useState<boolean>(false);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const bgImageRef = useRef<HTMLImageElement | null>(null);
  const [imageLoaded, setImageLoaded] = useState<boolean>(false);

  useEffect(() => {
    setZones(camera.zones || []);
    setSelectedZoneId(camera.zones?.[0]?.id || null);
    setDraftPoints([]);
  }, [camera.id, camera.zones]);

  // Load camera live snapshot into image object
  useEffect(() => {
    setImageLoaded(false);
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      bgImageRef.current = img;
      setImageLoaded(true);
    };
    img.src = `/api/cameras/${encodeURIComponent(camera.id)}/snapshot?tier=main&t=${snapshotNonce}`;
  }, [camera.id, snapshotNonce]);

  const isAnchorAllowed = useCallback(
    (anchor: Point2D): { allowed: boolean; reason: string } => {
      const activeZones = zones.filter((z) => z.active && z.points.length >= 3);
      if (activeZones.length === 0) {
        return { allowed: true, reason: 'No active zones defined (all detections allowed)' };
      }

      for (const z of activeZones.filter((z) => z.type === 'exclusion')) {
        if (pointInPolyClient(anchor, z.points)) {
          return {
            allowed: false,
            reason: `Blocked by Exclusion Zone "${z.name}"`,
          };
        }
      }

      const incZones = activeZones.filter((z) => z.type === 'inclusion');
      if (incZones.length === 0) {
        return { allowed: true, reason: 'Outside all Exclusion Zones' };
      }

      for (const z of incZones) {
        if (pointInPolyClient(anchor, z.points)) {
          return {
            allowed: true,
            reason: `Verified inside Inclusion Zone "${z.name}"`,
          };
        }
      }

      return {
        allowed: false,
        reason: 'Ignored: Bottom-center anchor ((x1+x2)/2, y2) is outside all Inclusion Zones',
      };
    },
    [zones]
  );

  // Render Snapshot + Polygons + Vertices + Test Bounding Box
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    if (bgImageRef.current && imageLoaded) {
      ctx.drawImage(bgImageRef.current, 0, 0, w, h);
    } else {
      ctx.fillStyle = '#0B0F17';
      ctx.fillRect(0, 0, w, h);
    }

    // Draw saved zones
    for (const zone of zones) {
      if (zone.points.length < 2) continue;
      const isSelected = zone.id === selectedZoneId;
      const isEx = zone.type === 'exclusion';
      const strokeColor = isEx ? '#EF4444' : '#10B981';

      ctx.save();
      ctx.beginPath();
      zone.points.forEach((p, idx) => {
        if (idx === 0) ctx.moveTo(p.x * w, p.y * h);
        else ctx.lineTo(p.x * w, p.y * h);
      });
      ctx.closePath();

      ctx.fillStyle = !zone.active
        ? 'rgba(100,116,139,0.12)'
        : isEx
          ? 'rgba(239,68,68,0.22)'
          : 'rgba(16,185,129,0.20)';
      ctx.fill();

      ctx.strokeStyle = !zone.active ? '#64748B' : strokeColor;
      ctx.lineWidth = isSelected ? 3 : 2;
      if (!zone.active) ctx.setLineDash([6, 4]);
      ctx.stroke();
      ctx.setLineDash([]);

      // Draw draggable vertices
      zone.points.forEach((p, idx) => {
        ctx.beginPath();
        ctx.arc(p.x * w, p.y * h, isSelected ? 6.5 : 4.5, 0, Math.PI * 2);
        ctx.fillStyle = isSelected ? '#FFFFFF' : strokeColor;
        ctx.fill();
        ctx.strokeStyle = strokeColor;
        ctx.lineWidth = 2;
        ctx.stroke();

        if (idx === 0) {
          ctx.fillStyle = 'rgba(11,15,23,0.88)';
          const label = `${isEx ? 'EXCL' : 'INCL'}: ${zone.name}`;
          ctx.font = '700 12px Inter, sans-serif';
          const tw = ctx.measureText(label).width + 14;
          ctx.fillRect(p.x * w, Math.max(4, p.y * h - 26), tw, 20);
          ctx.fillStyle = isEx ? '#FCA5A5' : '#6EE7B7';
          ctx.fillText(label, p.x * w + 7, Math.max(18, p.y * h - 12));
        }
      });

      ctx.restore();
    }

    // Draw draft polygon being drawn
    if (draftPoints.length > 0) {
      const isEx = editorMode === 'draw_exclusion';
      const color = isEx ? '#EF4444' : '#10B981';
      ctx.save();
      ctx.beginPath();
      draftPoints.forEach((p, idx) => {
        if (idx === 0) ctx.moveTo(p.x * w, p.y * h);
        else ctx.lineTo(p.x * w, p.y * h);
      });
      if (draftPoints.length >= 3) {
        ctx.closePath();
        ctx.fillStyle = isEx ? 'rgba(239,68,68,0.25)' : 'rgba(16,185,129,0.25)';
        ctx.fill();
      }
      ctx.strokeStyle = color;
      ctx.lineWidth = 2.5;
      ctx.setLineDash([5, 5]);
      ctx.stroke();
      ctx.setLineDash([]);

      draftPoints.forEach((p) => {
        ctx.beginPath();
        ctx.arc(p.x * w, p.y * h, 6, 0, Math.PI * 2);
        ctx.fillStyle = '#FFFFFF';
        ctx.fill();
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.stroke();
      });
      ctx.restore();
    }

    // Draw Test Bounding Box & Bottom-Center Anchor ((x1+x2)/2, y2)
    if (testAnchor) {
      const check = isAnchorAllowed(testAnchor);
      const boxW = 0.08 * w;
      const boxH = 0.24 * h;
      const bx = testAnchor.x * w - boxW / 2;
      const by = testAnchor.y * h - boxH;
      const color = check.allowed ? '#10B981' : '#EF4444';

      ctx.save();
      ctx.strokeStyle = color;
      ctx.lineWidth = 2.5;
      ctx.fillStyle = check.allowed ? 'rgba(16,185,129,0.16)' : 'rgba(239,68,68,0.16)';
      ctx.beginPath();
      ctx.roundRect(bx, by, boxW, boxH, 4);
      ctx.fill();
      ctx.stroke();

      // Anchor point ((x1+x2)/2, y2)
      ctx.beginPath();
      ctx.arc(testAnchor.x * w, testAnchor.y * h, 6, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.strokeStyle = '#FFFFFF';
      ctx.lineWidth = 2;
      ctx.stroke();

      const tag = check.allowed ? 'TEST OBJECT: ALLOWED' : 'TEST OBJECT: MASKED';
      ctx.font = '700 11px "JetBrains Mono", monospace';
      const tw = ctx.measureText(tag).width + 12;
      ctx.fillStyle = color;
      ctx.fillRect(bx, Math.max(4, by - 22), tw, 18);
      ctx.fillStyle = '#052E16';
      if (!check.allowed) ctx.fillStyle = '#FFFFFF';
      ctx.fillText(tag, bx + 6, Math.max(16, by - 9));
      ctx.restore();
    }
  }, [zones, selectedZoneId, draftPoints, editorMode, testAnchor, imageLoaded, isAnchorAllowed]);

  const getNormalizedCoords = (e: React.MouseEvent<HTMLCanvasElement>): Point2D => {
    const rect = canvasRef.current!.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1, Math.round(((e.clientX - rect.left) / rect.width) * 1000) / 1000)),
      y: Math.max(0, Math.min(1, Math.round(((e.clientY - rect.top) / rect.height) * 1000) / 1000)),
    };
  };

  const handleCanvasMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const pt = getNormalizedCoords(e);

    if (editorMode === 'draw_inclusion' || editorMode === 'draw_exclusion') {
      setDraftPoints((prev) => [...prev, pt]);
      return;
    }

    if (editorMode === 'test_box') {
      setTestAnchor(pt);
      return;
    }

    // Edit mode: check if clicking near any existing vertex
    for (const z of zones) {
      for (let i = 0; i < z.points.length; i++) {
        const vp = z.points[i];
        const dist = Math.hypot(vp.x - pt.x, vp.y - pt.y);
        if (dist < 0.03) {
          setSelectedZoneId(z.id);
          setDraggingVertex({ zoneId: z.id, ptIndex: i });
          return;
        }
      }
    }

    // Or check if clicking inside a polygon to select it
    for (const z of zones) {
      if (pointInPolyClient(pt, z.points)) {
        setSelectedZoneId(z.id);
        return;
      }
    }
  };

  const handleCanvasMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!draggingVertex) return;
    const pt = getNormalizedCoords(e);
    setZones((prev) =>
      prev.map((z) => {
        if (z.id !== draggingVertex.zoneId) return z;
        const nextPts = [...z.points];
        nextPts[draggingVertex.ptIndex] = pt;
        return { ...z, points: nextPts };
      })
    );
  };

  const handleCanvasMouseUp = () => {
    setDraggingVertex(null);
  };

  const handleCompleteDraftZone = () => {
    if (draftPoints.length < 3) return;
    const isEx = editorMode === 'draw_exclusion';
    const newZone: PolygonZone = {
      id: `zone_${Date.now().toString(36)}`,
      name: draftName.trim() || (isEx ? 'Exclusion Mask' : 'Inclusion Zone'),
      type: isEx ? 'exclusion' : 'inclusion',
      color: isEx ? '#EF4444' : '#10B981',
      active: true,
      points: draftPoints,
    };

    const updated = [...zones, newZone];
    setZones(updated);
    setSelectedZoneId(newZone.id);
    setDraftPoints([]);
    setEditorMode('edit');
  };

  const handleSaveAll = async () => {
    setIsSaving(true);
    try {
      await onSaveZones(camera.id, zones);
    } finally {
      setIsSaving(false);
    }
  };

  const testResult = testAnchor ? isAnchorAllowed(testAnchor) : null;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
      {/* Left 2 Columns: Interactive Canvas */}
      <div className="lg:col-span-2 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2 bg-[#0B0F17] p-2.5 rounded-lg border border-slate-800">
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              onClick={() => {
                setDraftPoints([]);
                setDraftName(`Inclusion Zone ${zones.length + 1}`);
                setEditorMode('draw_inclusion');
              }}
              className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded text-xs font-medium transition ${
                editorMode === 'draw_inclusion'
                  ? 'bg-emerald-500 text-slate-950 font-bold'
                  : 'bg-slate-800 hover:bg-slate-700 text-emerald-400'
              }`}
            >
              <Plus className="w-3.5 h-3.5" />
              <span>Draw Inclusion Polygon</span>
            </button>

            <button
              type="button"
              onClick={() => {
                setDraftPoints([]);
                setDraftName(`Exclusion Mask ${zones.length + 1}`);
                setEditorMode('draw_exclusion');
              }}
              className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded text-xs font-medium transition ${
                editorMode === 'draw_exclusion'
                  ? 'bg-red-500 text-white font-bold'
                  : 'bg-slate-800 hover:bg-slate-700 text-red-400'
              }`}
            >
              <Plus className="w-3.5 h-3.5" />
              <span>Draw Exclusion Polygon</span>
            </button>

            <button
              type="button"
              onClick={() =>
                setEditorMode(editorMode === 'test_box' ? 'edit' : 'test_box')
              }
              className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded text-xs font-medium transition ${
                editorMode === 'test_box'
                  ? 'bg-sky-500 text-slate-950 font-bold'
                  : 'bg-slate-800 hover:bg-slate-700 text-sky-400'
              }`}
              title="Click anywhere on canvas to test bottom-center point ((x1+x2)/2, y2) filtering"
            >
              <Crosshair className="w-3.5 h-3.5" />
              <span>Test Anchor Point</span>
            </button>
          </div>

          <button
            type="button"
            onClick={() => setSnapshotNonce(Date.now())}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs transition"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            <span>Refresh Live Frame</span>
          </button>
        </div>

        {/* Active Drawing Banner */}
        {(editorMode === 'draw_inclusion' || editorMode === 'draw_exclusion') && (
          <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-xs">
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={draftName}
                onChange={(e) => setDraftName(e.target.value)}
                placeholder="Zone Name"
                className="bg-slate-900 border border-slate-700 rounded px-2 py-1 text-xs text-white"
              />
              <span className="text-slate-300">
                Click canvas to place polygon points ({draftPoints.length} placed, min 3).
              </span>
            </div>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                disabled={draftPoints.length < 3}
                onClick={handleCompleteDraftZone}
                className="px-3 py-1 rounded bg-emerald-500 disabled:opacity-40 text-slate-950 font-bold"
              >
                Finish Polygon
              </button>
              <button
                type="button"
                onClick={() => {
                  setDraftPoints([]);
                  setEditorMode('edit');
                }}
                className="px-2.5 py-1 rounded bg-slate-800 text-slate-300"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {/* Canvas Viewport */}
        <div className="relative rounded-lg overflow-hidden border border-slate-700 bg-black aspect-video">
          <canvas
            ref={canvasRef}
            width={960}
            height={540}
            onMouseDown={handleCanvasMouseDown}
            onMouseMove={handleCanvasMouseMove}
            onMouseUp={handleCanvasMouseUp}
            className="w-full h-full block cursor-crosshair"
          />
        </div>

        {/* Bottom-Center Anchor Test Status */}
        {testResult && (
          <div
            className={`flex items-center justify-between px-3.5 py-2 rounded-lg border text-xs font-mono ${
              testResult.allowed
                ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300'
                : 'bg-red-500/10 border-red-500/30 text-red-300'
            }`}
          >
            <div className="flex items-center gap-2">
              {testResult.allowed ? (
                <ShieldCheck className="w-4 h-4 text-emerald-400 shrink-0" />
              ) : (
                <ShieldX className="w-4 h-4 text-red-400 shrink-0" />
              )}
              <span>{testResult.reason}</span>
            </div>
            {testAnchor && (
              <span className="text-slate-400">
                Anchor ((x1+x2)/2, y2): ({testAnchor.x.toFixed(2)}, {testAnchor.y.toFixed(2)})
              </span>
            )}
          </div>
        )}
      </div>

      {/* Right Column: Zone List & Save */}
      <div className="bg-[#0B0F17] border border-slate-800 rounded-lg p-3.5 flex flex-col justify-between space-y-4">
        <div className="space-y-3">
          <div>
            <h4 className="text-xs font-bold uppercase tracking-wider text-slate-200">
              Configured Polygon Zones ({zones.length})
            </h4>
            <p className="text-[11px] text-slate-400 mt-0.5">
              Drag any vertex on the canvas to refine coordinates. Any AI bounding box whose
              bottom-center point falls outside active inclusion zones is ignored.
            </p>
          </div>

          <div className="space-y-2 max-h-72 overflow-y-auto pr-1">
            {zones.map((z) => (
              <div
                key={z.id}
                onClick={() => setSelectedZoneId(z.id)}
                className={`p-2.5 rounded-lg border cursor-pointer transition flex items-center justify-between ${
                  selectedZoneId === z.id
                    ? 'bg-slate-800/90 border-emerald-500/60'
                    : 'bg-slate-900/70 border-slate-800 hover:border-slate-700'
                }`}
              >
                <div className="space-y-0.5">
                  <div className="flex items-center gap-2">
                    <span
                      className={`w-2.5 h-2.5 rounded-full ${
                        z.type === 'exclusion' ? 'bg-red-500' : 'bg-emerald-500'
                      }`}
                    />
                    <span className="text-xs font-semibold text-slate-100">{z.name}</span>
                  </div>
                  <div className="text-[10px] font-mono text-slate-400">
                    {z.type.toUpperCase()} • {z.points.length} vertices
                  </div>
                </div>

                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setZones((prev) =>
                        prev.map((item) =>
                          item.id === z.id ? { ...item, active: !item.active } : item
                        )
                      );
                    }}
                    className={`p-1.5 rounded ${
                      z.active ? 'text-emerald-400 bg-emerald-500/10' : 'text-slate-500 bg-slate-800'
                    }`}
                    title={z.active ? 'Zone Active' : 'Zone Disabled'}
                  >
                    {z.active ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5" />}
                  </button>

                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setZones((prev) => prev.filter((item) => item.id !== z.id));
                    }}
                    className="p-1.5 rounded text-slate-400 hover:text-red-400 hover:bg-red-500/10"
                    title="Delete Polygon Zone"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            ))}

            {zones.length === 0 && (
              <div className="py-8 text-center text-xs text-slate-500 border border-dashed border-slate-800 rounded-lg">
                No polygon zones defined. Entire camera frame is monitored.
              </div>
            )}
          </div>
        </div>

        <button
          type="button"
          disabled={isSaving}
          onClick={() => void handleSaveAll()}
          className="w-full py-2.5 px-4 rounded-lg bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50 text-slate-950 font-bold text-xs flex items-center justify-center gap-2 shadow-lg transition"
        >
          <Check className="w-4 h-4" />
          <span>{isSaving ? 'Saving Polygon Zones...' : 'Save Zones to Camera'}</span>
        </button>
      </div>
    </div>
  );
};


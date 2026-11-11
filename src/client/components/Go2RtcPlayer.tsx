import React, { useEffect, useRef, useState, useCallback } from 'react';
import { BoundingBox, Camera, CameraTelemetry } from '@shared/types';
import { Loader2, WifiOff } from 'lucide-react';

interface Go2RtcPlayerProps {
  camera: Camera;
  /** 'sub' in multi-camera Grid mode; 'main' (4K native) in Solo / Fullscreen mode */
  streamTier: 'main' | 'sub';
  telemetry?: CameraTelemetry;
  muted: boolean;
  showZonesOverlay: boolean;
  showBoxesOverlay: boolean;
  zoom: number;
  onZoomChange: (newZoom: number) => void;
}

/**
 * Codec list aligned with go2rtc's reference video-rtc.js client.
 * Including 'flac' allows go2rtc to mux G.711 (pcm_alaw / pcm_mulaw) camera audio
 * into fMP4 natively in Go with zero FFmpeg transcode latency.
 */
const GO2RTC_MSE_CODECS = [
  'avc1.640029', // H.264 High 4.1
  'avc1.64002A', // H.264 High 4.2
  'avc1.640033', // H.264 High 5.1
  'avc1.4D0029', // H.264 Main 4.1
  'avc1.4D001E', // H.264 Main 3.0
  'avc1.42E01E', // H.264 Baseline 3.0
  'hvc1.1.6.L153.B0', // H.265 / HEVC Main 5.1
  'hev1.1.6.L153.B0', // H.265 / HEVC Main 5.1
  'mp4a.40.2', // AAC-LC
  'mp4a.40.5', // AAC-HE
  'flac', // FLAC (lossless wrapper for PCM A-law / mu-law)
  'opus', // Opus
];

export const Go2RtcPlayer: React.FC<Go2RtcPlayerProps> = ({
  camera,
  streamTier,
  telemetry,
  muted,
  showZonesOverlay,
  showBoxesOverlay,
  zoom,
  onZoomChange,
}) => {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement | null>(null);

  const [protocolMode, setProtocolMode] = useState<'MSE' | 'WebRTC'>('MSE');
  const [connectionState, setConnectionState] = useState<'connecting' | 'playing' | 'error'>('connecting');
  const [errorText, setErrorText] = useState<string>('');
  const [pan, setPan] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [isDraggingPan, setIsDraggingPan] = useState(false);
  const dragStartRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });

  const streamSrcName = `${camera.id}_${streamTier}`;

  useEffect(() => {
    if (zoom <= 1.01) {
      setPan({ x: 0, y: 0 });
    }
  }, [zoom]);

  /**
   * Connects directly to go2rtc over WebSocket (ws://host:1984/api/ws?src=...)
   * using MSE primary and WebRTC fallback.
   */
  useEffect(() => {
    if (!camera.enabled) {
      setConnectionState('error');
      setErrorText('Camera Disabled');
      return;
    }

    let ws: WebSocket | null = null;
    let pc: RTCPeerConnection | null = null;
    let mediaSource: MediaSource | null = null;
    let sourceBuffer: SourceBuffer | null = null;
    let objectUrl: string | null = null;
    const buf = new Uint8Array(2 * 1024 * 1024);
    let bufLen = 0;
    let isCancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    setConnectionState('connecting');
    setErrorText('');

    const getSupportedCodecsString = (): string => {
      if (typeof MediaSource === 'undefined' || typeof MediaSource.isTypeSupported !== 'function') {
        return '';
      }
      return GO2RTC_MSE_CODECS.filter((codec) =>
        MediaSource.isTypeSupported(`video/mp4; codecs="${codec}"`)
      ).join(',');
    };

    const safePlay = () => {
      const video = videoRef.current;
      if (!video) return;
      video.play().catch(() => {
        if (!video.muted) {
          video.muted = true;
          video.play().catch(() => {});
        }
      });
    };

    const startWebRtc = (socket: WebSocket) => {
      try {
        setProtocolMode('WebRTC');
        pc = new RTCPeerConnection({
          iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
        });
        pc.addTransceiver('video', { direction: 'recvonly' });
        pc.addTransceiver('audio', { direction: 'recvonly' });

        pc.ontrack = (event) => {
          if (videoRef.current && event.streams[0]) {
            videoRef.current.srcObject = event.streams[0];
            safePlay();
            setConnectionState('playing');
          }
        };

        pc.onicecandidate = (event) => {
          if (socket.readyState === WebSocket.OPEN) {
            const candidate = event.candidate ? event.candidate.toJSON().candidate : '';
            socket.send(
              JSON.stringify({
                type: 'webrtc/candidate',
                value: candidate,
              })
            );
          }
        };

        void pc.createOffer().then(async (offer) => {
          if (!pc) return;
          await pc.setLocalDescription(offer);
          if (socket.readyState === WebSocket.OPEN) {
            socket.send(
              JSON.stringify({
                type: 'webrtc/offer',
                value: offer.sdp,
              })
            );
          }
        });
      } catch (err) {
        setConnectionState('error');
        setErrorText((err as Error).message);
      }
    };

    const connect = () => {
      if (isCancelled) return;
      const wsProto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const hostname = window.location.hostname || '127.0.0.1';
      const wsUrl = `${wsProto}//${hostname}:1984/api/ws?src=${encodeURIComponent(streamSrcName)}`;

      try {
        ws = new WebSocket(wsUrl);
        ws.binaryType = 'arraybuffer';
      } catch (err) {
        setConnectionState('error');
        setErrorText((err as Error).message);
        retryTimer = setTimeout(connect, 3000);
        return;
      }

      ws.onopen = () => {
        if (isCancelled || !ws) return;
        const codecs = getSupportedCodecsString();
        if (codecs && typeof MediaSource !== 'undefined') {
          setProtocolMode('MSE');
          mediaSource = new MediaSource();
          objectUrl = URL.createObjectURL(mediaSource);

          mediaSource.addEventListener(
            'sourceopen',
            () => {
              if (objectUrl) {
                URL.revokeObjectURL(objectUrl);
                objectUrl = null;
              }
              if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'mse', value: codecs }));
              }
            },
            { once: true }
          );

          if (videoRef.current) {
            videoRef.current.srcObject = null;
            videoRef.current.src = objectUrl;
            safePlay();
          }
        } else {
          startWebRtc(ws);
        }
      };

      ws.onmessage = (ev) => {
        if (isCancelled) return;

        if (typeof ev.data === 'string') {
          try {
            const msg = JSON.parse(ev.data) as { type: string; value: string };
            if (msg.type === 'mse') {
              if (mediaSource && mediaSource.readyState === 'open' && !sourceBuffer) {
                sourceBuffer = mediaSource.addSourceBuffer(msg.value);
                sourceBuffer.mode = 'segments';
                sourceBuffer.addEventListener('updateend', () => {
                  if (isCancelled || !sourceBuffer) return;

                  if (!sourceBuffer.updating && bufLen > 0) {
                    try {
                      const data = buf.slice(0, bufLen);
                      bufLen = 0;
                      sourceBuffer.appendBuffer(data);
                    } catch {
                      bufLen = 0;
                    }
                  }

                  if (
                    !sourceBuffer.updating &&
                    sourceBuffer.buffered &&
                    sourceBuffer.buffered.length > 0
                  ) {
                    const end = sourceBuffer.buffered.end(sourceBuffer.buffered.length - 1);
                    const start0 = sourceBuffer.buffered.start(0);
                    // Only trim old MSE buffer once it exceeds 25s (instead of every frame)
                    if (end - start0 > 25) {
                      const trimTo = end - 10;
                      try {
                        sourceBuffer.remove(start0, trimTo);
                      } catch {
                        // ignore remove error
                      }
                    }
                    const video = videoRef.current;
                    if (video) {
                      const gap = end - video.currentTime;
                      if (gap > 4.0) {
                        video.currentTime = Math.max(start0, end - 0.5);
                      } else if (gap > 1.8) {
                        if (video.playbackRate !== 1.05) video.playbackRate = 1.05;
                      } else if (video.playbackRate !== 1.0) {
                        video.playbackRate = 1.0;
                      }
                      if (video.paused && video.readyState >= 2) {
                        safePlay();
                      }
                    }
                  }
                });
              }
            } else if (msg.type === 'webrtc/answer' && pc) {
              void pc.setRemoteDescription({ type: 'answer', sdp: msg.value });
            } else if (msg.type === 'webrtc/candidate' && pc && msg.value) {
              void pc.addIceCandidate({ candidate: msg.value, sdpMid: '0' }).catch(() => {});
            } else if (msg.type === 'error') {
              setErrorText(msg.value || 'Stream error');
              if (protocolMode === 'MSE' && ws && ws.readyState === WebSocket.OPEN) {
                startWebRtc(ws);
              } else {
                setConnectionState('error');
              }
            }
          } catch {
            // ignore malformed JSON
          }
        } else if (ev.data instanceof ArrayBuffer) {
          setConnectionState('playing');
          if (!sourceBuffer) return;

          if (sourceBuffer.updating || bufLen > 0) {
            const b = new Uint8Array(ev.data);
            if (bufLen + b.byteLength <= buf.byteLength) {
              buf.set(b, bufLen);
              bufLen += b.byteLength;
            } else {
              bufLen = 0;
            }
          } else {
            try {
              sourceBuffer.appendBuffer(ev.data);
            } catch {
              // ignore append error
            }
          }
        }
      };

      ws.onerror = () => {
        if (isCancelled) return;
      };

      ws.onclose = () => {
        if (isCancelled) return;
        setConnectionState('connecting');
        retryTimer = setTimeout(connect, 2500);
      };
    };

    connect();

    return () => {
      isCancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
      if (ws) {
        ws.onclose = null;
        try {
          ws.close();
        } catch {
          // ignore
        }
      }
      if (pc) {
        try {
          pc.close();
        } catch {
          // ignore
        }
      }
      if (videoRef.current) {
        videoRef.current.pause();
        videoRef.current.removeAttribute('src');
        videoRef.current.srcObject = null;
        videoRef.current.load();
      }
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [
    camera.id,
    camera.enabled,
    camera.force_h264,
    camera.main_stream_url,
    camera.sub_stream_url,
    streamSrcName,
  ]);

  /**
   * Synchronized HTML5 <canvas> Overlay for drawing Polygon Detection Zones
   * and Live AI Bounding Boxes with bottom-center zone anchor points.
   */
  useEffect(() => {
    const canvas = overlayCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    // 1. Render Active Polygon Inclusion/Exclusion Zones
    if (showZonesOverlay && camera.zones && camera.zones.length > 0) {
      for (const zone of camera.zones) {
        if (!zone.active || !zone.points || zone.points.length < 3) continue;

        ctx.save();
        ctx.beginPath();
        zone.points.forEach((pt, idx) => {
          const px = pt.x * w;
          const py = pt.y * h;
          if (idx === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        });
        ctx.closePath();

        const isEx = zone.type === 'exclusion';
        ctx.fillStyle = isEx ? 'rgba(239, 68, 68, 0.14)' : 'rgba(16, 185, 129, 0.11)';
        ctx.fill();

        ctx.strokeStyle = isEx ? '#EF4444' : zone.color || '#10B981';
        ctx.lineWidth = 2;
        ctx.setLineDash([6, 4]);
        ctx.stroke();

        const first = zone.points[0];
        ctx.setLineDash([]);
        ctx.fillStyle = 'rgba(11, 15, 23, 0.85)';
        const tag = `${isEx ? 'EXCL' : 'INCL'}: ${zone.name}`;
        ctx.font = '600 11px Inter, sans-serif';
        const tw = ctx.measureText(tag).width + 12;
        ctx.fillRect(first.x * w, Math.max(4, first.y * h - 20), tw, 18);
        ctx.fillStyle = isEx ? '#FCA5A5' : '#6EE7B7';
        ctx.fillText(tag, first.x * w + 6, Math.max(16, first.y * h - 7));
        ctx.restore();
      }
    }

    // 2. Render Live AI Bounding Boxes
    const boxes: BoundingBox[] = telemetry?.activeDetections || [];
    if (showBoxesOverlay && boxes.length > 0) {
      for (const box of boxes) {
        const bx = box.x1 * w;
        const by = box.y1 * h;
        const bw = (box.x2 - box.x1) * w;
        const bh = (box.y2 - box.y1) * h;

        const labelLower = box.label.toLowerCase();
        const color =
          labelLower === 'person'
            ? '#EF4444'
            : ['car', 'truck', 'bus', 'vehicle'].includes(labelLower)
              ? '#3B82F6'
              : ['dog', 'cat', 'pet', 'animal'].includes(labelLower)
                ? '#F59E0B'
                : '#A855F7';

        ctx.save();
        ctx.strokeStyle = color;
        ctx.lineWidth = 2.5;
        ctx.fillStyle = `${color}22`;
        ctx.beginPath();
        ctx.roundRect(bx, by, bw, bh, 4);
        ctx.fill();
        ctx.stroke();

        const text = `${box.label.toUpperCase()} ${Math.round(box.confidence)}%`;
        ctx.font = '700 12px "JetBrains Mono", monospace';
        const pillW = ctx.measureText(text).width + 14;
        const pillY = Math.max(2, by - 22);
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.roundRect(bx, pillY, pillW, 20, 4);
        ctx.fill();

        ctx.fillStyle = '#FFFFFF';
        ctx.fillText(text, bx + 7, pillY + 14);

        const anchorX = ((box.x1 + box.x2) / 2) * w;
        const anchorY = box.y2 * h;
        ctx.fillStyle = '#10B981';
        ctx.beginPath();
        ctx.arc(anchorX, anchorY, 4.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#FFFFFF';
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.restore();
      }
    }
  }, [camera.zones, showZonesOverlay, showBoxesOverlay, telemetry?.activeDetections]);

  const handleWheel = useCallback(
    (e: React.WheelEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.stopPropagation();
      const delta = e.deltaY < 0 ? 0.35 : -0.35;
      const next = Math.max(1, Math.min(8, Math.round((zoom + delta) * 100) / 100));
      onZoomChange(next);
    },
    [zoom, onZoomChange]
  );

  const handleMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if (zoom <= 1.01) return;
    setIsDraggingPan(true);
    dragStartRef.current = { x: e.clientX - pan.x, y: e.clientY - pan.y };
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!isDraggingPan || zoom <= 1.01) return;
    const maxOffset = (zoom - 1) * 160;
    const nx = Math.max(-maxOffset, Math.min(maxOffset, e.clientX - dragStartRef.current.x));
    const ny = Math.max(-maxOffset, Math.min(maxOffset, e.clientY - dragStartRef.current.y));
    setPan({ x: nx, y: ny });
  };

  const handleMouseUp = () => {
    setIsDraggingPan(false);
  };

  const hasActiveZones =
    showZonesOverlay &&
    Boolean(camera.zones && camera.zones.some((z) => z.active && z.points && z.points.length >= 3));
  const hasActiveBoxes =
    showBoxesOverlay && Boolean(telemetry?.activeDetections && telemetry.activeDetections.length > 0);
  const showCanvasLayer = hasActiveZones || hasActiveBoxes;

  return (
    <div
      className="relative w-full h-full overflow-hidden bg-[#070A10] select-none"
      onWheel={handleWheel}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
      style={{ cursor: zoom > 1.01 ? (isDraggingPan ? 'grabbing' : 'grab') : 'pointer' }}
    >
      <div
        className="w-full h-full origin-center"
        style={
          zoom > 1.01
            ? {
                transform: `scale(${zoom}) translate(${pan.x / zoom}px, ${pan.y / zoom}px)`,
              }
            : undefined
        }
      >
        <video
          ref={videoRef}
          muted={muted}
          playsInline
          autoPlay
          onLoadedData={() => setConnectionState('playing')}
          className="w-full h-full object-cover block bg-[#070A10]"
        />

        <canvas
          ref={overlayCanvasRef}
          width={960}
          height={540}
          className={`absolute inset-0 w-full h-full pointer-events-none ${
            showCanvasLayer ? 'block' : 'hidden'
          }`}
        />
      </div>

      {connectionState !== 'playing' && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-slate-950/90 text-slate-300 gap-2 pointer-events-none">
          {connectionState === 'connecting' ? (
            <>
              <Loader2 className="w-6 h-6 text-emerald-400 animate-spin" />
              <span className="text-xs font-mono text-slate-300">
                Connecting {streamTier.toUpperCase()} stream ({camera.ip_address})...
              </span>
            </>
          ) : (
            <>
              <WifiOff className="w-6 h-6 text-red-400" />
              <span className="text-xs font-mono text-red-300">
                {errorText || `Stream Offline (${camera.ip_address})`}
              </span>
            </>
          )}
        </div>
      )}

      {zoom > 1.05 && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onZoomChange(1);
          }}
          className="absolute bottom-11 right-3 z-20 px-2.5 py-1 rounded bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-mono text-xs font-bold shadow-lg transition"
          title="Click to reset digital zoom to 1.0x"
        >
          {zoom.toFixed(1)}x D-ZOOM [RESET]
        </button>
      )}

      <div className="absolute bottom-2.5 right-2.5 z-10 pointer-events-none flex items-center gap-1.5 px-2 py-0.5 rounded bg-slate-950/90 border border-slate-800 text-[10px] font-mono text-slate-400">
        <span
          className={`w-1.5 h-1.5 rounded-full ${
            connectionState === 'playing'
              ? streamTier === 'main'
                ? 'bg-emerald-400'
                : 'bg-sky-400'
              : 'bg-amber-400'
          }`}
        />
        <span>{streamTier === 'main' ? '4K-MAIN' : 'SUB-GRID'}</span>
        <span className="text-slate-600">•</span>
        <span>{protocolMode}</span>
      </div>
    </div>
  );
};

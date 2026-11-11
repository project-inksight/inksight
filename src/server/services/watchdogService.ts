import { CameraTelemetry, SystemHealthStatus } from '../../shared/types.js';
import { CameraRepository, EventRepository } from '../db/repositories.js';
import { binaryResolver } from './binaryResolver.js';
import { go2rtcManager } from './go2rtcManager.js';
import { recorderManager } from './recorderManager.js';
import { aiVisionEngine } from './aiVisionEngine.js';
import { storageCleaner } from './storageCleaner.js';
import { streamProber, StreamProbeResult } from './streamProber.js';
import { wsHub } from './wsHub.js';

interface CachedCameraProbe {
  main?: StreamProbeResult;
  sub?: StreamProbeResult;
  probedAt: number;
  probing: boolean;
}

export class WatchdogService {
  private timer: NodeJS.Timeout | null = null;
  private telemetryByCamera: Record<string, CameraTelemetry> = {};
  private probeCache = new Map<string, CachedCameraProbe>();
  private startTimeMs = Date.now();

  public start(): void {
    if (this.timer) {
      clearInterval(this.timer);
    }

    void this.tick();
    this.timer = setInterval(() => {
      void this.tick();
    }, 10000);

    console.log('[WatchdogService] Process & Camera Health Watchdog active');
  }

  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  public getTelemetryMap(): Record<string, CameraTelemetry> {
    return this.telemetryByCamera;
  }

  public getSystemHealth(): SystemHealthStatus {
    const bin = binaryResolver.getCached();
    const go2rtcStatus = go2rtcManager.getStatus();
    const aiHealth = aiVisionEngine.getHealth();
    const disk = storageCleaner.getDiskMetrics();

    return {
      go2rtcOnline: go2rtcStatus.online,
      go2rtcPid: go2rtcStatus.pid,
      go2rtcApiUrl: go2rtcManager.getApiUrl(),
      go2rtcRtspPort: go2rtcManager.getRtspPort(),
      ffmpegAvailable: bin.ffmpegAvailable,
      ffmpegPath: bin.ffmpegPath,
      nvencSupported: bin.nvencSupported,
      codeProjectOnline: aiHealth.online,
      codeProjectLatencyMs: aiHealth.latencyMs,
      storageUsedBytes: disk.storageUsedBytes,
      storageQuotaBytes: disk.storageQuotaBytes,
      storageUsagePercent: disk.storageUsagePercent,
      diskTotalBytes: disk.diskTotalBytes,
      diskFreeBytes: disk.diskFreeBytes,
      diskUsagePercent: disk.diskUsagePercent,
      segmentCount: disk.segmentCount,
      lockedSegmentCount: disk.lockedSegmentCount,
      eventCount: EventRepository.getCount(),
      activeRecorders: recorderManager.getActiveRecorderCount(),
      uptimeSeconds: Math.floor((Date.now() - this.startTimeMs) / 1000),
    };
  }

  private ensureProbed(cameraId: string, mainUrl: string, subUrl: string): CachedCameraProbe | undefined {
    const existing = this.probeCache.get(cameraId);
    const now = Date.now();
    const cacheTtlMs = existing?.main?.reachable ? 30 * 60 * 1000 : 120000;
    if (existing && (existing.probing || now - existing.probedAt < cacheTtlMs)) {
      return existing;
    }

    const entry: CachedCameraProbe = existing || { probedAt: now, probing: true };
    entry.probing = true;
    this.probeCache.set(cameraId, entry);

    void Promise.all([
      streamProber.probeStream(mainUrl, 6000),
      subUrl && subUrl !== mainUrl ? streamProber.probeStream(subUrl, 6000) : Promise.resolve(undefined),
    ])
      .then(([mainRes, subRes]) => {
        entry.main = mainRes;
        entry.sub = subRes ?? mainRes;
        entry.probedAt = Date.now();
        entry.probing = false;
      })
      .catch(() => {
        entry.probedAt = Date.now();
        entry.probing = false;
      });

    return entry;
  }

  private async tick(): Promise<void> {
    await go2rtcManager.checkApiHealth();
    const streamsInfo = await go2rtcManager.getActiveStreamsInfo();

    const cameras = CameraRepository.getAll();
    const nextTelemetry: Record<string, CameraTelemetry> = {};

    for (const cam of cameras) {
      const worker = recorderManager.getWorkerState(cam.id);
      const motionActive = aiVisionEngine.isCameraMotionActive(cam.id);
      const activeDetections = aiVisionEngine.getActiveDetections(cam.id);
      const probe = cam.enabled
        ? this.ensureProbed(cam.id, cam.main_stream_url, cam.sub_stream_url)
        : undefined;

      const mainStreamData = streamsInfo[`${cam.id}_main`] as
        | { producers?: Array<{ medias?: string[]; recv?: number }> }
        | undefined;
      const hasActiveProducer = Boolean(
        mainStreamData?.producers && mainStreamData.producers.length > 0
      );

      const mainProbe = probe?.main;
      const subProbe = probe?.sub;

      const baseBitrate =
        mainProbe?.reachable && mainProbe.bitrateKbps > 0
          ? mainProbe.bitrateKbps
          : cam.force_h264
            ? 5400
            : 8192;

      let status: CameraTelemetry['status'] = 'online';
      if (!cam.enabled || (mainProbe && !mainProbe.reachable && !hasActiveProducer)) {
        status = 'offline';
      } else if (motionActive) {
        status = 'motion';
      } else if (worker.isRecording || cam.record_mode === 'continuous') {
        status = 'recording';
      } else if (hasActiveProducer) {
        status = 'online';
      }

      nextTelemetry[cam.id] = {
        cameraId: cam.id,
        status,
        codec: cam.force_h264
          ? 'H.264 / NVENC'
          : mainProbe?.reachable
            ? mainProbe.videoCodec
            : 'H.264 / AVC',
        subCodec: subProbe?.reachable ? subProbe.videoCodec : 'H.264 / AVC',
        resolution: mainProbe?.reachable ? mainProbe.resolution : '3840x2160',
        subResolution: subProbe?.reachable ? subProbe.resolution : '704x576',
        fps: mainProbe?.reachable && mainProbe.fps > 0 ? mainProbe.fps : 20,
        bitrateKbps: cam.enabled ? baseBitrate : 0,
        audioCodec: mainProbe?.reachable ? mainProbe.audioCodec : 'AAC-LC',
        isRecording: cam.enabled && (worker.isRecording || cam.record_mode === 'continuous'),
        isManualRecording: worker.isManualRecording,
        isMotionActive: motionActive,
        reconnectAttempts: worker.reconnectAttempts,
        nextRetryInSec:
          worker.reconnectAttempts > 0
            ? Math.min(Math.pow(2, Math.min(worker.reconnectAttempts, 6)), 60)
            : undefined,
        lastError: worker.lastError,
        lastUpdated: Date.now(),
        activeDetections,
      };
    }

    this.telemetryByCamera = nextTelemetry;

    wsHub.broadcast({
      type: 'CAMERA_TELEMETRY',
      telemetry: this.telemetryByCamera,
    });

    wsHub.broadcast({
      type: 'SYSTEM_HEALTH',
      health: this.getSystemHealth(),
    });
  }
}

export const watchdogService = new WatchdogService();

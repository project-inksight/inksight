import fs from 'fs';
import path from 'path';
import { spawn, ChildProcess, execFile } from 'child_process';
import { promisify } from 'util';
import chokidar, { FSWatcher } from 'chokidar';
import { Camera, RecordingSegment } from '../../shared/types.js';
import { CameraRepository, SegmentRepository, SettingsRepository } from '../db/repositories.js';
import { binaryResolver } from './binaryResolver.js';
import { go2rtcManager } from './go2rtcManager.js';
import { wsHub } from './wsHub.js';

const execFileAsync = promisify(execFile);

interface CameraRecorderWorker {
  cameraId: string;
  process: ChildProcess | null;
  isRecording: boolean;
  isManualOverride: boolean;
  eventRecordStopTimer: NodeJS.Timeout | null;
  reconnectAttempts: number;
  reconnectTimer: NodeJS.Timeout | null;
  lastError?: string;
  currentFilePath?: string;
}

export class RecorderManager {
  private workers = new Map<string, CameraRecorderWorker>();
  private watcher: FSWatcher | null = null;
  private dirMaintenanceTimer: NodeJS.Timeout | null = null;
  private isShuttingDown = false;

  public async initialize(): Promise<void> {
    this.isShuttingDown = false;
    const settings = SettingsRepository.getSettings();
    const recordingsRoot = path.join(settings.storage.storagePath, 'recordings');

    if (!fs.existsSync(recordingsRoot)) {
      fs.mkdirSync(recordingsRoot, { recursive: true });
    }

    // Ensure date/hour folders exist now and every 5 minutes so FFmpeg -strftime 1 never fails
    this.ensureCameraHourDirectories();
    this.dirMaintenanceTimer = setInterval(() => {
      this.ensureCameraHourDirectories();
    }, 5 * 60 * 1000);

    // Start Chokidar File Indexer Watcher
    this.startFileWatcher(recordingsRoot);

    // Sync workers for all enabled cameras
    this.syncAllCameraRecorders();
  }

  public ensureCameraHourDirectories(): void {
    const settings = SettingsRepository.getSettings();
    const recordingsRoot = path.join(settings.storage.storagePath, 'recordings');
    const cameras = CameraRepository.getAll();
    const now = new Date();
    const nextHour = new Date(now.getTime() + 60 * 60 * 1000);

    for (const cam of cameras) {
      for (const dt of [now, nextHour]) {
        const yyyy = dt.getFullYear();
        const mm = String(dt.getMonth() + 1).padStart(2, '0');
        const dd = String(dt.getDate()).padStart(2, '0');
        const hh = String(dt.getHours()).padStart(2, '0');
        const dirPath = path.join(recordingsRoot, cam.id, `${yyyy}-${mm}-${dd}`, hh);
        if (!fs.existsSync(dirPath)) {
          fs.mkdirSync(dirPath, { recursive: true });
        }
      }
    }
  }

  private startFileWatcher(recordingsRoot: string): void {
    if (this.watcher) {
      void this.watcher.close();
    }

    this.watcher = chokidar.watch(recordingsRoot, {
      ignoreInitial: false,
      persistent: true,
      depth: 4,
      awaitWriteFinish: {
        stabilityThreshold: 2500,
        pollInterval: 500,
      },
    });

    this.watcher.on('add', (filePath) => {
      if (filePath.endsWith('.mp4')) {
        void this.indexCompletedSegmentFile(filePath);
      }
    });

    this.watcher.on('change', (filePath) => {
      if (filePath.endsWith('.mp4')) {
        void this.indexCompletedSegmentFile(filePath);
      }
    });

    console.log(`[RecorderManager] File Indexer watching ${recordingsRoot}`);
  }

  public async indexCompletedSegmentFile(filePath: string): Promise<RecordingSegment | null> {
    try {
      if (!fs.existsSync(filePath)) return null;
      const stat = fs.statSync(filePath);
      // Ignore tiny header-only incomplete files
      if (stat.size < 4096) return null;

      const normalizedPath = path.resolve(filePath);
      const existing = SegmentRepository.getByFilePath(normalizedPath);
      if (existing && existing.file_size_bytes === stat.size) {
        return existing;
      }

      // Extract camera_id from path: .../recordings/<camera_id>/<YYYY-MM-DD>/<HH>/<YYYYMMDD_HHMMSS>.mp4
      const settings = SettingsRepository.getSettings();
      const recordingsRoot = path.resolve(settings.storage.storagePath, 'recordings');
      const rel = path.relative(recordingsRoot, normalizedPath);
      const parts = rel.split(path.sep);
      if (parts.length < 2) return null;

      const cameraId = parts[0];
      const camera = CameraRepository.getById(cameraId);
      if (!camera) return null;

      const baseName = path.basename(normalizedPath, '.mp4');
      let startTimeMs = Math.floor(stat.birthtimeMs || stat.mtimeMs - 60000);

      // Parse YYYYMMDD_HHMMSS if present
      const match = baseName.match(/^(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})/);
      if (match) {
        const [, y, m, d, hh, mm, ss] = match;
        const parsed = new Date(
          Number(y),
          Number(m) - 1,
          Number(d),
          Number(hh),
          Number(mm),
          Number(ss)
        ).getTime();
        if (!Number.isNaN(parsed)) {
          startTimeMs = parsed;
        }
      }

      // Probe duration via ffprobe if possible, fallback to 60s
      let durationSec = settings.storage.segmentDurationSeconds || 60;
      try {
        const ffprobePath = binaryResolver.resolveFFprobe();
        const { stdout } = await execFileAsync(
          ffprobePath,
          ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', normalizedPath],
          { timeout: 3000 }
        );
        const parsedDur = parseFloat(stdout.trim());
        if (parsedDur > 0 && Number.isFinite(parsedDur)) {
          durationSec = Math.round(parsedDur * 10) / 10;
        }
      } catch {
        // use default 60s
      }

      const endTimeMs = startTimeMs + Math.round(durationSec * 1000);
      const segmentId = existing?.id || `seg_${cameraId}_${startTimeMs}`;

      const segment: RecordingSegment = {
        id: segmentId,
        camera_id: cameraId,
        file_path: normalizedPath,
        start_time: startTimeMs,
        end_time: endTimeMs,
        duration_sec: durationSec,
        file_size_bytes: stat.size,
        has_ai_event: existing?.has_ai_event ?? false,
        is_locked: existing?.is_locked ?? false,
        camera_name: camera.name,
      };

      SegmentRepository.insert(segment);
      if (!existing) {
        wsHub.broadcast({ type: 'SEGMENT_ADDED', segment });
      }
      return segment;
    } catch (err) {
      console.warn('[RecorderManager] Failed to index segment file:', (err as Error).message);
      return null;
    }
  }

  public syncAllCameraRecorders(): void {
    const cameras = CameraRepository.getAll();
    const activeIds = new Set(cameras.map((c) => c.id));

    // Stop workers for deleted cameras
    for (const [camId] of this.workers) {
      if (!activeIds.has(camId)) {
        this.stopCameraRecorder(camId);
        this.workers.delete(camId);
      }
    }

    for (const cam of cameras) {
      this.syncCameraRecorder(cam);
    }
  }

  public syncCameraRecorder(camera: Camera): void {
    let worker = this.workers.get(camera.id);
    if (!worker) {
      worker = {
        cameraId: camera.id,
        process: null,
        isRecording: false,
        isManualOverride: false,
        eventRecordStopTimer: null,
        reconnectAttempts: 0,
        reconnectTimer: null,
      };
      this.workers.set(camera.id, worker);
    }

    if (!camera.enabled) {
      this.stopCameraRecorder(camera.id);
      return;
    }

    const shouldRecordContinuously = camera.record_mode === 'continuous' || worker.isManualOverride;
    if (shouldRecordContinuously && !worker.process) {
      this.spawnFFmpegRecorder(camera, worker);
    } else if (!shouldRecordContinuously && camera.record_mode === 'off' && !worker.isManualOverride) {
      this.stopCameraRecorder(camera.id);
    }
  }

  /**
   * Spawns the Direct-to-Disk FFmpeg segment worker pulling from go2rtc RTSP restream:
   * ffmpeg -hide_banner -loglevel error -rtsp_transport tcp -use_wallclock_as_timestamps 1
   *   -i rtsp://127.0.0.1:8554/{camera_id}_main -c:v copy -c:a aac
   *   -f segment -segment_time 60 -segment_atclocktime 1 -reset_timestamps 1 -strftime 1
   *   "<storage_path>/recordings/<camera_id>/%Y-%m-%d/%H/%Y%m%d_%H%M%S.mp4"
   */
  private spawnFFmpegRecorder(camera: Camera, worker: CameraRecorderWorker): void {
    if (this.isShuttingDown) return;
    if (worker.reconnectTimer) {
      clearTimeout(worker.reconnectTimer);
      worker.reconnectTimer = null;
    }

    this.ensureCameraHourDirectories();
    const settings = SettingsRepository.getSettings();
    const ffmpegPath = binaryResolver.resolveFFmpeg();

    const inputRtsp = go2rtcManager.getStatus().online
      ? `${go2rtcManager.getRtspBaseUrl()}/${camera.id}_main`
      : camera.main_stream_url;

    const outputPattern = path
      .join(settings.storage.storagePath, 'recordings', camera.id, '%Y-%m-%d', '%H', '%Y%m%d_%H%M%S.mp4')
      .replace(/\\/g, '/');

    const segmentTime = String(settings.storage.segmentDurationSeconds || 60);

    const args = [
      '-hide_banner',
      '-loglevel',
      'error',
      '-rtsp_transport',
      'tcp',
      '-use_wallclock_as_timestamps',
      '1',
      '-i',
      inputRtsp,
      '-c:v',
      'copy',
      '-c:a',
      'aac',
      '-f',
      'segment',
      '-segment_time',
      segmentTime,
      '-segment_atclocktime',
      '1',
      '-reset_timestamps',
      '1',
      '-strftime',
      '1',
      '-segment_format_options',
      'movflags=+frag_keyframe+empty_moov+default_base_moof',
      outputPattern,
    ];

    try {
      const proc = spawn(ffmpegPath, args, {
        stdio: ['ignore', 'ignore', 'pipe'],
        windowsHide: true,
      });

      worker.process = proc;
      worker.isRecording = true;

      proc.stderr?.on('data', (chunk: Buffer) => {
        const msg = chunk.toString().trim();
        if (msg) {
          worker.lastError = msg.split('\n')[0];
        }
      });

      proc.on('exit', (code) => {
        worker.process = null;
        worker.isRecording = false;

        if (this.isShuttingDown) return;

        const freshCam = CameraRepository.getById(camera.id);
        if (!freshCam || !freshCam.enabled) return;

        const stillNeedsRecord =
          freshCam.record_mode === 'continuous' ||
          worker.isManualOverride ||
          worker.eventRecordStopTimer !== null;

        if (stillNeedsRecord) {
          worker.reconnectAttempts += 1;
          const backoffSec = Math.min(Math.pow(2, Math.min(worker.reconnectAttempts, 6)), 60);
          worker.reconnectTimer = setTimeout(() => {
            const latestCam = CameraRepository.getById(camera.id);
            if (latestCam && latestCam.enabled) {
              this.spawnFFmpegRecorder(latestCam, worker);
            }
          }, backoffSec * 1000);
        }
      });
    } catch (err) {
      worker.lastError = (err as Error).message;
      worker.isRecording = false;
    }
  }

  public triggerEventRecording(cameraId: string, durationSec = 30): void {
    const camera = CameraRepository.getById(cameraId);
    if (!camera || !camera.enabled) return;

    let worker = this.workers.get(cameraId);
    if (!worker) {
      this.syncCameraRecorder(camera);
      worker = this.workers.get(cameraId)!;
    }

    if (camera.record_mode === 'events_only') {
      if (!worker.process) {
        this.spawnFFmpegRecorder(camera, worker);
      }
      if (worker.eventRecordStopTimer) {
        clearTimeout(worker.eventRecordStopTimer);
      }
      worker.eventRecordStopTimer = setTimeout(() => {
        worker!.eventRecordStopTimer = null;
        const latest = CameraRepository.getById(cameraId);
        if (latest && latest.record_mode === 'events_only' && !worker!.isManualOverride) {
          this.stopCameraRecorder(cameraId);
        }
      }, durationSec * 1000);
    }
  }

  public setManualRecording(cameraId: string, enable: boolean): boolean {
    const camera = CameraRepository.getById(cameraId);
    if (!camera) return false;

    let worker = this.workers.get(cameraId);
    if (!worker) {
      this.syncCameraRecorder(camera);
      worker = this.workers.get(cameraId)!;
    }

    worker.isManualOverride = enable;
    if (enable && !worker.process) {
      this.spawnFFmpegRecorder(camera, worker);
    } else if (!enable && camera.record_mode !== 'continuous') {
      this.stopCameraRecorder(cameraId);
    }
    return worker.isManualOverride;
  }

  public stopCameraRecorder(cameraId: string): void {
    const worker = this.workers.get(cameraId);
    if (!worker) return;

    if (worker.reconnectTimer) {
      clearTimeout(worker.reconnectTimer);
      worker.reconnectTimer = null;
    }
    if (worker.eventRecordStopTimer) {
      clearTimeout(worker.eventRecordStopTimer);
      worker.eventRecordStopTimer = null;
    }
    if (worker.process) {
      try {
        worker.process.kill('SIGTERM');
      } catch {
        // ignore
      }
      worker.process = null;
    }
    worker.isRecording = false;
  }

  public getWorkerState(cameraId: string): {
    isRecording: boolean;
    isManualRecording: boolean;
    reconnectAttempts: number;
    lastError?: string;
  } {
    const w = this.workers.get(cameraId);
    const cam = CameraRepository.getById(cameraId);
    return {
      isRecording: Boolean(w?.isRecording || cam?.record_mode === 'continuous'),
      isManualRecording: Boolean(w?.isManualOverride),
      reconnectAttempts: w?.reconnectAttempts ?? 0,
      lastError: w?.lastError,
    };
  }

  public getActiveRecorderCount(): number {
    let count = 0;
    for (const cam of CameraRepository.getAll()) {
      if (cam.enabled && (cam.record_mode === 'continuous' || this.workers.get(cam.id)?.isRecording)) {
        count++;
      }
    }
    return count;
  }

  /**
   * Pre-Event Clip Extraction (Section 2C):
   * Waits until T + postBufferSeconds (when triggered live), then uses FFmpeg -ss and -to
   * with -c copy (stitching across segment boundaries if necessary) to extract a standalone
   * alert clip spanning [T - preBufferSeconds, T + postBufferSeconds] into /storage/alerts/clips/.
   */
  public async extractPrePostEventClip(params: {
    eventId: string;
    cameraId: string;
    eventTimestampMs: number;
    waitForPostBuffer?: boolean;
  }): Promise<{ clipPath: string | null; segmentId: string | null }> {
    const settings = SettingsRepository.getSettings();
    const preSec = settings.storage.preBufferSeconds || 5;
    const postSec = settings.storage.postBufferSeconds || 10;
    const totalDurationSec = preSec + postSec;

    const clipStartMs = params.eventTimestampMs - preSec * 1000;
    const clipEndMs = params.eventTimestampMs + postSec * 1000;

    if (params.waitForPostBuffer) {
      const waitMs = Math.max(0, clipEndMs - Date.now());
      if (waitMs > 0 && waitMs <= 15000) {
        await new Promise((r) => setTimeout(r, Math.min(waitMs, 3000)));
      }
    }

    const clipsDir = path.join(settings.storage.storagePath, 'alerts', 'clips');
    if (!fs.existsSync(clipsDir)) {
      fs.mkdirSync(clipsDir, { recursive: true });
    }

    const clipFilename = `clip_${params.cameraId}_${params.eventTimestampMs}.mp4`;
    const clipOutputPath = path.join(clipsDir, clipFilename);

    // Find overlapping segments in SQLite
    const overlapping = SegmentRepository.getSegmentsInRange({
      cameraId: params.cameraId,
      startTime: clipStartMs - 60000,
      endTime: clipEndMs + 60000,
    }).filter((s) => s.end_time >= clipStartMs && s.start_time <= clipEndMs && fs.existsSync(s.file_path));

    const primarySegment =
      overlapping.find((s) => s.start_time <= params.eventTimestampMs && s.end_time >= params.eventTimestampMs) ||
      overlapping[0] ||
      SegmentRepository.findSegmentAtTimestamp(params.cameraId, params.eventTimestampMs);

    if (primarySegment) {
      SegmentRepository.markHasAiEvent(primarySegment.id);
    }

    const ffmpegPath = binaryResolver.resolveFFmpeg();

    try {
      if (overlapping.length === 1) {
        const seg = overlapping[0];
        const ssSec = Math.max(0, (clipStartMs - seg.start_time) / 1000);
        const toSec = Math.min(seg.duration_sec, ssSec + totalDurationSec);

        await execFileAsync(
          ffmpegPath,
          [
            '-hide_banner',
            '-loglevel',
            'error',
            '-y',
            '-ss',
            ssSec.toFixed(2),
            '-to',
            Math.max(ssSec + 2, toSec).toFixed(2),
            '-i',
            seg.file_path,
            '-c',
            'copy',
            '-movflags',
            '+faststart',
            clipOutputPath,
          ],
          { timeout: 15000 }
        );
      } else if (overlapping.length > 1) {
        // Stitch across segment boundaries using FFmpeg concat demuxer with -c copy
        const concatListPath = `${clipOutputPath}.concat.txt`;
        const concatContent = overlapping
          .map((s) => `file '${s.file_path.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`)
          .join('\n');
        fs.writeFileSync(concatListPath, concatContent, 'utf8');

        const firstSegStart = overlapping[0].start_time;
        const ssSec = Math.max(0, (clipStartMs - firstSegStart) / 1000);
        const toSec = ssSec + totalDurationSec;

        await execFileAsync(
          ffmpegPath,
          [
            '-hide_banner',
            '-loglevel',
            'error',
            '-y',
            '-f',
            'concat',
            '-safe',
            '0',
            '-i',
            concatListPath,
            '-ss',
            ssSec.toFixed(2),
            '-to',
            toSec.toFixed(2),
            '-c',
            'copy',
            '-movflags',
            '+faststart',
            clipOutputPath,
          ],
          { timeout: 20000 }
        );

        try {
          fs.unlinkSync(concatListPath);
        } catch {
          // ignore
        }
      }
    } catch (err) {
      console.warn('[RecorderManager] Segment copy extraction error, trying single segment or live RTSP clip:', (err as Error).message);
    }

    // Fallback 1: If multi-segment concat failed because the newest segment was still flushing, extract from primary/first segment
    if (
      (!fs.existsSync(clipOutputPath) || fs.statSync(clipOutputPath).size < 1024) &&
      overlapping.length > 0
    ) {
      const seg = primarySegment && fs.existsSync(primarySegment.file_path) ? primarySegment : overlapping[0];
      const ssSec = Math.max(0, Math.min(45, (clipStartMs - seg.start_time) / 1000));
      try {
        await execFileAsync(
          ffmpegPath,
          [
            '-hide_banner',
            '-loglevel',
            'error',
            '-y',
            '-ss',
            ssSec.toFixed(2),
            '-t',
            String(totalDurationSec),
            '-i',
            seg.file_path,
            '-c',
            'copy',
            '-movflags',
            '+faststart',
            clipOutputPath,
          ],
          { timeout: 15000 }
        );
      } catch {
        // fallback 2 below
      }
    }

    // Fallback 2: Direct RTSP stream copy clip from go2rtc restream if segment wasn't ready yet
    if (!fs.existsSync(clipOutputPath) || fs.statSync(clipOutputPath).size < 1024) {
      const cam = CameraRepository.getById(params.cameraId);
      if (cam && cam.enabled) {
        const inputRtsp = go2rtcManager.getStatus().online
          ? `${go2rtcManager.getRtspBaseUrl()}/${cam.id}_main`
          : cam.main_stream_url;
        try {
          await execFileAsync(
            ffmpegPath,
            [
              '-hide_banner',
              '-loglevel',
              'error',
              '-y',
              '-rtsp_transport',
              'tcp',
              '-i',
              inputRtsp,
              '-t',
              '8',
              '-c:v',
              'copy',
              '-c:a',
              'aac',
              '-movflags',
              '+faststart',
              clipOutputPath,
            ],
            { timeout: 15000 }
          );
        } catch {
          // ignore
        }
      }
    }

    return {
      clipPath:
        fs.existsSync(clipOutputPath) && fs.statSync(clipOutputPath).size >= 1024
          ? clipOutputPath
          : null,
      segmentId: primarySegment?.id ?? null,
    };
  }

  /**
   * Custom Time-Range Video Clip Export:
   * Stitches all 60-second Direct-to-Disk MP4 segments overlapping [startTimeMs, endTimeMs]
   * using FFmpeg -c copy (zero re-encoding, <1s execution) and trims to the exact time window.
   */
  public async exportCustomTimeRangeClip(params: {
    cameraId: string;
    startTimeMs: number;
    endTimeMs: number;
  }): Promise<{ filePath: string; filename: string }> {
    const camera = CameraRepository.getById(params.cameraId);
    if (!camera) {
      throw new Error('Camera not found');
    }

    const startMs = Math.min(params.startTimeMs, params.endTimeMs);
    const endMs = Math.max(params.startTimeMs, params.endTimeMs);
    const requestedDurationSec = Math.max(5, Math.min(1800, (endMs - startMs) / 1000));

    const overlapping = SegmentRepository.getSegmentsInRange({
      cameraId: params.cameraId,
      startTime: startMs - 120000,
      endTime: endMs + 120000,
    })
      .filter((s) => s.end_time >= startMs && s.start_time <= endMs && fs.existsSync(s.file_path))
      .sort((a, b) => a.start_time - b.start_time);

    if (overlapping.length === 0) {
      throw new Error('No recorded video segments found on disk for the selected time range.');
    }

    const settings = SettingsRepository.getSettings();
    const exportsDir = path.join(settings.storage.storagePath, 'exports');
    if (!fs.existsSync(exportsDir)) {
      fs.mkdirSync(exportsDir, { recursive: true });
    }

    const formatStamp = (ms: number) => {
      const d = new Date(ms);
      const yyyy = d.getFullYear();
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      const dd = String(d.getDate()).padStart(2, '0');
      const hh = String(d.getHours()).padStart(2, '0');
      const min = String(d.getMinutes()).padStart(2, '0');
      const ss = String(d.getSeconds()).padStart(2, '0');
      return `${yyyy}${mm}${dd}_${hh}${min}${ss}`;
    };

    const safeCamName = camera.name.replace(/[^a-zA-Z0-9_-]/g, '_');
    const filename = `Inksight_${safeCamName}_${formatStamp(startMs)}_to_${formatStamp(endMs).slice(9)}.mp4`;
    const outputPath = path.join(exportsDir, filename);
    const ffmpegPath = binaryResolver.resolveFFmpeg();

    if (overlapping.length === 1) {
      const seg = overlapping[0];
      const ssSec = Math.max(0, (startMs - seg.start_time) / 1000);
      const toSec = Math.min(seg.duration_sec, ssSec + requestedDurationSec);

      await execFileAsync(
        ffmpegPath,
        [
          '-hide_banner',
          '-loglevel',
          'error',
          '-y',
          '-ss',
          ssSec.toFixed(2),
          '-to',
          Math.max(ssSec + 2, toSec).toFixed(2),
          '-i',
          seg.file_path,
          '-c',
          'copy',
          '-movflags',
          '+faststart',
          outputPath,
        ],
        { timeout: 30000 }
      );
    } else {
      const concatListPath = `${outputPath}.concat.txt`;
      const concatContent = overlapping
        .map((s) => `file '${s.file_path.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`)
        .join('\n');
      fs.writeFileSync(concatListPath, concatContent, 'utf8');

      const firstSegStart = overlapping[0].start_time;
      const ssSec = Math.max(0, (startMs - firstSegStart) / 1000);
      const toSec = ssSec + requestedDurationSec;

      try {
        await execFileAsync(
          ffmpegPath,
          [
            '-hide_banner',
            '-loglevel',
            'error',
            '-y',
            '-f',
            'concat',
            '-safe',
            '0',
            '-i',
            concatListPath,
            '-ss',
            ssSec.toFixed(2),
            '-to',
            toSec.toFixed(2),
            '-c',
            'copy',
            '-movflags',
            '+faststart',
            outputPath,
          ],
          { timeout: 45000 }
        );
      } finally {
        try {
          if (fs.existsSync(concatListPath)) fs.unlinkSync(concatListPath);
        } catch {
          // ignore
        }
      }
    }

    if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size < 1024) {
      throw new Error('FFmpeg failed to produce an exported MP4 clip for the selected range.');
    }

    return { filePath: outputPath, filename };
  }

  public stopAll(): void {
    this.isShuttingDown = true;
    if (this.dirMaintenanceTimer) {
      clearInterval(this.dirMaintenanceTimer);
      this.dirMaintenanceTimer = null;
    }
    if (this.watcher) {
      void this.watcher.close();
      this.watcher = null;
    }
    for (const [camId] of this.workers) {
      this.stopCameraRecorder(camId);
    }
  }
}

export const recorderManager = new RecorderManager();


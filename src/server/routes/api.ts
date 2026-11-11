import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawn, execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
import {
  CameraRepository,
  SegmentRepository,
  EventRepository,
  SettingsRepository,
} from '../db/repositories.js';
import { go2rtcManager } from '../services/go2rtcManager.js';
import { streamProber } from '../services/streamProber.js';
import { recorderManager } from '../services/recorderManager.js';
import { aiVisionEngine } from '../services/aiVisionEngine.js';
import { alertEngine } from '../services/alertEngine.js';
import { storageCleaner } from '../services/storageCleaner.js';
import { watchdogService } from '../services/watchdogService.js';

export const apiRouter = Router();

/**
 * Helper to stream an MP4 file with full RFC 7233 HTTP 206 Partial Content Byte-Range support.
 */
function streamMp4WithByteRange(req: Request, res: Response, filePath: string, downloadFilename?: string): void {
  if (!fs.existsSync(filePath)) {
    res.status(404).json({ error: 'Video file not found on disk' });
    return;
  }

  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  const range = req.headers.range;

  if (downloadFilename) {
    res.setHeader('Content-Disposition', `attachment; filename="${downloadFilename}"`);
  }

  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

    if (start >= fileSize || end >= fileSize || start > end) {
      res.writeHead(416, {
        'Content-Range': `bytes */${fileSize}`,
      });
      res.end();
      return;
    }

    const chunkSize = end - start + 1;
    const fileStream = fs.createReadStream(filePath, { start, end });

    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunkSize,
      'Content-Type': 'video/mp4',
      'Cache-Control': 'no-cache',
    });

    fileStream.pipe(res);
  } else {
    res.writeHead(200, {
      'Content-Length': fileSize,
      'Accept-Ranges': 'bytes',
      'Content-Type': 'video/mp4',
      'Cache-Control': 'no-cache',
    });
    fs.createReadStream(filePath).pipe(res);
  }
}

// ============================================================================
// 1. CAMERAS CRUD & STREAM OPERATIONS
// ============================================================================

function syncCredentialsIntoRtspUrl(
  rawUrl: string,
  username?: string,
  password?: string,
  ipAddress?: string
): string {
  if (!rawUrl || (!rawUrl.startsWith('rtsp://') && !rawUrl.startsWith('rtsps://'))) {
    return rawUrl;
  }
  try {
    const u = new URL(rawUrl);
    if (username !== undefined && username !== '') {
      u.username = username;
    }
    if (password !== undefined && password !== '') {
      u.password = password;
    }
    if (ipAddress && ipAddress.trim()) {
      u.hostname = ipAddress.trim();
    }
    return u.toString();
  } catch {
    return rawUrl;
  }
}

apiRouter.get('/cameras', (_req: Request, res: Response) => {
  const cameras = CameraRepository.getAll();
  const telemetry = watchdogService.getTelemetryMap();
  res.json({ cameras, telemetry });
});

apiRouter.get('/cameras/discover', async (_req: Request, res: Response) => {
  try {
    const discovered = await streamProber.discoverLanCameras();
    res.json({ discovered });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

apiRouter.post('/cameras', async (req: Request, res: Response) => {
  try {
    const body = req.body;
    const id =
      body.id ||
      `cam_${(body.name || 'camera').toLowerCase().replace(/[^a-z0-9]+/g, '_')}_${Date.now().toString(36)}`;

    const ip = body.ip_address || '192.168.1.100';
    const user = body.username ?? 'admin';
    const pass = body.password ?? '';

    const mainUrl = syncCredentialsIntoRtspUrl(body.main_stream_url || '', user, pass, ip);
    const subUrl = syncCredentialsIntoRtspUrl(
      body.sub_stream_url || body.main_stream_url || '',
      user,
      pass,
      ip
    );

    const created = CameraRepository.create({
      id,
      name: body.name || 'New IP Camera',
      ip_address: ip,
      onvif_port: Number(body.onvif_port ?? 80),
      username: user,
      password: pass,
      main_stream_url: mainUrl,
      sub_stream_url: subUrl,
      record_mode: body.record_mode || 'continuous',
      ai_enabled: body.ai_enabled !== false,
      ai_classes: Array.isArray(body.ai_classes) ? body.ai_classes : ['person', 'car', 'truck'],
      min_confidence: Number(body.min_confidence ?? 65),
      zones: Array.isArray(body.zones) ? body.zones : [],
      cooldown_seconds: Number(body.cooldown_seconds ?? 60),
      force_h264: Boolean(body.force_h264),
      enabled: body.enabled !== false,
      schedule_mode: body.schedule_mode || '24/7',
      schedule_start: body.schedule_start || '20:00',
      schedule_end: body.schedule_end || '06:00',
      webhook_url: body.webhook_url || '',
      action_script: body.action_script || '',
      audio_compat: body.audio_compat || 'aac',
    });

    await go2rtcManager.reload();
    recorderManager.syncCameraRecorder(created);

    res.status(201).json({ camera: created });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

apiRouter.put('/cameras/:id', async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);
    const existing = CameraRepository.getById(id);
    if (!existing) {
      res.status(404).json({ error: 'Camera not found' });
      return;
    }

    const patch = { ...req.body };
    const ip = patch.ip_address ?? existing.ip_address;
    const user = patch.username ?? existing.username;
    const pass = patch.password ?? existing.password;

    if (patch.main_stream_url || patch.ip_address || patch.username || patch.password) {
      patch.main_stream_url = syncCredentialsIntoRtspUrl(
        patch.main_stream_url || existing.main_stream_url,
        user,
        pass,
        ip
      );
    }
    if (patch.sub_stream_url || patch.ip_address || patch.username || patch.password) {
      patch.sub_stream_url = syncCredentialsIntoRtspUrl(
        patch.sub_stream_url || existing.sub_stream_url,
        user,
        pass,
        ip
      );
    }

    const updated = CameraRepository.update(id, patch);
    if (!updated) {
      res.status(404).json({ error: 'Camera not found' });
      return;
    }

    const streamChanged =
      updated.sub_stream_url !== existing.sub_stream_url ||
      updated.main_stream_url !== existing.main_stream_url ||
      updated.enabled !== existing.enabled ||
      updated.ai_enabled !== existing.ai_enabled;

    if (!updated.enabled || !updated.ai_enabled || streamChanged) {
      streamProber.stopSubStreamPipe(id);
    }
    if (streamChanged) {
      aiVisionEngine.resetCameraState(id);
    }

    await go2rtcManager.reload();
    recorderManager.syncCameraRecorder(updated);

    res.json({ camera: updated });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

apiRouter.delete('/cameras/:id', async (req: Request, res: Response) => {
  const id = String(req.params.id);
  recorderManager.stopCameraRecorder(id);
  streamProber.stopSubStreamPipe(id);
  aiVisionEngine.resetCameraState(id);
  const deleted = CameraRepository.delete(id);
  if (!deleted) {
    res.status(404).json({ error: 'Camera not found' });
    return;
  }

  await go2rtcManager.reload();
  res.json({ success: true });
});

apiRouter.post('/cameras/probe', async (req: Request, res: Response) => {
  const { mainStreamUrl, subStreamUrl, username, password, ipAddress, cameraId } = req.body as {
    mainStreamUrl?: string;
    subStreamUrl?: string;
    username?: string;
    password?: string;
    ipAddress?: string;
    cameraId?: string;
  };
  if (!mainStreamUrl) {
    res.status(400).json({ error: 'mainStreamUrl is required' });
    return;
  }

  let effectiveUser = username;
  let effectivePass = password;
  let effectiveIp = ipAddress;

  // If the client still had placeholder 'password123' in memory, check SQLite for saved credentials on that camera/IP
  if (!effectivePass || effectivePass === 'password123' || mainStreamUrl.includes('password123')) {
    const allCams = CameraRepository.getAll();
    let matchedCam = cameraId ? allCams.find((c) => c.id === cameraId) : undefined;
    if (!matchedCam) {
      try {
        const parsedHost = new URL(mainStreamUrl).hostname;
        matchedCam = allCams.find((c) => c.ip_address === (effectiveIp || parsedHost));
      } catch {
        // ignore
      }
    }
    if (matchedCam && matchedCam.password && matchedCam.password !== 'password123') {
      effectiveUser = matchedCam.username;
      effectivePass = matchedCam.password;
      effectiveIp = matchedCam.ip_address;
    }
  }

  const resolvedMainUrl = syncCredentialsIntoRtspUrl(
    mainStreamUrl,
    effectiveUser,
    effectivePass,
    effectiveIp
  );
  const resolvedSubUrl = subStreamUrl
    ? syncCredentialsIntoRtspUrl(subStreamUrl, effectiveUser, effectivePass, effectiveIp)
    : undefined;

  const mainProbe = await streamProber.probeStream(resolvedMainUrl);
  const subProbe = resolvedSubUrl ? await streamProber.probeStream(resolvedSubUrl) : null;

  res.json({
    main: mainProbe,
    sub: subProbe,
    resolvedMainUrl,
    resolvedSubUrl,
  });
});

apiRouter.get('/cameras/:id/snapshot', async (req: Request, res: Response) => {
  const id = String(req.params.id);
  const tier = req.query.tier === 'sub' ? 'sub' : 'main';
  const camera = CameraRepository.getById(id);
  if (!camera) {
    res.status(404).json({ error: 'Camera not found' });
    return;
  }

  try {
    const streamUrl = tier === 'main' ? camera.main_stream_url : camera.sub_stream_url || camera.main_stream_url;
    const buf = await streamProber.captureFrameBuffer(camera.id, camera.name, streamUrl, tier);
    if (req.query.download === '1') {
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${camera.id}_${tier}_${Date.now()}.jpg"`
      );
    }
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'no-store');
    res.send(buf);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

apiRouter.post('/cameras/:id/record', (req: Request, res: Response) => {
  const id = String(req.params.id);
  const { enable } = req.body as { enable?: boolean };
  const current = recorderManager.getWorkerState(id);
  const nextState = enable !== undefined ? Boolean(enable) : !current.isManualRecording;
  const active = recorderManager.setManualRecording(id, nextState);
  res.json({ cameraId: id, isManualRecording: active });
});

apiRouter.post('/cameras/:id/simulate-event', async (req: Request, res: Response) => {
  try {
    const cameraId = String(req.params.id);
    const { objectClass, confidence, box, respectZones } = req.body as {
      objectClass?: string;
      confidence?: number;
      box?: { x1?: number; y1?: number; x2?: number; y2?: number };
      respectZones?: boolean;
    };

    const result = await aiVisionEngine.simulateDetection({
      cameraId,
      objectClass,
      confidence,
      box,
      respectZones,
    });

    res.json(result);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// ============================================================================
// 2. RECORDINGS & SYNCHRONIZED TIMELINE SCRUBBING
// ============================================================================

apiRouter.get('/recordings/timeline', (req: Request, res: Response) => {
  const cameraId = req.query.cameraId ? String(req.query.cameraId) : undefined;
  const endTime = req.query.endTime ? Number(req.query.endTime) : Date.now() + 60000;
  const startTime = req.query.startTime
    ? Number(req.query.startTime)
    : endTime - 24 * 60 * 60 * 1000;

  const segments = SegmentRepository.getSegmentsInRange({
    cameraId,
    startTime,
    endTime,
  });

  const events = EventRepository.getEvents({
    cameraId,
    startTime,
    endTime,
    limit: 2000,
  });

  const days = SegmentRepository.getRecordingDaysSummary(cameraId);

  res.json({ segments, events, days, startTime, endTime });
});

apiRouter.get('/recordings/days', (req: Request, res: Response) => {
  const cameraId = req.query.cameraId ? String(req.query.cameraId) : undefined;
  const days = SegmentRepository.getRecordingDaysSummary(cameraId);
  res.json({ days });
});

apiRouter.get('/recordings/seek', (req: Request, res: Response) => {
  const cameraId = String(req.query.cameraId || '');
  const timestamp = Number(req.query.timestamp || Date.now());

  if (!cameraId) {
    res.status(400).json({ error: 'cameraId is required' });
    return;
  }

  const segment = SegmentRepository.findSegmentAtTimestamp(cameraId, timestamp);
  if (!segment) {
    res.status(404).json({ error: 'No recording segment found near that timestamp' });
    return;
  }

  const offsetSeconds = Math.max(
    0,
    Math.min(segment.duration_sec - 0.5, (timestamp - segment.start_time) / 1000)
  );
  const nextSegment = SegmentRepository.getNextSequentialSegment(cameraId, segment.start_time);

  res.json({
    segment,
    offsetSeconds: Math.round(offsetSeconds * 100) / 100,
    streamUrl: `/api/recordings/stream/${segment.id}`,
    nextSegment,
    nextStreamUrl: nextSegment ? `/api/recordings/stream/${nextSegment.id}` : null,
  });
});

apiRouter.get('/recordings/stream/:segmentId', (req: Request, res: Response) => {
  const segmentId = String(req.params.segmentId);
  const segment = SegmentRepository.getById(segmentId);
  if (!segment) {
    res.status(404).json({ error: 'Recording segment not found' });
    return;
  }

  const downloadFilename =
    req.query.download === '1' ? `${segment.camera_id}_${segment.start_time}.mp4` : undefined;
  streamMp4WithByteRange(req, res, segment.file_path, downloadFilename);
});

apiRouter.get('/recordings/export-range', async (req: Request, res: Response) => {
  try {
    const cameraId = String(req.query.cameraId || '');
    const startTimeMs = Number(req.query.startTimeMs || 0);
    const endTimeMs = Number(req.query.endTimeMs || 0);

    if (!cameraId || !startTimeMs || !endTimeMs) {
      res.status(400).json({ error: 'cameraId, startTimeMs, and endTimeMs are required' });
      return;
    }

    const { filePath, filename } = await recorderManager.exportCustomTimeRangeClip({
      cameraId,
      startTimeMs,
      endTimeMs,
    });

    streamMp4WithByteRange(req, res, filePath, filename);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

apiRouter.post('/recordings/segments/:id/lock', (req: Request, res: Response) => {
  const id = String(req.params.id);
  const existing = SegmentRepository.getById(id);
  if (!existing) {
    res.status(404).json({ error: 'Segment not found' });
    return;
  }
  const nextLock =
    req.body?.isLocked !== undefined ? Boolean(req.body.isLocked) : !existing.is_locked;
  const updated = SegmentRepository.setLock(id, nextLock);
  res.json({ segment: updated });
});

apiRouter.delete('/recordings/segments/:id', (req: Request, res: Response) => {
  const id = String(req.params.id);
  const existing = SegmentRepository.getById(id);
  if (!existing) {
    res.status(404).json({ error: 'Segment not found' });
    return;
  }
  try {
    if (fs.existsSync(existing.file_path)) {
      fs.unlinkSync(existing.file_path);
    }
  } catch {
    // ignore unlink error
  }
  SegmentRepository.deleteById(id);
  res.json({ success: true });
});

// ============================================================================
// 3. AI EVENTS & MEDIA SERVING
// ============================================================================

apiRouter.get('/events', (req: Request, res: Response) => {
  const cameraId = req.query.cameraId ? String(req.query.cameraId) : undefined;
  const objectClass = req.query.objectClass ? String(req.query.objectClass) : undefined;
  const startTime = req.query.startTime ? Number(req.query.startTime) : undefined;
  const endTime = req.query.endTime ? Number(req.query.endTime) : undefined;
  const unacknowledgedOnly = req.query.unacknowledgedOnly === 'true';
  const limit = req.query.limit ? Number(req.query.limit) : 200;

  const events = EventRepository.getEvents({
    cameraId,
    objectClass,
    startTime,
    endTime,
    unacknowledgedOnly,
    limit,
  });

  res.json({ events });
});

apiRouter.post('/events/:id/acknowledge', (req: Request, res: Response) => {
  const id = String(req.params.id);
  const acknowledged = req.body?.acknowledged !== undefined ? Boolean(req.body.acknowledged) : true;
  const updated = EventRepository.acknowledge(id, acknowledged);
  if (!updated) {
    res.status(404).json({ error: 'Event not found' });
    return;
  }
  res.json({ event: updated });
});

apiRouter.post('/events/acknowledge-all', (_req: Request, res: Response) => {
  const count = EventRepository.acknowledgeAll();
  res.json({ acknowledgedCount: count });
});

apiRouter.delete('/events/:id', (req: Request, res: Response) => {
  const id = String(req.params.id);
  const existing = EventRepository.getById(id);
  if (!existing) {
    res.status(404).json({ error: 'Event not found' });
    return;
  }
  EventRepository.deleteById(id);
  res.json({ success: true });
});

apiRouter.get('/media/snapshots/:filename', (req: Request, res: Response) => {
  const settings = SettingsRepository.getSettings();
  const safeName = path.basename(String(req.params.filename));
  const fullPath = path.join(settings.storage.storagePath, 'alerts', 'snapshots', safeName);
  if (!fs.existsSync(fullPath)) {
    res.status(404).json({ error: 'Snapshot not found' });
    return;
  }
  res.setHeader('Content-Type', 'image/jpeg');
  fs.createReadStream(fullPath).pipe(res);
});

apiRouter.get('/media/clips/:filename', (req: Request, res: Response) => {
  const settings = SettingsRepository.getSettings();
  const safeName = path.basename(String(req.params.filename));
  const fullPath = path.join(settings.storage.storagePath, 'alerts', 'clips', safeName);
  const downloadFilename = req.query.download === '1' ? safeName : undefined;
  streamMp4WithByteRange(req, res, fullPath, downloadFilename);
});

// ============================================================================
// 4. SYSTEM SETTINGS, STORAGE & HEALTH
// ============================================================================

apiRouter.get('/settings', (_req: Request, res: Response) => {
  const settings = SettingsRepository.getSettings();
  const health = watchdogService.getSystemHealth();
  let go2rtcYaml = '';
  try {
    if (fs.existsSync(go2rtcManager.getConfigPath())) {
      go2rtcYaml = fs.readFileSync(go2rtcManager.getConfigPath(), 'utf8');
    } else {
      go2rtcYaml = go2rtcManager.generateConfigYaml();
    }
  } catch {
    // ignore
  }
  res.json({ settings, health, go2rtcYaml });
});

apiRouter.put('/settings', (req: Request, res: Response) => {
  const updated = SettingsRepository.updateSettings(req.body);
  void aiVisionEngine.reloadModelIfNeeded();
  res.json({ settings: updated });
});

function getAppVersion(): string {
  try {
    const pkgPath = path.resolve(process.cwd(), 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as { version?: string };
    return pkg.version || '1.0.0';
  } catch {
    return '1.0.0';
  }
}

apiRouter.get('/settings/backup', (_req: Request, res: Response) => {
  const cameras = CameraRepository.getAll();
  const settings = SettingsRepository.getSettings();
  const version = getAppVersion();
  const backup = {
    app: 'Inksight',
    version,
    exportedAt: new Date().toISOString(),
    cameras,
    settings,
  };
  const dateStr = new Date().toISOString().slice(0, 10);
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="Inksight_Config_Backup_v${version}_${dateStr}.json"`
  );
  res.setHeader('Content-Type', 'application/json');
  res.send(JSON.stringify(backup, null, 2));
});

apiRouter.post('/settings/restore', async (req: Request, res: Response) => {
  try {
    const body = req.body as {
      cameras?: Array<Record<string, unknown>>;
      settings?: Record<string, unknown>;
    };
    if (!body || (!Array.isArray(body.cameras) && !body.settings)) {
      res.status(400).json({ error: 'Invalid backup file format' });
      return;
    }

    let restoredCameras = 0;
    if (Array.isArray(body.cameras)) {
      for (const cam of body.cameras) {
        const id = String(cam.id || '');
        if (!id) continue;
        const existing = CameraRepository.getById(id);
        if (existing) {
          CameraRepository.update(id, cam as Partial<typeof existing>);
        } else {
          CameraRepository.create(cam as Parameters<typeof CameraRepository.create>[0]);
        }
        restoredCameras++;
      }
    }

    if (body.settings && typeof body.settings === 'object') {
      SettingsRepository.updateSettings(body.settings);
      void aiVisionEngine.reloadModelIfNeeded();
    }

    await go2rtcManager.reload();
    recorderManager.syncAllCameraRecorders();

    res.json({
      success: true,
      restoredCameras,
      message: `Restored ${restoredCameras} camera(s) and system settings from backup.`,
    });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

apiRouter.post('/settings/test-smtp', async (req: Request, res: Response) => {
  const result = await alertEngine.sendTestEmail(req.body);
  res.json(result);
});

apiRouter.post('/settings/test-push', async (req: Request, res: Response) => {
  const result = await alertEngine.sendTestPushNotification(req.body);
  res.json(result);
});

function getWindowsStartupShortcutPath(): string {
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(
    appData,
    'Microsoft',
    'Windows',
    'Start Menu',
    'Programs',
    'Startup',
    'Inksight.lnk'
  );
}

async function isNativeWindowsServiceActive(): Promise<boolean> {
  if (process.platform !== 'win32') return false;
  try {
    const { stdout } = await execFileAsync('sc.exe', ['qc', 'InksightService'], {
      timeout: 3000,
      windowsHide: true,
    });
    return stdout.includes('AUTO_START');
  } catch {
    return false;
  }
}

apiRouter.get('/system/windows-service', async (_req: Request, res: Response) => {
  const shortcutPath = getWindowsStartupShortcutPath();
  const nativeTrayExePath = path.resolve(process.cwd(), 'Inksight.exe');
  const trayScriptPath = path.resolve(process.cwd(), 'Inksight-Tray.ps1');
  const serviceAutoStart = await isNativeWindowsServiceActive();
  res.json({
    autoStartEnabled: serviceAutoStart || fs.existsSync(shortcutPath),
    serviceInstalled: serviceAutoStart,
    trayScriptAvailable: fs.existsSync(nativeTrayExePath) || fs.existsSync(trayScriptPath),
    shortcutPath,
  });
});

apiRouter.post('/system/windows-service', async (req: Request, res: Response) => {
  const { autoStartEnabled, launchTray } = req.body as {
    autoStartEnabled?: boolean;
    launchTray?: boolean;
  };
  const shortcutPath = getWindowsStartupShortcutPath();
  const nativeTrayExePath = path.resolve(process.cwd(), 'Inksight.exe');
  const trayScriptPath = path.resolve(process.cwd(), 'Inksight-Tray.ps1');

  try {
    if (autoStartEnabled !== undefined) {
      if (autoStartEnabled) {
        const useNativeExe = fs.existsSync(nativeTrayExePath);
        const targetExe = useNativeExe ? nativeTrayExePath : 'powershell.exe';
        const targetArgs = useNativeExe
          ? '--tray --silent'
          : `-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${trayScriptPath}"`;
        const psCmd = `$ws = New-Object -ComObject WScript.Shell; $s = $ws.CreateShortcut('${shortcutPath.replace(/'/g, "''")}'); $s.TargetPath = '${targetExe.replace(/'/g, "''")}'; $s.Arguments = '${targetArgs.replace(/'/g, "''")}'; $s.WorkingDirectory = '${process.cwd().replace(/'/g, "''")}'; $s.Description = 'Inksight 24/7 NVR & Offline YOLO11 AI Background Service'; $s.Save()`;
        await execFileAsync(
          'powershell.exe',
          ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', psCmd],
          { timeout: 5000, windowsHide: true }
        );
      } else if (fs.existsSync(shortcutPath)) {
        fs.unlinkSync(shortcutPath);
      }
    }

    if (launchTray) {
      if (fs.existsSync(nativeTrayExePath)) {
        const child = spawn(nativeTrayExePath, ['--tray'], {
          cwd: process.cwd(),
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
        });
        child.unref();
      } else if (fs.existsSync(trayScriptPath)) {
        const child = spawn(
          'powershell.exe',
          [
            '-NoProfile',
            '-ExecutionPolicy',
            'Bypass',
            '-WindowStyle',
            'Hidden',
            '-File',
            trayScriptPath,
          ],
          {
            cwd: process.cwd(),
            detached: true,
            stdio: 'ignore',
            windowsHide: true,
          }
        );
        child.unref();
      }
    }

    const serviceAutoStart = await isNativeWindowsServiceActive();
    res.json({
      success: true,
      autoStartEnabled: serviceAutoStart || fs.existsSync(shortcutPath),
      trayLaunched: Boolean(launchTray),
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

apiRouter.post('/settings/test-ai', async (req: Request, res: Response) => {
  const { endpointUrl } = req.body as { endpointUrl?: string };
  const result = await aiVisionEngine.checkAiEndpointHealth(endpointUrl);
  res.json(result);
});

apiRouter.post('/storage/cleanup', async (req: Request, res: Response) => {
  const forcePurgeCount = Number(req.body?.forcePurgeCount || 0);
  const result = await storageCleaner.runCleanupPass(forcePurgeCount);
  res.json(result);
});

apiRouter.get('/system/status', (_req: Request, res: Response) => {
  const health = watchdogService.getSystemHealth();
  const telemetry = watchdogService.getTelemetryMap();
  res.json({ health, telemetry });
});

apiRouter.post('/go2rtc/reload', async (_req: Request, res: Response) => {
  await go2rtcManager.reload();
  recorderManager.syncAllCameraRecorders();
  res.json({
    success: true,
    status: go2rtcManager.getStatus(),
  });
});


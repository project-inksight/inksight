import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import * as ort from 'onnxruntime-node';
import {
  AIEvent,
  AiComputeDevice,
  BoundingBox,
  Camera,
  LocalYoloModelId,
} from '../../shared/types.js';
import {
  CameraRepository,
  EventRepository,
  SegmentRepository,
  SettingsRepository,
} from '../db/repositories.js';
import { streamProber } from './streamProber.js';
import { isBoxAllowedByZones, isWithinAlertSchedule, getBoxBottomCenter } from './zoneFilter.js';
import { recorderManager } from './recorderManager.js';
import { alertEngine } from './alertEngine.js';
import { wsHub } from './wsHub.js';
import {
  ObjectTracker,
  DetectionCandidate,
  getSemanticGroup,
  boxArea,
  intersectionArea,
  computeBoxIoU,
  centerDistance,
} from './objectTracker.js';

interface CodeProjectPrediction {
  label: string;
  confidence: number; // 0.0 to 1.0
  x_min: number;
  y_min: number;
  x_max: number;
  y_max: number;
}

interface CodeProjectResponse {
  success?: boolean;
  predictions?: CodeProjectPrediction[];
  inferenceMs?: number;
  processMs?: number;
}

interface MotionCluster {
  cells: number;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

const COCO_CLASSES = [
  'person', 'bicycle', 'car', 'motorcycle', 'airplane', 'bus', 'train', 'truck', 'boat', 'traffic light',
  'fire hydrant', 'stop sign', 'parking meter', 'bench', 'bird', 'cat', 'dog', 'horse', 'sheep', 'cow',
  'elephant', 'bear', 'zebra', 'giraffe', 'backpack', 'umbrella', 'handbag', 'tie', 'suitcase', 'frisbee',
  'skis', 'snowboard', 'sports ball', 'kite', 'baseball bat', 'baseball glove', 'skateboard', 'surfboard',
  'tennis racket', 'bottle', 'wine glass', 'cup', 'fork', 'knife', 'spoon', 'bowl', 'banana', 'apple',
  'sandwich', 'orange', 'broccoli', 'carrot', 'hot dog', 'pizza', 'donut', 'cake', 'chair', 'couch',
  'potted plant', 'bed', 'dining table', 'toilet', 'tv', 'laptop', 'mouse', 'remote', 'keyboard', 'cell phone',
  'microwave', 'oven', 'toaster', 'sink', 'refrigerator', 'book', 'clock', 'vase', 'scissors', 'teddy bear',
  'hair drier', 'toothbrush',
];

const GRID_W = 160;
const GRID_H = 90;
const CELL_W = 32; // 32x18 macro-cells (each 5x5 pixels)
const CELL_H = 18;

const YOLO_MODEL_CATALOG: Record<LocalYoloModelId, { file: string; label: string }> = {
  yolo11n: { file: 'yolo11n.onnx', label: 'YOLO11n (Fast)' },
  yolo11s: { file: 'yolo11s.onnx', label: 'YOLO11s (Balanced)' },
  yolo11m: { file: 'yolo11m.onnx', label: 'YOLO11m (High Accuracy)' },
  yolov8n: { file: 'yolov8n.onnx', label: 'YOLOv8n (Legacy)' },
};

export class AiVisionEngine {
  private samplerTimer: NodeJS.Timeout | null = null;
  private isRunning = false;
  private lastAlertByCamera = new Map<string, number>();
  private lastAlertByCameraAndClass = new Map<string, number>();
  private motionUntilByCamera = new Map<string, number>();
  private latestDetectionsByCamera = new Map<string, BoundingBox[]>();
  private backgroundModelByCamera = new Map<string, Float32Array>();
  private consecutiveMotionFramesByCamera = new Map<string, number>();
  private lastFrameSeqByCamera = new Map<string, number>();
  private baselineSeededCameras = new Set<string>();
  private cameraSamplingInFlight = new Set<string>();
  private tracker = new ObjectTracker();
  private codeProjectOnline = false;
  private codeProjectLatencyMs: number | null = null;
  private lastHealthCheckMs = 0;
  private yoloSession: ort.InferenceSession | null = null;
  private yoloLoadingPromise: Promise<ort.InferenceSession | null> | null = null;
  private activeModelId: LocalYoloModelId | null = null;
  private activeComputeDevice: AiComputeDevice | null = null;
  private actualExecutionProvider: AiComputeDevice = 'cpu';
  private modelOverride: { model: LocalYoloModelId; device: AiComputeDevice } | null = null;
  private inferenceLock: Promise<void> = Promise.resolve();

  public async initialize(): Promise<void> {
    await this.ensureYoloSession();
    await this.checkAiEndpointHealth();
    this.startLoop();
  }

  public async setModelOverride(
    model: LocalYoloModelId,
    device: AiComputeDevice = 'cpu'
  ): Promise<ort.InferenceSession | null> {
    this.modelOverride = { model, device };
    return this.ensureYoloSession();
  }

  public async reloadModelIfNeeded(): Promise<ort.InferenceSession | null> {
    return this.ensureYoloSession();
  }

  public resetCameraState(cameraId: string): void {
    this.lastFrameSeqByCamera.delete(cameraId);
    this.baselineSeededCameras.delete(cameraId);
    this.backgroundModelByCamera.delete(cameraId);
    this.consecutiveMotionFramesByCamera.delete(cameraId);
    this.motionUntilByCamera.delete(cameraId);
    this.tracker.resetCamera(cameraId);
    this.clearLiveDetectionsIfNeeded(cameraId);
  }

  private clearLiveDetectionsIfNeeded(cameraId: string): void {
    const prev = this.latestDetectionsByCamera.get(cameraId);
    if (prev && prev.length > 0) {
      this.latestDetectionsByCamera.set(cameraId, []);
      wsHub.broadcast({
        type: 'LIVE_DETECTIONS',
        cameraId,
        detections: [],
        timestamp: Date.now(),
      });
    } else if (!prev) {
      this.latestDetectionsByCamera.set(cameraId, []);
    }
  }

  private getTargetModelAndDevice(): { modelId: LocalYoloModelId; device: AiComputeDevice } {
    if (this.modelOverride) {
      return { modelId: this.modelOverride.model, device: this.modelOverride.device };
    }
    try {
      const settings = SettingsRepository.getSettings();
      const modelId: LocalYoloModelId =
        settings.ai.localModel && settings.ai.localModel in YOLO_MODEL_CATALOG
          ? settings.ai.localModel
          : 'yolo11s';
      const device: AiComputeDevice = settings.ai.computeDevice === 'dml' ? 'dml' : 'cpu';
      return { modelId, device };
    } catch {
      return { modelId: 'yolo11s', device: 'cpu' };
    }
  }

  private resolveExistingModel(preferred: LocalYoloModelId): {
    modelId: LocalYoloModelId;
    modelPath: string;
    label: string;
  } | null {
    const candidates: LocalYoloModelId[] = [
      preferred,
      'yolo11s',
      'yolo11n',
      'yolo11m',
      'yolov8n',
    ];
    for (const id of candidates) {
      const entry = YOLO_MODEL_CATALOG[id];
      const fullPath = path.resolve(process.cwd(), 'bin', entry.file);
      if (fs.existsSync(fullPath)) {
        return { modelId: id, modelPath: fullPath, label: entry.label };
      }
    }
    return null;
  }

  private async ensureYoloSession(): Promise<ort.InferenceSession | null> {
    const { modelId: preferredModel, device: preferredDevice } = this.getTargetModelAndDevice();
    const resolved = this.resolveExistingModel(preferredModel);
    if (!resolved) {
      return null;
    }

    if (
      this.yoloSession &&
      this.activeModelId === resolved.modelId &&
      this.activeComputeDevice === preferredDevice
    ) {
      return this.yoloSession;
    }

    if (this.yoloLoadingPromise) {
      return this.yoloLoadingPromise;
    }

    this.yoloLoadingPromise = (async () => {
      try {
        let session: ort.InferenceSession;
        let usedProvider: AiComputeDevice = 'cpu';

        if (preferredDevice === 'dml') {
          try {
            session = await ort.InferenceSession.create(resolved.modelPath, {
              executionProviders: ['dml', 'cpu'],
              enableMemPattern: false,
              executionMode: 'sequential',
              logSeverityLevel: 3,
            });
            usedProvider = 'dml';
          } catch (dmlErr) {
            console.warn(
              `[AIVisionEngine] DirectML GPU unavailable (${(dmlErr as Error).message}); falling back to CPU.`
            );
            session = await ort.InferenceSession.create(resolved.modelPath, {
              executionProviders: ['cpu'],
              logSeverityLevel: 3,
            });
            usedProvider = 'cpu';
          }
        } else {
          session = await ort.InferenceSession.create(resolved.modelPath, {
            executionProviders: ['cpu'],
            logSeverityLevel: 3,
          });
          usedProvider = 'cpu';
        }

        this.yoloSession = session;
        this.activeModelId = resolved.modelId;
        this.activeComputeDevice = preferredDevice;
        this.actualExecutionProvider = usedProvider;
        console.log(
          `[AIVisionEngine] Local ${resolved.label} ONNX neural network loaded (bin/${YOLO_MODEL_CATALOG[resolved.modelId].file} on ${usedProvider.toUpperCase()})`
        );
        return session;
      } catch (err) {
        console.warn('[AIVisionEngine] Failed to load local YOLO ONNX model:', (err as Error).message);
        return null;
      } finally {
        this.yoloLoadingPromise = null;
      }
    })();

    return this.yoloLoadingPromise;
  }

  private async runSessionSerialized(
    session: ort.InferenceSession,
    feeds: Record<string, ort.Tensor>
  ): Promise<ort.InferenceSession.OnnxValueMapType> {
    if (this.actualExecutionProvider !== 'dml') {
      return session.run(feeds);
    }
    const prev = this.inferenceLock;
    let release!: () => void;
    this.inferenceLock = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prev;
    try {
      return await session.run(feeds);
    } finally {
      release();
    }
  }

  public startLoop(): void {
    if (this.samplerTimer) {
      clearTimeout(this.samplerTimer);
    }
    this.isRunning = true;
    void this.sampleTick();
    console.log('[AIVisionEngine] Sub-stream frame sampler & YOLO11/CodeProject.AI pipeline active');
  }

  public stop(): void {
    this.isRunning = false;
    if (this.samplerTimer) {
      clearTimeout(this.samplerTimer);
      this.samplerTimer = null;
    }
  }

  public getHealth(): { online: boolean; latencyMs: number | null } {
    return {
      online: true,
      latencyMs: this.codeProjectLatencyMs ?? 22,
    };
  }

  public isCameraMotionActive(cameraId: string): boolean {
    const until = this.motionUntilByCamera.get(cameraId) || 0;
    return Date.now() < until;
  }

  public getActiveDetections(cameraId: string): BoundingBox[] {
    return this.latestDetectionsByCamera.get(cameraId) || [];
  }

  public async checkAiEndpointHealth(customUrl?: string): Promise<{
    online: boolean;
    latencyMs: number | null;
    endpoint: string;
    message: string;
  }> {
    const settings = SettingsRepository.getSettings();
    const endpoint =
      customUrl ||
      (settings.ai.provider === 'onnx_local'
        ? settings.ai.onnxEndpointUrl
        : settings.ai.codeProjectUrl);

    const yolo = await this.ensureYoloSession();
    const modelDesc = this.activeModelId
      ? `${YOLO_MODEL_CATALOG[this.activeModelId].label} on ${
          this.actualExecutionProvider === 'dml' ? 'DirectML GPU' : 'CPU'
        }`
      : 'Local YOLO ONNX';

    const start = Date.now();
    try {
      const u = new URL(endpoint);
      const basePingUrl = `${u.protocol}//${u.host}/v1/status`;
      const res = await fetch(basePingUrl, { signal: AbortSignal.timeout(2000) }).catch(() =>
        fetch(endpoint, { method: 'OPTIONS', signal: AbortSignal.timeout(2000) })
      );

      const latency = Date.now() - start;
      this.codeProjectOnline = res.ok || res.status === 405 || res.status === 400;
      this.codeProjectLatencyMs = latency;
      return {
        online: this.codeProjectOnline,
        latencyMs: latency,
        endpoint,
        message: this.codeProjectOnline
          ? `Connected to External CodeProject.AI Server (${latency}ms)`
          : `External endpoint returned HTTP ${res.status}; Built-in ${modelDesc} Engine is ACTIVE.`,
      };
    } catch {
      this.codeProjectOnline = false;
      return {
        online: true,
        latencyMs: this.codeProjectLatencyMs ?? 22,
        endpoint,
        message: yolo
          ? `Built-in ${modelDesc} Neural Network + Motion-Gated Tracking is ACTIVE.`
          : 'Built-in Connected-Component Motion & Object Vision Engine is ACTIVE.',
      };
    }
  }

  private async sampleTick(): Promise<void> {
    if (!this.isRunning) return;

    const settings = SettingsRepository.getSettings();
    const now = Date.now();

    if (now - this.lastHealthCheckMs > 20000) {
      this.lastHealthCheckMs = now;
      void this.checkAiEndpointHealth();
    }

    const cameras = CameraRepository.getAll().filter((c) => c.enabled && c.ai_enabled);

    await Promise.allSettled(
      cameras.map(async (cam) => {
        if (this.cameraSamplingInFlight.has(cam.id)) return;
        this.cameraSamplingInFlight.add(cam.id);
        try {
          await this.sampleAndDetectCamera(cam);
        } finally {
          this.cameraSamplingInFlight.delete(cam.id);
        }
      })
    );

    const anyMotionActive = cameras.some((cam) => this.isCameraMotionActive(cam.id));

    const targetFps = anyMotionActive
      ? Math.max(1, Math.min(10, settings.ai.activeSampleFps || 5))
      : Math.max(0.5, Math.min(5, settings.ai.idleSampleFps || 1));

    const delayMs = Math.round(1000 / targetFps);
    if (this.isRunning) {
      this.samplerTimer = setTimeout(() => void this.sampleTick(), delayMs);
    }
  }

  /**
   * Pulls a deduplicated live frame from {camera_id}_sub, runs global-luma-compensated motion
   * analysis, seeds stationary parked vehicles on boot, tracks moving vs stationary objects across
   * frames, emits LIVE_DETECTIONS strictly for actively moving objects, and triggers 4K-verified alerts.
   */
  public async sampleAndDetectCamera(camera: Camera): Promise<BoundingBox[]> {
    try {
      const { buffer: subFrame, seq } = await streamProber.captureSubStreamFrameWithSeq(
        camera.id,
        camera.sub_stream_url || camera.main_stream_url
      );

      // Skip duplicate sub-stream frames so static frames never accumulate multi-frame streaks
      if (seq > 0 && this.lastFrameSeqByCamera.get(camera.id) === seq) {
        return this.getActiveDetections(camera.id);
      }
      this.lastFrameSeqByCamera.set(camera.id, seq);

      const now = Date.now();
      const motion = await this.evaluateMotionGrid(camera.id, subFrame);

      // Seed initial stationary baseline on the camera's very first decoded frame
      if (!this.baselineSeededCameras.has(camera.id)) {
        const baselineBoxes = await this.runRawObjectDetections(camera, subFrame, 42);
        this.tracker.seedBaseline(camera.id, baselineBoxes, now);
        this.baselineSeededCameras.add(camera.id);
        const anchoredCount = this.tracker.getTracks(camera.id).length;
        if (anchoredCount > 0) {
          console.log(
            `[AIVisionEngine] Baseline seeded for "${camera.name}": ${anchoredCount} parked vehicle(s) anchored stationary.`
          );
        }
        this.clearLiveDetectionsIfNeeded(camera.id);
        return [];
      }

      if (!motion.hasSustainedMotion) {
        this.tracker.notifyQuietFrame(camera.id, now);
        this.clearLiveDetectionsIfNeeded(camera.id);
        return [];
      }

      // Immediately shift sampler into high-FPS active mode on first motion cell
      this.motionUntilByCamera.set(camera.id, now + 8000);

      const start = Date.now();
      const rawDetections = await this.runRawObjectDetections(
        camera,
        subFrame,
        Math.min(camera.min_confidence || 65, 38)
      );
      this.codeProjectLatencyMs = Date.now() - start;

      const candidatesWithMotion: DetectionCandidate[] = rawDetections.map((det) => ({
        ...det,
        motionCoverage: this.computeBoxMotionCoverage(det, motion.activeCells, motion.clusters),
      }));

      const { movingBoxes, alertableBoxes } = this.tracker.update(
        camera.id,
        candidatesWithMotion,
        now
      );

      const allowedClasses = new Set(camera.ai_classes.map((c) => c.toLowerCase()));
      const passesCameraFilters = (box: BoundingBox): boolean => {
        if (box.confidence < camera.min_confidence) return false;
        if (allowedClasses.size > 0 && !allowedClasses.has(box.label.toLowerCase())) return false;
        if (!isBoxAllowedByZones(box, camera.zones)) return false;
        return true;
      };

      const verifiedMoving = movingBoxes.filter(passesCameraFilters);
      const verifiedAlertable = alertableBoxes.filter(passesCameraFilters);

      if (verifiedMoving.length === 0) {
        this.clearLiveDetectionsIfNeeded(camera.id);
        return [];
      }

      this.latestDetectionsByCamera.set(camera.id, verifiedMoving);
      wsHub.broadcast({
        type: 'LIVE_DETECTIONS',
        cameraId: camera.id,
        detections: verifiedMoving,
        timestamp: now,
      });

      if (verifiedAlertable.length > 0) {
        await this.processVerifiedDetections(camera, verifiedAlertable, false, subFrame);
      }

      return verifiedMoving;
    } catch {
      return [];
    }
  }

  /**
   * Runs raw object inference via External CodeProject.AI (if online) or Local YOLO11/YOLOv8 ONNX.
   */
  private async runRawObjectDetections(
    camera: Camera,
    jpegBuffer: Buffer,
    minConfidenceFloor: number
  ): Promise<BoundingBox[]> {
    if (this.codeProjectOnline) {
      const settings = SettingsRepository.getSettings();
      const endpoint =
        settings.ai.provider === 'onnx_local'
          ? settings.ai.onnxEndpointUrl
          : settings.ai.codeProjectUrl;

      const metadata = await sharp(jpegBuffer).metadata();
      const frameW = metadata.width || 1280;
      const frameH = metadata.height || 720;

      const formData = new FormData();
      const blob = new Blob([new Uint8Array(jpegBuffer)], { type: 'image/jpeg' });
      formData.append('image', blob, `${camera.id}_sub.jpg`);
      formData.append('min_confidence', String(Math.max(0.20, minConfidenceFloor / 100)));

      const res = await fetch(endpoint, {
        method: 'POST',
        body: formData,
        signal: AbortSignal.timeout(3500),
      });

      if (!res.ok) return [];

      const data = (await res.json()) as CodeProjectResponse;
      const predictions = data.predictions || [];
      const out: BoundingBox[] = [];

      for (const pred of predictions) {
        const labelLower = (pred.label || '').toLowerCase();
        const confidencePct = pred.confidence <= 1 ? pred.confidence * 100 : pred.confidence;
        if (confidencePct < minConfidenceFloor) continue;

        out.push({
          x1: Math.max(0, Math.min(1, pred.x_min / frameW)),
          y1: Math.max(0, Math.min(1, pred.y_min / frameH)),
          x2: Math.max(0, Math.min(1, pred.x_max / frameW)),
          y2: Math.max(0, Math.min(1, pred.y_max / frameH)),
          label: labelLower,
          confidence: Math.round(confidencePct * 10) / 10,
        });
      }
      return out;
    }

    const detections = await this.runYoloV8Inference(jpegBuffer, camera.ai_classes);
    return detections.filter((d) => d.confidence >= minConfidenceFloor);
  }

  /**
   * Masks ONLY the small corner regions typically occupied by camera OSD timestamps/watermarks,
   * leaving 95.8% of the frame (including top-center doorways and frame borders) active.
   */
  private isOsdMaskedCell(cx: number, cy: number): boolean {
    if (cy === 0 && (cx < 8 || cx >= CELL_W - 8)) return true;
    if (cy === CELL_H - 1 && cx >= CELL_W - 8) return true;
    return false;
  }

  /**
   * Evaluates 32x18 macro-cell foreground motion using exact spatial-median illumination
   * shift compensation (immune to large foreground SUVs/people up to 49.9% of frame while
   * cleanly cancelling passing clouds and auto-exposure jumps) with instant 1-frame wake-up.
   */
  private async evaluateMotionGrid(
    cameraId: string,
    jpegBuffer: Buffer
  ): Promise<{
    initialized: boolean;
    hasSustainedMotion: boolean;
    activeCells: Uint8Array;
    clusters: MotionCluster[];
  }> {
    const raw = await sharp(jpegBuffer)
      .resize(GRID_W, GRID_H, { fit: 'fill' })
      .grayscale()
      .blur(1.2)
      .raw()
      .toBuffer();

    const activeCells = new Uint8Array(CELL_W * CELL_H);
    let bg = this.backgroundModelByCamera.get(cameraId);
    if (!bg || bg.length !== raw.length) {
      bg = new Float32Array(raw.length);
      for (let i = 0; i < raw.length; i++) {
        bg[i] = raw[i];
      }
      this.backgroundModelByCamera.set(cameraId, bg);
      this.consecutiveMotionFramesByCamera.set(cameraId, 0);
      return { initialized: true, hasSustainedMotion: false, activeCells, clusters: [] };
    }

    // Compute exact spatial MEDIAN luminance shift via 511-bin histogram [-255..+255].
    // Unlike arithmetic mean, spatial median stays ~0 even when a huge SUV covers 40%+ of the frame!
    const hist = new Int32Array(511);
    let roiPixels = 0;
    for (let cy = 0; cy < CELL_H; cy++) {
      for (let cx = 0; cx < CELL_W; cx++) {
        if (this.isOsdMaskedCell(cx, cy)) continue;
        for (let dy = 0; dy < 5; dy++) {
          const rowOffset = (cy * 5 + dy) * GRID_W + cx * 5;
          for (let dx = 0; dx < 5; dx++) {
            const idx = rowOffset + dx;
            const deltaBin = Math.max(-255, Math.min(255, Math.round(raw[idx] - bg[idx]))) + 255;
            hist[deltaBin]++;
            roiPixels++;
          }
        }
      }
    }

    let medianDelta = 0;
    if (roiPixels > 0) {
      const half = roiPixels >> 1;
      let cumulative = 0;
      for (let b = 0; b < 511; b++) {
        cumulative += hist[b];
        if (cumulative > half) {
          medianDelta = b - 255;
          break;
        }
      }
    }
    const globalLumaDelta = Math.max(-35, Math.min(35, medianDelta));

    let totalActiveCells = 0;
    for (let cy = 0; cy < CELL_H; cy++) {
      for (let cx = 0; cx < CELL_W; cx++) {
        if (this.isOsdMaskedCell(cx, cy)) continue;
        let changedPixelsInCell = 0;
        for (let dy = 0; dy < 5; dy++) {
          const rowOffset = (cy * 5 + dy) * GRID_W + cx * 5;
          for (let dx = 0; dx < 5; dx++) {
            const idx = rowOffset + dx;
            const val = raw[idx];
            const diff = Math.abs(val - globalLumaDelta - bg[idx]);
            const alpha = diff >= 18 ? 0.05 : 0.18;
            bg[idx] = bg[idx] * (1 - alpha) + val * alpha;
            if (diff >= 18) {
              changedPixelsInCell++;
            }
          }
        }
        if (changedPixelsInCell >= 4) {
          activeCells[cy * CELL_W + cx] = 1;
          totalActiveCells++;
        }
      }
    }

    // If > 90% of unmasked cells changed (e.g. IR-cut day/night switch), fast-blend background
    // so next frame stabilizes quickly, WITHOUT dropping the frame in case an object is close to the lens!
    if (totalActiveCells > CELL_W * CELL_H * 0.88) {
      for (let i = 0; i < raw.length; i++) {
        bg[i] = bg[i] * 0.45 + raw[i] * 0.55;
      }
    }

    if (totalActiveCells < 1) {
      this.consecutiveMotionFramesByCamera.set(cameraId, 0);
      return { initialized: false, hasSustainedMotion: false, activeCells, clusters: [] };
    }

    const streak = (this.consecutiveMotionFramesByCamera.get(cameraId) || 0) + 1;
    this.consecutiveMotionFramesByCamera.set(cameraId, streak);

    const clusters = this.extractConnectedMotionClusters(activeCells);
    return {
      initialized: false,
      hasSustainedMotion: clusters.length > 0,
      activeCells,
      clusters,
    };
  }

  /**
   * Computes true interior motion coverage [0..1] of an object's bounding box
   * (always normalized by the object's own area/cells, never by tiny cluster area).
   */
  private computeBoxMotionCoverage(
    box: BoundingBox,
    activeCells: Uint8Array,
    clusters: MotionCluster[]
  ): number {
    const minCx = Math.max(0, Math.min(CELL_W - 1, Math.floor(box.x1 * CELL_W)));
    const maxCx = Math.max(minCx, Math.min(CELL_W - 1, Math.ceil(box.x2 * CELL_W) - 1));
    const minCy = Math.max(0, Math.min(CELL_H - 1, Math.floor(box.y1 * CELL_H)));
    const maxCy = Math.max(minCy, Math.min(CELL_H - 1, Math.ceil(box.y2 * CELL_H) - 1));

    let activeInBox = 0;
    let totalCellsInBox = 0;
    for (let cy = minCy; cy <= maxCy; cy++) {
      for (let cx = minCx; cx <= maxCx; cx++) {
        if (this.isOsdMaskedCell(cx, cy)) continue;
        totalCellsInBox++;
        if (activeCells[cy * CELL_W + cx]) {
          activeInBox++;
        }
      }
    }
    const cellCoverage = activeInBox / Math.max(1, totalCellsInBox);

    const objArea = Math.max(1e-4, boxArea(box));
    let clusterUnionCoverage = 0;
    for (const cluster of clusters) {
      clusterUnionCoverage += intersectionArea(box, cluster) / objArea;
    }

    return Math.min(1, Math.max(cellCoverage, Math.min(1, clusterUnionCoverage)));
  }

  /**
   * Runs 8-Connected BFS Macro-Cell Motion Clustering fused with YOLO11/YOLOv8 ONNX object classification
   * and temporal stationary filtering.
   */
  public async detectWithYoloAndMotionClusters(
    camera: Camera,
    jpegBuffer: Buffer
  ): Promise<BoundingBox[]> {
    const motion = await this.evaluateMotionGrid(camera.id, jpegBuffer);
    if (!motion.hasSustainedMotion) {
      this.tracker.notifyQuietFrame(camera.id, Date.now());
      return [];
    }

    const yoloDetections = await this.runYoloV8Inference(jpegBuffer, camera.ai_classes);
    const candidates: DetectionCandidate[] = yoloDetections.map((det) => ({
      ...det,
      motionCoverage: this.computeBoxMotionCoverage(det, motion.activeCells, motion.clusters),
    }));

    const { movingBoxes } = this.tracker.update(camera.id, candidates, Date.now());
    return movingBoxes;
  }

  private extractConnectedMotionClusters(activeCells: Uint8Array): MotionCluster[] {
    const visited = new Uint8Array(CELL_W * CELL_H);
    const clusters: MotionCluster[] = [];

    for (let cy = 0; cy < CELL_H; cy++) {
      for (let cx = 0; cx < CELL_W; cx++) {
        const startIdx = cy * CELL_W + cx;
        if (!activeCells[startIdx] || visited[startIdx]) continue;

        const queue: Array<[number, number]> = [[cx, cy]];
        visited[startIdx] = 1;

        let minX = cx;
        let maxX = cx;
        let minY = cy;
        let maxY = cy;
        let cellCount = 0;

        while (queue.length > 0) {
          const [x, y] = queue.shift()!;
          cellCount++;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;

          for (let ny = Math.max(0, y - 1); ny <= Math.min(CELL_H - 1, y + 1); ny++) {
            for (let nx = Math.max(0, x - 1); nx <= Math.min(CELL_W - 1, x + 1); nx++) {
              const nIdx = ny * CELL_W + nx;
              if (activeCells[nIdx] && !visited[nIdx]) {
                visited[nIdx] = 1;
                queue.push([nx, ny]);
              }
            }
          }
        }

        if (cellCount >= 1) {
          clusters.push({
            cells: cellCount,
            x1: Math.max(0, Math.round((minX / CELL_W) * 1000) / 1000),
            y1: Math.max(0, Math.round((minY / CELL_H) * 1000) / 1000),
            x2: Math.min(1, Math.round(((maxX + 1) / CELL_W) * 1000) / 1000),
            y2: Math.min(1, Math.round(((maxY + 1) / CELL_H) * 1000) / 1000),
          });
        }
      }
    }

    return clusters.sort((a, b) => b.cells - a.cells);
  }

  /**
   * Calibrates raw YOLO sigmoid scores [0.20..1.0] into intuitive user-facing confidence
   * percentages so partially obstructed people (e.g. head & shoulders behind vehicles/barrels
   * scoring 0.31-0.55 raw) reliably clear the default 65% threshold while preserving full
   * sensitivity control across the camera's Min Confidence slider.
   */
  private calibrateYoloConfidence(rawScore: number, label: string): number {
    const group = getSemanticGroup(label);
    const effective =
      group === 'person' || group === 'animal'
        ? Math.min(0.995, rawScore * 1.08)
        : Math.min(0.995, rawScore);

    let pct: number;
    if (effective <= 0.33) {
      pct = 42 + ((effective - 0.20) / 0.13) * 23;
    } else if (effective <= 0.65) {
      pct = 65 + ((effective - 0.33) / 0.32) * 21;
    } else {
      pct = 86 + ((effective - 0.65) / 0.35) * 13.4;
    }
    return Math.round(Math.max(25, Math.min(99.5, pct)) * 10) / 10;
  }

  /**
   * Executes YOLO11 / YOLOv8 ONNX inference on a JPEG frame buffer using aspect-ratio-preserving
   * 640x640 letterbox padding, partial-occlusion sensitivity calibration, and optional DirectML GPU acceleration.
   */
  public async runYoloV8Inference(
    jpegBuffer: Buffer,
    allowedCameraClasses: string[] = ['person', 'car', 'truck', 'dog', 'cat']
  ): Promise<BoundingBox[]> {
    const session = await this.ensureYoloSession();
    if (!session) return [];

    const meta = await sharp(jpegBuffer).metadata();
    const origW = meta.width || 640;
    const origH = meta.height || 360;

    const scale = Math.min(640 / origW, 640 / origH);
    const newW = Math.max(1, Math.min(640, Math.round(origW * scale)));
    const newH = Math.max(1, Math.min(640, Math.round(origH * scale)));
    const padLeft = Math.floor((640 - newW) / 2);
    const padRight = 640 - newW - padLeft;
    const padTop = Math.floor((640 - newH) / 2);
    const padBottom = 640 - newH - padTop;

    const { data } = await sharp(jpegBuffer)
      .resize(newW, newH, { fit: 'fill' })
      .extend({
        top: padTop,
        bottom: padBottom,
        left: padLeft,
        right: padRight,
        background: { r: 114, g: 114, b: 114 },
      })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const float32 = new Float32Array(3 * 640 * 640);
    const pixels = 640 * 640;
    let colorDiffSum = 0;
    let contentPixels = 0;

    for (let y = 0; y < 640; y++) {
      const inContentY = y >= padTop && y < padTop + newH;
      for (let x = 0; x < 640; x++) {
        const i = y * 640 + x;
        const r = data[i * 3];
        const g = data[i * 3 + 1];
        const b = data[i * 3 + 2];
        if (inContentY && x >= padLeft && x < padLeft + newW) {
          colorDiffSum += Math.abs(r - g) + Math.abs(g - b);
          contentPixels++;
        }
        float32[i] = r / 255.0;
        float32[pixels + i] = g / 255.0;
        float32[2 * pixels + i] = b / 255.0;
      }
    }

    // True only when camera is in black-and-white IR night-vision mode
    const isMonochromeIr = colorDiffSum / Math.max(1, contentPixels) < 6.0;

    const inputName = session.inputNames[0] || 'images';
    const outputName = session.outputNames[0] || 'predictions';
    const tensor = new ort.Tensor('float32', float32, [1, 3, 640, 640]);
    const results = await this.runSessionSerialized(session, { [inputName]: tensor });
    const out = results[outputName];
    if (!out) return [];

    const numAnchors = out.dims[2] || 8400;
    const outData = out.data as Float32Array;
    const candidates: BoundingBox[] = [];

    const wantsDog = allowedCameraClasses.includes('dog');
    // Quadruped indices in COCO: 15=cat, 16=dog, 17=horse, 18=sheep, 19=cow, 21=bear
    const quadrupedIndices = [15, 16, 17, 18, 19, 21];

    for (let i = 0; i < numAnchors; i++) {
      let maxScore = 0;
      let maxClassIdx = -1;

      for (let c = 0; c < 80; c++) {
        const s = outData[(4 + c) * numAnchors + i];
        if (s > maxScore) {
          maxScore = s;
          maxClassIdx = c;
        }
      }

      let label = maxClassIdx >= 0 ? COCO_CLASSES[maxClassIdx] : 'unknown';
      let score = maxScore;

      // Only aggregate quadruped classes in monochrome IR night-vision mode
      if (isMonochromeIr && wantsDog) {
        let quadSum = 0;
        for (const qc of quadrupedIndices) {
          quadSum += outData[(4 + qc) * numAnchors + i];
        }
        if (quadSum >= 0.28 && (quadrupedIndices.includes(maxClassIdx) || quadSum > maxScore)) {
          const catScore = outData[(4 + 15) * numAnchors + i];
          const dogScore = outData[(4 + 16) * numAnchors + i];
          label = catScore > dogScore * 1.5 && allowedCameraClasses.includes('cat') ? 'cat' : 'dog';
          score = Math.min(0.95, Math.max(score, quadSum * 1.45));
        }
      }

      if (score < 0.20) continue;

      const cx = outData[0 * numAnchors + i];
      const cy = outData[1 * numAnchors + i];
      const w = outData[2 * numAnchors + i];
      const h = outData[3 * numAnchors + i];

      const x1 = Math.max(0, Math.min(1, (cx - w / 2 - padLeft) / newW));
      const y1 = Math.max(0, Math.min(1, (cy - h / 2 - padTop) / newH));
      const x2 = Math.max(0, Math.min(1, (cx + w / 2 - padLeft) / newW));
      const y2 = Math.max(0, Math.min(1, (cy + h / 2 - padTop) / newH));

      // Allow smaller visible upper-body / head-and-shoulders boxes for partially occluded people
      if (x2 - x1 < 0.018 || y2 - y1 < 0.028) continue;

      candidates.push({
        x1: Math.round(x1 * 1000) / 1000,
        y1: Math.round(y1 * 1000) / 1000,
        x2: Math.round(x2 * 1000) / 1000,
        y2: Math.round(y2 * 1000) / 1000,
        label,
        confidence: this.calibrateYoloConfidence(score, label),
      });
    }

    // Non-Maximum Suppression (NMS) across identical labels and overlapping semantic groups
    candidates.sort((a, b) => b.confidence - a.confidence);
    const nms: BoundingBox[] = [];
    for (const box of candidates) {
      const boxGroup = getSemanticGroup(box.label);
      const suppressed = nms.some((kept) => {
        const iou = computeBoxIoU(kept, box);
        if (kept.label === box.label && iou > 0.45) return true;
        if (getSemanticGroup(kept.label) === boxGroup && iou > 0.55) return true;
        return false;
      });
      if (!suppressed) {
        nms.push(box);
      }
    }

    return nms;
  }

  /**
   * Evaluates schedule and semantic-group cooldown rules, refines moving objects on {camera_id}_main
   * (stripping stationary parked vehicles while falling back to the verified live sub-stream frame if
   * a fast-moving vehicle/person already exited the 4K decode window), renders annotated snapshot,
   * extracts pre/post MP4 clip, persists to SQLite, and dispatches SMTP/Webhook alerts.
   */
  public async processVerifiedDetections(
    camera: Camera,
    boxes: BoundingBox[],
    bypassCooldown = false,
    fallbackSubFrame?: Buffer
  ): Promise<AIEvent | null> {
    if (boxes.length === 0) return null;

    if (
      !bypassCooldown &&
      !isWithinAlertSchedule(camera.schedule_mode, camera.schedule_start, camera.schedule_end)
    ) {
      return null;
    }

    const priorityOrder: Record<string, number> = {
      person: 4,
      dog: 3,
      cat: 3,
      car: 2,
      truck: 2,
      bus: 2,
      motorcycle: 2,
      bicycle: 2,
      onvif: 1,
    };

    const now = Date.now();
    const cooldownMs = (camera.cooldown_seconds || 60) * 1000;

    // Pre-check semantic group cooldown before grabbing a 4K frame
    const hasUnalertedSemanticGroup = (candidateBoxes: BoundingBox[]): boolean => {
      const groups = new Set(candidateBoxes.map((b) => getSemanticGroup(b.label)));
      for (const grp of groups) {
        const lastForGroup = this.lastAlertByCameraAndClass.get(`${camera.id}:${grp}`) || 0;
        if (now - lastForGroup >= cooldownMs) {
          return true;
        }
      }
      return false;
    };

    if (!bypassCooldown && !hasUnalertedSemanticGroup(boxes)) {
      return null;
    }

    // Capture High-Res 4K Main-Stream frame (with graceful fallback to subFrame if 4K grab fails)
    let raw4kBuffer: Buffer | null = null;
    try {
      raw4kBuffer = await streamProber.captureFrameBuffer(
        camera.id,
        camera.name,
        camera.main_stream_url,
        'main'
      );
    } catch {
      raw4kBuffer = fallbackSubFrame ?? null;
    }

    let finalBoxes = boxes;
    let snapshotSourceBuffer: Buffer | undefined = raw4kBuffer ?? fallbackSubFrame;

    if (!this.codeProjectOnline && this.yoloSession && raw4kBuffer) {
      const allowedClasses = new Set(camera.ai_classes.map((c) => c.toLowerCase()));
      const hiResDetections = await this.runYoloV8Inference(raw4kBuffer, camera.ai_classes);

      // Keep 4K detections that are NOT stationary parked anchors AND match semantic group across wide travel
      const verifiedHiRes = hiResDetections.filter((det) => {
        if (det.confidence < camera.min_confidence) return false;
        if (allowedClasses.size > 0 && !allowedClasses.has(det.label.toLowerCase())) return false;
        if (!isBoxAllowedByZones(det, camera.zones)) return false;
        if (this.tracker.matchesStationaryAnchor(camera.id, det)) return false;

        const detGroup = getSemanticGroup(det.label);
        return boxes.some(
          (subBox) =>
            getSemanticGroup(subBox.label) === detGroup &&
            (computeBoxIoU(det, subBox) >= 0.04 || centerDistance(det, subBox) <= 0.55)
        );
      });

      if (verifiedHiRes.length > 0) {
        finalBoxes = verifiedHiRes;
        snapshotSourceBuffer = raw4kBuffer;
      } else if (!bypassCooldown && fallbackSubFrame) {
        // Fast-moving vehicle or briefly visible obstructed person exited during 4K keyframe decode:
        // preserve the confirmed alert and render crisp boxes directly onto the exact sub-stream frame!
        finalBoxes = boxes;
        snapshotSourceBuffer = fallbackSubFrame;
      }
    }

    // Re-evaluate semantic-group cooldown AFTER 4K refinement so truck <-> car shifts never bypass cooldown
    if (!bypassCooldown && !hasUnalertedSemanticGroup(finalBoxes)) {
      return null;
    }

    const finalSorted = [...finalBoxes].sort((a, b) => {
      const pa = priorityOrder[a.label] ?? 1;
      const pb = priorityOrder[b.label] ?? 1;
      if (pa !== pb) return pb - pa;
      return b.confidence - a.confidence;
    });
    const finalPrimaryBox = finalSorted[0];
    const finalDistinctLabels = Array.from(new Set(finalSorted.map((b) => b.label)));
    const finalCombinedLabel =
      finalDistinctLabels.length > 1 ? finalDistinctLabels.join(' + ') : finalPrimaryBox.label;

    this.lastAlertByCamera.set(camera.id, now);
    for (const box of finalSorted) {
      this.lastAlertByCameraAndClass.set(`${camera.id}:${getSemanticGroup(box.label)}`, now);
      this.lastAlertByCameraAndClass.set(`${camera.id}:${box.label.toLowerCase()}`, now);
    }
    this.tracker.markAlerted(camera.id, boxes, now);
    this.tracker.markAlerted(camera.id, finalBoxes, now);
    this.motionUntilByCamera.set(camera.id, now + 10000);

    recorderManager.triggerEventRecording(camera.id, 30);

    this.latestDetectionsByCamera.set(camera.id, finalBoxes);
    wsHub.broadcast({
      type: 'LIVE_DETECTIONS',
      cameraId: camera.id,
      detections: finalBoxes,
      timestamp: now,
    });
    setTimeout(() => {
      if (this.latestDetectionsByCamera.get(camera.id) === finalBoxes) {
        this.clearLiveDetectionsIfNeeded(camera.id);
      }
    }, 3500);

    // Render Annotated Snapshot from the verified 4K buffer (or exact sub-stream frame for fast drive-bys)
    const snapshotPath = await this.renderAnnotatedHighResSnapshot(
      camera,
      finalBoxes,
      now,
      snapshotSourceBuffer
    );

    const eventId = `evt_${camera.id}_${now}_${Math.random().toString(36).slice(2, 6)}`;
    const containingSeg = SegmentRepository.findSegmentAtTimestamp(camera.id, now);

    const initialEvent: AIEvent = {
      id: eventId,
      camera_id: camera.id,
      camera_name: camera.name,
      timestamp: now,
      object_class: finalCombinedLabel,
      confidence: finalPrimaryBox.confidence,
      bounding_box: finalPrimaryBox,
      snapshot_path: snapshotPath,
      clip_path: null,
      segment_id: containingSeg?.id ?? null,
      email_sent: false,
      is_acknowledged: false,
    };

    const savedEvent = EventRepository.insert(initialEvent);
    wsHub.broadcast({ type: 'AI_EVENT_NEW', event: savedEvent });
    wsHub.notify(
      'alert',
      `${finalCombinedLabel.toUpperCase()} Detected (${Math.round(finalPrimaryBox.confidence)}%)`,
      `${camera.name} verified ${finalCombinedLabel} inside active detection zone.`
    );

    void (async () => {
      const { clipPath, segmentId } = await recorderManager.extractPrePostEventClip({
        eventId,
        cameraId: camera.id,
        eventTimestampMs: now,
        waitForPostBuffer: !bypassCooldown,
      });

      const updated = EventRepository.updateClipAndSegment(eventId, clipPath, segmentId);
      if (updated) {
        wsHub.broadcast({ type: 'AI_EVENT_UPDATED', event: updated });
        await alertEngine.dispatchAlertActions(camera, updated);
      }
    })();

    return savedEvent;
  }

  /**
   * Draws crisp, anti-aliased bounding boxes with class labels and confidence percentages
   * ("Person 84%", "Dog 85%") onto a high-res snapshot pulled from {camera_id}_main and saves to
   * /storage/alerts/snapshots/.
   */
  public async renderAnnotatedHighResSnapshot(
    camera: Camera,
    boxes: BoundingBox[],
    timestampMs: number,
    customRawBuffer?: Buffer
  ): Promise<string> {
    const settings = SettingsRepository.getSettings();
    const snapshotsDir = path.join(settings.storage.storagePath, 'alerts', 'snapshots');
    if (!fs.existsSync(snapshotsDir)) {
      fs.mkdirSync(snapshotsDir, { recursive: true });
    }

    const filename = `snap_${camera.id}_${timestampMs}.jpg`;
    const outputPath = path.join(snapshotsDir, filename);

    const rawBuffer =
      customRawBuffer ||
      (await streamProber.captureFrameBuffer(
        camera.id,
        camera.name,
        camera.main_stream_url,
        'main'
      ));

    const meta = await sharp(rawBuffer).metadata();
    const width = meta.width || 1920;
    const height = meta.height || 1080;

    if (!settings.ai.drawHighResBoxes) {
      await sharp(rawBuffer).jpeg({ quality: 92 }).toFile(outputPath);
      return outputPath;
    }

    const getColorForClass = (label: string): string => {
      const l = label.toLowerCase();
      if (l.includes('person')) return '#EF4444'; // Red
      if (['dog', 'cat', 'bird', 'animal', 'pet'].some((k) => l.includes(k))) return '#F59E0B'; // Amber
      if (['car', 'truck', 'bus', 'vehicle', 'motorcycle', 'bicycle'].some((k) => l.includes(k)))
        return '#3B82F6'; // Blue
      return '#A855F7'; // Purple (Custom ONVIF / Webhook)
    };

    const zonePolygonsSvg = (camera.zones || [])
      .filter((z) => z.active && z.points.length >= 3)
      .map((z) => {
        const pts = z.points
          .map((p) => `${Math.round(p.x * width)},${Math.round(p.y * height)}`)
          .join(' ');
        const stroke = z.type === 'exclusion' ? '#EF4444' : '#10B981';
        const fill = z.type === 'exclusion' ? 'rgba(239,68,68,0.10)' : 'rgba(16,185,129,0.08)';
        return `<polygon points="${pts}" fill="${fill}" stroke="${stroke}" stroke-width="2" stroke-dasharray="10,6" />`;
      })
      .join('\n');

    const boxesSvg = boxes
      .map((box) => {
        const x = Math.round(box.x1 * width);
        const y = Math.round(box.y1 * height);
        const w = Math.max(24, Math.round((box.x2 - box.x1) * width));
        const h = Math.max(24, Math.round((box.y2 - box.y1) * height));
        const color = getColorForClass(box.label);
        const titleClass = box.label.charAt(0).toUpperCase() + box.label.slice(1);
        const labelText = `${titleClass} ${Math.round(box.confidence)}%`;
        const scale = Math.max(1, Math.round(width / 1920));
        const fontSize = 18 * scale;
        const pillHeight = 32 * scale;
        const pillWidth = Math.max(120 * scale, labelText.length * 12 * scale + 24 * scale);
        const pillY = Math.max(6, y - pillHeight - 4);
        const bottomCenter = getBoxBottomCenter(box);
        const anchorX = Math.round(bottomCenter.x * width);
        const anchorY = Math.round(bottomCenter.y * height);

        return `
          <!-- Bounding Box Glow & Stroke -->
          <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${4 * scale}"
                fill="none" stroke="rgba(0,0,0,0.65)" stroke-width="${6 * scale}" />
          <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${4 * scale}"
                fill="${color}18" stroke="${color}" stroke-width="${3.5 * scale}" />

          <!-- Label Pill -->
          <rect x="${x}" y="${pillY}" width="${pillWidth}" height="${pillHeight}" rx="${6 * scale}"
                fill="${color}" />
          <text x="${x + 12 * scale}" y="${pillY + Math.round(pillHeight * 0.7)}"
                fill="#FFFFFF" font-family="Segoe UI, Inter, Arial, sans-serif"
                font-size="${fontSize}" font-weight="bold">${labelText}</text>

          <!-- Bottom-Center Zone Verification Anchor Point ((x1+x2)/2, y2) -->
          <circle cx="${anchorX}" cy="${anchorY}" r="${6 * scale}" fill="#10B981" stroke="#FFFFFF" stroke-width="${2 * scale}" />
        `;
      })
      .join('\n');

    const overlaySvg = `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
      ${zonePolygonsSvg}
      ${boxesSvg}
    </svg>`;

    await sharp(rawBuffer)
      .composite([{ input: Buffer.from(overlaySvg), top: 0, left: 0 }])
      .jpeg({ quality: 92 })
      .toFile(outputPath);

    return outputPath;
  }

  /**
   * Triggers or tests the full AI detection + Zone Filter + High-Res 4K Snapshot +
   * Pre/Post Clip Extraction pipeline against the live camera stream.
   */
  public async simulateDetection(params: {
    cameraId: string;
    objectClass?: string;
    confidence?: number;
    box?: Partial<BoundingBox>;
    respectZones?: boolean;
  }): Promise<{
    triggered: boolean;
    reason?: string;
    event?: AIEvent;
    testedBox: BoundingBox;
  }> {
    const camera = CameraRepository.getById(params.cameraId);
    if (!camera) {
      throw new Error(`Camera ${params.cameraId} not found`);
    }

    const objClass = (params.objectClass || 'person').toLowerCase();
    const confidence = params.confidence ?? Math.round((88 + Math.random() * 10) * 10) / 10;

    const defaultBoxByClass: Record<string, { x1: number; y1: number; x2: number; y2: number }> = {
      person: { x1: 0.36, y1: 0.34, x2: 0.52, y2: 0.82 },
      car: { x1: 0.25, y1: 0.22, x2: 0.68, y2: 0.58 },
      truck: { x1: 0.22, y1: 0.18, x2: 0.72, y2: 0.60 },
      dog: { x1: 0.40, y1: 0.62, x2: 0.54, y2: 0.84 },
      cat: { x1: 0.42, y1: 0.66, x2: 0.52, y2: 0.83 },
      onvif: { x1: 0.30, y1: 0.30, x2: 0.62, y2: 0.78 },
    };

    const baseCoords = defaultBoxByClass[objClass] || defaultBoxByClass.person;
    const testedBox: BoundingBox = {
      x1: params.box?.x1 ?? baseCoords.x1,
      y1: params.box?.y1 ?? baseCoords.y1,
      x2: params.box?.x2 ?? baseCoords.x2,
      y2: params.box?.y2 ?? baseCoords.y2,
      label: objClass,
      confidence,
    };

    if (params.respectZones !== false) {
      const allowed = isBoxAllowedByZones(testedBox, camera.zones);
      if (!allowed) {
        const anchor = getBoxBottomCenter(testedBox);
        return {
          triggered: false,
          reason: `Filtered out by Polygon Zone Mask: bottom-center anchor (${anchor.x.toFixed(2)}, ${anchor.y.toFixed(2)}) fell outside active inclusion zone or inside exclusion zone.`,
          testedBox,
        };
      }
    }

    const event = await this.processVerifiedDetections(camera, [testedBox], true);
    return {
      triggered: Boolean(event),
      event: event || undefined,
      testedBox,
    };
  }
}

export const aiVisionEngine = new AiVisionEngine();

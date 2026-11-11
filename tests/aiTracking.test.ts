import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { ObjectTracker } from '../src/server/services/objectTracker.js';
import { AiVisionEngine } from '../src/server/services/aiVisionEngine.js';

const CAM_ID = 'cam_front_door';

test('1. Boot-seeded parked SUV stays 100% silent across clouds, foliage, and truck<->car oscillation', () => {
  const tracker = new ObjectTracker();
  const t0 = 1_700_000_000_000;

  tracker.seedBaseline(
    CAM_ID,
    [
      { x1: 0.45, y1: 0.19, x2: 0.71, y2: 0.36, label: 'car', confidence: 90 },
      { x1: 0.24, y1: 0.14, x2: 0.33, y2: 0.22, label: 'truck', confidence: 62 },
    ],
    t0
  );

  assert.equal(tracker.getTracks(CAM_ID).length, 2);

  let now = t0 + 1000;
  for (let i = 0; i < 15; i++) {
    tracker.notifyQuietFrame(CAM_ID, now);
    now += 60_000;
  }

  for (let i = 0; i < 12; i++) {
    const jitter = ((i % 3) - 1) * 0.004;
    const res = tracker.update(
      CAM_ID,
      [
        {
          x1: 0.45 + jitter,
          y1: 0.19 - jitter,
          x2: 0.71 + jitter,
          y2: 0.36,
          label: i % 2 === 0 ? 'truck' : 'car',
          confidence: 89.5,
          motionCoverage: 0.48,
        },
      ],
      now
    );
    assert.equal(res.movingBoxes.length, 0, `Expected 0 moving boxes on frame ${i}`);
    assert.equal(res.alertableBoxes.length, 0, `Expected 0 alerts on frame ${i}`);
    now += 400;
  }
});

test('2. Partially obstructed person behind/in front of parked SUV triggers IMMEDIATELY on Frame 1 (person only)', () => {
  const tracker = new ObjectTracker();
  let now = 1_700_000_000_000;

  tracker.seedBaseline(
    CAM_ID,
    [{ x1: 0.45, y1: 0.19, x2: 0.71, y2: 0.36, label: 'car', confidence: 90 }],
    now
  );

  // Frame 1: Partially obstructed person (head & shoulders visible behind SUV / barrel, modest motionCoverage 0.08)
  now += 250;
  const f1 = tracker.update(
    CAM_ID,
    [
      { x1: 0.44, y1: 0.15, x2: 0.49, y2: 0.27, label: 'person', confidence: 68, motionCoverage: 0.08 },
      { x1: 0.52, y1: 0.19, x2: 0.71, y2: 0.36, label: 'car', confidence: 84, motionCoverage: 0.32 },
    ],
    now
  );
  assert.equal(f1.movingBoxes.length, 1);
  assert.equal(f1.movingBoxes[0].label, 'person');
  assert.equal(f1.alertableBoxes.length, 1, 'Obstructed person glimpse must trigger on Frame 1');
  assert.equal(f1.alertableBoxes[0].label, 'person');

  assert.equal(
    tracker.matchesStationaryAnchor(CAM_ID, {
      x1: 0.45,
      y1: 0.19,
      x2: 0.71,
      y2: 0.36,
      label: 'car',
      confidence: 91,
    }),
    true
  );

  tracker.markAlerted(CAM_ID, f1.alertableBoxes, now);

  // Frame 2: Person continues walking -> live box stays on person, no duplicate alert
  now += 250;
  const f2 = tracker.update(
    CAM_ID,
    [
      { x1: 0.52, y1: 0.16, x2: 0.58, y2: 0.30, label: 'person', confidence: 74, motionCoverage: 0.40 },
      { x1: 0.45, y1: 0.19, x2: 0.71, y2: 0.36, label: 'car', confidence: 90, motionCoverage: 0.22 },
    ],
    now
  );
  assert.equal(f2.movingBoxes.length, 1);
  assert.equal(f2.movingBoxes[0].label, 'person');
  assert.equal(f2.alertableBoxes.length, 0);
});

test('3. Huge fast-moving SUV driving past camera triggers on Frame 1 and links across wide 40% screen jump', () => {
  const tracker = new ObjectTracker();
  let now = 1_700_000_000_000;

  // Even with a parked car in the background, a huge passing SUV in foreground triggers immediately
  tracker.seedBaseline(
    CAM_ID,
    [{ x1: 0.45, y1: 0.19, x2: 0.71, y2: 0.36, label: 'car', confidence: 90 }],
    now
  );

  now += 250;
  const s1 = tracker.update(
    CAM_ID,
    [
      // Huge SUV covering 55% width x 50% height on left/center
      { x1: 0.05, y1: 0.35, x2: 0.60, y2: 0.88, label: 'car', confidence: 92, motionCoverage: 0.65 },
      { x1: 0.45, y1: 0.19, x2: 0.71, y2: 0.36, label: 'car', confidence: 88, motionCoverage: 0.15 },
    ],
    now
  );
  assert.equal(s1.movingBoxes.length, 1);
  assert.equal(s1.alertableBoxes.length, 1, 'Fast passing SUV must alert immediately on Frame 1');
  tracker.markAlerted(CAM_ID, s1.alertableBoxes, now);

  // Next frame: SUV jumps +38% across the screen in 250ms -> links to same track without re-alerting
  now += 250;
  const s2 = tracker.update(
    CAM_ID,
    [{ x1: 0.43, y1: 0.35, x2: 0.98, y2: 0.88, label: 'truck', confidence: 91, motionCoverage: 0.70 }],
    now
  );
  assert.equal(s2.movingBoxes.length, 1);
  assert.equal(s2.alertableBoxes.length, 0, 'Wide jump must associate to existing SUV track');
});

test('4. Parked SUV starting up and departing triggers car departure alert and live moving boxes', () => {
  const tracker = new ObjectTracker();
  let now = 1_700_000_000_000;

  tracker.seedBaseline(
    CAM_ID,
    [{ x1: 0.45, y1: 0.19, x2: 0.71, y2: 0.36, label: 'car', confidence: 90 }],
    now
  );

  now += 300;
  const d1 = tracker.update(
    CAM_ID,
    [{ x1: 0.51, y1: 0.19, x2: 0.77, y2: 0.36, label: 'car', confidence: 89, motionCoverage: 0.42 }],
    now
  );
  assert.equal(d1.alertableBoxes.length, 0);

  now += 300;
  const d2 = tracker.update(
    CAM_ID,
    [{ x1: 0.58, y1: 0.20, x2: 0.84, y2: 0.37, label: 'car', confidence: 91, motionCoverage: 0.52 }],
    now
  );
  assert.equal(d2.movingBoxes.length, 1);
  assert.equal(d2.alertableBoxes.length, 1);

  assert.equal(
    tracker.matchesStationaryAnchor(CAM_ID, {
      x1: 0.58,
      y1: 0.20,
      x2: 0.84,
      y2: 0.37,
      label: 'car',
      confidence: 92,
    }),
    false
  );
});

test('5. Full lifecycle: New car arrives (1 alert) -> parks (0 boxes, 0 alerts) -> departs (1 alert)', () => {
  const tracker = new ObjectTracker();
  let now = 1_700_000_000_000;

  tracker.seedBaseline(CAM_ID, [], now);

  now += 300;
  const a1 = tracker.update(
    CAM_ID,
    [{ x1: 0.68, y1: 0.20, x2: 0.94, y2: 0.37, label: 'car', confidence: 87, motionCoverage: 0.55 }],
    now
  );
  assert.equal(a1.movingBoxes.length, 1);
  assert.equal(a1.alertableBoxes.length, 1);
  tracker.markAlerted(CAM_ID, a1.alertableBoxes, now);

  now += 300;
  const a2 = tracker.update(
    CAM_ID,
    [{ x1: 0.45, y1: 0.19, x2: 0.71, y2: 0.36, label: 'car', confidence: 90, motionCoverage: 0.48 }],
    now
  );
  assert.equal(a2.movingBoxes.length, 1);
  assert.equal(a2.alertableBoxes.length, 0);

  // Car stops moving -> movingBoxes immediately becomes empty!
  now += 300;
  const stopped = tracker.update(
    CAM_ID,
    [{ x1: 0.45, y1: 0.19, x2: 0.71, y2: 0.36, label: 'car', confidence: 90, motionCoverage: 0.02 }],
    now
  );
  assert.equal(stopped.movingBoxes.length, 0);
  assert.equal(stopped.alertableBoxes.length, 0);

  now += 11_000;
  tracker.notifyQuietFrame(CAM_ID, now);
  assert.equal(tracker.getTracks(CAM_ID)[0]?.isStationary, true);

  // Clouds pass 10 minutes later -> 0 boxes, 0 alerts
  now += 600_000;
  const cloud = tracker.update(
    CAM_ID,
    [{ x1: 0.45, y1: 0.19, x2: 0.71, y2: 0.36, label: 'car', confidence: 90, motionCoverage: 0.40 }],
    now
  );
  assert.equal(cloud.movingBoxes.length, 0);
  assert.equal(cloud.alertableBoxes.length, 0);

  // Departs -> 1 departure alert
  now += 300;
  tracker.update(
    CAM_ID,
    [{ x1: 0.38, y1: 0.19, x2: 0.64, y2: 0.36, label: 'car', confidence: 89, motionCoverage: 0.48 }],
    now
  );
  now += 300;
  const dep = tracker.update(
    CAM_ID,
    [{ x1: 0.29, y1: 0.19, x2: 0.55, y2: 0.36, label: 'car', confidence: 91, motionCoverage: 0.55 }],
    now
  );
  assert.equal(dep.movingBoxes.length, 1);
  assert.equal(dep.alertableBoxes.length, 1);
});

test('6. Sunrise newly-illuminated static vehicle is silently anchored without false alert', () => {
  const tracker = new ObjectTracker();
  let now = 1_700_000_000_000;

  tracker.seedBaseline(CAM_ID, [], now);

  for (let i = 0; i < 5; i++) {
    now += 1000;
    const res = tracker.update(
      CAM_ID,
      [{ x1: 0.24, y1: 0.14, x2: 0.33, y2: 0.22, label: 'truck', confidence: 74, motionCoverage: 0.14 }],
      now
    );
    assert.equal(res.movingBoxes.length, 0);
    assert.equal(res.alertableBoxes.length, 0);
  }

  const tracks = tracker.getTracks(CAM_ID);
  assert.equal(tracks.length, 1);
  assert.equal(tracks[0].isStationary, true);
});

test('7. Spatial-median motion grid cancels cloud luma jumps while detecting BOTH huge 40% SUVs and tiny 1-cell obstructed people on Frame 1', async () => {
  const engine = new AiVisionEngine() as unknown as {
    evaluateMotionGrid: (
      cameraId: string,
      jpegBuffer: Buffer
    ) => Promise<{
      initialized: boolean;
      hasSustainedMotion: boolean;
      activeCells: Uint8Array;
      clusters: Array<{ cells: number }>;
    }>;
  };

  const makeSolidJpeg = async (
    luma: number,
    rect?: { x: number; y: number; w: number; h: number; val: number }
  ) => {
    const width = 640;
    const height = 360;
    const buf = Buffer.alloc(width * height * 3, luma);
    if (rect) {
      for (let y = rect.y; y < rect.y + rect.h; y++) {
        for (let x = rect.x; x < rect.x + rect.w; x++) {
          const idx = (y * width + x) * 3;
          buf[idx] = rect.val;
          buf[idx + 1] = rect.val;
          buf[idx + 2] = rect.val;
        }
      }
    }
    return sharp(buf, { raw: { width, height, channels: 3 } }).jpeg({ quality: 90 }).toBuffer();
  };

  // Initialize background at luma 100
  const frame0 = await makeSolidJpeg(100);
  const m0 = await engine.evaluateMotionGrid('cam_median_test', frame0);
  assert.equal(m0.initialized, true);

  // Cloud clears: entire frame brightens by +24 luma simultaneously -> spatial median cancels to 0 motion!
  const cloudFrame = await makeSolidJpeg(124);
  const mCloud = await engine.evaluateMotionGrid('cam_median_test', cloudFrame);
  assert.equal(mCloud.hasSustainedMotion, false);
  assert.equal(mCloud.clusters.length, 0);

  // Tiny partial head-and-shoulders glimpse (24x24 px = ~1 cell) -> detected IMMEDIATELY on Frame 1!
  const tinyPersonFrame = await makeSolidJpeg(104, { x: 300, y: 10, w: 24, h: 24, val: 25 });
  const mTiny = await engine.evaluateMotionGrid('cam_median_test', tinyPersonFrame);
  assert.equal(mTiny.hasSustainedMotion, true, '1-cell obstructed upper-body motion must trigger on Frame 1');
  assert.ok(mTiny.clusters.length >= 1);

  // Huge SUV covering 42% of the entire frame (420x230 out of 640x360) -> NEVER dropped by IR-cut filter!
  const hugeSuvFrame = await makeSolidJpeg(104, { x: 80, y: 90, w: 420, h: 230, val: 15 });
  const mHuge = await engine.evaluateMotionGrid('cam_median_test', hugeSuvFrame);
  assert.equal(mHuge.hasSustainedMotion, true, 'Huge foreground SUV covering 42% of frame must NOT be dropped');
  assert.ok(mHuge.clusters.length >= 1);
});

test('8. All three bundled YOLO11 ONNX models (yolo11n, yolo11s, yolo11m) load and execute cleanly on CPU & DirectML', async () => {
  const engine = new AiVisionEngine();
  const blank16x9 = await sharp({
    create: { width: 640, height: 360, channels: 3, background: { r: 90, g: 120, b: 85 } },
  })
    .jpeg()
    .toBuffer();

  for (const modelId of ['yolo11n', 'yolo11s', 'yolo11m'] as const) {
    const session = await engine.setModelOverride(modelId, 'cpu');
    assert.ok(session, `Expected ${modelId} ONNX session to load on CPU`);
    const dets = await engine.runYoloV8Inference(blank16x9, ['person', 'car', 'truck', 'dog']);
    assert.equal(dets.length, 0);
  }

  // Also verify DirectML GPU provider hot-swap on YOLO11s
  const dmlSession = await engine.setModelOverride('yolo11s', 'dml');
  assert.ok(dmlSession, 'Expected yolo11s ONNX session to load with DirectML GPU provider');
  const dmlDets = await engine.runYoloV8Inference(blank16x9, ['person', 'car', 'truck', 'dog']);
  assert.equal(dmlDets.length, 0);
});

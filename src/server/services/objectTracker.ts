import { BoundingBox } from '../../shared/types.js';

export type SemanticGroup = 'vehicle' | 'two_wheeler' | 'person' | 'animal' | 'other';

export interface DetectionCandidate extends BoundingBox {
  /** Fraction [0..1] of the bounding box covered by active foreground motion */
  motionCoverage: number;
}

export interface TrackedObject {
  id: string;
  semanticGroup: SemanticGroup;
  label: string;
  confidence: number;
  box: BoundingBox;
  initialBox: BoundingBox;
  anchorBox: BoundingBox | null;
  firstSeenMs: number;
  lastSeenMs: number;
  totalHits: number;
  consecutiveHits: number;
  missingFrames: number;
  isStationary: boolean;
  hasConfirmedMovement: boolean;
  alertedForCurrentMove: boolean;
  stationaryCandidateSinceMs: number | null;
  departureStreak: number;
}

export interface TrackerUpdateResult {
  /** Confirmed actively moving objects for LIVE_DETECTIONS HUD overlay */
  movingBoxes: BoundingBox[];
  /** Subset of movingBoxes that have not yet triggered an alert for their current movement */
  alertableBoxes: BoundingBox[];
}

const VEHICLE_LABELS = new Set(['car', 'truck', 'bus', 'train', 'boat']);
const TWO_WHEELER_LABELS = new Set(['motorcycle', 'bicycle']);
const ANIMAL_LABELS = new Set([
  'dog',
  'cat',
  'bird',
  'horse',
  'sheep',
  'cow',
  'bear',
  'elephant',
  'zebra',
  'giraffe',
]);

export function getSemanticGroup(label: string): SemanticGroup {
  const l = label.toLowerCase().trim();
  if (VEHICLE_LABELS.has(l)) return 'vehicle';
  if (TWO_WHEELER_LABELS.has(l)) return 'two_wheeler';
  if (l === 'person') return 'person';
  if (ANIMAL_LABELS.has(l)) return 'animal';
  return 'other';
}

export function isVehicleGroup(group: SemanticGroup): boolean {
  return group === 'vehicle' || group === 'two_wheeler';
}

export function boxArea(b: { x1: number; y1: number; x2: number; y2: number }): number {
  return Math.max(0, b.x2 - b.x1) * Math.max(0, b.y2 - b.y1);
}

export function boxCenter(b: { x1: number; y1: number; x2: number; y2: number }): {
  cx: number;
  cy: number;
} {
  return {
    cx: (b.x1 + b.x2) * 0.5,
    cy: (b.y1 + b.y2) * 0.5,
  };
}

export function intersectionArea(
  a: { x1: number; y1: number; x2: number; y2: number },
  b: { x1: number; y1: number; x2: number; y2: number }
): number {
  const ix1 = Math.max(a.x1, b.x1);
  const iy1 = Math.max(a.y1, b.y1);
  const ix2 = Math.min(a.x2, b.x2);
  const iy2 = Math.min(a.y2, b.y2);
  return Math.max(0, ix2 - ix1) * Math.max(0, iy2 - iy1);
}

export function computeBoxIoU(
  a: { x1: number; y1: number; x2: number; y2: number },
  b: { x1: number; y1: number; x2: number; y2: number }
): number {
  const inter = intersectionArea(a, b);
  if (inter <= 0) return 0;
  const union = boxArea(a) + boxArea(b) - inter;
  return union > 0 ? inter / union : 0;
}

export function centerDistance(
  a: { x1: number; y1: number; x2: number; y2: number },
  b: { x1: number; y1: number; x2: number; y2: number }
): number {
  const ca = boxCenter(a);
  const cb = boxCenter(b);
  return Math.hypot(ca.cx - cb.cx, ca.cy - cb.cy);
}

function cloneBox(b: BoundingBox): BoundingBox {
  return {
    x1: b.x1,
    y1: b.y1,
    x2: b.x2,
    y2: b.y2,
    label: b.label,
    confidence: b.confidence,
  };
}

/**
 * High-Recall Multi-Object Tracker with Persistent Stationary Vehicle Anchoring.
 *
 * Design principles:
 * 1. Never miss genuine movement: People, pets, two-wheelers, and actively moving vehicles
 *    confirm immediately on Frame 1 when accompanied by foreground motion, and link across
 *    wide frame-to-frame travel distances (up to 48% of screen width per step).
 * 2. Zero parked-vehicle spam: Already-parked vehicles are anchored as `isStationary = true`
 *    and emit 0 boxes and 0 alerts across wind, clouds, glare, or people walking past.
 * 3. Reliable departure alerts: When a parked vehicle drives/reverses out of its `anchorBox`
 *    across >= 2 frames (~0.4s), `isStationary` clears and triggers a departure alert.
 */
export class ObjectTracker {
  private tracksByCamera = new Map<string, TrackedObject[]>();
  private nextTrackSeq = 1;

  /**
   * Seeds already-present vehicles on the camera's initial baseline frame as stationary
   * so parked cars/SUVs/tractors never false-alert after NVR startup or camera reconnect.
   */
  public seedBaseline(cameraId: string, detections: BoundingBox[], nowMs = Date.now()): void {
    const seeded: TrackedObject[] = [];

    for (const det of detections) {
      const group = getSemanticGroup(det.label);
      if (group !== 'vehicle') continue;

      if (seeded.some((t) => t.semanticGroup === group && computeBoxIoU(t.box, det) >= 0.45)) {
        continue;
      }

      const clean = cloneBox(det);
      seeded.push({
        id: `trk_${this.nextTrackSeq++}`,
        semanticGroup: group,
        label: det.label.toLowerCase(),
        confidence: det.confidence,
        box: clean,
        initialBox: cloneBox(clean),
        anchorBox: cloneBox(clean),
        firstSeenMs: nowMs,
        lastSeenMs: nowMs,
        totalHits: 2,
        consecutiveHits: 2,
        missingFrames: 0,
        isStationary: true,
        hasConfirmedMovement: false,
        alertedForCurrentMove: false,
        stationaryCandidateSinceMs: nowMs,
        departureStreak: 0,
      });
    }

    this.tracksByCamera.set(cameraId, seeded);
  }

  /**
   * Called on frames where foreground motion was below threshold and YOLO inference was skipped.
   * Preserves all stationary vehicle anchors indefinitely and settles arrived vehicles into
   * stationary parked anchors after 10s of quiet.
   */
  public notifyQuietFrame(cameraId: string, nowMs = Date.now()): void {
    const tracks = this.tracksByCamera.get(cameraId);
    if (!tracks || tracks.length === 0) return;

    const kept: TrackedObject[] = [];
    for (const track of tracks) {
      if (track.isStationary) {
        track.departureStreak = 0;
        kept.push(track);
        continue;
      }

      track.consecutiveHits = 0;

      if (track.semanticGroup === 'vehicle' && track.hasConfirmedMovement) {
        if (track.stationaryCandidateSinceMs === null) {
          track.stationaryCandidateSinceMs = nowMs;
        }
        if (nowMs - track.stationaryCandidateSinceMs >= 10000) {
          track.isStationary = true;
          track.anchorBox = cloneBox(track.box);
          track.initialBox = cloneBox(track.box);
          track.hasConfirmedMovement = false;
          track.alertedForCurrentMove = false;
          track.missingFrames = 0;
          track.departureStreak = 0;
        }
        kept.push(track);
        continue;
      }

      // Keep recently seen foreground tracks alive across brief occlusions (e.g. walking behind SUV/pillar)
      if (nowMs - track.lastSeenMs < 6000) {
        kept.push(track);
      }
    }

    this.tracksByCamera.set(cameraId, kept);
  }

  /**
   * Updates per-camera tracks with object detections from a motion-active frame.
   */
  public update(
    cameraId: string,
    candidates: DetectionCandidate[],
    nowMs = Date.now()
  ): TrackerUpdateResult {
    const tracks = this.tracksByCamera.get(cameraId) ?? [];

    interface MatchPair {
      trackIdx: number;
      candIdx: number;
      score: number;
    }

    const pairs: MatchPair[] = [];
    for (let tIdx = 0; tIdx < tracks.length; tIdx++) {
      const track = tracks[tIdx];
      for (let cIdx = 0; cIdx < candidates.length; cIdx++) {
        const cand = candidates[cIdx];
        if (getSemanticGroup(cand.label) !== track.semanticGroup) continue;

        if (track.isStationary && track.anchorBox) {
          // Stationary tracks match tightly around their parking spot (plus initial departure step)
          // so passing vehicles elsewhere in the frame are never swallowed by a parked anchor.
          const anchorIoU = computeBoxIoU(track.anchorBox, cand);
          const anchorDist = centerDistance(track.anchorBox, cand);
          const boxIoU = computeBoxIoU(track.box, cand);
          const boxDist = centerDistance(track.box, cand);
          const bestIoU = Math.max(anchorIoU, boxIoU);
          const bestDist = Math.min(anchorDist, boxDist);

          if (bestIoU >= 0.24 || bestDist <= 0.15) {
            const score = 1.0 + bestIoU + Math.max(0, 0.2 - bestDist);
            pairs.push({ trackIdx: tIdx, candIdx: cIdx, score });
          }
        } else {
          // Moving tracks allow wide travel up to 48% of screen width between frames for fast vehicles/walkers
          const iou = computeBoxIoU(track.box, cand);
          const dist = centerDistance(track.box, cand);
          if (iou >= 0.05 || dist <= 0.48) {
            const score = iou + Math.max(0, 0.5 - dist);
            pairs.push({ trackIdx: tIdx, candIdx: cIdx, score });
          }
        }
      }
    }

    pairs.sort((a, b) => b.score - a.score);

    const matchedTrackIndices = new Set<number>();
    const matchedCandIndices = new Set<number>();
    const candByTrackIdx = new Map<number, number>();

    for (const pair of pairs) {
      if (matchedTrackIndices.has(pair.trackIdx) || matchedCandIndices.has(pair.candIdx)) {
        continue;
      }
      matchedTrackIndices.add(pair.trackIdx);
      matchedCandIndices.add(pair.candIdx);
      candByTrackIdx.set(pair.trackIdx, pair.candIdx);
    }

    const movingBoxes: BoundingBox[] = [];
    const alertableBoxes: BoundingBox[] = [];
    const nextTracks: TrackedObject[] = [];

    // 1. Update matched & unmatched existing tracks
    for (let tIdx = 0; tIdx < tracks.length; tIdx++) {
      const track = tracks[tIdx];
      const cIdx = candByTrackIdx.get(tIdx);

      if (cIdx === undefined) {
        track.missingFrames += 1;
        track.consecutiveHits = 0;
        track.departureStreak = 0;

        if (track.isStationary) {
          if (track.missingFrames < 5 || nowMs - track.lastSeenMs < 10000) {
            nextTracks.push(track);
          }
        } else {
          // Preserve active tracks briefly across obstacles (e.g. person walking behind car/barrel)
          if (track.missingFrames < 5 && nowMs - track.lastSeenMs < 8000) {
            nextTracks.push(track);
          }
        }
        continue;
      }

      const cand = candidates[cIdx];
      const prevBox = track.box;
      const frameShift = centerDistance(prevBox, cand);

      track.missingFrames = 0;
      track.totalHits += 1;
      track.consecutiveHits += 1;
      track.lastSeenMs = nowMs;
      track.label = cand.label.toLowerCase();
      track.confidence = cand.confidence;
      track.box = cloneBox(cand);

      // A. Parked / Stationary Vehicle Track
      if (track.isStationary && track.anchorBox) {
        const anchor = track.anchorBox;
        const cShift = centerDistance(cand, anchor);
        const outsideAnchorRatio =
          1 - intersectionArea(cand, anchor) / Math.max(1e-6, boxArea(cand));
        const areaRatio = boxArea(cand) / Math.max(1e-6, boxArea(anchor));
        const bottomShift = Math.abs(cand.y2 - anchor.y2);

        const occludedByOther = candidates.some((other, idx) => {
          if (idx === cIdx) return false;
          const inter = intersectionArea(other, anchor);
          if (inter <= 0) return false;
          return inter / Math.max(1e-6, Math.min(boxArea(other), boxArea(anchor))) >= 0.15;
        });

        const translatedOutOfSpot = outsideAnchorRatio >= 0.15 && cShift >= 0.04;
        const depthDeparted =
          !occludedByOther &&
          (areaRatio <= 0.70 || areaRatio >= 1.38) &&
          (cShift >= 0.035 || bottomShift >= 0.035);

        const isDepartingFrame =
          cand.motionCoverage >= 0.12 && (translatedOutOfSpot || depthDeparted);

        if (isDepartingFrame) {
          track.departureStreak += 1;
          if (track.departureStreak >= 2) {
            track.isStationary = false;
            track.initialBox = cloneBox(anchor);
            track.anchorBox = null;
            track.hasConfirmedMovement = true;
            track.alertedForCurrentMove = false;
            track.stationaryCandidateSinceMs = null;
            track.departureStreak = 0;

            const emitted = cloneBox(track.box);
            movingBoxes.push(emitted);
            alertableBoxes.push(emitted);
          }
        } else {
          track.departureStreak = 0;
        }

        nextTracks.push(track);
        continue;
      }

      // B. Non-stationary Moving Track
      const shiftFromInitial = centerDistance(cand, track.initialBox);
      const outsideInitialRatio =
        1 - intersectionArea(cand, track.initialBox) / Math.max(1e-6, boxArea(cand));
      const scaleChangeFromInitial =
        Math.abs(boxArea(cand) - boxArea(track.initialBox)) /
        Math.max(1e-6, boxArea(track.initialBox));

      if (track.semanticGroup === 'vehicle') {
        const displaced =
          shiftFromInitial >= 0.02 ||
          outsideInitialRatio >= 0.10 ||
          scaleChangeFromInitial >= 0.12;

        if (!track.hasConfirmedMovement) {
          if (
            cand.motionCoverage >= 0.20 ||
            (displaced && cand.motionCoverage >= 0.08)
          ) {
            track.hasConfirmedMovement = true;
            track.stationaryCandidateSinceMs = null;
          } else if (
            !displaced &&
            (track.totalHits >= 4 || nowMs - track.firstSeenMs >= 3500)
          ) {
            // Unmoving static vehicle revealed by sunrise/lighting -> anchor silently!
            track.isStationary = true;
            track.anchorBox = cloneBox(cand);
            track.alertedForCurrentMove = false;
            track.stationaryCandidateSinceMs = nowMs;
            track.departureStreak = 0;
            nextTracks.push(track);
            continue;
          }
        }

        if (track.hasConfirmedMovement) {
          const activelyMovingNow = frameShift >= 0.010 || cand.motionCoverage >= 0.10;
          if (activelyMovingNow) {
            track.stationaryCandidateSinceMs = null;
            const emitted = cloneBox(track.box);
            movingBoxes.push(emitted);
            if (!track.alertedForCurrentMove) {
              alertableBoxes.push(emitted);
            }
          } else {
            if (track.stationaryCandidateSinceMs === null) {
              track.stationaryCandidateSinceMs = nowMs;
            }
            if (nowMs - track.stationaryCandidateSinceMs >= 10000) {
              track.isStationary = true;
              track.anchorBox = cloneBox(track.box);
              track.initialBox = cloneBox(track.box);
              track.hasConfirmedMovement = false;
              track.alertedForCurrentMove = false;
              track.departureStreak = 0;
            }
          }
        }

        nextTracks.push(track);
        continue;
      }

      // C. Person, Animal, Two-Wheeler, Other -> High sensitivity including partial obstruction
      const activeForeground =
        cand.motionCoverage >= 0.03 || frameShift >= 0.010 || shiftFromInitial >= 0.015;
      if (activeForeground) {
        track.hasConfirmedMovement = true;
        const emitted = cloneBox(track.box);
        movingBoxes.push(emitted);
        if (!track.alertedForCurrentMove) {
          alertableBoxes.push(emitted);
        }
      }

      nextTracks.push(track);
    }

    // 2. Register newly appearing candidates — confirm immediately on Frame 1 when genuinely moving!
    for (let cIdx = 0; cIdx < candidates.length; cIdx++) {
      if (matchedCandIndices.has(cIdx)) continue;
      const cand = candidates[cIdx];
      const group = getSemanticGroup(cand.label);
      const clean = cloneBox(cand);

      // Immediate confirmation on Frame 1:
      // - People / Pets / Two-Wheelers: any motion overlap >= 3% (catches brief obstructed glimpses!)
      // - New Vehicles (not matching any parked anchor): clear interior motion >= 22% (catches fast SUVs immediately!)
      const confirmedImmediately =
        group === 'vehicle' ? cand.motionCoverage >= 0.22 : cand.motionCoverage >= 0.03;

      const newTrack: TrackedObject = {
        id: `trk_${this.nextTrackSeq++}`,
        semanticGroup: group,
        label: cand.label.toLowerCase(),
        confidence: cand.confidence,
        box: clean,
        initialBox: cloneBox(clean),
        anchorBox: null,
        firstSeenMs: nowMs,
        lastSeenMs: nowMs,
        totalHits: 1,
        consecutiveHits: 1,
        missingFrames: 0,
        isStationary: false,
        hasConfirmedMovement: confirmedImmediately,
        alertedForCurrentMove: false,
        stationaryCandidateSinceMs: null,
        departureStreak: 0,
      };

      nextTracks.push(newTrack);

      if (confirmedImmediately) {
        const emitted = cloneBox(clean);
        movingBoxes.push(emitted);
        alertableBoxes.push(emitted);
      }
    }

    this.tracksByCamera.set(cameraId, nextTracks);
    return { movingBoxes, alertableBoxes };
  }

  /**
   * Returns true if a 4K main-stream bounding box corresponds to a known parked/stationary
   * vehicle anchor on this camera so parked vehicles are stripped from 4K snapshots and alerts.
   */
  public matchesStationaryAnchor(cameraId: string, box: BoundingBox): boolean {
    const group = getSemanticGroup(box.label);
    if (group !== 'vehicle') return false;

    const tracks = this.tracksByCamera.get(cameraId);
    if (!tracks || tracks.length === 0) return false;

    for (const track of tracks) {
      if (!track.isStationary || !track.anchorBox || track.semanticGroup !== group) continue;
      const iou = computeBoxIoU(box, track.anchorBox);
      if (iou >= 0.50) return true;

      const inter = intersectionArea(box, track.anchorBox);
      const containedInAnchor = inter / Math.max(1e-6, boxArea(box));
      const cShift = centerDistance(box, track.anchorBox);
      if (containedInAnchor >= 0.78 && cShift < 0.06) return true;
    }

    return false;
  }

  /**
   * Marks matching active tracks as having triggered an alert for their current movement.
   */
  public markAlerted(cameraId: string, alertedBoxes: BoundingBox[], nowMs = Date.now()): void {
    const tracks = this.tracksByCamera.get(cameraId);
    if (!tracks || tracks.length === 0) return;

    for (const alerted of alertedBoxes) {
      const group = getSemanticGroup(alerted.label);
      for (const track of tracks) {
        if (track.isStationary || track.semanticGroup !== group) continue;
        if (
          computeBoxIoU(track.box, alerted) >= 0.05 ||
          centerDistance(track.box, alerted) <= 0.48
        ) {
          track.alertedForCurrentMove = true;
          track.lastSeenMs = nowMs;
        }
      }
    }
  }

  public getTracks(cameraId: string): ReadonlyArray<TrackedObject> {
    return this.tracksByCamera.get(cameraId) ?? [];
  }

  public resetCamera(cameraId: string): void {
    this.tracksByCamera.delete(cameraId);
  }
}

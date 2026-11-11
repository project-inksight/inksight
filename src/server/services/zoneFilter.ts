import { BoundingBox, Point2D, PolygonZone } from '../../shared/types.js';

/**
 * Ray-casting Point-in-Polygon algorithm.
 * Coordinates are normalized [0.0 .. 1.0].
 */
export function isPointInPolygon(point: Point2D, polygon: Point2D[]): boolean {
  if (!polygon || polygon.length < 3) return false;

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

/**
 * Computes the bottom-center anchor point ((x1 + x2) / 2, y2) of a bounding box
 * (representing where a person's feet or vehicle's tires touch the ground).
 */
export function getBoxBottomCenter(box: BoundingBox): Point2D {
  return {
    x: (box.x1 + box.x2) / 2,
    y: box.y2,
  };
}

/**
 * Evaluates whether a detected bounding box passes a camera's polygon zones:
 * - Bottom-center point ((x1+x2)/2, y2) must NOT be inside any active exclusion zone.
 * - If at least one active inclusion zone exists with >= 3 points, bottom-center point
 *   MUST fall inside at least one active inclusion zone.
 */
export function isBoxAllowedByZones(box: BoundingBox, zones: PolygonZone[]): boolean {
  if (!zones || zones.length === 0) return true;

  const anchor = getBoxBottomCenter(box);
  const activeZones = zones.filter((z) => z.active && z.points && z.points.length >= 3);
  if (activeZones.length === 0) return true;

  const exclusionZones = activeZones.filter((z) => z.type === 'exclusion');
  for (const exZone of exclusionZones) {
    if (isPointInPolygon(anchor, exZone.points)) {
      return false;
    }
  }

  const inclusionZones = activeZones.filter((z) => z.type === 'inclusion');
  if (inclusionZones.length === 0) {
    return true;
  }

  for (const incZone of inclusionZones) {
    if (isPointInPolygon(anchor, incZone.points)) {
      return true;
    }
  }

  return false;
}

/**
 * Evaluates whether the current wall-clock time is within the camera's alert schedule.
 */
export function isWithinAlertSchedule(
  mode: '24/7' | 'night_only' | 'custom_hours',
  startHHMM = '20:00',
  endHHMM = '06:00',
  now = new Date()
): boolean {
  if (!mode || mode === '24/7') return true;

  const currentMinutes = now.getHours() * 60 + now.getMinutes();

  const parseHHMM = (str: string, fallback: number): number => {
    const parts = (str || '').split(':').map(Number);
    if (parts.length === 2 && !Number.isNaN(parts[0]) && !Number.isNaN(parts[1])) {
      return parts[0] * 60 + parts[1];
    }
    return fallback;
  };

  const startMin = mode === 'night_only' ? 20 * 60 : parseHHMM(startHHMM, 20 * 60);
  const endMin = mode === 'night_only' ? 6 * 60 : parseHHMM(endHHMM, 6 * 60);

  if (startMin <= endMin) {
    return currentMinutes >= startMin && currentMinutes <= endMin;
  } else {
    // Overnight window (e.g., 20:00 to 06:00)
    return currentMinutes >= startMin || currentMinutes <= endMin;
  }
}


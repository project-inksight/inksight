import { db, DEFAULT_SYSTEM_SETTINGS } from './schema.js';
import {
  Camera,
  CameraRecord,
  RecordingSegment,
  RecordingDaySummary,
  AIEvent,
  SystemSettings,
  AlertScheduleMode,
  PolygonZone,
  BoundingBox,
} from '../../shared/types.js';

function mapRecordToCamera(row: CameraRecord): Camera {
  let aiClasses: string[] = ['person', 'car', 'truck', 'dog', 'cat'];
  let zones: PolygonZone[] = [];
  try {
    aiClasses = JSON.parse(row.ai_classes || '[]');
  } catch {
    aiClasses = ['person', 'car'];
  }
  try {
    zones = JSON.parse(row.zones || '[]');
  } catch {
    zones = [];
  }

  return {
    id: row.id,
    name: row.name,
    ip_address: row.ip_address,
    onvif_port: Number(row.onvif_port || 80),
    username: row.username || 'admin',
    password: row.password || '',
    main_stream_url: row.main_stream_url,
    sub_stream_url: row.sub_stream_url,
    record_mode: row.record_mode,
    ai_enabled: Boolean(row.ai_enabled),
    ai_classes: aiClasses,
    min_confidence: Number(row.min_confidence ?? 65),
    zones,
    cooldown_seconds: Number(row.cooldown_seconds ?? 60),
    force_h264: Boolean(row.force_h264),
    enabled: Boolean(row.enabled),
    schedule_mode: (row.schedule_mode as AlertScheduleMode) || '24/7',
    schedule_start: row.schedule_start || '20:00',
    schedule_end: row.schedule_end || '06:00',
    webhook_url: row.webhook_url || '',
    action_script: row.action_script || '',
    audio_compat: (row.audio_compat as 'aac' | 'opus' | 'copy') || 'aac',
    created_at: row.created_at,
  };
}

export const CameraRepository = {
  getAll(): Camera[] {
    const rows = db
      .prepare(`
        SELECT * FROM cameras
        ORDER BY
          CASE WHEN ip_address IN ('192.168.1.101','192.168.1.102','192.168.1.103','192.168.1.104') AND password = 'password123' THEN 1 ELSE 0 END ASC,
          created_at DESC,
          name ASC
      `)
      .all() as CameraRecord[];
    return rows.map(mapRecordToCamera);
  },

  getById(id: string): Camera | null {
    const row = db.prepare('SELECT * FROM cameras WHERE id = ?').get(id) as CameraRecord | undefined;
    return row ? mapRecordToCamera(row) : null;
  },

  create(camera: Omit<Camera, 'created_at'> & { created_at?: string }): Camera {
    const createdAt = camera.created_at || new Date().toISOString();
    const stmt = db.prepare(`
      INSERT INTO cameras (
        id, name, ip_address, onvif_port, username, password,
        main_stream_url, sub_stream_url, record_mode, ai_enabled,
        ai_classes, min_confidence, zones, cooldown_seconds,
        force_h264, enabled, schedule_mode, schedule_start, schedule_end,
        webhook_url, action_script, audio_compat, created_at
      ) VALUES (
        @id, @name, @ip_address, @onvif_port, @username, @password,
        @main_stream_url, @sub_stream_url, @record_mode, @ai_enabled,
        @ai_classes, @min_confidence, @zones, @cooldown_seconds,
        @force_h264, @enabled, @schedule_mode, @schedule_start, @schedule_end,
        @webhook_url, @action_script, @audio_compat, @created_at
      )
    `);

    stmt.run({
      id: camera.id,
      name: camera.name,
      ip_address: camera.ip_address,
      onvif_port: camera.onvif_port ?? 80,
      username: camera.username ?? 'admin',
      password: camera.password ?? '',
      main_stream_url: camera.main_stream_url,
      sub_stream_url: camera.sub_stream_url,
      record_mode: camera.record_mode ?? 'continuous',
      ai_enabled: camera.ai_enabled ? 1 : 0,
      ai_classes: JSON.stringify(camera.ai_classes ?? ['person', 'car']),
      min_confidence: camera.min_confidence ?? 65,
      zones: JSON.stringify(camera.zones ?? []),
      cooldown_seconds: camera.cooldown_seconds ?? 60,
      force_h264: camera.force_h264 ? 1 : 0,
      enabled: camera.enabled ? 1 : 0,
      schedule_mode: camera.schedule_mode ?? '24/7',
      schedule_start: camera.schedule_start ?? '20:00',
      schedule_end: camera.schedule_end ?? '06:00',
      webhook_url: camera.webhook_url ?? '',
      action_script: camera.action_script ?? '',
      audio_compat: camera.audio_compat ?? 'aac',
      created_at: createdAt,
    });

    return this.getById(camera.id)!;
  },

  update(id: string, patch: Partial<Camera>): Camera | null {
    const existing = this.getById(id);
    if (!existing) return null;

    const merged: Camera = {
      ...existing,
      ...patch,
      id,
    };

    const stmt = db.prepare(`
      UPDATE cameras SET
        name = @name,
        ip_address = @ip_address,
        onvif_port = @onvif_port,
        username = @username,
        password = @password,
        main_stream_url = @main_stream_url,
        sub_stream_url = @sub_stream_url,
        record_mode = @record_mode,
        ai_enabled = @ai_enabled,
        ai_classes = @ai_classes,
        min_confidence = @min_confidence,
        zones = @zones,
        cooldown_seconds = @cooldown_seconds,
        force_h264 = @force_h264,
        enabled = @enabled,
        schedule_mode = @schedule_mode,
        schedule_start = @schedule_start,
        schedule_end = @schedule_end,
        webhook_url = @webhook_url,
        action_script = @action_script,
        audio_compat = @audio_compat
      WHERE id = @id
    `);

    stmt.run({
      id,
      name: merged.name,
      ip_address: merged.ip_address,
      onvif_port: merged.onvif_port,
      username: merged.username,
      password: merged.password,
      main_stream_url: merged.main_stream_url,
      sub_stream_url: merged.sub_stream_url,
      record_mode: merged.record_mode,
      ai_enabled: merged.ai_enabled ? 1 : 0,
      ai_classes: JSON.stringify(merged.ai_classes),
      min_confidence: merged.min_confidence,
      zones: JSON.stringify(merged.zones),
      cooldown_seconds: merged.cooldown_seconds,
      force_h264: merged.force_h264 ? 1 : 0,
      enabled: merged.enabled ? 1 : 0,
      schedule_mode: merged.schedule_mode,
      schedule_start: merged.schedule_start,
      schedule_end: merged.schedule_end,
      webhook_url: merged.webhook_url,
      action_script: merged.action_script,
      audio_compat: merged.audio_compat,
    });

    return this.getById(id);
  },

  delete(id: string): boolean {
    const info = db.prepare('DELETE FROM cameras WHERE id = ?').run(id);
    return info.changes > 0;
  },
};

interface SegmentRow {
  id: string;
  camera_id: string;
  file_path: string;
  start_time: number;
  end_time: number;
  duration_sec: number;
  file_size_bytes: number;
  has_ai_event: number;
  is_locked: number;
  camera_name?: string;
}

function mapSegmentRow(row: SegmentRow): RecordingSegment {
  return {
    id: row.id,
    camera_id: row.camera_id,
    file_path: row.file_path,
    start_time: Number(row.start_time),
    end_time: Number(row.end_time),
    duration_sec: Number(row.duration_sec),
    file_size_bytes: Number(row.file_size_bytes),
    has_ai_event: Boolean(row.has_ai_event),
    is_locked: Boolean(row.is_locked),
    camera_name: row.camera_name,
  };
}

export const SegmentRepository = {
  insert(segment: RecordingSegment): RecordingSegment {
    db.prepare(`
      INSERT OR REPLACE INTO recording_segments (
        id, camera_id, file_path, start_time, end_time,
        duration_sec, file_size_bytes, has_ai_event, is_locked
      ) VALUES (
        @id, @camera_id, @file_path, @start_time, @end_time,
        @duration_sec, @file_size_bytes, @has_ai_event, @is_locked
      )
    `).run({
      id: segment.id,
      camera_id: segment.camera_id,
      file_path: segment.file_path,
      start_time: segment.start_time,
      end_time: segment.end_time,
      duration_sec: segment.duration_sec,
      file_size_bytes: segment.file_size_bytes,
      has_ai_event: segment.has_ai_event ? 1 : 0,
      is_locked: segment.is_locked ? 1 : 0,
    });
    return segment;
  },

  getById(id: string): RecordingSegment | null {
    const row = db
      .prepare(`
        SELECT s.*, c.name as camera_name
        FROM recording_segments s
        LEFT JOIN cameras c ON c.id = s.camera_id
        WHERE s.id = ?
      `)
      .get(id) as SegmentRow | undefined;
    return row ? mapSegmentRow(row) : null;
  },

  getByFilePath(filePath: string): RecordingSegment | null {
    const row = db
      .prepare('SELECT * FROM recording_segments WHERE file_path = ?')
      .get(filePath) as SegmentRow | undefined;
    return row ? mapSegmentRow(row) : null;
  },

  getSegmentsInRange(params: {
    cameraId?: string;
    startTime: number;
    endTime: number;
  }): RecordingSegment[] {
    if (params.cameraId) {
      const rows = db
        .prepare(`
          SELECT s.*, c.name as camera_name
          FROM recording_segments s
          LEFT JOIN cameras c ON c.id = s.camera_id
          WHERE s.camera_id = @cameraId
            AND s.end_time >= @startTime
            AND s.start_time <= @endTime
          ORDER BY s.start_time ASC
        `)
        .all(params) as SegmentRow[];
      return rows.map(mapSegmentRow);
    } else {
      const rows = db
        .prepare(`
          SELECT s.*, c.name as camera_name
          FROM recording_segments s
          LEFT JOIN cameras c ON c.id = s.camera_id
          WHERE s.end_time >= @startTime
            AND s.start_time <= @endTime
          ORDER BY s.start_time ASC
        `)
        .all(params) as SegmentRow[];
      return rows.map(mapSegmentRow);
    }
  },

  findSegmentAtTimestamp(cameraId: string, timestampMs: number): RecordingSegment | null {
    const exact = db
      .prepare(`
        SELECT s.*, c.name as camera_name
        FROM recording_segments s
        LEFT JOIN cameras c ON c.id = s.camera_id
        WHERE s.camera_id = ?
          AND s.start_time <= ?
          AND s.end_time >= ?
        ORDER BY s.start_time DESC
        LIMIT 1
      `)
      .get(cameraId, timestampMs, timestampMs) as SegmentRow | undefined;

    if (exact) return mapSegmentRow(exact);

    // Fallback: closest segment starting after or slightly before within 5 minutes
    const closest = db
      .prepare(`
        SELECT s.*, c.name as camera_name
        FROM recording_segments s
        LEFT JOIN cameras c ON c.id = s.camera_id
        WHERE s.camera_id = ?
          AND ABS(s.start_time - ?) <= 300000
        ORDER BY ABS(s.start_time - ?) ASC
        LIMIT 1
      `)
      .get(cameraId, timestampMs, timestampMs) as SegmentRow | undefined;

    return closest ? mapSegmentRow(closest) : null;
  },

  getNextSequentialSegment(cameraId: string, afterStartTime: number): RecordingSegment | null {
    const row = db
      .prepare(`
        SELECT s.*, c.name as camera_name
        FROM recording_segments s
        LEFT JOIN cameras c ON c.id = s.camera_id
        WHERE s.camera_id = ?
          AND s.start_time > ?
        ORDER BY s.start_time ASC
        LIMIT 1
      `)
      .get(cameraId, afterStartTime) as SegmentRow | undefined;
    return row ? mapSegmentRow(row) : null;
  },

  markHasAiEvent(id: string): void {
    db.prepare('UPDATE recording_segments SET has_ai_event = 1 WHERE id = ?').run(id);
  },

  setLock(id: string, isLocked: boolean): RecordingSegment | null {
    db.prepare('UPDATE recording_segments SET is_locked = ? WHERE id = ?').run(isLocked ? 1 : 0, id);
    return this.getById(id);
  },

  deleteById(id: string): boolean {
    const info = db.prepare('DELETE FROM recording_segments WHERE id = ?').run(id);
    return info.changes > 0;
  },

  getOldestUnlockedSegments(limit = 50): RecordingSegment[] {
    const rows = db
      .prepare(`
        SELECT * FROM recording_segments
        WHERE is_locked = 0
        ORDER BY start_time ASC
        LIMIT ?
      `)
      .all(limit) as SegmentRow[];
    return rows.map(mapSegmentRow);
  },

  getUnlockedSegmentsOlderThan(cutoffMs: number): RecordingSegment[] {
    const rows = db
      .prepare(`
        SELECT * FROM recording_segments
        WHERE is_locked = 0 AND end_time < ?
        ORDER BY start_time ASC
      `)
      .all(cutoffMs) as SegmentRow[];
    return rows.map(mapSegmentRow);
  },

  getStorageStats(): { totalBytes: number; segmentCount: number; lockedCount: number } {
    const row = db
      .prepare(`
        SELECT
          COALESCE(SUM(file_size_bytes), 0) as totalBytes,
          COUNT(*) as segmentCount,
          COALESCE(SUM(CASE WHEN is_locked = 1 THEN 1 ELSE 0 END), 0) as lockedCount
        FROM recording_segments
      `)
      .get() as { totalBytes: number; segmentCount: number; lockedCount: number };
    return row;
  },

  getRecordingDaysSummary(cameraId?: string): RecordingDaySummary[] {
    const segRows = (
      cameraId
        ? db
            .prepare(`
              SELECT
                strftime('%Y-%m-%d', start_time / 1000, 'unixepoch', 'localtime') as date,
                COUNT(*) as segmentCount,
                MIN(start_time) as earliestMs,
                MAX(end_time) as latestMs
              FROM recording_segments
              WHERE camera_id = ?
              GROUP BY date
              ORDER BY date DESC
              LIMIT 60
            `)
            .all(cameraId)
        : db
            .prepare(`
              SELECT
                strftime('%Y-%m-%d', start_time / 1000, 'unixepoch', 'localtime') as date,
                COUNT(*) as segmentCount,
                MIN(start_time) as earliestMs,
                MAX(end_time) as latestMs
              FROM recording_segments
              GROUP BY date
              ORDER BY date DESC
              LIMIT 60
            `)
            .all()
    ) as Array<{
      date: string | null;
      segmentCount: number;
      earliestMs: number;
      latestMs: number;
    }>;

    const evtRows = (
      cameraId
        ? db
            .prepare(`
              SELECT
                strftime('%Y-%m-%d', timestamp / 1000, 'unixepoch', 'localtime') as date,
                COUNT(*) as eventCount,
                MIN(timestamp) as earliestMs,
                MAX(timestamp) as latestMs
              FROM ai_events
              WHERE camera_id = ?
              GROUP BY date
              ORDER BY date DESC
              LIMIT 60
            `)
            .all(cameraId)
        : db
            .prepare(`
              SELECT
                strftime('%Y-%m-%d', timestamp / 1000, 'unixepoch', 'localtime') as date,
                COUNT(*) as eventCount,
                MIN(timestamp) as earliestMs,
                MAX(timestamp) as latestMs
              FROM ai_events
              GROUP BY date
              ORDER BY date DESC
              LIMIT 60
            `)
            .all()
    ) as Array<{
      date: string | null;
      eventCount: number;
      earliestMs: number;
      latestMs: number;
    }>;

    const byDate = new Map<string, RecordingDaySummary>();

    for (const r of segRows) {
      if (!r.date) continue;
      byDate.set(r.date, {
        date: r.date,
        segmentCount: Number(r.segmentCount || 0),
        eventCount: 0,
        earliestMs: Number(r.earliestMs || 0),
        latestMs: Number(r.latestMs || 0),
      });
    }

    for (const e of evtRows) {
      if (!e.date) continue;
      const existing = byDate.get(e.date);
      if (existing) {
        existing.eventCount = Number(e.eventCount || 0);
        existing.earliestMs = Math.min(existing.earliestMs || e.earliestMs, Number(e.earliestMs));
        existing.latestMs = Math.max(existing.latestMs || e.latestMs, Number(e.latestMs));
      } else {
        byDate.set(e.date, {
          date: e.date,
          segmentCount: 0,
          eventCount: Number(e.eventCount || 0),
          earliestMs: Number(e.earliestMs || 0),
          latestMs: Number(e.latestMs || 0),
        });
      }
    }

    return Array.from(byDate.values()).sort((a, b) => b.date.localeCompare(a.date));
  },
};

interface EventRow {
  id: string;
  camera_id: string;
  camera_name?: string;
  timestamp: number;
  object_class: string;
  confidence: number;
  bounding_box: string;
  snapshot_path: string;
  clip_path: string | null;
  segment_id: string | null;
  email_sent: number;
  is_acknowledged: number;
}

function mapEventRow(row: EventRow): AIEvent {
  let box: BoundingBox = {
    x1: 0.2,
    y1: 0.2,
    x2: 0.6,
    y2: 0.8,
    label: row.object_class,
    confidence: row.confidence,
  };
  try {
    box = JSON.parse(row.bounding_box);
  } catch {
    // keep default
  }

  return {
    id: row.id,
    camera_id: row.camera_id,
    camera_name: row.camera_name,
    timestamp: Number(row.timestamp),
    object_class: row.object_class,
    confidence: Number(row.confidence),
    bounding_box: box,
    snapshot_path: row.snapshot_path,
    clip_path: row.clip_path,
    segment_id: row.segment_id,
    email_sent: Boolean(row.email_sent),
    is_acknowledged: Boolean(row.is_acknowledged),
  };
}

export const EventRepository = {
  insert(event: AIEvent): AIEvent {
    db.prepare(`
      INSERT INTO ai_events (
        id, camera_id, timestamp, object_class, confidence,
        bounding_box, snapshot_path, clip_path, segment_id,
        email_sent, is_acknowledged
      ) VALUES (
        @id, @camera_id, @timestamp, @object_class, @confidence,
        @bounding_box, @snapshot_path, @clip_path, @segment_id,
        @email_sent, @is_acknowledged
      )
    `).run({
      id: event.id,
      camera_id: event.camera_id,
      timestamp: event.timestamp,
      object_class: event.object_class,
      confidence: event.confidence,
      bounding_box: JSON.stringify(event.bounding_box),
      snapshot_path: event.snapshot_path,
      clip_path: event.clip_path,
      segment_id: event.segment_id,
      email_sent: event.email_sent ? 1 : 0,
      is_acknowledged: event.is_acknowledged ? 1 : 0,
    });
    return this.getById(event.id)!;
  },

  getById(id: string): AIEvent | null {
    const row = db
      .prepare(`
        SELECT e.*, c.name as camera_name
        FROM ai_events e
        LEFT JOIN cameras c ON c.id = e.camera_id
        WHERE e.id = ?
      `)
      .get(id) as EventRow | undefined;
    return row ? mapEventRow(row) : null;
  },

  getEvents(filters: {
    cameraId?: string;
    objectClass?: string;
    startTime?: number;
    endTime?: number;
    unacknowledgedOnly?: boolean;
    limit?: number;
  }): AIEvent[] {
    const conditions: string[] = [];
    const params: Record<string, unknown> = {};

    if (filters.cameraId) {
      conditions.push('e.camera_id = @cameraId');
      params.cameraId = filters.cameraId;
    }
    if (filters.objectClass && filters.objectClass !== 'all') {
      conditions.push('LOWER(e.object_class) = LOWER(@objectClass)');
      params.objectClass = filters.objectClass;
    }
    if (filters.startTime !== undefined) {
      conditions.push('e.timestamp >= @startTime');
      params.startTime = filters.startTime;
    }
    if (filters.endTime !== undefined) {
      conditions.push('e.timestamp <= @endTime');
      params.endTime = filters.endTime;
    }
    if (filters.unacknowledgedOnly) {
      conditions.push('e.is_acknowledged = 0');
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = filters.limit ?? 200;

    const rows = db
      .prepare(`
        SELECT e.*, c.name as camera_name
        FROM ai_events e
        LEFT JOIN cameras c ON c.id = e.camera_id
        ${whereClause}
        ORDER BY e.timestamp DESC
        LIMIT ${Number(limit)}
      `)
      .all(params) as EventRow[];

    return rows.map(mapEventRow);
  },

  updateClipAndSegment(id: string, clipPath: string | null, segmentId: string | null): AIEvent | null {
    db.prepare(`
      UPDATE ai_events
      SET clip_path = COALESCE(@clipPath, clip_path),
          segment_id = COALESCE(@segmentId, segment_id)
      WHERE id = @id
    `).run({ id, clipPath, segmentId });
    return this.getById(id);
  },

  markEmailSent(id: string): AIEvent | null {
    db.prepare('UPDATE ai_events SET email_sent = 1 WHERE id = ?').run(id);
    return this.getById(id);
  },

  acknowledge(id: string, acknowledged = true): AIEvent | null {
    db.prepare('UPDATE ai_events SET is_acknowledged = ? WHERE id = ?').run(acknowledged ? 1 : 0, id);
    return this.getById(id);
  },

  acknowledgeAll(): number {
    const info = db.prepare('UPDATE ai_events SET is_acknowledged = 1 WHERE is_acknowledged = 0').run();
    return info.changes;
  },

  deleteById(id: string): boolean {
    const info = db.prepare('DELETE FROM ai_events WHERE id = ?').run(id);
    return info.changes > 0;
  },

  getCount(): number {
    const row = db.prepare('SELECT COUNT(*) as count FROM ai_events').get() as { count: number };
    return row.count;
  },
};

export const SettingsRepository = {
  getSettings(): SystemSettings {
    const rows = db.prepare('SELECT key, value FROM system_settings').all() as Array<{
      key: string;
      value: string;
    }>;
    const map: Record<string, unknown> = {};
    for (const r of rows) {
      try {
        map[r.key] = JSON.parse(r.value);
      } catch {
        // ignore invalid json
      }
    }

    return {
      smtp: { ...DEFAULT_SYSTEM_SETTINGS.smtp, ...(map.smtp as object) },
      ai: { ...DEFAULT_SYSTEM_SETTINGS.ai, ...(map.ai as object) },
      storage: { ...DEFAULT_SYSTEM_SETTINGS.storage, ...(map.storage as object) },
    };
  },

  updateSettings(patch: Partial<SystemSettings>): SystemSettings {
    const current = this.getSettings();
    const updated: SystemSettings = {
      smtp: { ...current.smtp, ...(patch.smtp || {}) },
      ai: { ...current.ai, ...(patch.ai || {}) },
      storage: { ...current.storage, ...(patch.storage || {}) },
    };

    const stmt = db.prepare(`
      INSERT INTO system_settings (key, value)
      VALUES (@key, @value)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `);

    const tx = db.transaction(() => {
      stmt.run({ key: 'smtp', value: JSON.stringify(updated.smtp) });
      stmt.run({ key: 'ai', value: JSON.stringify(updated.ai) });
      stmt.run({ key: 'storage', value: JSON.stringify(updated.storage) });
    });
    tx();

    return updated;
  },
};


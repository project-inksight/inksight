import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { SystemSettings } from '../../shared/types.js';

export const DATA_DIR = process.env.SENTINEL_DATA_DIR
  ? path.resolve(process.env.SENTINEL_DATA_DIR)
  : path.resolve(process.cwd(), 'data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const DEFAULT_STORAGE_PATH = process.env.SENTINEL_STORAGE_DIR
  ? path.resolve(process.env.SENTINEL_STORAGE_DIR)
  : path.resolve(process.cwd(), 'storage');

const DB_PATH = path.join(DATA_DIR, 'sentinel_vms.sqlite');

export const db: Database.Database = new Database(DB_PATH);

// Enable WAL mode & high-concurrency pragmas
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

export const DEFAULT_SYSTEM_SETTINGS: SystemSettings = {
  smtp: {
    enabled: false,
    host: 'smtp.gmail.com',
    port: 587,
    secure: false,
    username: '',
    password: '',
    sender: 'Inksight NVR <alerts@inksight.local>',
    recipients: '',
    maxAttachmentSizeMb: 20,
    lanBaseUrl: 'http://localhost:5173',
    telegramEnabled: false,
    telegramBotToken: '',
    telegramChatId: '',
    ntfyEnabled: false,
    ntfyServerUrl: 'https://ntfy.sh',
    ntfyTopic: '',
    pushoverEnabled: false,
    pushoverUserKey: '',
    pushoverApiToken: '',
  },
  ai: {
    provider: 'codeproject',
    localModel: 'yolo11s',
    computeDevice: 'cpu',
    codeProjectUrl: 'http://localhost:32168/v1/vision/detection',
    onnxEndpointUrl: 'http://localhost:8080/v1/vision/detection',
    idleSampleFps: 2,
    activeSampleFps: 5,
    drawHighResBoxes: true,
    globalWebhookUrl: '',
    globalScriptPath: '',
  },
  storage: {
    storagePath: DEFAULT_STORAGE_PATH,
    overwritePolicy: 'days_and_quota',
    maxStorageGb: 500,
    maxDiskUsagePercent: 85,
    preBufferSeconds: 5,
    postBufferSeconds: 10,
    retentionDays: 7,
    segmentDurationSeconds: 60,
  },
};

export function initializeDatabase(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS cameras (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      ip_address TEXT NOT NULL,
      onvif_port INTEGER NOT NULL DEFAULT 80,
      username TEXT NOT NULL DEFAULT 'admin',
      password TEXT NOT NULL DEFAULT '',
      main_stream_url TEXT NOT NULL,
      sub_stream_url TEXT NOT NULL,
      record_mode TEXT NOT NULL DEFAULT 'continuous' CHECK(record_mode IN ('continuous', 'events_only', 'off')),
      ai_enabled INTEGER NOT NULL DEFAULT 1,
      ai_classes TEXT NOT NULL DEFAULT '["person","car","truck","dog","cat"]',
      min_confidence REAL NOT NULL DEFAULT 65,
      zones TEXT NOT NULL DEFAULT '[]',
      cooldown_seconds INTEGER NOT NULL DEFAULT 60,
      force_h264 INTEGER NOT NULL DEFAULT 0,
      enabled INTEGER NOT NULL DEFAULT 1,
      schedule_mode TEXT NOT NULL DEFAULT '24/7',
      schedule_start TEXT NOT NULL DEFAULT '20:00',
      schedule_end TEXT NOT NULL DEFAULT '06:00',
      webhook_url TEXT NOT NULL DEFAULT '',
      action_script TEXT NOT NULL DEFAULT '',
      audio_compat TEXT NOT NULL DEFAULT 'aac',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS recording_segments (
      id TEXT PRIMARY KEY,
      camera_id TEXT NOT NULL,
      file_path TEXT NOT NULL,
      start_time INTEGER NOT NULL,
      end_time INTEGER NOT NULL,
      duration_sec REAL NOT NULL DEFAULT 60,
      file_size_bytes INTEGER NOT NULL DEFAULT 0,
      has_ai_event INTEGER NOT NULL DEFAULT 0,
      is_locked INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (camera_id) REFERENCES cameras(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_segments_camera_time
      ON recording_segments(camera_id, start_time, end_time);

    CREATE INDEX IF NOT EXISTS idx_segments_start_time
      ON recording_segments(start_time);

    CREATE TABLE IF NOT EXISTS ai_events (
      id TEXT PRIMARY KEY,
      camera_id TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      object_class TEXT NOT NULL,
      confidence REAL NOT NULL,
      bounding_box TEXT NOT NULL,
      snapshot_path TEXT NOT NULL,
      clip_path TEXT,
      segment_id TEXT,
      email_sent INTEGER NOT NULL DEFAULT 0,
      is_acknowledged INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (camera_id) REFERENCES cameras(id) ON DELETE CASCADE,
      FOREIGN KEY (segment_id) REFERENCES recording_segments(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_ai_events_camera_timestamp
      ON ai_events(camera_id, timestamp DESC);

    CREATE INDEX IF NOT EXISTS idx_ai_events_timestamp
      ON ai_events(timestamp DESC);

    CREATE TABLE IF NOT EXISTS system_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  // Seed default system settings
  const upsertSetting = db.prepare(`
    INSERT INTO system_settings (key, value)
    VALUES (@key, @value)
    ON CONFLICT(key) DO NOTHING
  `);

  upsertSetting.run({ key: 'smtp', value: JSON.stringify(DEFAULT_SYSTEM_SETTINGS.smtp) });
  upsertSetting.run({ key: 'ai', value: JSON.stringify(DEFAULT_SYSTEM_SETTINGS.ai) });
  upsertSetting.run({ key: 'storage', value: JSON.stringify(DEFAULT_SYSTEM_SETTINGS.storage) });

  // Ensure configured storage folders exist
  let activeStorageBase = DEFAULT_SYSTEM_SETTINGS.storage.storagePath;
  try {
    const row = db
      .prepare("SELECT value FROM system_settings WHERE key = 'storage'")
      .get() as { value?: string } | undefined;
    if (row?.value) {
      const parsed = JSON.parse(row.value) as { storagePath?: string };
      if (parsed.storagePath) {
        activeStorageBase = parsed.storagePath;
      }
    }
  } catch {
    // fallback to default storage base
  }

  const dirs = [
    activeStorageBase,
    path.join(activeStorageBase, 'recordings'),
    path.join(activeStorageBase, 'alerts', 'snapshots'),
    path.join(activeStorageBase, 'alerts', 'clips'),
    path.join(activeStorageBase, 'demo'),
  ];
  for (const dir of dirs) {
    try {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    } catch (err) {
      console.warn(`[Database] Could not create storage folder ${dir}:`, (err as Error).message);
    }
  }
}


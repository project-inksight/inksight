export type RecordMode = 'continuous' | 'events_only' | 'off';

export type AlertScheduleMode = '24/7' | 'night_only' | 'custom_hours';

export type AIObjectClass = 'person' | 'car' | 'truck' | 'bus' | 'motorcycle' | 'bicycle' | 'dog' | 'cat' | 'bird' | 'custom';

export interface Point2D {
  /** Normalized X coordinate (0.0 to 1.0) */
  x: number;
  /** Normalized Y coordinate (0.0 to 1.0) */
  y: number;
}

export interface PolygonZone {
  id: string;
  name: string;
  type: 'inclusion' | 'exclusion';
  points: Point2D[];
  color: string;
  active: boolean;
}

export interface BoundingBox {
  /** Normalized left (0.0 - 1.0) */
  x1: number;
  /** Normalized top (0.0 - 1.0) */
  y1: number;
  /** Normalized right (0.0 - 1.0) */
  x2: number;
  /** Normalized bottom (0.0 - 1.0) */
  y2: number;
  label: string;
  confidence: number;
}

export interface CameraRecord {
  id: string;
  name: string;
  ip_address: string;
  onvif_port: number;
  username: string;
  password: string;
  main_stream_url: string;
  sub_stream_url: string;
  record_mode: RecordMode;
  ai_enabled: number; // SQLite 0 | 1
  ai_classes: string; // JSON string of string[]
  min_confidence: number; // e.g., 65
  zones: string; // JSON string of PolygonZone[]
  cooldown_seconds: number;
  force_h264: number; // SQLite 0 | 1
  enabled: number; // SQLite 0 | 1
  schedule_mode?: string;
  schedule_start?: string;
  schedule_end?: string;
  webhook_url?: string;
  action_script?: string;
  audio_compat?: string; // 'aac' | 'opus' | 'copy'
  created_at: string;
}

export interface Camera {
  id: string;
  name: string;
  ip_address: string;
  onvif_port: number;
  username: string;
  password: string;
  main_stream_url: string;
  sub_stream_url: string;
  record_mode: RecordMode;
  ai_enabled: boolean;
  ai_classes: string[];
  min_confidence: number;
  zones: PolygonZone[];
  cooldown_seconds: number;
  force_h264: boolean;
  enabled: boolean;
  schedule_mode: AlertScheduleMode;
  schedule_start: string;
  schedule_end: string;
  webhook_url: string;
  action_script: string;
  audio_compat: 'aac' | 'opus' | 'copy';
  created_at: string;
}

export interface RecordingSegment {
  id: string;
  camera_id: string;
  file_path: string;
  start_time: number; // Unix timestamp ms
  end_time: number; // Unix timestamp ms
  duration_sec: number;
  file_size_bytes: number;
  has_ai_event: boolean;
  is_locked: boolean;
  camera_name?: string;
}

export interface AIEvent {
  id: string;
  camera_id: string;
  camera_name?: string;
  timestamp: number; // Unix timestamp ms
  object_class: string;
  confidence: number; // 0 to 100
  bounding_box: BoundingBox;
  snapshot_path: string;
  clip_path: string | null;
  segment_id: string | null;
  email_sent: boolean;
  is_acknowledged: boolean;
}

export interface DiscoveredLanCamera {
  ipAddress: string;
  rtspPort: number;
  httpPortOpen: boolean;
  serverBanner: string;
  suggestedBrand: 'dahua' | 'hikvision' | 'reolink' | 'onvif';
  alreadyConfigured: boolean;
  existingCameraName?: string;
}

export interface SmtpSettings {
  enabled: boolean;
  host: string;
  port: number;
  secure: boolean; // TLS/SSL
  username: string;
  password: string;
  sender: string;
  recipients: string; // comma-separated emails
  maxAttachmentSizeMb: number;
  lanBaseUrl: string;
  telegramEnabled?: boolean;
  telegramBotToken?: string;
  telegramChatId?: string;
  ntfyEnabled?: boolean;
  ntfyServerUrl?: string;
  ntfyTopic?: string;
  ntfyToken?: string;
  pushoverEnabled?: boolean;
  pushoverUserKey?: string;
  pushoverApiToken?: string;
}

export type LocalYoloModelId = 'yolo11n' | 'yolo11s' | 'yolo11m' | 'yolov8n';
export type AiComputeDevice = 'cpu' | 'dml';

export interface AiSettings {
  provider: 'codeproject' | 'onnx_local';
  localModel?: LocalYoloModelId; // default: 'yolo11s'
  computeDevice?: AiComputeDevice; // default: 'cpu'
  codeProjectUrl: string; // default: http://localhost:32168/v1/vision/detection
  onnxEndpointUrl: string; // default: http://localhost:8080/v1/vision/detection
  idleSampleFps: number; // default: 2
  activeSampleFps: number; // default: 5
  drawHighResBoxes: boolean;
  globalWebhookUrl: string;
  globalScriptPath: string;
}

export type StorageOverwritePolicy = 'days_and_quota' | 'circular_quota' | 'stop_when_full';

export interface StorageSettings {
  storagePath: string;
  overwritePolicy?: StorageOverwritePolicy;
  maxStorageGb: number;
  maxDiskUsagePercent: number;
  preBufferSeconds: number;
  postBufferSeconds: number;
  retentionDays: number;
  segmentDurationSeconds: number;
}

export interface SystemSettings {
  smtp: SmtpSettings;
  ai: AiSettings;
  storage: StorageSettings;
  nvencAvailable?: boolean;
}

export interface CameraTelemetry {
  cameraId: string;
  status: 'online' | 'recording' | 'motion' | 'offline' | 'connecting';
  codec: string; // 'H.265 / HEVC' | 'H.264 / AVC'
  subCodec: string;
  resolution: string; // e.g., '3840x2160'
  subResolution: string; // e.g., '1280x720'
  fps: number;
  bitrateKbps: number;
  audioCodec: string;
  isRecording: boolean;
  isManualRecording: boolean;
  isMotionActive: boolean;
  reconnectAttempts: number;
  nextRetryInSec?: number;
  lastError?: string;
  lastUpdated: number;
  activeDetections: BoundingBox[];
}

export interface SystemHealthStatus {
  go2rtcOnline: boolean;
  go2rtcPid: number | null;
  go2rtcApiUrl: string;
  go2rtcRtspPort: number;
  ffmpegAvailable: boolean;
  ffmpegPath: string;
  nvencSupported: boolean;
  codeProjectOnline: boolean;
  codeProjectLatencyMs: number | null;
  storageUsedBytes: number;
  storageQuotaBytes: number;
  storageUsagePercent: number;
  diskTotalBytes: number;
  diskFreeBytes: number;
  diskUsagePercent: number;
  segmentCount: number;
  lockedSegmentCount: number;
  eventCount: number;
  activeRecorders: number;
  uptimeSeconds: number;
}

export interface RecordingDaySummary {
  date: string; // 'YYYY-MM-DD' in local time
  segmentCount: number;
  eventCount: number;
  earliestMs: number;
  latestMs: number;
}

export type WSMessage =
  | { type: 'INIT_STATE'; telemetry: Record<string, CameraTelemetry>; health: SystemHealthStatus }
  | { type: 'CAMERA_TELEMETRY'; telemetry: Record<string, CameraTelemetry> }
  | { type: 'AI_EVENT_NEW'; event: AIEvent }
  | { type: 'AI_EVENT_UPDATED'; event: AIEvent }
  | { type: 'LIVE_DETECTIONS'; cameraId: string; detections: BoundingBox[]; timestamp: number }
  | { type: 'SEGMENT_ADDED'; segment: RecordingSegment }
  | { type: 'SYSTEM_HEALTH'; health: SystemHealthStatus }
  | { type: 'NOTIFICATION'; level: 'info' | 'warning' | 'error' | 'alert'; title: string; message: string; timestamp: number };


import fs from 'fs';
import { SegmentRepository, SettingsRepository } from '../db/repositories.js';
import { wsHub } from './wsHub.js';

export interface StorageDiskInfo {
  storageUsedBytes: number;
  storageQuotaBytes: number;
  storageUsagePercent: number;
  diskTotalBytes: number;
  diskFreeBytes: number;
  diskUsagePercent: number;
  segmentCount: number;
  lockedSegmentCount: number;
}

export class StorageCleanerService {
  private cronTimer: NodeJS.Timeout | null = null;
  private readonly CRON_INTERVAL_MS = 15 * 60 * 1000; // Every 15 minutes

  public start(): void {
    if (this.cronTimer) {
      clearInterval(this.cronTimer);
    }

    // Run every 15 minutes
    this.cronTimer = setInterval(() => {
      void this.runCleanupPass();
    }, this.CRON_INTERVAL_MS);

    console.log('[StorageCleaner] Circular Storage Manager scheduled (every 15 minutes)');
  }

  public stop(): void {
    if (this.cronTimer) {
      clearInterval(this.cronTimer);
      this.cronTimer = null;
    }
  }

  public getDiskMetrics(): StorageDiskInfo {
    const settings = SettingsRepository.getSettings();
    const stats = SegmentRepository.getStorageStats();
    const storageQuotaBytes = Math.max(1, settings.storage.maxStorageGb) * 1024 * 1024 * 1024;
    const storageUsedBytes = stats.totalBytes;
    const storageUsagePercent = Math.min(
      100,
      Math.round((storageUsedBytes / storageQuotaBytes) * 1000) / 10
    );

    let diskTotalBytes = 1000 * 1024 * 1024 * 1024;
    let diskFreeBytes = 500 * 1024 * 1024 * 1024;

    try {
      const targetDir = fs.existsSync(settings.storage.storagePath)
        ? settings.storage.storagePath
        : process.cwd();
      const statfs = fs.statfsSync(targetDir);
      diskTotalBytes = Number(statfs.bsize) * Number(statfs.blocks);
      diskFreeBytes = Number(statfs.bsize) * Number(statfs.bavail);
    } catch {
      // keep fallback values
    }

    const diskUsedBytes = Math.max(0, diskTotalBytes - diskFreeBytes);
    const diskUsagePercent =
      diskTotalBytes > 0 ? Math.round((diskUsedBytes / diskTotalBytes) * 1000) / 10 : 0;

    return {
      storageUsedBytes,
      storageQuotaBytes,
      storageUsagePercent,
      diskTotalBytes,
      diskFreeBytes,
      diskUsagePercent,
      segmentCount: stats.segmentCount,
      lockedSegmentCount: stats.lockedCount,
    };
  }

  /**
   * Executes a circular cleanup pass based on the selected overwritePolicy:
   * - 'days_and_quota' (default): Purges unlocked segments older than retentionDays (e.g. 7 days)
   *   AND recycles oldest unlocked segments when maxStorageGb or maxDiskUsagePercent is reached.
   * - 'circular_quota' ("Whatever Storage Holds"): Retains footage for as many days as fit within
   *   maxStorageGb / maxDiskUsagePercent, recycling the oldest unlocked segments FIFO once full.
   * - 'stop_when_full': Never auto-deletes segments unless forcePurgeCount > 0 (manual cleanup).
   * Note: Bookmarked/locked segments (is_locked = 1) are always protected from automatic deletion.
   */
  public async runCleanupPass(forcePurgeCount = 0): Promise<{
    deletedSegments: number;
    freedBytes: number;
    metrics: StorageDiskInfo;
  }> {
    const settings = SettingsRepository.getSettings();
    const policy = settings.storage.overwritePolicy || 'days_and_quota';
    let deletedSegments = 0;
    let freedBytes = 0;

    if (policy === 'stop_when_full' && forcePurgeCount === 0) {
      return {
        deletedSegments: 0,
        freedBytes: 0,
        metrics: this.getDiskMetrics(),
      };
    }

    // 1. Retention Days policy (only when policy === 'days_and_quota' and retentionDays > 0, excluding is_locked = 1)
    if (policy === 'days_and_quota' && settings.storage.retentionDays > 0) {
      const cutoffMs = Date.now() - settings.storage.retentionDays * 24 * 60 * 60 * 1000;
      const expired = SegmentRepository.getUnlockedSegmentsOlderThan(cutoffMs);
      for (const seg of expired) {
        freedBytes += this.deleteSegmentFromDiskAndDb(seg.id, seg.file_path, seg.file_size_bytes);
        deletedSegments++;
      }
    }

    // 2. Circular Quota & Max Disk Full percentage policy (excluding is_locked = 1)
    let metrics = this.getDiskMetrics();
    const maxDiskPercent = settings.storage.maxDiskUsagePercent || 85;
    let safetyCounter = 0;

    while (
      (metrics.storageUsedBytes > metrics.storageQuotaBytes ||
        metrics.diskUsagePercent > maxDiskPercent ||
        deletedSegments < forcePurgeCount) &&
      safetyCounter < 500
    ) {
      safetyCounter++;
      const oldestBatch = SegmentRepository.getOldestUnlockedSegments(10);
      if (oldestBatch.length === 0) break;

      for (const seg of oldestBatch) {
        freedBytes += this.deleteSegmentFromDiskAndDb(seg.id, seg.file_path, seg.file_size_bytes);
        deletedSegments++;
        if (
          deletedSegments >= forcePurgeCount &&
          metrics.storageUsedBytes - freedBytes <= metrics.storageQuotaBytes &&
          metrics.diskUsagePercent <= maxDiskPercent
        ) {
          break;
        }
      }
      metrics = this.getDiskMetrics();
    }

    if (deletedSegments > 0) {
      const freedMb = (freedBytes / (1024 * 1024)).toFixed(1);
      console.log(
        `[StorageCleaner] Purged ${deletedSegments} unlocked segments (${freedMb} MB freed)`
      );
      wsHub.notify(
        'info',
        'Circular Storage Cleanup',
        `Purged ${deletedSegments} oldest unlocked segments (${freedMb} MB freed).`
      );
    }

    return {
      deletedSegments,
      freedBytes,
      metrics: this.getDiskMetrics(),
    };
  }

  private deleteSegmentFromDiskAndDb(id: string, filePath: string, sizeBytes: number): number {
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch (err) {
      console.warn(`[StorageCleaner] Could not unlink ${filePath}:`, (err as Error).message);
    }
    SegmentRepository.deleteById(id);
    return sizeBytes;
  }
}

export const storageCleaner = new StorageCleanerService();


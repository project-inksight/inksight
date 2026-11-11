import { execFile, spawn, ChildProcess } from 'child_process';
import { promisify } from 'util';
import net from 'net';
import os from 'os';
import { DiscoveredLanCamera } from '../../shared/types.js';
import { CameraRepository } from '../db/repositories.js';
import { binaryResolver } from './binaryResolver.js';
import { go2rtcManager } from './go2rtcManager.js';

const execFileAsync = promisify(execFile);

export interface StreamProbeResult {
  reachable: boolean;
  videoCodec: string;
  rawVideoCodec: string;
  width: number;
  height: number;
  resolution: string;
  fps: number;
  bitrateKbps: number;
  audioCodec: string;
  needsAudioTranscode: boolean;
  error?: string;
  probeDurationMs: number;
}

interface SubStreamPipeWorker {
  cameraId: string;
  streamUrl: string;
  proc: ChildProcess | null;
  latestFrame: Buffer | null;
  latestFrameTimeMs: number;
  latestFrameSeq: number;
  restartTimer: NodeJS.Timeout | null;
}

const SOI = Buffer.from([0xff, 0xd8]);
const EOI = Buffer.from([0xff, 0xd9]);

export class StreamProberService {
  private subPipes = new Map<string, SubStreamPipeWorker>();
  private nextFrameSeq = 0;

  /**
   * Maintains a single persistent low-overhead FFmpeg MJPEG pipe (3 FPS at 640w aspect-preserved)
   * on the camera's sub-stream so AI sampling reads frames straight from RAM in <1ms
   * instead of spawning a new ffmpeg.exe process on every go2rtc /api/frame.jpeg call.
   */
  private ensureSubStreamPipe(cameraId: string, fallbackStreamUrl: string): SubStreamPipeWorker {
    const inputUrl = go2rtcManager.getStatus().online
      ? `${go2rtcManager.getRtspBaseUrl()}/${cameraId}_sub`
      : fallbackStreamUrl;

    let worker = this.subPipes.get(cameraId);
    if (worker && worker.proc && worker.streamUrl === inputUrl) {
      return worker;
    }

    if (worker?.proc) {
      try {
        worker.proc.kill('SIGTERM');
      } catch {
        // ignore
      }
    }

    worker = {
      cameraId,
      streamUrl: inputUrl,
      proc: null,
      latestFrame: worker?.latestFrame ?? null,
      latestFrameTimeMs: worker?.latestFrameTimeMs ?? 0,
      latestFrameSeq: worker?.latestFrameSeq ?? 0,
      restartTimer: null,
    };
    this.subPipes.set(cameraId, worker);

    this.spawnSubPipeProcess(worker);
    return worker;
  }

  private spawnSubPipeProcess(worker: SubStreamPipeWorker): void {
    const ffmpegPath = binaryResolver.resolveFFmpeg();
    const args = [
      '-hide_banner',
      '-loglevel',
      'error',
      '-rtsp_transport',
      'tcp',
      '-i',
      worker.streamUrl,
      '-vf',
      'fps=5,scale=640:-2',
      '-q:v',
      '5',
      '-f',
      'image2pipe',
      '-vcodec',
      'mjpeg',
      'pipe:1',
    ];

    try {
      const proc = spawn(ffmpegPath, args, {
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      });
      worker.proc = proc;

      let acc = Buffer.alloc(0);

      proc.stdout?.on('data', (chunk: Buffer) => {
        acc = Buffer.concat([acc, chunk]);
        // Prevent unbounded buffer growth
        if (acc.length > 2 * 1024 * 1024) {
          acc = acc.subarray(acc.length - 512 * 1024);
        }

        let startIdx = acc.indexOf(SOI);
        while (startIdx !== -1) {
          const endIdx = acc.indexOf(EOI, startIdx + 2);
          if (endIdx === -1) break;

          const jpegFrame = Buffer.from(acc.subarray(startIdx, endIdx + 2));
          if (jpegFrame.length > 1000) {
            worker.latestFrame = jpegFrame;
            worker.latestFrameTimeMs = Date.now();
            worker.latestFrameSeq = ++this.nextFrameSeq;
          }
          acc = acc.subarray(endIdx + 2);
          startIdx = acc.indexOf(SOI);
        }
      });

      proc.on('exit', () => {
        worker.proc = null;
        if (this.subPipes.has(worker.cameraId)) {
          if (worker.restartTimer) clearTimeout(worker.restartTimer);
          worker.restartTimer = setTimeout(() => {
            if (this.subPipes.has(worker.cameraId)) {
              this.spawnSubPipeProcess(worker);
            }
          }, 5000);
        }
      });
    } catch {
      worker.proc = null;
    }
  }

  public stopSubStreamPipe(cameraId: string): void {
    const worker = this.subPipes.get(cameraId);
    if (!worker) return;
    this.subPipes.delete(cameraId);
    if (worker.restartTimer) clearTimeout(worker.restartTimer);
    if (worker.proc) {
      try {
        worker.proc.kill('SIGTERM');
      } catch {
        // ignore
      }
    }
  }

  public stopAllSubStreamPipes(): void {
    for (const cameraId of Array.from(this.subPipes.keys())) {
      this.stopSubStreamPipe(cameraId);
    }
  }

  /**
   * Uses ffprobe to inspect an RTSP or HTTP/File video stream and detect
   * exact resolution, video codec (H.264 / H.265 HEVC), FPS, bitrate, and audio codec.
   */
  public async probeStream(streamUrl: string, timeoutMs = 8000): Promise<StreamProbeResult> {
    const start = Date.now();
    const ffprobePath = binaryResolver.resolveFFprobe();

    const args: string[] = [
      '-v',
      'quiet',
      '-print_format',
      'json',
      '-show_streams',
      '-show_format',
    ];

    if (streamUrl.startsWith('rtsp://') || streamUrl.startsWith('rtsps://')) {
      args.push('-rtsp_transport', 'tcp', '-analyzeduration', '3000000', '-probesize', '3000000');
    }

    args.push(streamUrl);

    try {
      const { stdout } = await execFileAsync(ffprobePath, args, {
        timeout: timeoutMs,
        maxBuffer: 2 * 1024 * 1024,
      });

      const parsed = JSON.parse(stdout || '{}') as {
        streams?: Array<{
          codec_type?: string;
          codec_name?: string;
          width?: number;
          height?: number;
          r_frame_rate?: string;
          avg_frame_rate?: string;
          bit_rate?: string;
        }>;
        format?: {
          bit_rate?: string;
        };
      };

      const streams = parsed.streams || [];
      const videoStream = streams.find((s) => s.codec_type === 'video');
      const audioStream = streams.find((s) => s.codec_type === 'audio');

      if (!videoStream) {
        return {
          reachable: false,
          videoCodec: 'Unknown',
          rawVideoCodec: 'unknown',
          width: 0,
          height: 0,
          resolution: 'N/A',
          fps: 0,
          bitrateKbps: 0,
          audioCodec: 'none',
          needsAudioTranscode: false,
          error: 'No video stream found in source',
          probeDurationMs: Date.now() - start,
        };
      }

      const rawCodec = (videoStream.codec_name || 'h264').toLowerCase();
      const videoCodec =
        rawCodec === 'hevc' || rawCodec === 'h265'
          ? 'H.265 / HEVC'
          : rawCodec === 'h264'
            ? 'H.264 / AVC'
            : rawCodec.toUpperCase();

      const width = Number(videoStream.width || 3840);
      const height = Number(videoStream.height || 2160);

      let fps = 25;
      const rateStr =
        videoStream.avg_frame_rate && videoStream.avg_frame_rate !== '0/0'
          ? videoStream.avg_frame_rate
          : videoStream.r_frame_rate;
      if (rateStr && rateStr.includes('/')) {
        const [num, den] = rateStr.split('/').map(Number);
        if (den > 0 && num > 0) {
          fps = Math.round((num / den) * 10) / 10;
        }
      }

      const rawBitrate = Number(videoStream.bit_rate || parsed.format?.bit_rate || 0);
      const bitrateKbps =
        rawBitrate > 0
          ? Math.round(rawBitrate / 1000)
          : width >= 3840
            ? 8192
            : width >= 1920
              ? 4096
              : 1024;

      const rawAudio = (audioStream?.codec_name || 'none').toLowerCase();
      const needsAudioTranscode =
        rawAudio.includes('pcm') ||
        rawAudio.includes('mulaw') ||
        rawAudio.includes('alaw') ||
        rawAudio.includes('g711');

      return {
        reachable: true,
        videoCodec,
        rawVideoCodec: rawCodec,
        width,
        height,
        resolution: `${width}x${height}`,
        fps,
        bitrateKbps,
        audioCodec: rawAudio.toUpperCase(),
        needsAudioTranscode,
        probeDurationMs: Date.now() - start,
      };
    } catch (err) {
      const sanitizedErr = (err as Error).message
        .split('\n')[0]
        .replace(/(rtsps?:\/\/[^:/@\s]+:)([^@\s]+)(@)/gi, '$1***$3');
      return {
        reachable: false,
        videoCodec: 'Offline',
        rawVideoCodec: 'offline',
        width: 0,
        height: 0,
        resolution: 'Offline',
        fps: 0,
        bitrateKbps: 0,
        audioCodec: 'NONE',
        needsAudioTranscode: false,
        error: sanitizedErr,
        probeDurationMs: Date.now() - start,
      };
    }
  }

  /**
   * Captures a live sub-stream JPEG frame along with a strictly monotonic frame sequence number
   * so the AI Vision Engine never re-evaluates duplicate frames across ticks.
   */
  public async captureSubStreamFrameWithSeq(
    cameraId: string,
    streamUrl: string
  ): Promise<{ buffer: Buffer; seq: number }> {
    const pipeWorker = this.ensureSubStreamPipe(cameraId, streamUrl);
    if (pipeWorker.latestFrame && Date.now() - pipeWorker.latestFrameTimeMs < 8000) {
      return { buffer: pipeWorker.latestFrame, seq: pipeWorker.latestFrameSeq };
    }
    // Wait briefly if pipe just started
    for (let i = 0; i < 6; i++) {
      await new Promise((r) => setTimeout(r, 250));
      if (pipeWorker.latestFrame && Date.now() - pipeWorker.latestFrameTimeMs < 8000) {
        return { buffer: pipeWorker.latestFrame, seq: pipeWorker.latestFrameSeq };
      }
    }

    const fallbackBuf = await this.captureDirectFrameBuffer(cameraId, streamUrl, 'sub');
    return { buffer: fallbackBuf, seq: ++this.nextFrameSeq };
  }

  /**
   * Captures a live JPEG frame from the camera stream.
   * - For 'sub' tier: Returns the latest frame from the persistent sub-stream MJPEG pipe in RAM
   *   (zero process spawning per tick).
   * - For 'main' tier (4K snapshot on AI alert or manual snapshot): Uses go2rtc or direct FFmpeg.
   */
  public async captureFrameBuffer(
    cameraId: string,
    _cameraName: string,
    streamUrl: string,
    tier: 'main' | 'sub' = 'sub'
  ): Promise<Buffer> {
    if (tier === 'sub') {
      const { buffer } = await this.captureSubStreamFrameWithSeq(cameraId, streamUrl);
      return buffer;
    }

    return this.captureDirectFrameBuffer(cameraId, streamUrl, tier);
  }

  private async captureDirectFrameBuffer(
    cameraId: string,
    streamUrl: string,
    tier: 'main' | 'sub'
  ): Promise<Buffer> {
    // 1. Try go2rtc frame endpoint (used for 4K main snapshot or initial fallback)
    if (go2rtcManager.getStatus().online) {
      try {
        const go2rtcFrameUrl = `${go2rtcManager.getApiUrl()}/api/frame.jpeg?src=${encodeURIComponent(
          `${cameraId}_${tier}`
        )}`;
        const res = await fetch(go2rtcFrameUrl, { signal: AbortSignal.timeout(8000) });
        if (res.ok) {
          const buf = Buffer.from(await res.arrayBuffer());
          if (buf.length > 1000) {
            return buf;
          }
        }
      } catch {
        // Fallback to direct ffmpeg grab
      }
    }

    // 2. Try direct FFmpeg RTSP frame grab
    const ffmpegPath = binaryResolver.resolveFFmpeg();
    if (streamUrl) {
      const args = ['-hide_banner', '-loglevel', 'error'];
      if (streamUrl.startsWith('rtsp://') || streamUrl.startsWith('rtsps://')) {
        args.push('-rtsp_transport', 'tcp');
      }
      args.push('-i', streamUrl, '-frames:v', '1', '-q:v', '2', '-f', 'image2', 'pipe:1');
      const { stdout } = await execFileAsync(ffmpegPath, args, {
        encoding: 'buffer',
        timeout: 10000,
        maxBuffer: 20 * 1024 * 1024,
      });
      if (stdout && stdout.length > 1000) {
        return stdout;
      }
    }

    throw new Error(`Unable to capture live frame from camera ${cameraId} (${tier})`);
  }

  /**
   * Scans the local IPv4 /24 subnet(s) on Port 554 (RTSP) and Port 80 (HTTP/ONVIF)
   * in parallel (<1.5s) to automatically discover all IP cameras on the user's LAN.
   */
  public async discoverLanCameras(): Promise<DiscoveredLanCamera[]> {
    const existingCameras = CameraRepository.getAll();
    const existingByIp = new Map(existingCameras.map((c) => [c.ip_address.trim(), c]));

    const subnets = new Set<string>();
    const selfIps = new Set<string>(['127.0.0.1']);
    const interfaces = os.networkInterfaces();

    for (const list of Object.values(interfaces)) {
      if (!list) continue;
      for (const iface of list) {
        if (iface.family === 'IPv4' && !iface.internal) {
          selfIps.add(iface.address);
          const parts = iface.address.split('.');
          if (parts.length === 4 && (parts[0] === '192' || parts[0] === '10' || parts[0] === '172')) {
            subnets.add(`${parts[0]}.${parts[1]}.${parts[2]}`);
          }
        }
      }
    }

    // Ensure any subnet from existing cameras is also included
    for (const c of existingCameras) {
      const parts = c.ip_address.trim().split('.');
      if (parts.length === 4) {
        subnets.add(`${parts[0]}.${parts[1]}.${parts[2]}`);
      }
    }

    if (subnets.size === 0) {
      subnets.add('192.168.1');
    }

    const probeRtspHost = (ip: string): Promise<DiscoveredLanCamera | null> =>
      new Promise((resolve) => {
        const socket = new net.Socket();
        let banner = '';
        let resolved = false;

        const finish = (hit: boolean) => {
          if (resolved) return;
          resolved = true;
          socket.destroy();
          if (!hit) {
            resolve(null);
            return;
          }

          const lower = banner.toLowerCase();
          let suggestedBrand: DiscoveredLanCamera['suggestedBrand'] = 'dahua';
          if (lower.includes('hikvision') || lower.includes('app-webs')) {
            suggestedBrand = 'hikvision';
          } else if (lower.includes('reolink')) {
            suggestedBrand = 'reolink';
          } else if (lower.includes('dahua') || lower.includes('rtspserver')) {
            suggestedBrand = 'dahua';
          } else {
            suggestedBrand = 'dahua';
          }

          const cleanBanner =
            banner
              .split(/\r?\n/)
              .find((l) => l.toLowerCase().startsWith('server:') || l.toLowerCase().startsWith('www-authenticate:'))
              ?.trim() || 'RTSP 1.0 Camera (Port 554)';

          const existing = existingByIp.get(ip);
          resolve({
            ipAddress: ip,
            rtspPort: 554,
            httpPortOpen: true,
            serverBanner: cleanBanner.slice(0, 70),
            suggestedBrand,
            alreadyConfigured: Boolean(existing),
            existingCameraName: existing?.name,
          });
        };

        socket.setTimeout(420);
        socket.once('connect', () => {
          socket.write(`OPTIONS rtsp://${ip}:554/ RTSP/1.0\r\nCSeq: 1\r\n\r\n`);
          setTimeout(() => finish(true), 160);
        });
        socket.on('data', (chunk) => {
          banner += chunk.toString('utf8');
          finish(true);
        });
        socket.once('timeout', () => finish(false));
        socket.once('error', () => finish(false));
        socket.connect(554, ip);
      });

    const candidateIps: string[] = [];
    for (const subnet of subnets) {
      for (let host = 1; host <= 254; host++) {
        const ip = `${subnet}.${host}`;
        if (!selfIps.has(ip)) {
          candidateIps.push(ip);
        }
      }
    }

    const results = await Promise.all(candidateIps.map((ip) => probeRtspHost(ip)));
    return results
      .filter((r): r is DiscoveredLanCamera => r !== null)
      .sort((a, b) => a.ipAddress.localeCompare(b.ipAddress, undefined, { numeric: true }));
  }
}

export const streamProber = new StreamProberService();

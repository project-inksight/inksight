import fs from 'fs';
import path from 'path';
import { execFile, spawnSync } from 'child_process';
import { promisify } from 'util';
import ffmpegStatic from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';

const execFileAsync = promisify(execFile);

const BIN_DIR = path.resolve(process.cwd(), 'bin');
if (!fs.existsSync(BIN_DIR)) {
  try {
    fs.mkdirSync(BIN_DIR, { recursive: true });
  } catch {
    // ignore read-only Program Files when bin already managed by installer
  }
}

export interface BinaryPaths {
  ffmpegPath: string;
  ffprobePath: string;
  go2rtcPath: string;
  ffmpegAvailable: boolean;
  ffprobeAvailable: boolean;
  go2rtcAvailable: boolean;
  nvencSupported: boolean;
}

class BinaryResolverService {
  private cachedPaths: BinaryPaths | null = null;

  public getBinDir(): string {
    return BIN_DIR;
  }

  public resolveFFmpeg(): string {
    const isWin = process.platform === 'win32';
    const localBin = path.join(BIN_DIR, isWin ? 'ffmpeg.exe' : 'ffmpeg');
    if (fs.existsSync(localBin)) return localBin;

    // Check system PATH
    const checkCmd = isWin ? 'where.exe' : 'which';
    const res = spawnSync(checkCmd, ['ffmpeg'], { encoding: 'utf8' });
    if (res.status === 0 && res.stdout.trim()) {
      const firstLine = res.stdout.trim().split(/\r?\n/)[0].trim();
      if (fs.existsSync(firstLine)) return firstLine;
    }

    // Fallback to ffmpeg-static npm package
    const staticPath = typeof ffmpegStatic === 'string' ? ffmpegStatic : (ffmpegStatic as unknown as { default?: string })?.default;
    if (staticPath && fs.existsSync(staticPath)) {
      return staticPath;
    }

    return 'ffmpeg';
  }

  public resolveFFprobe(): string {
    const isWin = process.platform === 'win32';
    const localBin = path.join(BIN_DIR, isWin ? 'ffprobe.exe' : 'ffprobe');
    if (fs.existsSync(localBin)) return localBin;

    const checkCmd = isWin ? 'where.exe' : 'which';
    const res = spawnSync(checkCmd, ['ffprobe'], { encoding: 'utf8' });
    if (res.status === 0 && res.stdout.trim()) {
      const firstLine = res.stdout.trim().split(/\r?\n/)[0].trim();
      if (fs.existsSync(firstLine)) return firstLine;
    }

    const staticProbe =
      (ffprobeStatic as { path?: string })?.path ||
      (ffprobeStatic as unknown as { default?: { path?: string } })?.default?.path;
    if (staticProbe && fs.existsSync(staticProbe)) {
      return staticProbe;
    }

    return 'ffprobe';
  }

  public resolveGo2rtcPath(): string {
    const isWin = process.platform === 'win32';
    const localBin = path.join(BIN_DIR, isWin ? 'go2rtc.exe' : 'go2rtc');
    if (fs.existsSync(localBin)) return localBin;

    const checkCmd = isWin ? 'where.exe' : 'which';
    const res = spawnSync(checkCmd, ['go2rtc'], { encoding: 'utf8' });
    if (res.status === 0 && res.stdout.trim()) {
      const firstLine = res.stdout.trim().split(/\r?\n/)[0].trim();
      if (fs.existsSync(firstLine)) return firstLine;
    }

    return localBin;
  }

  public async ensureGo2rtcBinary(): Promise<string> {
    const targetPath = this.resolveGo2rtcPath();
    if (fs.existsSync(targetPath)) {
      return targetPath;
    }

    console.log('[BinaryResolver] go2rtc binary not found locally. Attempting automatic download...');
    const isWin = process.platform === 'win32';
    try {
      if (isWin) {
        const zipUrl = 'https://github.com/AlexxIT/go2rtc/releases/latest/download/go2rtc_win64.zip';
        const zipDest = path.join(BIN_DIR, 'go2rtc_win64.zip');
        const res = await fetch(zipUrl, { signal: AbortSignal.timeout(25000) });
        if (!res.ok) {
          throw new Error(`HTTP ${res.status} downloading ${zipUrl}`);
        }
        const arrayBuf = await res.arrayBuffer();
        fs.writeFileSync(zipDest, Buffer.from(arrayBuf));

        await execFileAsync('powershell.exe', [
          '-NoProfile',
          '-Command',
          `Expand-Archive -Path '${zipDest}' -DestinationPath '${BIN_DIR}' -Force`,
        ]);
        try {
          fs.unlinkSync(zipDest);
        } catch {
          // ignore cleanup error
        }
      } else {
        const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
        const platform = process.platform === 'darwin' ? 'mac' : 'linux';
        const binUrl = `https://github.com/AlexxIT/go2rtc/releases/latest/download/go2rtc_${platform}_${arch}`;
        const res = await fetch(binUrl, { signal: AbortSignal.timeout(25000) });
        if (!res.ok) {
          throw new Error(`HTTP ${res.status} downloading ${binUrl}`);
        }
        const arrayBuf = await res.arrayBuffer();
        fs.writeFileSync(targetPath, Buffer.from(arrayBuf), { mode: 0o755 });
      }

      if (fs.existsSync(targetPath)) {
        console.log(`[BinaryResolver] Successfully downloaded go2rtc binary to ${targetPath}`);
      }
    } catch (err) {
      console.warn(
        '[BinaryResolver] Could not auto-download go2rtc from GitHub (offline or restricted network):',
        (err as Error).message
      );
    }

    return targetPath;
  }

  public async verifyAll(): Promise<BinaryPaths> {
    const ffmpegPath = this.resolveFFmpeg();
    const ffprobePath = this.resolveFFprobe();
    const go2rtcPath = await this.ensureGo2rtcBinary();

    let ffmpegAvailable = false;
    let nvencSupported = false;

    try {
      const { stdout } = await execFileAsync(ffmpegPath, ['-hide_banner', '-encoders'], {
        timeout: 8000,
        maxBuffer: 4 * 1024 * 1024,
      });
      ffmpegAvailable = true;
      nvencSupported = stdout.includes('h264_nvenc');
    } catch {
      ffmpegAvailable = fs.existsSync(ffmpegPath);
    }

    let ffprobeAvailable = false;
    try {
      await execFileAsync(ffprobePath, ['-version'], { timeout: 5000 });
      ffprobeAvailable = true;
    } catch {
      ffprobeAvailable = fs.existsSync(ffprobePath);
    }

    const go2rtcAvailable = fs.existsSync(go2rtcPath);

    this.cachedPaths = {
      ffmpegPath,
      ffprobePath,
      go2rtcPath,
      ffmpegAvailable,
      ffprobeAvailable,
      go2rtcAvailable,
      nvencSupported,
    };

    return this.cachedPaths;
  }

  public getCached(): BinaryPaths {
    if (!this.cachedPaths) {
      const ffmpegPath = this.resolveFFmpeg();
      const ffprobePath = this.resolveFFprobe();
      const go2rtcPath = this.resolveGo2rtcPath();
      return {
        ffmpegPath,
        ffprobePath,
        go2rtcPath,
        ffmpegAvailable: fs.existsSync(ffmpegPath),
        ffprobeAvailable: fs.existsSync(ffprobePath),
        go2rtcAvailable: fs.existsSync(go2rtcPath),
        nvencSupported: false,
      };
    }
    return this.cachedPaths;
  }
}

export const binaryResolver = new BinaryResolverService();


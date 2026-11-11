import express from 'express';
import cors from 'cors';
import http from 'http';
import path from 'path';
import fs from 'fs';
import { initializeDatabase } from './db/schema.js';
import { binaryResolver } from './services/binaryResolver.js';
import { wsHub } from './services/wsHub.js';
import { go2rtcManager } from './services/go2rtcManager.js';
import { streamProber } from './services/streamProber.js';
import { recorderManager } from './services/recorderManager.js';
import { aiVisionEngine } from './services/aiVisionEngine.js';
import { storageCleaner } from './services/storageCleaner.js';
import { watchdogService } from './services/watchdogService.js';
import { apiRouter } from './routes/api.js';

const PORT = Number(process.env.PORT || 3001);

async function bootstrapServer(): Promise<void> {
  console.log('==================================================================');
  console.log('  INKSIGHT (PROJECT INKSIGHT) - LOCAL-FIRST ZERO-CLOUD 4K AI NVR');
  console.log('==================================================================');

  // 1. Initialize SQLite database with WAL mode
  initializeDatabase();
  console.log('[Server] SQLite Database initialized (WAL Mode active)');

  // 2. Verify FFmpeg, FFprobe & go2rtc binaries
  const binStatus = await binaryResolver.verifyAll();
  console.log(
    `[Server] Binaries verified: FFmpeg=${binStatus.ffmpegAvailable} (NVENC=${binStatus.nvencSupported}), go2rtc=${binStatus.go2rtcAvailable}`
  );

  // 3. Start go2rtc stream ingestion engine
  await go2rtcManager.start();

  // 4. Initialize Direct-to-Disk Recorder & File Indexer
  await recorderManager.initialize();

  // 5. Initialize AI Vision Pipeline (CodeProject.AI / Polygon Zone Filter)
  await aiVisionEngine.initialize();

  // 6. Start Circular Storage Manager & Process Watchdog
  storageCleaner.start();
  watchdogService.start();

  // 7. Create Express + HTTP + WebSocket Server
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '15mb' }));

  app.use('/api', apiRouter);

  // Serve built frontend in production
  const clientDist = path.resolve(process.cwd(), 'dist', 'client');
  if (fs.existsSync(clientDist)) {
    app.use(express.static(clientDist));
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api') || req.path.startsWith('/ws')) {
        next();
        return;
      }
      res.sendFile(path.join(clientDist, 'index.html'));
    });
  }

  const server = http.createServer(app);

  wsHub.attach(server, (ws) => {
    wsHub.sendToClient(ws, {
      type: 'INIT_STATE',
      telemetry: watchdogService.getTelemetryMap(),
      health: watchdogService.getSystemHealth(),
    });
  });

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[Server] Inksight API & WebSocket listening on http://localhost:${PORT}`);
  });

  const gracefulShutdown = () => {
    console.log('\n[Server] Shutting down Inksight services...');
    watchdogService.stop();
    storageCleaner.stop();
    aiVisionEngine.stop();
    streamProber.stopAllSubStreamPipes();
    recorderManager.stopAll();
    go2rtcManager.stop();
    process.exit(0);
  };

  process.on('SIGINT', gracefulShutdown);
  process.on('SIGTERM', gracefulShutdown);
}

void bootstrapServer();


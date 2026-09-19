import path from 'node:path';
import { pruneActivity } from './activity.js';
import { buildApp } from './app.js';
import { ensureAdminUser, pruneSessions } from './auth.js';
import { config } from './config.js';
import { closeDb, getDb } from './db.js';
import { startIndexer, stopIndexer } from './indexer.js';
import { createLogger, flushLogs } from './logging.js';
import { initUploads, stopUploads } from './uploads.js';
import { videoToolStatus } from './video.js';
import { destroyImagePool } from './workers/pool.js';

async function main(): Promise<void> {
  const cfg = config();
  const app = await buildApp(cfg, await createLogger(cfg));

  // Said before anything worth reading is logged — including the first-run
  // access code — so whoever is watching a console knows where the rest went.
  if (cfg.logToFile) {
    const kept = cfg.logCleanup ? `kept for ${cfg.logRetentionDays} days` : 'kept indefinitely';
    app.log.info(`logging to ${path.join(cfg.logDir, 'gallery-<date>.log')}, ${kept}`);
  }

  getDb();
  pruneSessions();
  pruneActivity();
  // Clears `.part` files an upload interrupted by a previous shutdown left in
  // the library, before the scanner or the browser can trip over them.
  await initUploads((msg) => app.log.info(`[uploads] ${msg}`));
  // Runs before the port opens, so the server is never reachable without an
  // admin account existing to gate it.
  await ensureAdminUser((msg) => app.log.info(msg));

  await app.listen({ port: cfg.port, host: cfg.host });
  app.log.info(`serving photos from ${cfg.photosRoot}`);
  // Says out loud which build is running. A libvips crash is invisible from the
  // outside — it kills the process with a bare Windows exit code and no stack —
  // so seeing this line is how you know decoding happens somewhere survivable.
  app.log.info('image decoding runs in isolated worker processes');

  // Videos are indexed and played whether or not ffmpeg is here; what it buys
  // is their poster tiles and their real dates and dimensions. Worth saying
  // out loud, because a library of grey video tiles has exactly one cause.
  const tools = await videoToolStatus();
  if (tools.ffmpeg && tools.ffprobe) {
    app.log.info(`video support: ffmpeg at ${tools.ffmpeg}`);
  } else {
    const missing = [tools.ffmpeg ? null : 'ffmpeg', tools.ffprobe ? null : 'ffprobe']
      .filter(Boolean)
      .join(' and ');
    app.log.warn(
      `video support is limited: ${missing} not found. Videos still appear and play, but ` +
        `without thumbnails or capture dates. Install ffmpeg, or set ffmpegPath/ffprobePath.`,
    );
  }

  await startIndexer();

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info(`${signal} received, shutting down`);
    try {
      await stopIndexer();
      // In-flight uploads cannot survive the restart — their sessions are held
      // in memory — so their partial files go now rather than being swept on
      // the next boot.
      await stopUploads();
      await destroyImagePool();
      await app.close();
      closeDb();
    } finally {
      // The daily file buffers its writes, and process.exit does not wait.
      flushLogs();
      process.exit(0);
    }
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err: Error) => {
  console.error(`\n${err.message}\n`);
  process.exit(1);
});

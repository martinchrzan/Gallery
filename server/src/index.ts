import fs from 'node:fs';
import path from 'node:path';
import compress from '@fastify/compress';
import formbody from '@fastify/formbody';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import { config, repoRoot } from './config.js';
import { getDb } from './db.js';
import { startIndexer, stopIndexer } from './indexer.js';
import { PathError } from './paths.js';
import { destroyMetadataPool } from './workers/pool.js';
import { filesRoutes } from './routes/files.js';
import { galleryRoutes } from './routes/gallery.js';
import { mediaRoutes } from './routes/media.js';
import { settingsRoutes } from './routes/settings.js';

async function main(): Promise<void> {
  const cfg = config();

  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
      transport:
        process.env.NODE_ENV === 'production'
          ? undefined
          : { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } },
    },
    bodyLimit: 2 * 1024 * 1024,
    // Photo libraries on spinning disks or network shares can be slow to stat.
    connectionTimeout: 0,
  });

  // The ZIP endpoint accepts a form POST so the browser streams it to disk.
  await app.register(formbody);

  await app.register(compress, {
    global: true,
    threshold: 1024,
    // Thumbnails and originals are already compressed; re-compressing them
    // wastes CPU on the hot path. The binary manifest, however, gzips ~4x.
    encodings: ['gzip', 'deflate'],
    customTypes: /^application\/(json|octet-stream)$|^text\//,
  });

  app.setErrorHandler((error: Error & { statusCode?: number }, req, reply) => {
    if (error instanceof PathError) {
      return reply.code(403).send({ error: error.message });
    }
    req.log.error({ err: error }, 'request failed');
    const status = error.statusCode && error.statusCode >= 400 ? error.statusCode : 500;
    // Internal failures must not leak a filesystem path in their message.
    return reply.code(status).send({ error: status === 500 ? 'Internal error' : error.message });
  });

  await app.register(galleryRoutes);
  await app.register(mediaRoutes);
  await app.register(filesRoutes);
  await app.register(settingsRoutes);

  app.get('/api/health', async () => ({ ok: true, photosRoot: cfg.photosRoot }));

  // In production the built SPA is served from this same process, so the whole
  // gallery is one `npm start`.
  const webDist = path.join(repoRoot, 'web', 'dist');
  if (fs.existsSync(path.join(webDist, 'index.html'))) {
    await app.register(fastifyStatic, {
      root: webDist,
      index: ['index.html'],
      maxAge: '1h',
      // Vite emits content-hashed asset names, so those can be cached hard.
      setHeaders: (res, filePath) => {
        if (filePath.includes(`${path.sep}assets${path.sep}`)) {
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        }
      },
    });

    // Client-side routes (/files/..., /settings) must fall back to the shell.
    app.setNotFoundHandler((req, reply) => {
      if (req.raw.url?.startsWith('/api/')) {
        return reply.code(404).send({ error: 'Not found' });
      }
      return reply.sendFile('index.html');
    });
  } else {
    app.log.warn('web/dist not found — run `npm run build` to serve the UI from this server');
  }

  getDb();
  await app.listen({ port: cfg.port, host: cfg.host });
  app.log.info(`serving photos from ${cfg.photosRoot}`);

  await startIndexer();

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info(`${signal} received, shutting down`);
    try {
      await stopIndexer();
      await destroyMetadataPool();
      await app.close();
    } finally {
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

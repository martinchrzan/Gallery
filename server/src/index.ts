import fs from 'node:fs';
import path from 'node:path';
import compress from '@fastify/compress';
import cookie from '@fastify/cookie';
import formbody from '@fastify/formbody';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import { ensureAdminUser, pruneSessions } from './auth.js';
import { config, repoRoot } from './config.js';
import { getDb } from './db.js';
import { authGuard } from './guard.js';
import { startIndexer, stopIndexer } from './indexer.js';
import { PathError } from './paths.js';
import { destroyMetadataPool } from './workers/pool.js';
import { authRoutes } from './routes/auth.js';
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
    // Behind a tunnel or reverse proxy, the real client IP and scheme only
    // arrive in X-Forwarded-*; the rate limiter and cookie flags depend on them.
    trustProxy: cfg.trustProxy,
  });

  // Registered first so the headers are on every response, including the ones
  // the error handler and the 404 fallback produce.
  //
  // The policy is as tight as a same-origin SPA allows: nothing loads from
  // anywhere but this server. The built bundle carries no inline script or
  // style — React applies its `style` props through the CSSOM, which CSP does
  // not police — so neither directive needs `unsafe-inline`, and helmet's
  // defaults are narrowed accordingly.
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        'default-src': ["'self'"],
        'base-uri': ["'self'"],
        // Same-origin XHR plus the SSE stream behind /api/index/events.
        'connect-src': ["'self'"],
        // Mulish is bundled into /assets, never fetched from a CDN, so the
        // default's `https:` and `data:` are not needed.
        'font-src': ["'self'"],
        // The ZIP download submits a generated form to /api/files/zip.
        'form-action': ["'self'"],
        // Nothing here is meant to be framed; this is the clickjacking guard.
        'frame-ancestors': ["'none'"],
        // `data:` is the inline SVG favicon in index.html.
        'img-src': ["'self'", 'data:'],
        'object-src': ["'none'"],
        'script-src': ["'self'"],
        'style-src': ["'self'"],
        // Dropped on purpose: it rewrites same-origin asset URLs to https and
        // would break plain-HTTP access over the LAN. The tunnel serves TLS
        // for the public hostname, and HSTS below covers that side.
        'upgrade-insecure-requests': null,
      },
    },
    // Scoped to this host alone — a sibling subdomain served over plain HTTP
    // must not be dragged into HTTPS-only by this app's header.
    hsts: { maxAge: 31536000, includeSubDomains: false },
    // The legacy twin of `frame-ancestors 'none'`. Helmet defaults it to
    // SAMEORIGIN, which would contradict the CSP on browsers old enough to
    // only understand this header.
    xFrameOptions: { action: 'deny' },
    // Photos and thumbnails are private; no other origin should embed them.
    crossOriginResourcePolicy: { policy: 'same-origin' },
  });

  // The ZIP endpoint accepts a form POST so the browser streams it to disk.
  await app.register(formbody);
  await app.register(cookie);

  // Off by default so ordinary browsing is never throttled; the login route
  // opts in, since that is the one endpoint worth guessing at.
  await app.register(rateLimit, { global: false });

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

  // Registered on the root instance so it covers every /api/ route, including
  // any added later — protection is opt-out, not opt-in.
  app.decorateRequest('authUser', null);
  app.addHook('onRequest', authGuard);

  await app.register(authRoutes);
  await app.register(galleryRoutes);
  await app.register(mediaRoutes);
  await app.register(filesRoutes);
  await app.register(settingsRoutes);

  // Deliberately says nothing about the library: this is the one endpoint a
  // monitoring check may want without a session, so it must not leak a path.
  app.get('/api/health', async () => ({ ok: true }));

  // In production the built SPA is served from this same process, so the whole
  // gallery is one `npm start`.
  const webDist = path.join(repoRoot, 'web', 'dist');
  if (fs.existsSync(path.join(webDist, 'index.html'))) {
    await app.register(fastifyStatic, {
      root: webDist,
      index: ['index.html'],
      maxAge: '1h',
      // Vite emits content-hashed asset names, so those can be cached hard.
      setHeaders: (reply, filePath) => {
        if (filePath.includes(`${path.sep}assets${path.sep}`)) {
          reply.header('Cache-Control', 'public, max-age=31536000, immutable');
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
  pruneSessions();
  // Runs before the port opens, so the server is never reachable without an
  // admin account existing to gate it.
  await ensureAdminUser((msg) => app.log.info(msg));

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

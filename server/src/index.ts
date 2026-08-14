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
import { initUploads, stopUploads } from './uploads.js';
import { videoToolStatus } from './video.js';
import { destroyImagePool } from './workers/pool.js';
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
        // Videos stream from /api/media/:id/original, same origin as everything
        // else. Spelled out rather than left to default-src, so narrowing that
        // later cannot silently break playback.
        'media-src': ["'self'"],
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
    const status = error.statusCode && error.statusCode >= 400 ? error.statusCode : 500;
    // A 4xx is the client being told something about its own request — a chunk
    // resent at a stale offset, a file type we do not take — and on a flaky
    // mobile upload it is routine. Only a 5xx is this server's problem, and only
    // that deserves a stack trace in the log.
    // `reason` rather than `err`: pino reserves that key for a real Error, which
    // it renders with its stack — the very thing being left out here.
    if (status >= 500) req.log.error({ err: error }, 'request failed');
    else req.log.info({ reason: error.message, status }, 'request refused');

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

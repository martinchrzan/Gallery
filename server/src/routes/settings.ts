import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getDb, getSettings, KIND_VIDEO, saveSettings } from '../db.js';
import { currentUser, requireAdmin } from '../guard.js';
import { applyIndexMode, getIndexStatus, indexEvents, scan } from '../indexer.js';
import { toRelPosix } from '../paths.js';
import { galleryScope } from '../scope.js';
import { clearThumbCache, thumbCacheStats } from '../thumbs.js';
import { DEFAULT_SETTINGS, type IndexStatus, type Settings, type StatsResult, type User } from '../types.js';

const SettingsPatch = z
  .object({
    galleryFolders: z.array(z.string()).max(500).optional(),
    indexMode: z.enum(['watch', 'interval', 'manual']).optional(),
    indexIntervalHours: z.number().min(0.25).max(24 * 7).optional(),
    rowHeight: z.number().int().min(120).max(600).optional(),
    showMetadata: z.boolean().optional(),
    prewarmThumbs: z.boolean().optional(),
  })
  .strict();

/**
 * What a given user is allowed to know about the configuration.
 *
 * A viewer's client needs the display preferences and needs `galleryFolders` to
 * render the "nothing selected" empty state — but the real value would list
 * folder names from across the library, so they get their own assignment
 * instead. Indexing settings are operational and are flattened to defaults
 * rather than reported.
 */
function visibleSettings(user: User): Settings {
  const settings = getSettings();
  if (user.role === 'admin') return settings;

  return {
    ...DEFAULT_SETTINGS,
    galleryFolders: galleryScope(user),
    rowHeight: settings.rowHeight,
    showMetadata: settings.showMetadata,
  };
}

export async function settingsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/settings', async (req, reply) =>
    reply.header('Cache-Control', 'no-store').send(visibleSettings(currentUser(req))),
  );

  app.put('/api/settings', { preHandler: requireAdmin }, async (req, reply) => {
    const parsed = SettingsPatch.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid settings', issues: parsed.error.issues });
    }

    const patch = { ...parsed.data };
    if (patch.galleryFolders) {
      patch.galleryFolders = [...new Set(patch.galleryFolders.map(toRelPosix))];
    }

    const before = getSettings();
    const after = saveSettings(patch);

    // Switching mode has to reconfigure the watcher / timer immediately.
    if (
      after.indexMode !== before.indexMode ||
      after.indexIntervalHours !== before.indexIntervalHours
    ) {
      await applyIndexMode();
    }

    return reply.send(after);
  });

  app.get('/api/index/status', { preHandler: requireAdmin }, async (_req, reply) =>
    reply.header('Cache-Control', 'no-store').send(getIndexStatus()),
  );

  app.post('/api/index/rescan', { preHandler: requireAdmin }, async (_req, reply) => {
    void scan();
    return reply.send({ started: true });
  });

  /** Server-sent events carrying scan progress to the UI's progress pill. */
  app.get('/api/index/events', { preHandler: requireAdmin }, (req, reply) => {
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const send = (status: IndexStatus): void => {
      reply.raw.write(`data: ${JSON.stringify(status)}\n\n`);
    };

    send(getIndexStatus());
    indexEvents.on('status', send);

    // Proxies drop idle connections; a comment frame keeps this one alive.
    const heartbeat = setInterval(() => reply.raw.write(': ping\n\n'), 25_000);
    heartbeat.unref();

    req.raw.on('close', () => {
      clearInterval(heartbeat);
      indexEvents.off('status', send);
    });
  });

  app.get('/api/stats', { preHandler: requireAdmin }, async (_req, reply) => {
    const row = getDb()
      .prepare(
        `SELECT count(*) AS photos, coalesce(sum(size), 0) AS bytes,
                coalesce(sum(kind = ${KIND_VIDEO}), 0) AS videos,
                min(taken_at) AS oldest, max(taken_at) AS newest
         FROM photos`,
      )
      .get() as {
      photos: number;
      videos: number;
      bytes: number;
      oldest: number | null;
      newest: number | null;
    };

    const cache = await thumbCacheStats();
    const stats: StatsResult = {
      photos: row.photos,
      videos: row.videos,
      totalBytes: row.bytes,
      thumbBytes: cache.bytes,
      thumbFiles: cache.files,
      oldest: row.oldest,
      newest: row.newest,
    };
    return reply.header('Cache-Control', 'no-store').send(stats);
  });

  app.post('/api/cache/clear', { preHandler: requireAdmin }, async (_req, reply) => {
    await clearThumbCache();
    return reply.send({ cleared: true });
  });
}

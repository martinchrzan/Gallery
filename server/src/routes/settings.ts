import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getDb, getSettings, saveSettings } from '../db.js';
import { applyIndexMode, getIndexStatus, indexEvents, scan } from '../indexer.js';
import { toRelPosix } from '../paths.js';
import { clearThumbCache, thumbCacheStats } from '../thumbs.js';
import type { IndexStatus, StatsResult } from '../types.js';

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

export async function settingsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/settings', async (_req, reply) =>
    reply.header('Cache-Control', 'no-store').send(getSettings()),
  );

  app.put('/api/settings', async (req, reply) => {
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

  app.get('/api/index/status', async (_req, reply) =>
    reply.header('Cache-Control', 'no-store').send(getIndexStatus()),
  );

  app.post('/api/index/rescan', async (_req, reply) => {
    void scan();
    return reply.send({ started: true });
  });

  /** Server-sent events carrying scan progress to the UI's progress pill. */
  app.get('/api/index/events', (req, reply) => {
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

  app.get('/api/stats', async (_req, reply) => {
    const row = getDb()
      .prepare(
        `SELECT count(*) AS photos, coalesce(sum(size), 0) AS bytes,
                min(taken_at) AS oldest, max(taken_at) AS newest
         FROM photos`,
      )
      .get() as { photos: number; bytes: number; oldest: number | null; newest: number | null };

    const cache = await thumbCacheStats();
    const stats: StatsResult = {
      photos: row.photos,
      totalBytes: row.bytes,
      thumbBytes: cache.bytes,
      thumbFiles: cache.files,
      oldest: row.oldest,
      newest: row.newest,
    };
    return reply.header('Cache-Control', 'no-store').send(stats);
  });

  app.post('/api/cache/clear', async (_req, reply) => {
    await clearThumbCache();
    return reply.send({ cleared: true });
  });
}

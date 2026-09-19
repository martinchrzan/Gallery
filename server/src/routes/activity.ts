import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { activityReport } from '../activity.js';
import { deviceFromRequest } from '../auth.js';
import { requireAdmin } from '../guard.js';
import type { ActivityReport } from '../types.js';

/**
 * `since` rather than a number of days: the client asks from its own local
 * midnight, so the first day it draws is a whole one in its timezone.
 */
const ActivityQuery = z.object({ since: z.coerce.number().int().nonnegative().default(0) });

export async function activityRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/activity', { preHandler: requireAdmin }, async (req, reply) => {
    const parsed = ActivityQuery.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid query' });

    const report: ActivityReport = activityReport(parsed.data.since, deviceFromRequest(req));
    return reply.header('Cache-Control', 'no-store').send(report);
  });
}

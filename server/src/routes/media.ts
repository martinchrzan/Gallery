import { createReadStream } from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { getDb } from '../db.js';
import { currentUser } from '../guard.js';
import { absFromRel, realpathWithin } from '../paths.js';
import { accessScope, dirAllowed } from '../scope.js';
import { getThumb, isThumbSize } from '../thumbs.js';

const MIME_BY_EXT: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.jpe': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.gif': 'image/gif',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
};

export function mimeFor(name: string): string {
  return MIME_BY_EXT[path.extname(name).toLowerCase()] ?? 'application/octet-stream';
}

interface MediaRow {
  rel_path: string;
  dir: string;
  name: string;
  content_key: string;
  size: number;
}

function lookup(id: number): MediaRow | undefined {
  return getDb()
    .prepare('SELECT rel_path, dir, name, content_key, size FROM photos WHERE id = ?')
    .get(id) as MediaRow | undefined;
}

/**
 * Streams a file, honouring a single `Range` header so the browser can seek
 * into large originals instead of buffering the whole thing.
 */
export async function sendFile(
  reply: FastifyReply,
  absPath: string,
  contentType: string,
  rangeHeader: string | undefined,
  totalSize: number,
): Promise<FastifyReply> {
  reply.header('Accept-Ranges', 'bytes');
  reply.header('Content-Type', contentType);

  const match = rangeHeader ? /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim()) : null;
  if (match) {
    const startRaw = match[1];
    const endRaw = match[2];
    let start: number;
    let end: number;

    if (startRaw === '' && endRaw !== '' && endRaw !== undefined) {
      // Suffix range: the last N bytes.
      const suffix = Number(endRaw);
      start = Math.max(0, totalSize - suffix);
      end = totalSize - 1;
    } else {
      start = Number(startRaw || 0);
      end = endRaw ? Number(endRaw) : totalSize - 1;
    }

    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= totalSize) {
      return reply.code(416).header('Content-Range', `bytes */${totalSize}`).send();
    }
    end = Math.min(end, totalSize - 1);

    return reply
      .code(206)
      .header('Content-Range', `bytes ${start}-${end}/${totalSize}`)
      .header('Content-Length', String(end - start + 1))
      .send(createReadStream(absPath, { start, end }));
  }

  return reply.header('Content-Length', String(totalSize)).send(createReadStream(absPath));
}

export async function mediaRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Cached WebP thumbnail. Generated on first request and reused forever: the
   * cache key includes the file's size and mtime, so an edited photo naturally
   * lands on a different key and the `immutable` caching below stays safe.
   */
  app.get<{ Params: { id: string }; Querystring: { h?: string } }>(
    '/api/media/:id/thumb',
    async (req, reply) => {
      const id = Number(req.params.id);
      if (!Number.isInteger(id)) return reply.code(400).send({ error: 'Invalid id' });

      const size = Number(req.query.h ?? 320);
      if (!isThumbSize(size)) return reply.code(400).send({ error: 'Unsupported thumbnail size' });

      const row = lookup(id);
      // Indistinguishable from a genuinely missing photo, so scanning ids tells
      // a restricted viewer nothing about what exists outside their folders.
      if (!row || !dirAllowed(accessScope(currentUser(req)), row.dir)) {
        return reply.code(404).send({ error: 'Not found' });
      }

      const etag = `"${row.content_key}-${size}"`;
      if (req.headers['if-none-match'] === etag) return reply.code(304).send();

      let thumbFile: string;
      try {
        const source = await realpathWithin(absFromRel(row.rel_path));
        thumbFile = await getThumb(source, row.content_key, size);
      } catch (err) {
        req.log.warn({ err, id, path: row.rel_path }, 'thumbnail generation failed');
        return reply.code(415).send({ error: 'Could not render this image' });
      }

      const stat = await fsp.stat(thumbFile);
      return reply
        .header('Content-Type', 'image/webp')
        .header('Content-Length', String(stat.size))
        // `private`, not `public`: the response now depends on who asked, so a
        // shared cache in front of the server must never hand it to someone else.
        .header('Cache-Control', 'private, max-age=31536000, immutable')
        .header('ETag', etag)
        .send(createReadStream(thumbFile));
    },
  );

  /** The untouched original — used for zooming past 100% and for downloads. */
  app.get<{ Params: { id: string }; Querystring: { download?: string } }>(
    '/api/media/:id/original',
    async (req, reply) => {
      const id = Number(req.params.id);
      if (!Number.isInteger(id)) return reply.code(400).send({ error: 'Invalid id' });

      const row = lookup(id);
      if (!row || !dirAllowed(accessScope(currentUser(req)), row.dir)) {
        return reply.code(404).send({ error: 'Not found' });
      }

      let abs: string;
      let stat;
      try {
        abs = await realpathWithin(absFromRel(row.rel_path));
        stat = await fsp.stat(abs);
      } catch {
        return reply.code(404).send({ error: 'Not found' });
      }

      const etag = `"${row.content_key}-orig"`;
      if (req.headers['if-none-match'] === etag && !req.headers.range) {
        return reply.code(304).send();
      }

      reply.header('Cache-Control', 'private, max-age=31536000, immutable').header('ETag', etag);
      if (req.query.download !== undefined) {
        reply.header('Content-Disposition', contentDisposition(row.name));
      }

      return sendFile(reply, abs, mimeFor(row.name), req.headers.range, stat.size);
    },
  );
}

/** RFC 5987 disposition so non-ASCII filenames survive the round trip. */
export function contentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

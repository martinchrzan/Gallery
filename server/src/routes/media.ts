import { createReadStream } from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { getDb, KIND_VIDEO, markMetaFailed, META_FAILED } from '../db.js';
import { currentUser } from '../guard.js';
import { absFromRel, realpathWithin } from '../paths.js';
import { accessScope, dirAllowed } from '../scope.js';
import { getThumb, isThumbSize, ThumbError } from '../thumbs.js';

/**
 * How long a browser may reuse a media response without asking again.
 *
 * These URLs are keyed by photo id, and a photo id is *not* a permanent name
 * for a file: `photos.id` is a plain SQLite rowid, a scan deletes the rows of
 * files that have gone, and a later insert takes the freed number — to say
 * nothing of a rebuilt index, where every id is reassigned at once. So the
 * bytes behind `/api/media/7/thumb` can change identity, and the `immutable`
 * this used to send was a promise the server cannot keep: browsers held the
 * previous occupant's picture for a year and never revalidated, which is how a
 * tile ends up opening a photo that is nothing like the one it shows.
 *
 * A minute is long enough that scrolling back up a feed — which remounts tiles
 * the virtualiser had dropped — still costs nothing, and short enough that a
 * remapped id corrects itself before anyone can puzzle over it. Past that the
 * ETag makes revalidation a bodiless 304.
 */
const MEDIA_MAX_AGE = 60;

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
  // Videos. `.mov` is deliberately served as video/mp4: Safari and Chrome both
  // play an H.264 QuickTime file happily, and the honest `video/quicktime`
  // makes some of them offer a download instead.
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/mp4',
  '.webm': 'video/webm',
  '.ogv': 'video/ogg',
  '.3gp': 'video/3gpp',
  '.3g2': 'video/3gpp2',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.mpg': 'video/mpeg',
  '.mpeg': 'video/mpeg',
  '.mts': 'video/mp2t',
  '.m2ts': 'video/mp2t',
  '.wmv': 'video/x-ms-wmv',
  '.flv': 'video/x-flv',
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
  meta_state: number;
  kind: number;
  duration_ms: number | null;
}

function lookup(id: number): MediaRow | undefined {
  return getDb()
    .prepare(
      `SELECT rel_path, dir, name, content_key, size, meta_state, kind, duration_ms
       FROM photos WHERE id = ?`,
    )
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
   * Cached WebP thumbnail. Generated on first request and kept on disk from
   * then on: the *disk* key includes the file's size and mtime, so an edited
   * photo lands on a different file rather than overwriting one. What a browser
   * may assume about the id in the URL is a separate question — see
   * {@link MEDIA_MAX_AGE}.
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

      // Already known to be unreadable — say so without waking a worker. The
      // client draws its placeholder tile either way.
      if (row.meta_state === META_FAILED) {
        return reply.code(415).send({ error: 'Could not render this image' });
      }

      const etag = `"${row.content_key}-${size}"`;
      if (req.headers['if-none-match'] === etag) return reply.code(304).send();

      let thumbFile: string;
      try {
        const source = await realpathWithin(absFromRel(row.rel_path));
        thumbFile = await getThumb(source, row.content_key, size, {
          video: row.kind === KIND_VIDEO,
          durationMs: row.duration_ms,
        });
      } catch (err) {
        req.log.warn({ err, id, path: row.rel_path }, 'thumbnail generation failed');
        // The file did not just fail to decode, it killed the decoder. Remember
        // that, so scrolling past this photo costs one worker rather than one
        // worker per request.
        if (err instanceof ThumbError && err.fatal) {
          req.log.error({ id, path: row.rel_path }, 'image killed its worker; marking unreadable');
          markMetaFailed(id);
        }
        return reply.code(415).send({ error: 'Could not render this image' });
      }

      const stat = await fsp.stat(thumbFile);
      return reply
        .header('Content-Type', 'image/webp')
        .header('Content-Length', String(stat.size))
        // `private`, not `public`: the response now depends on who asked, so a
        // shared cache in front of the server must never hand it to someone else.
        .header('Cache-Control', `private, max-age=${MEDIA_MAX_AGE}, must-revalidate`)
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

      reply
        .header('Cache-Control', `private, max-age=${MEDIA_MAX_AGE}, must-revalidate`)
        .header('ETag', etag);
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

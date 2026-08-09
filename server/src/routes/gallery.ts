import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { getDb } from '../db.js';
import { currentUser } from '../guard.js';
import { getDataVersion } from '../indexer.js';
import { accessScope, folderFilter, galleryScope, photoAllowed } from '../scope.js';
import type { PhotoDetail, User } from '../types.js';

/** Bytes per manifest record: id u32 | takenAt(sec) u32 | w u16 | h u16. */
export const MANIFEST_RECORD_BYTES = 12;

interface ManifestRow {
  id: number;
  taken_at: number | null;
  width: number | null;
  height: number | null;
}

function clampU16(value: number | null): number {
  if (value === null || !Number.isFinite(value) || value <= 0) return 0;
  return Math.min(65535, Math.round(value));
}

export function buildManifest(user: User): { buffer: Buffer; count: number } {
  const { sql, params } = folderFilter(galleryScope(user));

  const rows = getDb()
    .prepare(
      `SELECT id, taken_at, width, height FROM photos${sql} ORDER BY taken_at DESC, id DESC`,
    )
    .all(...params) as ManifestRow[];

  const buffer = Buffer.allocUnsafe(rows.length * MANIFEST_RECORD_BYTES);
  let offset = 0;
  for (const row of rows) {
    buffer.writeUInt32LE(row.id, offset);
    // Seconds, not milliseconds: keeps the record at 12 bytes and stays exact
    // until 2106. Undated photos sort last with 0.
    buffer.writeUInt32LE(row.taken_at ? Math.floor(row.taken_at / 1000) : 0, offset + 4);
    buffer.writeUInt16LE(clampU16(row.width), offset + 8);
    buffer.writeUInt16LE(clampU16(row.height), offset + 10);
    offset += MANIFEST_RECORD_BYTES;
  }

  return { buffer, count: rows.length };
}

/**
 * The user's folder set is part of the key, so two people signed in to the same
 * browser — or sharing any cache in front of the server — can never be served
 * each other's feed on a stale validator.
 */
function manifestEtag(user: User, count: number): string {
  const hash = createHash('sha1')
    .update(
      `${getDataVersion()}|${user.id}|${count}|${galleryScope(user).slice().sort().join(',')}`,
    )
    .digest('base64url');
  return `"${hash}"`;
}

export async function galleryRoutes(app: FastifyInstance): Promise<void> {
  /**
   * The whole feed as packed binary — 12 bytes per photo instead of ~45 for
   * JSON, and decodable straight into typed arrays with no parse step. This is
   * what lets the client compute an exact scroll height and jump anywhere.
   */
  app.get('/api/gallery/manifest', async (req, reply) => {
    const user = currentUser(req);
    const { buffer, count } = buildManifest(user);
    const etag = manifestEtag(user, count);

    if (req.headers['if-none-match'] === etag) {
      return reply.code(304).send();
    }

    return reply
      .header('Content-Type', 'application/octet-stream')
      .header('Cache-Control', 'private, no-cache')
      .header('ETag', etag)
      .header('X-Photo-Count', String(count))
      .send(buffer);
  });

  app.get<{ Params: { id: string } }>('/api/photos/:id', async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return reply.code(400).send({ error: 'Invalid id' });

    // Ids are sequential, so without this a restricted viewer could read the
    // path and EXIF of every photo in the library just by counting upwards.
    // 404 rather than 403: whether the id exists is itself not their business.
    if (!photoAllowed(accessScope(currentUser(req)), id)) {
      return reply.code(404).send({ error: 'Not found' });
    }

    const row = getDb()
      .prepare(
        `SELECT id, rel_path, dir, name, size, mtime_ms, width, height, taken_at, taken_src,
                camera, lens, iso, fnum, exposure, focal, gps_lat, gps_lon
         FROM photos WHERE id = ?`,
      )
      .get(id) as Record<string, never> | undefined;

    if (!row) return reply.code(404).send({ error: 'Not found' });

    const r = row as unknown as {
      id: number;
      rel_path: string;
      dir: string;
      name: string;
      size: number;
      mtime_ms: number;
      width: number | null;
      height: number | null;
      taken_at: number | null;
      taken_src: PhotoDetail['takenSource'];
      camera: string | null;
      lens: string | null;
      iso: number | null;
      fnum: number | null;
      exposure: string | null;
      focal: number | null;
      gps_lat: number | null;
      gps_lon: number | null;
    };

    const detail: PhotoDetail = {
      id: r.id,
      path: r.rel_path,
      name: r.name,
      dir: r.dir,
      size: r.size,
      width: r.width,
      height: r.height,
      takenAt: r.taken_at,
      takenSource: r.taken_src,
      modifiedAt: r.mtime_ms,
      camera: r.camera,
      lens: r.lens,
      iso: r.iso,
      aperture: r.fnum,
      exposure: r.exposure,
      focalLength: r.focal,
      gps: r.gps_lat !== null && r.gps_lon !== null ? { lat: r.gps_lat, lon: r.gps_lon } : null,
    };

    return reply.header('Cache-Control', 'private, no-cache').send(detail);
  });
}

import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { getDb, KIND_VIDEO } from '../db.js';
import { currentUser } from '../guard.js';
import { getDataVersion } from '../indexer.js';
import { accessScope, folderFilter, galleryScope, photoAllowed } from '../scope.js';
import type { PhotoDetail, User } from '../types.js';

/**
 * Bytes per manifest record:
 *   id u32 | takenAt(sec) u32 | w u16 | h u16 | duration(sec) u16 | flags u16
 *
 * Still a quarter of what the equivalent JSON costs. The last four bytes are
 * what a video needs beyond a photo — the badge on its tile, and knowing to
 * open a player instead of an image.
 */
export const MANIFEST_RECORD_BYTES = 16;

/** `flags` bit 0. */
export const MANIFEST_FLAG_VIDEO = 1;
/**
 * `flags` bit 1: the date is the file's own timestamp, not a capture date.
 *
 * Every file is indexed with `taken_at = mtime` up front and only re-dated once
 * its metadata has been read, so this covers both a photo carrying no date of
 * its own and one whose scan has not got to it yet. Anything claiming to know
 * *when a photo was taken* has to be able to tell the two apart.
 */
export const MANIFEST_FLAG_FILE_DATE = 2;

interface ManifestRow {
  id: number;
  taken_at: number | null;
  width: number | null;
  height: number | null;
  kind: number;
  duration_ms: number | null;
  taken_src: string | null;
}

function clampU16(value: number | null): number {
  if (value === null || !Number.isFinite(value) || value <= 0) return 0;
  return Math.min(65535, Math.round(value));
}

export function buildManifest(user: User): { buffer: Buffer; count: number } {
  const { sql, params } = folderFilter(galleryScope(user));

  const rows = getDb()
    .prepare(
      `SELECT id, taken_at, width, height, kind, duration_ms, taken_src FROM photos${sql}
       ORDER BY taken_at DESC, id DESC`,
    )
    .all(...params) as ManifestRow[];

  const buffer = Buffer.allocUnsafe(rows.length * MANIFEST_RECORD_BYTES);
  let offset = 0;
  for (const row of rows) {
    buffer.writeUInt32LE(row.id, offset);
    // Seconds, not milliseconds: keeps the record compact and stays exact until
    // 2106. Undated photos sort last with 0.
    buffer.writeUInt32LE(row.taken_at ? Math.floor(row.taken_at / 1000) : 0, offset + 4);
    buffer.writeUInt16LE(clampU16(row.width), offset + 8);
    buffer.writeUInt16LE(clampU16(row.height), offset + 10);
    // Seconds too, saturating at ~18 hours — the badge only needs a duration a
    // person can read, and a clip that long is not one.
    buffer.writeUInt16LE(clampU16(row.duration_ms === null ? null : row.duration_ms / 1000), offset + 12);
    buffer.writeUInt16LE(
      (row.kind === KIND_VIDEO ? MANIFEST_FLAG_VIDEO : 0) |
        (row.taken_src === 'mtime' ? MANIFEST_FLAG_FILE_DATE : 0),
      offset + 14,
    );
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
      return reply.code(304).header('X-Media-Version', String(getDataVersion())).send();
    }

    return reply
      .header('Content-Type', 'application/octet-stream')
      .header('Cache-Control', 'private, no-cache')
      .header('ETag', etag)
      .header('X-Photo-Count', String(count))
      // Moves the media URLs whenever the index does, so a browser cannot go on
      // showing a thumbnail it cached for an id that now means another file.
      .header('X-Media-Version', String(getDataVersion()))
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
                camera, lens, iso, fnum, exposure, focal, gps_lat, gps_lon, kind, duration_ms
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
      kind: number;
      duration_ms: number | null;
    };

    const detail: PhotoDetail = {
      kind: r.kind === KIND_VIDEO ? 'video' : 'photo',
      duration: r.duration_ms,
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

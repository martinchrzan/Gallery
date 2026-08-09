import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { getDb, getSettings } from '../db.js';
import { getDataVersion } from '../indexer.js';
import { toRelPosix } from '../paths.js';
import type { PhotoDetail } from '../types.js';

/** Bytes per manifest record: id u32 | takenAt(sec) u32 | w u16 | h u16. */
export const MANIFEST_RECORD_BYTES = 12;

interface ManifestRow {
  id: number;
  taken_at: number | null;
  width: number | null;
  height: number | null;
}

/**
 * Builds the SQL fragment restricting photos to the folders selected in
 * settings.
 *
 * An empty selection shows *nothing*: the gallery is an explicit choice of
 * folders, so an empty choice is an empty gallery rather than a silent
 * "everything". Selecting the root entry ('') is how you ask for the lot.
 */
function folderFilter(folders: string[]): { sql: string; params: string[] } {
  const cleaned = folders.map(toRelPosix).filter((f, i, arr) => arr.indexOf(f) === i);
  if (cleaned.length === 0) return { sql: ' WHERE 0', params: [] };
  if (cleaned.includes('')) return { sql: '', params: [] };

  const clauses: string[] = [];
  const params: string[] = [];
  for (const folder of cleaned) {
    // The folder itself, plus everything beneath it.
    clauses.push('(dir = ? OR dir LIKE ? ESCAPE \'\\\')');
    params.push(folder, `${escapeLike(folder)}/%`);
  }
  return { sql: ` WHERE ${clauses.join(' OR ')}`, params };
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

function clampU16(value: number | null): number {
  if (value === null || !Number.isFinite(value) || value <= 0) return 0;
  return Math.min(65535, Math.round(value));
}

export function buildManifest(): { buffer: Buffer; count: number } {
  const settings = getSettings();
  const { sql, params } = folderFilter(settings.galleryFolders);

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

function manifestEtag(count: number): string {
  const settings = getSettings();
  const hash = createHash('sha1')
    .update(`${getDataVersion()}|${count}|${settings.galleryFolders.slice().sort().join(',')}`)
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
    const { buffer, count } = buildManifest();
    const etag = manifestEtag(count);

    if (req.headers['if-none-match'] === etag) {
      return reply.code(304).send();
    }

    return reply
      .header('Content-Type', 'application/octet-stream')
      .header('Cache-Control', 'no-cache')
      .header('ETag', etag)
      .header('X-Photo-Count', String(count))
      .send(buffer);
  });

  app.get<{ Params: { id: string } }>('/api/photos/:id', async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return reply.code(400).send({ error: 'Invalid id' });

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

    return reply.header('Cache-Control', 'no-cache').send(detail);
  });
}

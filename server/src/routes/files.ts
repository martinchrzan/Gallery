import type { Dirent } from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import archiver from 'archiver';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getDb, KIND_VIDEO } from '../db.js';
import { requireAdmin } from '../guard.js';
import { indexNewFile } from '../indexer.js';
import {
  isIgnoredDir,
  isIndexableMedia,
  isUnsupportedImage,
  parentOf,
  PathError,
  realpathWithin,
  resolveWithinRoot,
  safeSegment,
} from '../paths.js';
import type { BrowseResult, DirEntry, FileEntry, FolderNode, UploadSession } from '../types.js';
import {
  abortUpload,
  CHUNK_BYTES,
  createUpload,
  finishUpload,
  MAX_CHUNK_BYTES,
  OffsetMismatch,
  writeChunk,
} from '../uploads.js';
import { contentDisposition, mimeFor, sendFile } from './media.js';

interface IndexedRow {
  id: number;
  name: string;
  width: number | null;
  height: number | null;
  kind: number;
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

export async function filesRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Every route here is admin-only, applied once for the whole plugin so a route
   * added later cannot forget it.
   *
   * These endpoints address the library by path rather than by photo id, and
   * `resolveWithinRoot` confines them to `photosRoot` — which is exactly the
   * boundary a per-user folder assignment subdivides. Rather than teach each of
   * browse, download, zip and tree to respect a narrower root, viewers simply do
   * not get the Files view at all.
   */
  app.addHook('preHandler', requireAdmin);

  /**
   * Upload chunks arrive as raw bytes, handed to the route as a stream rather
   * than buffered into memory first — a chunk goes straight from the socket to
   * the file. Registered inside this plugin, so it applies to these routes only.
   */
  app.addContentTypeParser('application/octet-stream', (_req, payload, done) => {
    done(null, payload);
  });

  /** One directory level: subfolders plus files, with photo ids where indexed. */
  app.get<{ Querystring: { path?: string } }>('/api/files/browse', async (req, reply) => {
    const { rel, abs } = resolveWithinRoot(req.query.path);
    const real = await realpathWithin(abs);

    const stat = await fsp.stat(real);
    if (!stat.isDirectory()) return reply.code(400).send({ error: 'Not a directory' });

    const entries = await fsp.readdir(real, { withFileTypes: true });

    // One indexed lookup for the whole directory instead of one per file.
    const indexed = new Map<string, IndexedRow>();
    for (const row of getDb()
      .prepare('SELECT id, name, width, height, kind FROM photos WHERE dir = ?')
      .all(rel) as IndexedRow[]) {
      indexed.set(row.name, row);
    }

    const dirs: DirEntry[] = [];
    const files: FileEntry[] = [];

    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (isIgnoredDir(entry.name)) continue;
        dirs.push({ name: entry.name, path: rel ? `${rel}/${entry.name}` : entry.name });
        continue;
      }
      if (!entry.isFile() || entry.name.startsWith('.')) continue;

      let fstat;
      try {
        fstat = await fsp.stat(path.join(real, entry.name));
      } catch {
        continue;
      }

      const row = indexed.get(entry.name);
      files.push({
        name: entry.name,
        path: rel ? `${rel}/${entry.name}` : entry.name,
        size: fstat.size,
        modifiedAt: Math.round(fstat.mtimeMs),
        photoId: row?.id ?? null,
        width: row?.width ?? null,
        height: row?.height ?? null,
        unsupportedImage: !isIndexableMedia(entry.name) && isUnsupportedImage(entry.name),
        video: row?.kind === KIND_VIDEO,
      });
    }

    dirs.sort((a, b) => collator.compare(a.name, b.name));
    files.sort((a, b) => collator.compare(a.name, b.name));

    const result: BrowseResult = { path: rel, parent: parentOf(rel), dirs, files };
    return reply.header('Cache-Control', 'no-store').send(result);
  });

  /** Single-file download of anything inside the root. */
  app.get<{ Querystring: { path?: string } }>('/api/files/download', async (req, reply) => {
    const { abs } = resolveWithinRoot(req.query.path);
    const real = await realpathWithin(abs);

    const stat = await fsp.stat(real);
    if (!stat.isFile()) return reply.code(400).send({ error: 'Not a file' });

    const name = path.basename(real);
    reply.header('Content-Disposition', contentDisposition(name));
    return sendFile(reply, real, mimeFor(name), req.headers.range, stat.size);
  });

  /**
   * Streamed ZIP of any mix of files and folders. Stored, not deflated: photos
   * are already compressed, so deflate would burn CPU for ~1% saving.
   */
  app.post<{ Body: ZipBody }>('/api/files/zip', async (req, reply) => {
    const body = parseZipBody(req.body);
    const requested = body.paths;
    if (requested.length === 0) return reply.code(400).send({ error: 'No paths given' });
    if (requested.length > 5000) return reply.code(400).send({ error: 'Too many paths' });

    const resolved: { rel: string; real: string; isDir: boolean }[] = [];
    for (const candidate of requested) {
      const { rel, abs } = resolveWithinRoot(candidate);
      if (rel === '') throw new PathError('Cannot zip the library root');
      const real = await realpathWithin(abs);
      const stat = await fsp.stat(real);
      resolved.push({ rel, real, isDir: stat.isDirectory() });
    }

    const zipName = sanitizeZipName(
      body.name ??
        (resolved.length === 1 && resolved[0]
          ? `${path.basename(resolved[0].rel)}.zip`
          : 'photos.zip'),
    );

    const archive = archiver('zip', { store: true });
    // Individual failures (a file deleted mid-stream) must not kill the ZIP.
    archive.on('warning', (err) => req.log.warn({ err }, 'zip warning'));
    archive.on('error', (err) => {
      req.log.error({ err }, 'zip failed');
      archive.destroy();
    });

    reply
      .header('Content-Type', 'application/zip')
      .header('Content-Disposition', contentDisposition(zipName))
      .header('Cache-Control', 'no-store');

    // Abort the archive if the client hangs up, so we stop reading from disk.
    req.raw.on('close', () => {
      if (!req.raw.readableEnded) archive.destroy();
    });

    for (const item of resolved) {
      if (item.isDir) {
        archive.directory(item.real, path.basename(item.rel));
      } else {
        archive.file(item.real, { name: path.basename(item.rel) });
      }
    }

    void archive.finalize();
    return reply.send(archive);
  });

  /** Directory tree with recursive photo counts, for the settings folder picker. */
  app.get('/api/folders/tree', async (_req, reply) => {
    const counts = new Map<string, number>();
    for (const row of getDb()
      .prepare('SELECT dir, count(*) AS n FROM photos GROUP BY dir')
      .all() as { dir: string; n: number }[]) {
      counts.set(row.dir, row.n);
    }

    const build = async (rel: string, name: string): Promise<FolderNode> => {
      const { abs } = resolveWithinRoot(rel);
      const children: FolderNode[] = [];

      let entries: Dirent[] = [];
      try {
        entries = await fsp.readdir(abs, { withFileTypes: true });
      } catch {
        // Unreadable folder: show it, but with no children.
      }

      for (const entry of entries) {
        if (!entry.isDirectory() || isIgnoredDir(entry.name)) continue;
        children.push(await build(rel ? `${rel}/${entry.name}` : entry.name, entry.name));
      }
      children.sort((a, b) => collator.compare(a.name, b.name));

      // Own photos plus everything below, so a parent shows the real total.
      const photoCount =
        (counts.get(rel) ?? 0) + children.reduce((sum, child) => sum + child.photoCount, 0);

      return { name, path: rel, children, photoCount };
    };

    const tree = await build('', 'All photos');
    return reply.header('Cache-Control', 'no-store').send(tree);
  });

  /**
   * Creates one folder inside the library.
   *
   * One level only, and the name goes through the same segment guard an upload's
   * does: what a request may choose is a name, never a path. Nothing is created
   * recursively, so a typo cannot conjure a tree.
   */
  app.post<{ Body: unknown }>('/api/files/folder', async (req, reply) => {
    const parsed = NewFolder.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid folder request' });

    const name = safeSegment(parsed.data.name);
    if (name === null) return reply.code(400).send({ error: 'That folder name cannot be used' });

    const { rel, abs } = resolveWithinRoot(parsed.data.path);
    const parent = await realpathWithin(abs);
    if (!(await fsp.stat(parent)).isDirectory()) {
      return reply.code(400).send({ error: 'The destination is not a folder' });
    }

    try {
      // Not `recursive`: that succeeds silently on a folder that already exists,
      // and here the client is told so instead.
      await fsp.mkdir(path.join(parent, name));
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') {
        return reply.code(409).send({ error: `“${name}” already exists here` });
      }
      return reply.code(403).send({ error: `Cannot create a folder here (${code ?? 'error'})` });
    }

    const created: DirEntry = { name, path: rel ? `${rel}/${name}` : name };
    return reply.send(created);
  });

  /* ---------------------------------------------------------------- upload */

  /**
   * Opens an upload session for one file.
   *
   * Everything that can be checked before a byte is sent is checked here — the
   * name, the extension, the destination folder, whether that folder can be
   * written to at all — because the alternative is telling someone their video
   * cannot be stored after they have spent ten minutes on a phone sending it.
   */
  app.post<{ Body: unknown }>('/api/files/upload', async (req, reply) => {
    const parsed = UploadInit.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid upload request' });

    const handle = await createUpload({
      dir: parsed.data.path,
      name: parsed.data.name,
      size: parsed.data.size,
    });

    const session: UploadSession = {
      ...handle,
      chunkSize: CHUNK_BYTES,
      maxChunkSize: MAX_CHUNK_BYTES,
    };
    return reply.header('Cache-Control', 'no-store').send(session);
  });

  /**
   * One chunk, at an explicit byte offset.
   *
   * A mismatched offset is answered with where the server actually is, so a
   * client whose chunk landed but whose response was lost resumes from the
   * right place instead of duplicating or skipping bytes.
   *
   * No `bodyLimit` here, and the app-wide one does not apply either: Fastify
   * enforces those while buffering a body into a string or a buffer, which is
   * exactly what the parser above declines to do. The ceiling on a chunk is held
   * in two places instead — the header check below, and `writeChunk` counting
   * the bytes as they arrive.
   */
  app.post<{ Params: { id: string }; Querystring: { offset?: string } }>(
    '/api/files/upload/:id/chunk',
    async (req, reply) => {
      const offset = Number(req.query.offset ?? '0');

      // Refused on the declared length, before a byte is read. `writeChunk`
      // catches an oversized body too, but only by destroying the stream part
      // way through, which reaches the client as a dropped connection rather
      // than as an answer it can do anything with. Its check stays as the
      // backstop for a body that lies about its length or omits one.
      const declared = Number(req.headers['content-length']);
      if (Number.isFinite(declared) && declared > MAX_CHUNK_BYTES) {
        return reply.code(413).send({ error: 'Chunk is too large' });
      }

      try {
        const handle = await writeChunk(req.params.id, offset, req.body as Readable);
        return reply.header('Cache-Control', 'no-store').send(handle);
      } catch (err) {
        if (err instanceof OffsetMismatch) {
          return reply
            .code(409)
            .send({ error: err.message, expectedOffset: err.expectedOffset });
        }
        throw err;
      }
    },
  );

  /** Moves a completed upload into the library and indexes it immediately. */
  app.post<{ Params: { id: string } }>('/api/files/upload/:id/finish', async (req, reply) => {
    const file = await finishUpload(req.params.id);

    // Best-effort: the file is in the library either way, and the next scan
    // would find it. Failing the request here would tell the client its upload
    // did not happen, which would be a lie.
    await indexNewFile(file.abs).catch((err: Error) =>
      req.log.warn({ err }, 'could not index an uploaded file'),
    );

    return reply.send({ path: file.rel, name: file.name });
  });

  /** Cancels a session and discards its partial file. */
  app.delete<{ Params: { id: string } }>('/api/files/upload/:id', async (req, reply) => {
    await abortUpload(req.params.id);
    return reply.send({ aborted: true });
  });
}

const NewFolder = z
  .object({
    /** The folder to create it in, relative to the library root. */
    path: z.string().max(4096).optional(),
    name: z.string().min(1).max(200),
  })
  .strict();

const UploadInit = z
  .object({
    /** Destination folder, relative to the library root. Omitted means the root. */
    path: z.string().max(4096).optional(),
    name: z.string().min(1).max(400),
    size: z.number().int().nonnegative(),
  })
  .strict();

/**
 * The ZIP endpoint accepts either a JSON body or a form-encoded `payload`
 * field. The form variant exists so the browser can stream the archive to disk
 * instead of buffering it in memory the way `fetch` would.
 */
type ZipBody = { paths?: unknown; name?: unknown; payload?: unknown } | undefined;

function parseZipBody(body: ZipBody): { paths: string[]; name?: string } {
  let source: { paths?: unknown; name?: unknown } = body ?? {};

  if (typeof body?.payload === 'string') {
    try {
      source = JSON.parse(body.payload) as { paths?: unknown; name?: unknown };
    } catch {
      throw new PathError('Malformed request');
    }
  }

  const paths = Array.isArray(source.paths)
    ? source.paths.filter((p): p is string => typeof p === 'string')
    : [];
  return { paths, ...(typeof source.name === 'string' ? { name: source.name } : {}) };
}

function sanitizeZipName(name: string): string {
  const base = path.basename(name).replace(/[\\/:*?"<>|]/g, '_').trim() || 'photos';
  return base.toLowerCase().endsWith('.zip') ? base : `${base}.zip`;
}

import type { Dirent } from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import archiver from 'archiver';
import type { FastifyInstance } from 'fastify';
import { getDb } from '../db.js';
import {
  isIgnoredDir,
  isSupportedImage,
  isUnsupportedImage,
  parentOf,
  PathError,
  realpathWithin,
  resolveWithinRoot,
} from '../paths.js';
import type { BrowseResult, DirEntry, FileEntry, FolderNode } from '../types.js';
import { contentDisposition, mimeFor, sendFile } from './media.js';

interface IndexedRow {
  id: number;
  name: string;
  width: number | null;
  height: number | null;
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

export async function filesRoutes(app: FastifyInstance): Promise<void> {
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
      .prepare('SELECT id, name, width, height FROM photos WHERE dir = ?')
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
        unsupportedImage: !isSupportedImage(entry.name) && isUnsupportedImage(entry.name),
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
}

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

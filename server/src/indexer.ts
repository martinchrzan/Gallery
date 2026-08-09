import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fsp from 'node:fs/promises';
import path from 'node:path';
import chokidar, { type FSWatcher } from 'chokidar';
import { config } from './config.js';
import {
  getDb,
  getMeta,
  getSettings,
  META_DONE,
  META_FAILED,
  META_INFLIGHT,
  META_PENDING,
  setMeta,
} from './db.js';
import {
  absFromRel,
  isIgnoredDir,
  isSupportedImage,
  isUnsupportedImage,
  relFromAbs,
  toRelPosix,
} from './paths.js';
import { deleteThumbs, getThumb, hasThumb } from './thumbs.js';
import type { IndexStatus } from './types.js';
import { destroyMetadataPool, getMetadataPool } from './workers/pool.js';
import type { MetaJob, MetaResult } from './workers/metadata-worker.js';

const WALK_BATCH = 500;
const META_BATCH = 32;
/**
 * How often one file may be handed to the extractor before it is retired.
 * A file that kills its worker process never reports a result, so without this
 * the next scan would pick it up again and die in exactly the same place.
 */
const MAX_META_ATTEMPTS = 3;

export const indexEvents = new EventEmitter();

const status: IndexStatus = {
  scanning: false,
  phase: 'idle',
  discovered: 0,
  processed: 0,
  pending: 0,
  total: 0,
  lastScanAt: null,
  lastError: null,
};

/** Bumped whenever the photo set changes, so manifest ETags invalidate. */
let dataVersion = Date.now();

/**
 * Set once shutdown begins. The extraction pass reads it to tell "the worker
 * died on this file" from "we are tearing the pool down" — without it, every
 * batch still in the air at exit would look like a bad file and be retired.
 */
let stopping = false;

export function getIndexStatus(): IndexStatus {
  return { ...status };
}

export function getDataVersion(): number {
  return dataVersion;
}

function bumpDataVersion(): void {
  dataVersion = Date.now();
}

let emitScheduled = false;
function emitStatus(immediate = false): void {
  if (immediate) {
    emitScheduled = false;
    indexEvents.emit('status', getIndexStatus());
    return;
  }
  // Coalesce the high-frequency updates from the walk into ~4 events/sec.
  if (emitScheduled) return;
  emitScheduled = true;
  setTimeout(() => {
    emitScheduled = false;
    indexEvents.emit('status', getIndexStatus());
  }, 250).unref();
}

export function contentKey(relPath: string, size: number, mtimeMs: number): string {
  return createHash('sha1').update(`${relPath}|${size}|${Math.round(mtimeMs)}`).digest('hex');
}

/* ------------------------------------------------------------ statements -- */

interface MetaUpdate {
  id: number;
  width: number | null;
  height: number | null;
  orientation: number | null;
  taken_at: number | null;
  taken_src: string | null;
  camera: string | null;
  lens: string | null;
  iso: number | null;
  fnum: number | null;
  exposure: string | null;
  focal: number | null;
  gps_lat: number | null;
  gps_lon: number | null;
  meta_state: number;
}

function buildStatements() {
  const db = getDb();
  return {
    upsert: db.prepare<[WalkRow]>(`
      INSERT INTO photos (rel_path, dir, name, ext, size, mtime_ms, content_key,
                          taken_at, taken_src, meta_state, seen_gen)
      VALUES (@rel_path, @dir, @name, @ext, @size, @mtime_ms, @content_key,
              @mtime_ms, 'mtime', ${META_PENDING}, @gen)
      ON CONFLICT(rel_path) DO UPDATE SET
        seen_gen    = @gen,
        size        = @size,
        mtime_ms    = @mtime_ms,
        content_key = @content_key,
        -- Only re-extract when the bytes actually changed.
        meta_state  = CASE WHEN photos.mtime_ms <> @mtime_ms OR photos.size <> @size
                           THEN ${META_PENDING} ELSE photos.meta_state END,
        taken_at    = CASE WHEN photos.mtime_ms <> @mtime_ms OR photos.size <> @size
                           THEN @mtime_ms ELSE photos.taken_at END,
        -- New bytes deserve a fresh set of attempts, even for a file that was
        -- retired as unreadable before.
        meta_attempts = CASE WHEN photos.mtime_ms <> @mtime_ms OR photos.size <> @size
                             THEN 0 ELSE photos.meta_attempts END
    `),
    stale: db.prepare<[number], { id: number; content_key: string }>(
      'SELECT id, content_key FROM photos WHERE seen_gen <> ?',
    ),
    del: db.prepare<[number]>('DELETE FROM photos WHERE id = ?'),
    pending: db.prepare<
      [number],
      { id: number; rel_path: string; name: string; mtime_ms: number }
    >(
      `SELECT id, rel_path, name, mtime_ms FROM photos WHERE meta_state = ${META_PENDING} LIMIT ?`,
    ),
    pendingCount: db.prepare<[], { n: number }>(
      `SELECT count(*) AS n FROM photos WHERE meta_state = ${META_PENDING}`,
    ),
    applyMeta: db.prepare<[MetaUpdate]>(`
      UPDATE photos SET
        width = @width, height = @height, orientation = @orientation,
        taken_at = @taken_at, taken_src = @taken_src,
        camera = @camera, lens = @lens, iso = @iso, fnum = @fnum,
        exposure = @exposure, focal = @focal,
        gps_lat = @gps_lat, gps_lon = @gps_lon,
        meta_state = @meta_state
      WHERE id = @id
    `),
    claim: db.prepare<[number]>(
      `UPDATE photos SET meta_state = ${META_INFLIGHT}, meta_attempts = meta_attempts + 1
       WHERE id = ?`,
    ),
    stuck: db.prepare<[], { id: number; rel_path: string; meta_attempts: number }>(
      `SELECT id, rel_path, meta_attempts FROM photos WHERE meta_state = ${META_INFLIGHT}`,
    ),
    retire: db.prepare<[number]>(
      `UPDATE photos SET meta_state = ${META_FAILED}
       WHERE meta_state = ${META_INFLIGHT} AND meta_attempts >= ?`,
    ),
    reclaimAll: db.prepare<[]>(
      `UPDATE photos SET meta_state = ${META_PENDING} WHERE meta_state = ${META_INFLIGHT}`,
    ),
    /** Reclaim without charging an attempt — for a shutdown we asked for. */
    releaseAll: db.prepare<[]>(
      `UPDATE photos SET meta_state = ${META_PENDING},
                         meta_attempts = MAX(0, meta_attempts - 1)
       WHERE meta_state = ${META_INFLIGHT}`,
    ),
    failOne: db.prepare<[number]>(`UPDATE photos SET meta_state = ${META_FAILED} WHERE id = ?`),
  };
}

let stmts: ReturnType<typeof buildStatements> | null = null;

/** Prepared statements, built once on first use. */
function statements(): ReturnType<typeof buildStatements> {
  stmts ??= buildStatements();
  return stmts;
}

/* ------------------------------------------------------------------ walk -- */

interface WalkRow {
  rel_path: string;
  dir: string;
  name: string;
  ext: string;
  size: number;
  mtime_ms: number;
  content_key: string;
  gen: number;
}

/**
 * Recursively lists supported images under `root`, flushing to SQLite in
 * batched transactions so memory stays flat on huge libraries.
 */
async function walk(gen: number): Promise<void> {
  const db = getDb();
  const { upsert } = statements();
  const flush = db.transaction((rows: WalkRow[]) => {
    for (const row of rows) upsert.run(row);
  });

  let batch: WalkRow[] = [];

  const visit = async (absDir: string): Promise<void> => {
    let entries;
    try {
      entries = await fsp.readdir(absDir, { withFileTypes: true });
    } catch {
      return; // Unreadable directory (permissions, vanished mid-scan).
    }

    const subdirs: string[] = [];

    for (const entry of entries) {
      const abs = path.join(absDir, entry.name);

      if (entry.isDirectory()) {
        if (!isIgnoredDir(entry.name)) subdirs.push(abs);
        continue;
      }
      // Skip symlinks entirely: following them invites cycles and lets content
      // outside the root be indexed.
      if (!entry.isFile()) continue;
      if (!isSupportedImage(entry.name)) continue;

      let stat;
      try {
        stat = await fsp.stat(abs);
      } catch {
        continue;
      }

      const rel = relFromAbs(abs);
      batch.push({
        rel_path: rel,
        dir: toRelPosix(path.dirname(rel) === '.' ? '' : path.dirname(rel)),
        name: entry.name,
        ext: path.extname(entry.name).toLowerCase(),
        size: stat.size,
        mtime_ms: Math.round(stat.mtimeMs),
        content_key: contentKey(rel, stat.size, stat.mtimeMs),
        gen,
      });

      status.discovered++;

      if (batch.length >= WALK_BATCH) {
        flush(batch);
        batch = [];
        emitStatus();
      }
    }

    for (const dir of subdirs) await visit(dir);
  };

  await visit(config().photosRoot);
  if (batch.length > 0) flush(batch);
}

/* --------------------------------------------------------------- extract -- */

/**
 * Drains the metadata backlog through the worker pool. Runs until no pending
 * rows remain, so it also picks up work queued by the watcher.
 */
async function extractPending(): Promise<void> {
  const db = getDb();
  const { pending, pendingCount, applyMeta, claim, stuck, retire, reclaimAll, failOne } =
    statements();
  const pool = getMetadataPool();

  // Recover anything a previous run left claimed. Rows still claimed here were
  // in a worker when it died — usually because the whole server was killed
  // mid-extraction — so anything that has burned through its attempts is retired
  // rather than fed to the extractor again.
  const abandoned = stuck.all();
  if (abandoned.length > 0) {
    const retired = abandoned.filter((r) => r.meta_attempts >= MAX_META_ATTEMPTS);
    for (const row of retired) {
      console.warn(
        `[indexer] giving up on ${row.rel_path} after ${row.meta_attempts} failed extraction attempts`,
      );
    }
    if (retired.length > 0) {
      status.lastError = `Skipped ${retired.length} file(s) that could not be read: ${retired
        .slice(0, 3)
        .map((r) => r.rel_path)
        .join(', ')}${retired.length > 3 ? ', …' : ''}`;
    }
    retire.run(MAX_META_ATTEMPTS);
    reclaimAll.run();
  }

  status.total = pendingCount.get()?.n ?? 0;
  status.processed = 0;
  status.pending = status.total;
  emitStatus(true);

  if (status.total === 0) return;

  const writeResults = db.transaction((results: MetaResult[]) => {
    for (const r of results) {
      if (!r) continue;
      applyMeta.run({
        id: r.id,
        width: r.width,
        height: r.height,
        orientation: r.orientation,
        taken_at: r.takenAt,
        taken_src: r.takenSrc,
        camera: r.camera,
        lens: r.lens,
        iso: r.iso,
        fnum: r.fnum,
        exposure: r.exposure,
        focal: r.focal,
        gps_lat: r.gpsLat,
        gps_lon: r.gpsLon,
        // A file that failed to decode is marked done-with-failure so the next
        // scan does not retry it forever.
        meta_state: r.failed ? META_FAILED : META_DONE,
      });
    }
  });

  // Keep every worker fed: hand out `poolSize` batches and refill as they land.
  const inFlight = new Set<Promise<void>>();
  // Batches whose worker died, queued for a second run one file at a time.
  const retries: MetaJob[][] = [];
  let exhausted = false;

  const claimRows = db.transaction((ids: number[]) => {
    for (const id of ids) claim.run(id);
  });

  const advance = (by: number): void => {
    status.processed += by;
    status.pending = Math.max(0, status.total - status.processed);
    emitStatus();
  };

  const nextJobs = (): MetaJob[] | null => {
    const retry = retries.shift();
    if (retry) return retry;

    const rows = pending.all(META_BATCH);
    if (rows.length === 0) return null;

    // Claim the rows immediately so the next `pending.all()` returns new ones.
    claimRows(rows.map((r) => r.id));
    return rows.map((row) => ({
      id: row.id,
      absPath: absFromRel(row.rel_path),
      fileName: row.name,
      mtimeMs: row.mtime_ms,
    }));
  };

  const dispatch = (): boolean => {
    const jobs = nextJobs();
    if (!jobs) return false;

    const task = pool
      .run(jobs)
      .then((results) => {
        writeResults(results);
        advance(results.length);
      })
      .catch((err: Error) => {
        // Shutting down: these rows are still claimed, and `stopIndexer` hands
        // them back untouched. Nothing here is the file's fault.
        if (stopping) return;

        // The worker died holding this batch — almost always one file libvips
        // could not survive. Re-run the batch one file at a time so the rest of
        // it still gets indexed and the culprit can be named.
        if (jobs.length > 1) {
          for (const job of jobs) retries.push([job]);
          // A retry queued after the table drained still has to be dispatched.
          exhausted = false;
          return;
        }

        const job = jobs[0];
        if (!job) return;
        console.warn(
          `[indexer] skipping ${job.absPath}: the metadata worker died reading it (${err.message})`,
        );
        failOne.run(job.id);
        status.lastError = `Skipped ${relFromAbs(job.absPath)}: could not be read`;
        advance(1);
      })
      .finally(() => {
        inFlight.delete(task);
      });

    inFlight.add(task);
    return true;
  };

  const concurrency = pool.size + 1;
  while ((!exhausted && !stopping) || inFlight.size > 0) {
    while (!exhausted && !stopping && inFlight.size < concurrency) {
      if (!dispatch()) exhausted = true;
    }
    if (inFlight.size > 0) await Promise.race(inFlight);
  }

  bumpDataVersion();
}

/* -------------------------------------------------------------- pre-warm -- */

async function prewarm(signal: { cancelled: boolean }): Promise<void> {
  const db = getDb();
  const rows = db
    .prepare('SELECT rel_path, content_key FROM photos ORDER BY taken_at DESC')
    .all() as { rel_path: string; content_key: string }[];

  status.phase = 'prewarming';
  status.total = rows.length;
  status.processed = 0;
  emitStatus(true);

  const CONCURRENCY = 4;
  let cursor = 0;

  const runner = async (): Promise<void> => {
    while (!signal.cancelled) {
      const row = rows[cursor++];
      if (!row) return;
      if (!(await hasThumb(row.content_key, 320))) {
        await getThumb(absFromRel(row.rel_path), row.content_key, 320).catch(() => {});
      }
      status.processed++;
      if (status.processed % 25 === 0) emitStatus();
    }
  };

  await Promise.all(Array.from({ length: CONCURRENCY }, runner));
}

/* ------------------------------------------------------------------ scan -- */

let scanPromise: Promise<void> | null = null;
let cancelSignal = { cancelled: false };

/** Runs a full sweep. Concurrent calls join the in-progress scan. */
export function scan(): Promise<void> {
  if (scanPromise) return scanPromise;

  cancelSignal = { cancelled: false };
  const signal = cancelSignal;

  scanPromise = (async () => {
    const db = getDb();
    const gen = Number(getMeta('scan_gen') ?? '0') + 1;

    status.scanning = true;
    status.phase = 'walking';
    status.discovered = 0;
    status.processed = 0;
    status.pending = 0;
    status.total = 0;
    status.lastError = null;
    emitStatus(true);

    try {
      await walk(gen);
      setMeta('scan_gen', String(gen));

      // Anything not touched by this generation is gone from disk.
      const stale = statements().stale.all(gen);
      if (stale.length > 0) {
        const removeRows = db.transaction((ids: number[]) => {
          for (const id of ids) statements().del.run(id);
        });
        removeRows(stale.map((r) => r.id));
        await Promise.all(stale.map((r) => deleteThumbs(r.content_key)));
      }
      bumpDataVersion();

      status.phase = 'extracting';
      emitStatus(true);
      await extractPending();

      status.lastScanAt = Date.now();
      setMeta('last_scan_at', String(status.lastScanAt));

      if (getSettings().prewarmThumbs && !signal.cancelled) {
        await prewarm(signal);
      }
    } catch (err) {
      status.lastError = (err as Error).message;
    } finally {
      status.scanning = false;
      status.phase = 'idle';
      emitStatus(true);
      scanPromise = null;
    }
  })();

  return scanPromise;
}

export function cancelScan(): void {
  cancelSignal.cancelled = true;
}

/* -------------------------------------------------------- incremental fs -- */

/** Indexes or refreshes one file discovered by the watcher. */
async function indexOne(abs: string): Promise<void> {
  if (!isSupportedImage(abs)) return;

  let stat;
  try {
    stat = await fsp.stat(abs);
  } catch {
    return;
  }
  if (!stat.isFile()) return;

  const rel = relFromAbs(abs);
  if (rel.startsWith('..')) return;

  const dir = path.dirname(rel) === '.' ? '' : path.dirname(rel);
  statements().upsert.run({
    rel_path: rel,
    dir: toRelPosix(dir),
    name: path.basename(rel),
    ext: path.extname(rel).toLowerCase(),
    size: stat.size,
    mtime_ms: Math.round(stat.mtimeMs),
    content_key: contentKey(rel, stat.size, stat.mtimeMs),
    gen: Number(getMeta('scan_gen') ?? '0'),
  });

  bumpDataVersion();
}

async function unindexOne(abs: string): Promise<void> {
  const rel = relFromAbs(abs);
  const row = getDb().prepare('SELECT id, content_key FROM photos WHERE rel_path = ?').get(rel) as
    | { id: number; content_key: string }
    | undefined;
  if (!row) return;

  statements().del.run(row.id);
  await deleteThumbs(row.content_key);
  bumpDataVersion();
}

/* ----------------------------------------------------------- scheduling -- */

let watcher: FSWatcher | null = null;
let intervalTimer: NodeJS.Timeout | null = null;
let watchFlushTimer: NodeJS.Timeout | null = null;

function scheduleWatchFlush(): void {
  if (watchFlushTimer) clearTimeout(watchFlushTimer);
  // Copying a folder in fires hundreds of events; wait for the burst to settle
  // before spending worker time on extraction.
  watchFlushTimer = setTimeout(() => {
    watchFlushTimer = null;
    if (!status.scanning) {
      status.scanning = true;
      status.phase = 'extracting';
      void extractPending()
        .catch(() => {})
        .finally(() => {
          status.scanning = false;
          status.phase = 'idle';
          emitStatus(true);
        });
    }
  }, 2000);
  watchFlushTimer.unref();
}

async function startWatching(): Promise<void> {
  if (watcher) return;

  watcher = chokidar.watch(config().photosRoot, {
    ignoreInitial: true,
    followSymlinks: false,
    depth: 20,
    awaitWriteFinish: { stabilityThreshold: 1500, pollInterval: 200 },
    ignored: (target: string) => {
      const rel = path.relative(config().photosRoot, target);
      if (rel === '' || rel.startsWith('..')) return false;
      return rel.split(/[\\/]/).some(isIgnoredDir);
    },
  });

  watcher
    .on('add', (file) => {
      void indexOne(file).then(scheduleWatchFlush);
    })
    .on('change', (file) => {
      void indexOne(file).then(scheduleWatchFlush);
    })
    .on('unlink', (file) => {
      void unindexOne(file);
    })
    .on('unlinkDir', () => {
      // A whole folder vanished; a sweep is the cheapest way to reconcile.
      void scan();
    })
    .on('error', (err) => {
      status.lastError = `watcher: ${(err as Error).message}`;
    });
}

async function stopWatching(): Promise<void> {
  if (!watcher) return;
  const w = watcher;
  watcher = null;
  await w.close();
}

/** Applies the current settings' index mode: watcher on/off, timer on/off. */
export async function applyIndexMode(): Promise<void> {
  const settings = getSettings();

  if (intervalTimer) {
    clearInterval(intervalTimer);
    intervalTimer = null;
  }

  if (settings.indexMode === 'watch') {
    await startWatching();
  } else {
    await stopWatching();
  }

  if (settings.indexMode === 'interval') {
    const hours = Math.max(0.25, settings.indexIntervalHours || 6);
    intervalTimer = setInterval(() => void scan(), hours * 3600_000);
    intervalTimer.unref();
  }
}

export async function startIndexer(): Promise<void> {
  stopping = false;
  status.lastScanAt = Number(getMeta('last_scan_at') ?? '') || null;
  await applyIndexMode();
  // Always reconcile on boot, whatever the mode — the folder may have changed
  // while the server was down.
  void scan();
}

export async function stopIndexer(): Promise<void> {
  stopping = true;
  cancelScan();
  if (intervalTimer) clearInterval(intervalTimer);
  if (watchFlushTimer) clearTimeout(watchFlushTimer);
  await stopWatching();

  // Stop the workers before releasing their claims, so nothing writes a result
  // for a row we have just handed back. An orderly stop must not count against
  // those files: only a worker dying on its own says anything about the bytes.
  await destroyMetadataPool();
  if (stmts) stmts.releaseAll.run();
}

export { isUnsupportedImage };

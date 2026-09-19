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
  KIND_IMAGE,
  KIND_VIDEO,
  markMetaFailed,
  MAX_META_ATTEMPTS,
  META_DONE,
  META_FAILED,
  META_INFLIGHT,
  META_PENDING,
  setMeta,
} from './db.js';
import {
  absFromRel,
  isIgnoredDir,
  isIndexableMedia,
  isSupportedVideo,
  isUnsupportedImage,
  realpathWithin,
  relFromAbs,
  toRelPosix,
} from './paths.js';
import { deleteThumbs, getThumb, hasThumb, ThumbError } from './thumbs.js';
import type { IndexStatus } from './types.js';
import { toolPath } from './video.js';
import { destroyImagePool, getImagePool } from './workers/pool.js';
import type { MetaJob, MetaResult } from './workers/image-worker.js';

const WALK_BATCH = 500;
/**
 * Files handed to a worker in one go. A worker only answers once the whole batch
 * is done, and nothing preempts a running batch, so this is also the worst-case
 * wait a browser asking for a thumbnail mid-scan can inherit. Kept small for
 * that reason: the IPC round trip it amortises costs microseconds, while each
 * extra file in the batch can cost a second on a slow disk.
 */
const META_BATCH = 8;

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
  watchIssue: null,
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
  duration_ms: number | null;
  meta_state: number;
}

function buildStatements() {
  const db = getDb();
  return {
    upsert: db.prepare<[WalkRow]>(`
      INSERT INTO photos (rel_path, dir, name, ext, kind, size, mtime_ms, content_key,
                          taken_at, taken_src, meta_state, seen_gen)
      VALUES (@rel_path, @dir, @name, @ext, @kind, @size, @mtime_ms, @content_key,
              @mtime_ms, 'mtime', ${META_PENDING}, @gen)
      ON CONFLICT(rel_path) DO UPDATE SET
        seen_gen    = @gen,
        kind        = @kind,
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
    prewarmRows: db.prepare<[], { id: number; rel_path: string; content_key: string; kind: number; duration_ms: number | null }>(
      `SELECT id, rel_path, content_key, kind, duration_ms FROM photos
       WHERE meta_state <> ${META_FAILED} ORDER BY taken_at DESC`,
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
        duration_ms = @duration_ms,
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
    /**
     * Videos indexed while ffprobe was missing. They were recorded as done —
     * an absent tool says nothing about the file — but done with no dimensions,
     * no duration and a fallback date, which is exactly the state a newly
     * installed ffprobe can fix.
     */
    unprobedVideos: db.prepare<[]>(
      `UPDATE photos SET meta_state = ${META_PENDING}, meta_attempts = 0
       WHERE kind = ${KIND_VIDEO} AND meta_state = ${META_DONE} AND width IS NULL`,
    ),
    /**
     * Videos whose probe failed without killing anything. ffprobe refusing a
     * file it read fine a minute earlier — under load, or while a sync client
     * or antivirus held the freshly written file — is common enough that one
     * failure is no verdict. Each scan tries again until the attempts run out.
     */
    failedVideos: db.prepare<[]>(
      `UPDATE photos SET meta_state = ${META_PENDING}
       WHERE kind = ${KIND_VIDEO} AND meta_state = ${META_FAILED}
         AND meta_attempts < ${MAX_META_ATTEMPTS}`,
    ),
    /** Everything given up on, for an admin asking to try it all again. */
    requeueFailed: db.prepare<[]>(
      `UPDATE photos SET meta_state = ${META_PENDING}, meta_attempts = 0
       WHERE meta_state = ${META_FAILED}`,
    ),
    resetAttempts: db.prepare<[number]>('UPDATE photos SET meta_attempts = 0 WHERE id = ?'),
    markDone: db.prepare<[number]>(`UPDATE photos SET meta_state = ${META_DONE} WHERE id = ?`),
    failedCount: db.prepare<[], { n: number }>(
      `SELECT count(*) AS n FROM photos WHERE meta_state = ${META_FAILED}`,
    ),
    byId: db.prepare<
      [number],
      {
        id: number;
        rel_path: string;
        name: string;
        mtime_ms: number;
        content_key: string;
        kind: number;
        meta_state: number;
        duration_ms: number | null;
      }
    >(
      `SELECT id, rel_path, name, mtime_ms, content_key, kind, meta_state, duration_ms
       FROM photos WHERE id = ?`,
    ),
  };
}

/** Writes one extraction result back to its row. */
function applyResult(r: MetaResult): void {
  statements().applyMeta.run({
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
    duration_ms: r.durationMs,
    // A file that failed to decode is marked done-with-failure so the next
    // scan does not retry it forever.
    meta_state: r.failed ? META_FAILED : META_DONE,
  });
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
  kind: number;
  size: number;
  mtime_ms: number;
  content_key: string;
  gen: number;
}

function kindOf(name: string): number {
  return isSupportedVideo(name) ? KIND_VIDEO : KIND_IMAGE;
}

/**
 * Recursively lists supported photos and videos under `root`, flushing to
 * SQLite in batched transactions so memory stays flat on huge libraries.
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
      if (!isIndexableMedia(entry.name)) continue;

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
        kind: kindOf(entry.name),
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
  const { pending, pendingCount, claim, stuck, retire, reclaimAll } = statements();
  const pool = getImagePool();

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
      if (r) applyResult(r);
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
        markMetaFailed(job.id);
        status.lastError = `Skipped ${relFromAbs(job.absPath)}: could not be read`;
        advance(1);
      })
      .finally(() => {
        inFlight.delete(task);
      });

    inFlight.add(task);
    return true;
  };

  // One worker below the pool size, so a slot stays free for the thumbnail
  // requests a browser is waiting on. Saturating the pool made "urgent" jobs
  // meaningless — they still had to wait for a whole batch to drain.
  //
  // The floor of 1 matters: at 0 the dispatch loop below would spin without ever
  // handing out work.
  const concurrency = Math.max(1, pool.size - 1);
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
  const rows = statements().prewarmRows.all();

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
        await getThumb(absFromRel(row.rel_path), row.content_key, 320, {
          video: row.kind === KIND_VIDEO,
          durationMs: row.duration_ms,
        }).catch((err: unknown) => {
          // A file that kills the renderer is retired here rather than waiting
          // for someone to scroll past it in the gallery.
          if (err instanceof ThumbError && err.fatal) {
            console.warn(`[indexer] ${row.rel_path} killed the thumbnail worker; marking unreadable`);
            markMetaFailed(row.id);
          }
        });
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

/**
 * The generation a scan in progress is stamping its rows with, or null between
 * scans.
 *
 * `scan_gen` in the database only advances once the walk has finished, so it is
 * the *previous* generation for as long as a scan is running. Anything indexed
 * during that window has to read the new generation from here: stamped with the
 * old one, the row would be deleted by the stale sweep the moment the walk ends,
 * and a file that is plainly on disk would vanish from the gallery until the
 * next full scan.
 */
let activeGen: number | null = null;

/** Runs a full sweep. Concurrent calls join the in-progress scan. */
export function scan(): Promise<void> {
  if (scanPromise) return scanPromise;

  cancelSignal = { cancelled: false };
  const signal = cancelSignal;

  scanPromise = (async () => {
    const db = getDb();
    const gen = Number(getMeta('scan_gen') ?? '0') + 1;
    activeGen = gen;

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

      // Queued before the extraction pass rather than after, so installing
      // ffmpeg and restarting is all it takes to fill in what was missing.
      if (await toolPath('ffprobe')) {
        const repaired = statements().unprobedVideos.run().changes;
        if (repaired > 0) {
          console.info(`[indexer] re-reading ${repaired} video(s) now that ffprobe is available`);
        }
        const retried = statements().failedVideos.run().changes;
        if (retried > 0) {
          console.info(`[indexer] retrying ${retried} video(s) that could not be read last time`);
        }
      }

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
      activeGen = null;
      status.scanning = false;
      status.phase = 'idle';
      emitStatus(true);
      scanPromise = null;
    }
  })();

  return scanPromise;
}

function cancelScan(): void {
  cancelSignal.cancelled = true;
}

/* -------------------------------------------------------- incremental fs -- */

/** Indexes or refreshes one file discovered by the watcher. */
async function indexOne(abs: string): Promise<void> {
  if (!isIndexableMedia(abs)) return;

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
    kind: kindOf(rel),
    size: stat.size,
    mtime_ms: Math.round(stat.mtimeMs),
    content_key: contentKey(rel, stat.size, stat.mtimeMs),
    // The generation of the scan in progress if there is one — see {@link activeGen}.
    gen: activeGen ?? Number(getMeta('scan_gen') ?? '0'),
  });

  bumpDataVersion();
}

/**
 * Indexes a file the server has just written itself — an upload — so it appears
 * in the gallery without waiting for the next scan. The watcher would catch it
 * too, but only in `watch` mode; this path works in all three.
 *
 * The extraction pass is scheduled through the same debounce the watcher uses,
 * so a burst of uploads costs one pass rather than one per file.
 */
export async function indexNewFile(abs: string): Promise<void> {
  await indexOne(abs);
  scheduleWatchFlush();
}

/* ---------------------------------------------------------------- repair -- */

export interface RepairResult {
  ok: boolean;
  /** Why the preview still could not be made, when it could not. */
  error: string | null;
}

/**
 * Starts one file over: forgets its cached thumbnails and any verdict against
 * it, reads its metadata again, and renders its grid thumbnail. The answer says
 * whether the preview now exists, not merely that a retry was queued.
 *
 * Returns null for an id that is not in the index.
 */
export async function repairMedia(id: number): Promise<RepairResult | null> {
  const s = statements();
  const row = s.byId.get(id);
  if (!row) return null;

  await deleteThumbs(row.content_key);

  // Claimed like any batch, which keeps a concurrent extraction pass off it.
  s.resetAttempts.run(id);
  s.claim.run(id);

  let abs: string;
  try {
    abs = await realpathWithin(absFromRel(row.rel_path));
  } catch {
    s.failOne.run(id);
    return { ok: false, error: 'The file is no longer on disk' };
  }

  try {
    const [result] = await getImagePool().run([
      { id, absPath: abs, fileName: row.name, mtimeMs: row.mtime_ms },
    ]);
    if (result) applyResult(result);
    else s.failOne.run(id);
  } catch {
    markMetaFailed(id);
    bumpDataVersion();
    return { ok: false, error: 'Reading this file crashed the reader' };
  }
  bumpDataVersion();

  const fresh = s.byId.get(id);
  if (!fresh) return null;
  // A photo libvips cannot read will not thumbnail either. A video still can:
  // its poster comes from ffmpeg, which does not need ffprobe's blessing.
  if (fresh.meta_state === META_FAILED && fresh.kind !== KIND_VIDEO) {
    return { ok: false, error: 'This image could not be read' };
  }

  try {
    await getThumb(abs, fresh.content_key, 320, {
      video: fresh.kind === KIND_VIDEO,
      durationMs: fresh.duration_ms,
    });
  } catch (err) {
    if (err instanceof ThumbError && err.fatal) markMetaFailed(id);
    return { ok: false, error: (err as Error).message };
  }

  // The preview exists, so the file is readable whatever the probe said.
  // Clearing the verdict keeps the thumbnail route from refusing the other sizes.
  if (fresh.meta_state === META_FAILED) {
    s.markDone.run(id);
    bumpDataVersion();
  }
  return { ok: true, error: null };
}

/**
 * Gives every file the index has given up on a fresh set of attempts, and
 * starts reading them. Returns how many were queued.
 */
export function retryFailed(): number {
  const queued = statements().requeueFailed.run().changes;
  if (queued > 0) {
    bumpDataVersion();
    scheduleWatchFlush();
  }
  return queued;
}

/** Files currently marked unreadable, for the settings page. */
export function failedCount(): number {
  return statements().failedCount.get()?.n ?? 0;
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
    // A pass already running may have finished handing out work before these
    // rows were queued, so look again once it is done. Dropping the flush here
    // left an upload that landed mid-scan pending until the next full scan.
    if (status.scanning) {
      scheduleWatchFlush();
      return;
    }
    status.scanning = true;
    status.phase = 'extracting';
    void extractPending()
      .catch(() => {})
      .finally(() => {
        status.scanning = false;
        status.phase = 'idle';
        emitStatus(true);
      });
  }, 2000);
  watchFlushTimer.unref();
}

/** Paths this watcher session could not attach to, and the most recent one. */
let watchErrors = 0;

async function startWatching(): Promise<void> {
  if (watcher) return;

  watchErrors = 0;
  status.watchIssue = null;

  watcher = chokidar.watch(config().photosRoot, {
    ignoreInitial: true,
    followSymlinks: false,
    depth: 20,
    awaitWriteFinish: { stabilityThreshold: 1500, pollInterval: 200 },
    /**
     * chokidar opens a native watch handle for every *file* it walks, not just
     * every directory — so on a library of tens of thousands of files this
     * predicate is what decides how many handles the OS is asked for. Excluding
     * the files we would ignore anyway cuts that down to the media alone, which
     * matters most next to a photo manager's own sidecars and databases.
     *
     * `stats` is absent on the pre-stat call and present on the one that
     * decides whether to watch, so keying the file test on it is safe: an
     * unstatted path is never ignored, and a directory is never mistaken for a
     * file with an unlucky name.
     */
    ignored: (target: string, stats?: { isFile: () => boolean }) => {
      const rel = path.relative(config().photosRoot, target);
      if (rel === '' || rel.startsWith('..')) return false;
      if (rel.split(/[\\/]/).some(isIgnoredDir)) return true;
      return stats?.isFile() === true && !isIndexableMedia(target);
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
    /**
     * Per-path failures, and almost always about one file rather than the
     * watch as a whole: `UNKNOWN` from a OneDrive placeholder or an SMB share,
     * `EMFILE` once a big enough tree exhausts the handle budget. chokidar
     * carries on watching everything else, and a scan still sees these files,
     * so this is a warning about latency — not the error state of the index.
     */
    .on('error', (err) => {
      watchErrors++;
      const message = (err as Error).message;
      console.warn(`[indexer] watcher could not attach: ${message}`);
      status.watchIssue =
        watchErrors === 1 ? message : `${message} (and ${watchErrors - 1} more)`;
      emitStatus();
    });
}

async function stopWatching(): Promise<void> {
  // The warning describes a watcher that no longer exists, so it goes with it —
  // including when the mode changes to one that does not watch at all.
  status.watchIssue = null;
  watchErrors = 0;

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
  await destroyImagePool();
  if (stmts) stmts.releaseAll.run();
}

export { isUnsupportedImage };

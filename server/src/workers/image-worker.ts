import fsp from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import sharp from 'sharp';
import { extractMetadata, type ExtractedMeta } from '../metadata.js';
import { extractPoster } from '../video.js';

export interface MetaJob {
  id: number;
  absPath: string;
  fileName: string;
  mtimeMs: number;
}

export interface MetaResult extends ExtractedMeta {
  id: number;
}

export interface ThumbJob {
  absPath: string;
  /** Final cache path. The parent owns the naming; we just fill it in. */
  dest: string;
  size: number;
  /** Render a poster frame through ffmpeg first, rather than reading pixels directly. */
  video: boolean;
  /** Runtime, when known — it decides how far in the poster frame is taken. */
  durationMs: number | null;
}

export type WorkerRequest =
  | { kind: 'meta'; jobs: MetaJob[] }
  | { kind: 'thumb'; job: ThumbJob };

export type WorkerResult =
  | { kind: 'meta'; results: MetaResult[] }
  /** `error` is null on success; a message when the image simply would not decode. */
  | { kind: 'thumb'; error: string | null };

export interface WorkerEnvelope {
  batchId: number;
  request: WorkerRequest;
}

export interface WorkerReply {
  batchId: number;
  result: WorkerResult;
}

if (typeof process.send !== 'function') {
  throw new Error('image-worker must be run as a forked child process');
}
const send = process.send.bind(process);

// The pool already runs one of these per core. Letting libvips fan out inside
// each one on top of that just thrashes, and its pixel cache is dead weight
// when a scan visits every file exactly once.
sharp.concurrency(1);
sharp.cache(false);

// Never outlive the pool: if the parent goes away, so do we.
process.on('disconnect', () => process.exit(0));

/* ---------------------------------------------------------------- metadata -- */

/** A file that blew up mid-extraction still needs a row, marked failed. */
function failedResult(id: number, mtimeMs: number): MetaResult {
  return {
    id,
    width: null,
    height: null,
    orientation: null,
    takenAt: mtimeMs,
    takenSrc: 'mtime',
    camera: null,
    lens: null,
    iso: null,
    fnum: null,
    exposure: null,
    focal: null,
    gpsLat: null,
    gpsLon: null,
    durationMs: null,
    failed: true,
  };
}

async function runMeta(jobs: MetaJob[]): Promise<MetaResult[]> {
  // Two at a time inside each worker: sharp offloads decoding to libuv, so a
  // little in-process overlap hides that latency without oversubscribing.
  const results: MetaResult[] = new Array(jobs.length);
  let next = 0;

  const runner = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      const job = jobs[i];
      if (!job) return;
      try {
        const meta = await extractMetadata(job.absPath, job.fileName, job.mtimeMs);
        results[i] = { id: job.id, ...meta };
      } catch (err) {
        // extractMetadata is meant to swallow everything; if it ever does not,
        // one file must still not cost the batch.
        console.warn(`image worker: ${job.absPath}: ${(err as Error).message}`);
        results[i] = failedResult(job.id, job.mtimeMs);
      }
    }
  };

  await Promise.all([runner(), runner()]);
  return results;
}

/* -------------------------------------------------------------- thumbnails -- */

async function runThumb(job: ThumbJob): Promise<void> {
  await fsp.mkdir(path.dirname(job.dest), { recursive: true });

  // A video becomes a photo problem the moment ffmpeg hands us a frame: the
  // resize, the format and the cache entry are then all the same as any tile's.
  // ffmpeg applies the display matrix itself, so the JPEG arrives upright and
  // carries no EXIF orientation for the `rotate()` below to act on.
  const source: string | Buffer = job.video
    ? await extractPoster(job.absPath, job.durationMs)
    : job.absPath;

  const buffer = await sharp(source, { failOn: 'none', animated: false })
    // `rotate()` with no argument applies the EXIF orientation and strips it,
    // so the browser never double-rotates.
    .rotate()
    .resize({
      height: job.size,
      width: job.size * 3,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .webp({ quality: job.size >= 1600 ? 82 : 78, effort: 4 })
    .toBuffer();

  // Write to a temp name first: a crash mid-write must never leave a truncated
  // file that later looks like a valid cache hit.
  const tmp = `${job.dest}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await fsp.writeFile(tmp, buffer);
  await fsp.rename(tmp, job.dest).catch(async (err: NodeJS.ErrnoException) => {
    // Another worker won the race; its file is equally valid.
    await fsp.rm(tmp, { force: true });
    if (err.code !== 'EEXIST' && err.code !== 'EPERM') throw err;
  });
}

/* ------------------------------------------------------------------ router -- */

process.on('message', (msg: WorkerEnvelope) => {
  void (async () => {
    if (msg.request.kind === 'meta') {
      const results = await runMeta(msg.request.jobs);
      send({ batchId: msg.batchId, result: { kind: 'meta', results } } satisfies WorkerReply);
      return;
    }

    // An image libvips can report on is an ordinary failure — the caller turns
    // it into a placeholder tile. Only an abort kills us, and the pool sees that.
    let error: string | null = null;
    try {
      await runThumb(msg.request.job);
    } catch (err) {
      error = (err as Error).message;
    }
    send({ batchId: msg.batchId, result: { kind: 'thumb', error } } satisfies WorkerReply);
  })();
});

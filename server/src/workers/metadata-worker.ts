import process from 'node:process';
import sharp from 'sharp';
import { extractMetadata, type ExtractedMeta } from '../metadata.js';

export interface MetaJob {
  id: number;
  absPath: string;
  fileName: string;
  mtimeMs: number;
}

export interface MetaResult extends ExtractedMeta {
  id: number;
}

export interface WorkerRequest {
  batchId: number;
  jobs: MetaJob[];
}

export interface WorkerResponse {
  batchId: number;
  results: MetaResult[];
}

if (typeof process.send !== 'function') {
  throw new Error('metadata-worker must be run as a forked child process');
}
const send = process.send.bind(process);

// The pool already runs one of these per core. Letting libvips fan out inside
// each one on top of that just thrashes, and its pixel cache is dead weight
// when every file is visited exactly once.
sharp.concurrency(1);
sharp.cache(false);

// Never outlive the pool: if the parent goes away, so do we.
process.on('disconnect', () => process.exit(0));

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
    failed: true,
  };
}

process.on('message', (msg: WorkerRequest) => {
  void (async () => {
    // Two at a time inside each worker: sharp offloads decoding to libuv, so a
    // little in-thread overlap hides that latency without oversubscribing.
    const results: MetaResult[] = new Array(msg.jobs.length);
    let next = 0;

    const runner = async () => {
      for (;;) {
        const i = next++;
        const job = msg.jobs[i];
        if (!job) return;
        try {
          const meta = await extractMetadata(job.absPath, job.fileName, job.mtimeMs);
          results[i] = { id: job.id, ...meta };
        } catch (err) {
          // extractMetadata is meant to swallow everything; if it ever does not,
          // one file must still not cost the batch.
          console.warn(`metadata worker: ${job.absPath}: ${(err as Error).message}`);
          results[i] = failedResult(job.id, job.mtimeMs);
        }
      }
    };

    await Promise.all([runner(), runner()]);
    send({ batchId: msg.batchId, results } satisfies WorkerResponse);
  })();
});

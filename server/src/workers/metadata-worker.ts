import { parentPort } from 'node:worker_threads';
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

if (!parentPort) throw new Error('metadata-worker must be run as a worker thread');
const port = parentPort;

port.on('message', (msg: WorkerRequest) => {
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
        const meta = await extractMetadata(job.absPath, job.fileName, job.mtimeMs);
        results[i] = { id: job.id, ...meta };
      }
    };

    await Promise.all([runner(), runner()]);
    port.postMessage({ batchId: msg.batchId, results } satisfies WorkerResponse);
  })();
});

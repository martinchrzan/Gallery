import os from 'node:os';
import { Worker } from 'node:worker_threads';
import type { MetaJob, MetaResult, WorkerRequest, WorkerResponse } from './metadata-worker.js';

/** tsx compiles the worker entry on the fly in dev; prod loads the built .js. */
const RUNNING_FROM_SOURCE = import.meta.url.endsWith('.ts');

const WORKER_URL = new URL(
  RUNNING_FROM_SOURCE ? './metadata-worker.ts' : './metadata-worker.js',
  import.meta.url,
);

interface PendingBatch {
  resolve: (results: MetaResult[]) => void;
  reject: (err: Error) => void;
}

interface Slot {
  worker: Worker;
  busy: boolean;
}

/**
 * A small worker-thread pool for EXIF extraction. Keeping this off the main
 * thread is what lets the HTTP server stay responsive while a large library is
 * being indexed.
 */
export class MetadataPool {
  private readonly slots: Slot[] = [];
  private readonly pending = new Map<number, PendingBatch>();
  private readonly queue: { jobs: MetaJob[]; batch: PendingBatch }[] = [];
  private nextBatchId = 1;
  private destroyed = false;

  constructor(size = defaultPoolSize()) {
    for (let i = 0; i < size; i++) this.slots.push(this.spawn());
  }

  get size(): number {
    return this.slots.length;
  }

  private spawn(): Slot {
    const worker = new Worker(WORKER_URL, {
      execArgv: RUNNING_FROM_SOURCE ? ['--import', 'tsx'] : [],
    });
    const slot: Slot = { worker, busy: false };

    worker.on('message', (msg: WorkerResponse) => {
      const batch = this.pending.get(msg.batchId);
      this.pending.delete(msg.batchId);
      slot.busy = false;
      batch?.resolve(msg.results);
      this.drain();
    });

    worker.on('error', (err) => {
      slot.busy = false;
      // A crashed worker takes its in-flight batch with it. Fail that batch and
      // replace the thread so the scan can carry on.
      for (const [id, batch] of this.pending) {
        this.pending.delete(id);
        batch.reject(err);
        break;
      }
      if (!this.destroyed) {
        const idx = this.slots.indexOf(slot);
        if (idx !== -1) this.slots[idx] = this.spawn();
      }
      this.drain();
    });

    worker.unref();
    return slot;
  }

  /** Extracts metadata for a batch of files on the first free worker. */
  run(jobs: MetaJob[]): Promise<MetaResult[]> {
    if (jobs.length === 0) return Promise.resolve([]);
    if (this.destroyed) return Promise.reject(new Error('Metadata pool has been destroyed'));

    return new Promise<MetaResult[]>((resolve, reject) => {
      this.queue.push({ jobs, batch: { resolve, reject } });
      this.drain();
    });
  }

  private drain(): void {
    while (this.queue.length > 0) {
      const slot = this.slots.find((s) => !s.busy);
      if (!slot) return;

      const next = this.queue.shift();
      if (!next) return;

      const batchId = this.nextBatchId++;
      slot.busy = true;
      this.pending.set(batchId, next.batch);
      slot.worker.postMessage({ batchId, jobs: next.jobs } satisfies WorkerRequest);
    }
  }

  async destroy(): Promise<void> {
    this.destroyed = true;
    await Promise.all(this.slots.map((slot) => slot.worker.terminate()));
    this.slots.length = 0;
  }
}

function defaultPoolSize(): number {
  const cpus = os.cpus().length || 4;
  // Leave a core for the HTTP server and sharp's own thread pool.
  return Math.max(1, Math.min(6, cpus - 1));
}

let pool: MetadataPool | null = null;

export function getMetadataPool(): MetadataPool {
  if (!pool) pool = new MetadataPool();
  return pool;
}

export async function destroyMetadataPool(): Promise<void> {
  if (pool) {
    await pool.destroy();
    pool = null;
  }
}

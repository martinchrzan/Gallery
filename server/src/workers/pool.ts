import { fork, type ChildProcess } from 'node:child_process';
import os from 'node:os';
import url from 'node:url';
import type { MetaJob, MetaResult, WorkerRequest, WorkerResponse } from './metadata-worker.js';

/** tsx compiles the worker entry on the fly in dev; prod loads the built .js. */
const RUNNING_FROM_SOURCE = import.meta.url.endsWith('.ts');

const WORKER_PATH = url.fileURLToPath(
  new URL(
    RUNNING_FROM_SOURCE ? './metadata-worker.ts' : './metadata-worker.js',
    import.meta.url,
  ),
);

interface PendingBatch {
  resolve: (results: MetaResult[]) => void;
  reject: (err: Error) => void;
}

interface Slot {
  child: ChildProcess;
  /** The batch this worker is chewing on, or null when idle. */
  batchId: number | null;
  /** Set once the child has died, so `error` and `exit` only retire it once. */
  dead: boolean;
}

/**
 * A small pool of child processes for EXIF extraction.
 *
 * Child processes, not worker threads: libvips decodes untrusted image bytes,
 * and a malformed file can make it abort rather than return an error. Threads
 * share the process, so such an abort would take the whole server with it —
 * on Windows it surfaces as exit code 3221226505 (0xC0000409, __fastfail).
 * Out of process, the blast radius is one child, which the pool replaces.
 *
 * Keeping the work off the main thread is also what lets the HTTP server stay
 * responsive while a large library is being indexed.
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
    const child = fork(WORKER_PATH, [], {
      execArgv: RUNNING_FROM_SOURCE ? ['--import', 'tsx'] : [],
      // Let the child's own diagnostics (and libvips' warnings) reach our log.
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });
    const slot: Slot = { child, batchId: null, dead: false };

    child.on('message', (msg: WorkerResponse) => {
      const batch = this.take(slot);
      batch?.resolve(msg.results);
      this.drain();
    });

    // A child that dies mid-batch takes that batch with it. Fail the batch so
    // the caller can decide what to do with those files, then replace the child
    // so the scan carries on.
    const retire = (err: Error): void => {
      if (slot.dead) return;
      slot.dead = true;

      this.take(slot)?.reject(err);

      if (!this.destroyed) {
        const idx = this.slots.indexOf(slot);
        if (idx !== -1) this.slots[idx] = this.spawn();
      }
      this.drain();
    };

    child.on('error', retire);
    child.on('exit', (code, signal) => {
      if (this.destroyed) return;
      retire(
        new Error(
          `metadata worker exited unexpectedly (code ${code ?? 'null'}, signal ${signal ?? 'none'})`,
        ),
      );
    });

    // The pool must never be the reason the process stays alive.
    child.unref();
    child.channel?.unref();
    return slot;
  }

  /** Detaches the batch a slot is holding, marking the slot idle. */
  private take(slot: Slot): PendingBatch | undefined {
    if (slot.batchId === null) return undefined;
    const batch = this.pending.get(slot.batchId);
    this.pending.delete(slot.batchId);
    slot.batchId = null;
    return batch;
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
      const slot = this.slots.find((s) => !s.dead && s.batchId === null);
      if (!slot) return;

      const next = this.queue.shift();
      if (!next) return;

      const batchId = this.nextBatchId++;
      slot.batchId = batchId;
      this.pending.set(batchId, next.batch);
      slot.child.send({ batchId, jobs: next.jobs } satisfies WorkerRequest, (err) => {
        // The channel closed between `find` and `send` — the exit handler has
        // not fired yet, so fail the batch here.
        if (err) {
          if (slot.dead) return;
          slot.dead = true;
          this.take(slot)?.reject(err);
          this.drain();
        }
      });
    }
  }

  async destroy(): Promise<void> {
    this.destroyed = true;
    const slots = [...this.slots];
    this.slots.length = 0;

    await Promise.all(
      slots.map(
        (slot) =>
          new Promise<void>((resolve) => {
            if (slot.child.exitCode !== null || slot.child.signalCode !== null) return resolve();
            slot.child.once('exit', () => resolve());
            slot.child.kill();
          }),
      ),
    );
  }
}

function defaultPoolSize(): number {
  const cpus = os.cpus().length || 4;
  // One process per worker costs real memory (sharp + libvips is ~60 MB each),
  // so this is capped tighter than a thread pool would be.
  return Math.max(1, Math.min(4, cpus - 1));
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

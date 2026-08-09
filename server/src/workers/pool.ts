import { fork, type ChildProcess } from 'node:child_process';
import os from 'node:os';
import url from 'node:url';
import type {
  MetaJob,
  MetaResult,
  ThumbJob,
  WorkerEnvelope,
  WorkerReply,
  WorkerRequest,
  WorkerResult,
} from './image-worker.js';

/** tsx compiles the worker entry on the fly in dev; prod loads the built .js. */
const RUNNING_FROM_SOURCE = import.meta.url.endsWith('.ts');

const WORKER_PATH = url.fileURLToPath(
  new URL(RUNNING_FROM_SOURCE ? './image-worker.ts' : './image-worker.js', import.meta.url),
);

/** Thrown when the worker holding a job died instead of answering. */
export class WorkerCrashError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkerCrashError';
  }
}

interface PendingTask {
  resolve: (result: WorkerResult) => void;
  reject: (err: Error) => void;
}

interface QueueEntry {
  request: WorkerRequest;
  task: PendingTask;
}

interface Slot {
  child: ChildProcess;
  /** The job this worker is chewing on, or null when idle. */
  batchId: number | null;
  /** Set once the child has died, so `error` and `exit` only retire it once. */
  dead: boolean;
}

/**
 * A small pool of child processes for everything that touches image bytes:
 * EXIF extraction during a scan, and thumbnail rendering on demand.
 *
 * Child processes, not worker threads: libvips decodes untrusted image bytes,
 * and a malformed file can make it abort rather than return an error. Threads
 * share the process, so such an abort would take the whole server with it —
 * on Windows it surfaces as exit code 3221226505 (0xC0000409, __fastfail).
 * Out of process, the abort becomes an ordinary rejected promise, which is what
 * lets a bad photo end up as a placeholder tile instead of downtime.
 *
 * Keeping the work out of the main process is also what lets the HTTP server
 * stay responsive while a large library is being indexed.
 */
export class ImagePool {
  private readonly slots: Slot[] = [];
  private readonly pending = new Map<number, PendingTask>();
  private readonly queue: QueueEntry[] = [];
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

    child.on('message', (msg: WorkerReply) => {
      const task = this.take(slot);
      task?.resolve(msg.result);
      this.drain();
    });

    // A child that dies mid-job takes that job with it. Fail the job so the
    // caller can decide what to do with the file, then replace the child so the
    // next request has somewhere to go.
    const retire = (err: Error): void => {
      if (slot.dead) return;
      slot.dead = true;

      this.take(slot)?.reject(new WorkerCrashError(err.message));

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
          `image worker exited unexpectedly (code ${code ?? 'null'}, signal ${signal ?? 'none'})`,
        ),
      );
    });

    // The pool must never be the reason the process stays alive.
    child.unref();
    child.channel?.unref();
    return slot;
  }

  /** Detaches the job a slot is holding, marking the slot idle. */
  private take(slot: Slot): PendingTask | undefined {
    if (slot.batchId === null) return undefined;
    const task = this.pending.get(slot.batchId);
    this.pending.delete(slot.batchId);
    slot.batchId = null;
    return task;
  }

  /**
   * Queues one request. `urgent` jumps the line — a browser waiting on a
   * thumbnail should not sit behind a scan's worth of metadata batches.
   */
  private submit(request: WorkerRequest, urgent: boolean): Promise<WorkerResult> {
    if (this.destroyed) return Promise.reject(new Error('Image pool has been destroyed'));

    return new Promise<WorkerResult>((resolve, reject) => {
      const entry: QueueEntry = { request, task: { resolve, reject } };
      if (urgent) this.queue.unshift(entry);
      else this.queue.push(entry);
      this.drain();
    });
  }

  /** Extracts metadata for a batch of files on the first free worker. */
  async run(jobs: MetaJob[]): Promise<MetaResult[]> {
    if (jobs.length === 0) return [];
    const result = await this.submit({ kind: 'meta', jobs }, false);
    if (result.kind !== 'meta') throw new Error('Image worker answered the wrong request');
    return result.results;
  }

  /**
   * Renders one thumbnail. Rejects with a {@link WorkerCrashError} when the file
   * killed the worker, and with a plain Error when libvips merely refused it.
   */
  async renderThumb(job: ThumbJob): Promise<void> {
    const result = await this.submit({ kind: 'thumb', job }, true);
    if (result.kind !== 'thumb') throw new Error('Image worker answered the wrong request');
    if (result.error !== null) throw new Error(result.error);
  }

  private drain(): void {
    while (this.queue.length > 0) {
      const slot = this.slots.find((s) => !s.dead && s.batchId === null);
      if (!slot) return;

      const next = this.queue.shift();
      if (!next) return;

      const batchId = this.nextBatchId++;
      slot.batchId = batchId;
      this.pending.set(batchId, next.task);
      slot.child.send({ batchId, request: next.request } satisfies WorkerEnvelope, (err) => {
        // The channel closed between `find` and `send` — the exit handler has
        // not fired yet, so fail the job here.
        if (err) {
          if (slot.dead) return;
          slot.dead = true;
          this.take(slot)?.reject(new WorkerCrashError(err.message));
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

let pool: ImagePool | null = null;

export function getImagePool(): ImagePool {
  if (!pool) pool = new ImagePool();
  return pool;
}

export async function destroyImagePool(): Promise<void> {
  if (pool) {
    await pool.destroy();
    pool = null;
  }
}

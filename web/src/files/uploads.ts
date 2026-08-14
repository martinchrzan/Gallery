/**
 * The upload queue.
 *
 * Files go up one at a time, each as a series of chunks at explicit offsets —
 * see `server/src/uploads.ts` for why the transfer is split at all. What this
 * side adds is the behaviour a phone needs:
 *
 * - **Retries.** A failed chunk is re-sent up to four times with a widening
 *   delay. Only the chunk is repeated, never the file, so a lift or a tunnel
 *   costs seconds rather than a 2 GB restart.
 * - **A chunk size that follows the connection.** Starting at the server's
 *   suggestion, it doubles while chunks land quickly and halves when one drags,
 *   because the ceiling that matters is a proxy's request timeout, not its body
 *   limit: on a slow uplink a large chunk can exceed the former long before it
 *   approaches the latter.
 * - **A screen that stays awake.** Android suspends a backgrounded tab, which
 *   would stall the queue mid-file.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { api, RequestError, uploadChunk } from '../api/client';

/** Never go below this: the per-chunk round trip stops being worth it. */
const MIN_CHUNK = 256 * 1024;
/** A chunk slower than this shrinks the next one. */
const SLOW_MS = 20_000;
/** …and one faster than this grows it. */
const FAST_MS = 5_000;
const CHUNK_ATTEMPTS = 4;
/** Consecutive replies that move the offset nowhere before we give up. */
const MAX_STALLS = 5;

export type UploadState = 'queued' | 'uploading' | 'done' | 'error' | 'canceled';

export interface UploadTask {
  key: string;
  name: string;
  /** Destination folder, captured when the file was picked — browsing on does
   *  not redirect an upload that is already under way. */
  dir: string;
  size: number;
  sent: number;
  state: UploadState;
  error: string | null;
}

export interface Uploader {
  tasks: UploadTask[];
  /** True while anything is queued or in flight. */
  active: boolean;
  /** Bytes sent and bytes total, across everything not yet finished. */
  progress: { sent: number; total: number; done: number; failed: number };
  add: (files: File[], dir: string) => void;
  cancel: (key: string) => void;
  cancelAll: () => void;
  /** Forgets everything that has finished, one way or the other. */
  clearFinished: () => void;
}

/** Cancellation is not a failure; it travels as its own type so it reads as one. */
class Cancelled extends Error {
  constructor() {
    super('Canceled');
  }
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Statuses that mean "not now" rather than "not ever".
 *
 * 409 is the interesting one: a chunk whose offset the server can resolve comes
 * back as progress rather than as an error, so a 409 that reaches here is the
 * server still writing the previous attempt — which is exactly what a retried
 * chunk after a dropped connection runs into.
 */
const RETRYABLE = new Set([408, 409, 425, 429]);

/** A 4xx that is about this request, not about the network, will never succeed. */
function permanent(err: unknown): boolean {
  return (
    err instanceof RequestError &&
    err.status >= 400 &&
    err.status < 500 &&
    !RETRYABLE.has(err.status)
  );
}

function nextChunkSize(current: number, elapsedMs: number, max: number): number {
  if (elapsedMs < FAST_MS) return Math.min(max, current * 2);
  if (elapsedMs > SLOW_MS) return Math.max(MIN_CHUNK, Math.round(current / 2));
  return current;
}

let nextKey = 0;

export function useUploader(onIdle: (result: { uploaded: number; failed: number }) => void): Uploader {
  const [tasks, setTasks] = useState<UploadTask[]>([]);

  // The queue's own state lives in refs: it has to survive re-renders untouched,
  // and the run loop reads it between awaits, where a captured state value would
  // already be stale.
  const pending = useRef(new Map<string, { file: File; dir: string }>());
  const queue = useRef<string[]>([]);
  const canceled = useRef(new Set<string>());
  const aborters = useRef(new Map<string, AbortController>());
  const running = useRef(false);

  const idleRef = useRef(onIdle);
  idleRef.current = onIdle;

  const patch = useCallback((key: string, change: Partial<UploadTask>): void => {
    setTasks((prev) => prev.map((task) => (task.key === key ? { ...task, ...change } : task)));
  }, []);

  const pump = useCallback(async (): Promise<void> => {
    if (running.current) return;
    running.current = true;

    let uploaded = 0;
    let failed = 0;

    try {
      for (;;) {
        const key = queue.current.shift();
        if (key === undefined) break;

        const item = pending.current.get(key);
        pending.current.delete(key);
        if (!item) continue;

        if (canceled.current.has(key)) {
          patch(key, { state: 'canceled' });
          continue;
        }

        const controller = new AbortController();
        aborters.current.set(key, controller);
        patch(key, { state: 'uploading' });

        try {
          await sendFile(item.file, item.dir, controller.signal, {
            isCanceled: () => canceled.current.has(key),
            onProgress: (sent) => patch(key, { sent }),
          });
          patch(key, { state: 'done', sent: item.file.size, error: null });
          uploaded++;
        } catch (err) {
          if (err instanceof Cancelled || canceled.current.has(key)) {
            patch(key, { state: 'canceled' });
          } else {
            patch(key, { state: 'error', error: (err as Error).message });
            failed++;
          }
        } finally {
          aborters.current.delete(key);
        }
      }
    } finally {
      running.current = false;
    }

    if (uploaded > 0 || failed > 0) idleRef.current({ uploaded, failed });
  }, [patch]);

  const add = useCallback(
    (files: File[], dir: string): void => {
      if (files.length === 0) return;

      const added: UploadTask[] = [];
      for (const file of files) {
        const key = `u${nextKey++}`;
        pending.current.set(key, { file, dir });
        queue.current.push(key);
        added.push({
          key,
          name: file.name,
          dir,
          size: file.size,
          sent: 0,
          state: 'queued',
          error: null,
        });
      }

      setTasks((prev) => [...prev, ...added]);
      void pump();
    },
    [pump],
  );

  const cancel = useCallback(
    (key: string): void => {
      canceled.current.add(key);
      // Cuts a chunk that is already in flight, so a cancel on a big video is
      // immediate rather than waiting for several megabytes to finish.
      aborters.current.get(key)?.abort();
      patch(key, { state: 'canceled' });
    },
    [patch],
  );

  const cancelAll = useCallback((): void => {
    // Taken from the queue's own record rather than from the task list, so that
    // the state updater below stays a pure mapping. Between them the two cover
    // everything still in play: what is waiting, and the one in flight.
    for (const key of [...queue.current, ...aborters.current.keys()]) {
      canceled.current.add(key);
      aborters.current.get(key)?.abort();
    }

    setTasks((prev) =>
      prev.map((task) =>
        task.state === 'queued' || task.state === 'uploading'
          ? { ...task, state: 'canceled' as const }
          : task,
      ),
    );
  }, []);

  const clearFinished = useCallback((): void => {
    setTasks((prev) => prev.filter((task) => task.state === 'queued' || task.state === 'uploading'));
  }, []);

  const active = tasks.some((task) => task.state === 'queued' || task.state === 'uploading');

  /* Warn before a reload throws away a transfer, and keep the screen — and so
     the tab — awake while one is running. Both are undone the moment the queue
     drains, so an idle tab is left alone. */
  useEffect(() => {
    if (!active) return;

    const warn = (event: BeforeUnloadEvent): void => event.preventDefault();
    window.addEventListener('beforeunload', warn);

    const wakeLock = (
      navigator as Navigator & {
        wakeLock?: { request: (type: 'screen') => Promise<{ release: () => Promise<void> }> };
      }
    ).wakeLock;

    let sentinel: { release: () => Promise<void> } | null = null;
    let released = false;

    const acquire = (): void => {
      if (!wakeLock || sentinel || document.visibilityState !== 'visible') return;
      void wakeLock
        .request('screen')
        .then((lock) => {
          // The queue may have drained while the request was in the air.
          if (released) return void lock.release().catch(() => {});
          sentinel = lock;
        })
        .catch(() => {
          // Denied, unsupported, or the tab is not visible. Uploading works
          // regardless; the screen may just sleep.
        });
    };

    // Android drops the lock whenever the tab hides, so it is taken again on
    // the way back rather than only once at the start.
    const onVisible = (): void => acquire();
    document.addEventListener('visibilitychange', onVisible);
    acquire();

    return () => {
      released = true;
      window.removeEventListener('beforeunload', warn);
      document.removeEventListener('visibilitychange', onVisible);
      void sentinel?.release().catch(() => {});
    };
  }, [active]);

  /* A file that failed or was canceled leaves the totals entirely, bytes and
     size alike. Counting what it managed to send against a total that no longer
     includes its size is what would put the overall figure above 100%. */
  const progress = tasks.reduce(
    (sum, task) => {
      const dropped = task.state === 'canceled' || task.state === 'error';
      return {
        sent: sum.sent + (dropped ? 0 : task.state === 'done' ? task.size : task.sent),
        total: sum.total + (dropped ? 0 : task.size),
        done: sum.done + (task.state === 'done' ? 1 : 0),
        failed: sum.failed + (task.state === 'error' ? 1 : 0),
      };
    },
    { sent: 0, total: 0, done: 0, failed: 0 },
  );

  return { tasks, active, progress, add, cancel, cancelAll, clearFinished };
}

/* ------------------------------------------------------------ one file -- */

interface SendHooks {
  isCanceled: () => boolean;
  onProgress: (sent: number) => void;
}

async function sendFile(
  file: File,
  dir: string,
  signal: AbortSignal,
  hooks: SendHooks,
): Promise<void> {
  const session = await api.uploadInit({ path: dir, name: file.name, size: file.size });

  let chunkSize = Math.max(MIN_CHUNK, Math.min(session.chunkSize, session.maxChunkSize));
  let offset = session.received;
  let stalls = 0;

  try {
    // An empty file has no chunks at all, but still has to be finished.
    while (offset < file.size) {
      if (hooks.isCanceled()) throw new Cancelled();

      const end = Math.min(offset + chunkSize, file.size);
      const started = performance.now();
      const received = await sendChunk(session.uploadId, offset, file.slice(offset, end), signal, hooks);
      const elapsed = performance.now() - started;

      if (received <= offset) {
        // The server re-reported an offset we have already passed, or an
        // earlier one after rolling back a torn chunk. Resume from whatever it
        // says, and give up if that stops moving at all.
        if (++stalls >= MAX_STALLS) throw new Error('The upload stopped making progress');
        offset = received;
        continue;
      }

      stalls = 0;
      offset = received;
      hooks.onProgress(offset);
      chunkSize = nextChunkSize(chunkSize, elapsed, session.maxChunkSize);
    }

    // Worth retrying on its own: every byte is already on the server, and
    // losing the file to one dropped request at the last step would be absurd.
    await retrying(() => api.uploadFinish(session.uploadId), hooks);
  } catch (err) {
    // Release the staging file rather than leaving it for the server's sweeper.
    void api.uploadAbort(session.uploadId).catch(() => {});
    throw err;
  }
}

const sendChunk = (
  uploadId: string,
  offset: number,
  chunk: Blob,
  signal: AbortSignal,
  hooks: SendHooks,
): Promise<number> => retrying(() => uploadChunk(uploadId, offset, chunk, signal), hooks);

/** Runs `attempt` until it works, it is refused outright, or the tries run out. */
async function retrying<T>(attempt: () => Promise<T>, hooks: SendHooks): Promise<T> {
  let last: Error = new Error('Upload failed');

  for (let tries = 0; tries < CHUNK_ATTEMPTS; tries++) {
    if (hooks.isCanceled()) throw new Cancelled();

    try {
      return await attempt();
    } catch (err) {
      if (hooks.isCanceled()) throw new Cancelled();
      if (permanent(err)) throw err;
      last = err as Error;
      // 1s, 2s, 4s: long enough for a handover between cells to settle, short
      // enough that a transfer does not visibly stall on one bad chunk.
      await delay(1000 * 2 ** tries);
    }
  }

  throw last;
}

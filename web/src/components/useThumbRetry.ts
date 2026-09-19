import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api/client';

/**
 * How long a tile waits before asking for a failed thumbnail once more.
 *
 * A failure is often a moment rather than a verdict: a video that has just been
 * uploaded can be asked for before the indexer has read it, and ffmpeg can trip
 * over a file that something else briefly holds open. One quiet retry fixes
 * those without anyone noticing there was a problem.
 */
const AUTO_RETRY_MS = 4000;
const AUTO_RETRIES = 1;

export type ThumbState = 'loading' | 'loaded' | 'error';

export interface ThumbRetry {
  state: ThumbState;
  /** Feed to `thumbUrl` so each retry is a fresh request. */
  attempt: number;
  onLoad: () => void;
  onError: () => void;
  /** True while a manual repair is running on the server. */
  repairing: boolean;
  /** Why the last manual repair did not produce a preview. */
  repairError: string | null;
  /** Asks the server to re-read the file and render it again. Admin-only. */
  repair: () => void;
}

export function useThumbRetry(id: number | null): ThumbRetry {
  const [state, setState] = useState<ThumbState>('loading');
  const [attempt, setAttempt] = useState(0);
  const [repairing, setRepairing] = useState(false);
  const [repairError, setRepairError] = useState<string | null>(null);

  const autoRetries = useRef(0);
  const timer = useRef<number | undefined>(undefined);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      window.clearTimeout(timer.current);
    };
  }, []);

  const onLoad = useCallback(() => setState('loaded'), []);

  const onError = useCallback(() => {
    if (autoRetries.current < AUTO_RETRIES) {
      autoRetries.current++;
      // Hidden while waiting, rather than flashing the broken tile first.
      timer.current = window.setTimeout(() => {
        if (!mounted.current) return;
        setAttempt((n) => n + 1);
      }, AUTO_RETRY_MS);
      return;
    }
    setState('error');
  }, []);

  const repair = useCallback(() => {
    if (id === null) return;
    setRepairing(true);
    setRepairError(null);
    api
      .repairMedia(id)
      .then((result) => {
        if (!mounted.current) return;
        if (result.ok) {
          setState('loading');
          setAttempt((n) => n + 1);
        } else {
          setRepairError(result.error ?? 'The preview still could not be made');
        }
      })
      .catch((err: Error) => mounted.current && setRepairError(err.message))
      .finally(() => mounted.current && setRepairing(false));
  }, [id]);

  return { state, attempt, onLoad, onError, repairing, repairError, repair };
}

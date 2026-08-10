import { useCallback, useEffect, useRef, useState } from 'react';
import type { IndexStatus } from '@shared';

export interface Size {
  width: number;
  height: number;
}

/**
 * Live size of an element, tracked with ResizeObserver.
 *
 * Takes the element as *state* rather than a ref on purpose: a view that
 * renders a loading placeholder first would otherwise run this effect while the
 * ref is still null and never observe anything once the real node appeared.
 * Pass the setter straight to `ref={setNode}`.
 */
export function useElementSize(element: HTMLElement | null): Size {
  const [size, setSize] = useState<Size>({ width: 0, height: 0 });

  useEffect(() => {
    if (!element) {
      setSize({ width: 0, height: 0 });
      return;
    }

    // clientWidth/Height exclude the scrollbar, which is what layout must use.
    const measure = (): void =>
      setSize((prev) =>
        prev.width === element.clientWidth && prev.height === element.clientHeight
          ? prev
          : { width: element.clientWidth, height: element.clientHeight },
      );

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);

  return size;
}

/**
 * Live indexing progress from the server's SSE stream, with automatic
 * reconnection when the server restarts during development.
 *
 * The stream is admin-only. `enabled` exists so a viewer does not sit in a
 * three-second reconnect loop against an endpoint that will always 401.
 */
export function useIndexStatus(enabled = true): IndexStatus | null {
  const [status, setStatus] = useState<IndexStatus | null>(null);

  useEffect(() => {
    if (!enabled) {
      setStatus(null);
      return;
    }

    let source: EventSource | null = null;
    let retry: number | undefined;
    let closed = false;

    const connect = (): void => {
      if (closed) return;
      source = new EventSource('/api/index/events');

      source.onmessage = (event) => {
        try {
          setStatus(JSON.parse(event.data) as IndexStatus);
        } catch {
          // Ignore a malformed frame rather than tearing down the stream.
        }
      };

      source.onerror = () => {
        source?.close();
        if (!closed) retry = window.setTimeout(connect, 3000);
      };
    };

    connect();
    return () => {
      closed = true;
      window.clearTimeout(retry);
      source?.close();
    };
  }, [enabled]);

  return status;
}

/** Marks the throwaway history entry an overlay parks on. */
const OVERLAY_MARK = '__overlay';
/**
 * True while a `history.back()` we issued ourselves is in flight, so the
 * popstate it produces is not mistaken for the user pressing Back.
 * Module-level because only one overlay is ever open at a time.
 */
let unwinding = false;

/**
 * Makes the system Back gesture close an overlay instead of leaving the app.
 *
 * Android's hardware Back is the way out of a full-screen view on a phone, and
 * a web app that ignores it drops the user onto whatever preceded the gallery.
 * So an open overlay parks on a throwaway history entry: Back pops that entry,
 * and the popstate closes the overlay while the app stays put.
 *
 * Closing any other way (Esc, the close button, a tap on the backdrop) unwinds
 * that entry again on the way out — otherwise it lingers on the stack and the
 * next Back press would replay the overlay instead of going anywhere.
 */
export function useCloseOnBack(close: () => void): void {
  // Read through a ref: the caller's handler is usually a fresh closure each
  // render, and re-running this effect would churn the history stack.
  const closeRef = useRef(close);
  closeRef.current = close;

  useEffect(() => {
    // Keep whatever the router put here — it tracks its own position in `state`.
    window.history.pushState({ ...window.history.state, [OVERLAY_MARK]: true }, '');

    const onPop = (): void => {
      if (unwinding) {
        unwinding = false;
        return;
      }
      closeRef.current();
    };

    window.addEventListener('popstate', onPop);
    return () => {
      window.removeEventListener('popstate', onPop);
      // Already popped when Back is what closed us; only unwind if it is still there.
      if ((window.history.state as Record<string, unknown> | null)?.[OVERLAY_MARK]) {
        unwinding = true;
        window.history.back();
      }
    };
  }, []);
}

/** Transient status message shown in the bottom toast. */
export function useToast(): [
  { message: string; error: boolean } | null,
  (message: string, error?: boolean) => void,
] {
  const [toast, setToast] = useState<{ message: string; error: boolean } | null>(null);
  const timer = useRef<number | undefined>(undefined);

  // Stable identity: callers pass this down as a prop, and a fresh function on
  // every render would invalidate their effect dependencies.
  const show = useCallback((message: string, error = false): void => {
    window.clearTimeout(timer.current);
    setToast({ message, error });
    timer.current = window.setTimeout(() => setToast(null), error ? 6000 : 2800);
  }, []);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  return [toast, show];
}

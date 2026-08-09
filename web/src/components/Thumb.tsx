import { memo, useState } from 'react';
import { thumbUrl } from '../api/client';

interface ThumbProps {
  id: number;
  /** Rendered box, in CSS pixels. */
  x: number;
  y: number;
  width: number;
  height: number;
  onOpen: () => void;
  label?: string;
}

/**
 * One grid tile. The virtualiser only mounts tiles near the viewport, so
 * mounting *is* the "first seen" signal — no IntersectionObserver needed, and
 * unmounting lets the browser cancel a still-loading request.
 */
function ThumbImpl({ id, x, y, width, height, onOpen, label }: ThumbProps): React.ReactElement {
  const [state, setState] = useState<'loading' | 'loaded' | 'error'>('loading');

  return (
    <div
      className="thumb"
      style={{
        transform: `translate3d(${x}px, ${y}px, 0)`,
        width: `${width}px`,
        height: `${height}px`,
      }}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onOpen();
        }
      }}
      role="button"
      tabIndex={-1}
      aria-label={label ?? 'Open photo'}
    >
      {state === 'error' ? (
        <div className="thumb-broken" title="This image could not be rendered">
          ⚠
        </div>
      ) : (
        <img
          src={thumbUrl(id, 320)}
          // The 640px variant only downloads on HiDPI screens, where it is
          // actually needed — no wasted bytes on a normal display.
          srcSet={`${thumbUrl(id, 320)} 1x, ${thumbUrl(id, 640)} 2x`}
          className={state === 'loaded' ? 'loaded' : undefined}
          alt=""
          draggable={false}
          decoding="async"
          onLoad={() => setState('loaded')}
          onError={() => setState('error')}
        />
      )}
    </div>
  );
}

export const Thumb = memo(ThumbImpl);

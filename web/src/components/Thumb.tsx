import { memo, useState } from 'react';
import { thumbUrl } from '../api/client';
import { formatDuration } from '../lib/format';
import { IconPlay, IconVideo } from './icons';

interface ThumbProps {
  id: number;
  /** Rendered box, in CSS pixels. */
  x: number;
  y: number;
  width: number;
  height: number;
  onOpen: () => void;
  label?: string;
  /** Draws the play badge and, when known, the runtime. */
  video?: boolean;
  /** Runtime in seconds; 0 or absent hides the time from the badge. */
  duration?: number;
}

/**
 * One grid tile. The virtualiser only mounts tiles near the viewport, so
 * mounting *is* the "first seen" signal — no IntersectionObserver needed, and
 * unmounting lets the browser cancel a still-loading request.
 */
function ThumbImpl({
  id,
  x,
  y,
  width,
  height,
  onOpen,
  label,
  video = false,
  duration = 0,
}: ThumbProps): React.ReactElement {
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
      aria-label={label ?? (video ? 'Play video' : 'Open photo')}
    >
      {state === 'error' ? (
        // A video with no poster is the ordinary state on a server without
        // ffmpeg, not a broken file — so it gets a film icon and stays
        // openable, where a photo that will not render gets a warning.
        <div
          className="thumb-broken"
          title={video ? 'No preview for this video' : 'This image could not be rendered'}
        >
          {video ? <IconVideo size={22} /> : '⚠'}
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

      {/* A poster frame is indistinguishable from a photo without this. */}
      {video && (
        <div className="thumb-video">
          <IconPlay size={10} />
          {duration > 0 && <span>{formatDuration(duration)}</span>}
        </div>
      )}
    </div>
  );
}

export const Thumb = memo(ThumbImpl);

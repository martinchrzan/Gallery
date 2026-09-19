import { memo } from 'react';
import { thumbUrl } from '../api/client';
import { formatDuration } from '../lib/format';
import { IconPlay, IconRefresh, IconVideo } from './icons';
import { useThumbRetry } from './useThumbRetry';

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
  /** Offers a button on a broken tile that regenerates it. Admins only. */
  canRepair?: boolean;
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
  canRepair = false,
}: ThumbProps): React.ReactElement {
  const retry = useThumbRetry(id);
  const { state, attempt } = retry;

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
          title={
            retry.repairError ??
            (video ? 'No preview for this video' : 'This image could not be rendered')
          }
        >
          {video ? <IconVideo size={22} /> : '⚠'}
          {canRepair && (
            <button
              className="thumb-repair"
              disabled={retry.repairing}
              title="Try to make the preview again"
              aria-label="Retry preview"
              onClick={(event) => {
                // The tile itself opens the viewer; this button must not.
                event.stopPropagation();
                retry.repair();
              }}
              onKeyDown={(event) => event.stopPropagation()}
            >
              <IconRefresh size={13} className={retry.repairing ? 'spin' : undefined} />
              <span>{retry.repairing ? 'Retrying…' : retry.repairError ? 'Failed' : 'Retry'}</span>
            </button>
          )}
        </div>
      ) : (
        <img
          // Keyed on the attempt so a retry is a new element: the old one's
          // failed load cannot fire late and knock the new one back to broken.
          key={attempt}
          src={thumbUrl(id, 320, attempt)}
          // The 640px variant only downloads on HiDPI screens, where it is
          // actually needed — no wasted bytes on a normal display.
          srcSet={`${thumbUrl(id, 320, attempt)} 1x, ${thumbUrl(id, 640, attempt)} 2x`}
          className={state === 'loaded' ? 'loaded' : undefined}
          alt=""
          draggable={false}
          decoding="async"
          onLoad={retry.onLoad}
          onError={retry.onError}
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

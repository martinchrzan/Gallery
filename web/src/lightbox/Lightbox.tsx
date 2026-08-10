import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  api,
  originalUrl,
  photoDownloadUrl,
  thumbUrl,
  type Manifest,
  type PhotoDetail,
} from '../api/client';
import {
  IconChevronLeft,
  IconChevronRight,
  IconClose,
  IconCollapse,
  IconDownload,
  IconExpand,
  IconInfo,
  IconZoom,
} from '../components/icons';
import { formatCount } from '../lib/format';
import { MetadataPanel } from './MetadataPanel';
import { scaleToSlider, sliderToScale, useZoomPan } from './useZoomPan';

/** Neighbours preloaded either side, so arrow-key browsing never waits. */
const PRELOAD_RADIUS = 2;
/** Aspect used before the real dimensions are known. */
const FALLBACK_ASPECT = 3 / 2;
/** Travel before a touch drag is claimed as a swipe rather than a pan. */
const SWIPE_LOCK = 10;
/** Horizontal travel that commits the swipe, capped against narrow stages. */
const SWIPE_COMMIT = 60;
/** Gap between the current photo and the neighbour peeking in behind it. */
const SWIPE_GAP = 24;

interface LightboxProps {
  manifest: Manifest;
  index: number;
  showMetadataDefault: boolean;
  onIndexChange: (index: number) => void;
  onClose: () => void;
}

export function Lightbox({
  manifest,
  index,
  showMetadataDefault,
  onIndexChange,
  onClose,
}: LightboxProps): React.ReactElement | null {
  const [showMeta, setShowMeta] = useState(showMetadataDefault);
  const [detail, setDetail] = useState<PhotoDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [previewLoaded, setPreviewLoaded] = useState(false);
  const [originalLoaded, setOriginalLoaded] = useState(false);
  const [wantOriginal, setWantOriginal] = useState(false);
  const [stage, setStage] = useState({ width: 0, height: 0 });
  /** Filled in when the manifest has no dimensions for this photo. */
  const [measured, setMeasured] = useState<{ width: number; height: number } | null>(null);

  /** How far the photo has been dragged sideways by an in-flight swipe. */
  const [swipeDx, setSwipeDx] = useState(0);
  /** True only while an abandoned swipe animates back to centre. */
  const [settling, setSettling] = useState(false);

  const stageRef = useRef<HTMLDivElement>(null);
  const sliderRef = useRef<HTMLInputElement>(null);
  /** Tracks whether the current press turned into a drag, so releasing a pan
   *  over the backdrop does not count as a click-to-close. */
  const press = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  /** The in-flight swipe, once the gesture has committed to an axis. */
  const swipe = useRef<{ x: number; y: number; dx: number; axis: 'x' | 'y' | null } | null>(null);
  /** A second finger means pinch-zoom, which cancels any swipe in progress. */
  const touches = useRef(0);

  const id = manifest.ids[index];
  const manifestWidth = manifest.widths[index] ?? 0;
  const manifestHeight = manifest.heights[index] ?? 0;

  const natural = useMemo(() => {
    if (manifestWidth > 0 && manifestHeight > 0) {
      return { width: manifestWidth, height: manifestHeight };
    }
    if (measured) return measured;
    // Placeholder that keeps the stage geometry sane until the image lands.
    return { width: Math.round(1000 * FALLBACK_ASPECT), height: 1000 };
  }, [manifestWidth, manifestHeight, measured]);

  const { state: view, reset, zoomBy, zoomTo, toggleZoom, handlers } = useZoomPan({
    stageWidth: stage.width,
    stageHeight: stage.height,
    imageWidth: natural.width,
    imageHeight: natural.height,
    // Two consecutive photos can share dimensions exactly (common among
    // screenshots), so the geometry alone is not enough to trigger a re-fit.
    resetKey: id,
  });

  /* ---------------------------------------------------------------- stage */

  useEffect(() => {
    const element = stageRef.current;
    if (!element) return;

    const measure = (): void =>
      setStage({ width: element.clientWidth, height: element.clientHeight });
    measure();

    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  /* ------------------------------------------------------- photo changed */

  useEffect(() => {
    setPreviewLoaded(false);
    setOriginalLoaded(false);
    setWantOriginal(false);
    setMeasured(null);
  }, [id]);

  // Zooming past the fit means the preview is no longer sharp enough.
  useEffect(() => {
    if (view.zoomed) setWantOriginal(true);
  }, [view.zoomed]);

  // The settle transition is fire-and-forget: it must be off again before the
  // next zoom or pan, or those would animate too.
  useEffect(() => {
    if (!settling) return;
    const timer = window.setTimeout(() => setSettling(false), 220);
    return () => window.clearTimeout(timer);
  }, [settling]);

  /**
   * The zoom slider is deliberately *uncontrolled*, and only corrected once the
   * zoom has settled.
   *
   * Writing the thumb position on every change fights the drag: the write runs
   * against the previous render's scale, so it puts the thumb back where it was
   * a moment ago. The browser then treats that as the new grab origin and the
   * drag never recovers. Debouncing means the cleanup cancels the write on
   * every drag step, so it only lands after the user stops — where it exists to
   * catch zoom that came from the wheel, a shortcut or a new photo.
   */
  useEffect(() => {
    const input = sliderRef.current;
    if (!input) return;

    const timer = window.setTimeout(() => {
      const target = Math.round(scaleToSlider(view.scale, view.fitScale) * 1000);
      if (Math.abs(Number(input.value) - target) > 2) input.value = String(target);
    }, 120);

    return () => window.clearTimeout(timer);
  }, [view.scale, view.fitScale]);

  /* -------------------------------------------------------------- detail */

  useEffect(() => {
    if (!showMeta || id === undefined) return;

    const controller = new AbortController();
    setDetailLoading(true);
    api
      .photo(id, controller.signal)
      .then((photo) => {
        if (!controller.signal.aborted) setDetail(photo);
      })
      .catch(() => {
        if (!controller.signal.aborted) setDetail(null);
      })
      .finally(() => {
        if (!controller.signal.aborted) setDetailLoading(false);
      });

    return () => controller.abort();
  }, [id, showMeta]);

  /* ------------------------------------------------------------- preload */

  useEffect(() => {
    const images: HTMLImageElement[] = [];
    for (let offset = -PRELOAD_RADIUS; offset <= PRELOAD_RADIUS; offset++) {
      if (offset === 0) continue;
      const neighbour = index + offset;
      if (neighbour < 0 || neighbour >= manifest.count) continue;

      const image = new Image();
      image.decoding = 'async';
      image.src = thumbUrl(manifest.ids[neighbour]!, 1600);
      images.push(image);
    }
    // Dropping the references lets the browser cancel anything still in flight
    // when the user moves on quickly.
    return () => {
      for (const image of images) image.src = '';
    };
  }, [index, manifest]);

  /* ----------------------------------------------------------- navigation */

  const go = useCallback(
    (delta: number) => {
      if (manifest.count === 0) return;
      const next = (index + delta + manifest.count) % manifest.count;
      onIndexChange(next);
    },
    [index, manifest.count, onIndexChange],
  );

  /**
   * Touch drag across a fitted photo browses the library, the way every phone
   * gallery does. It is deliberately limited to touch and to the unzoomed
   * state: a mouse drag on the backdrop is how you dismiss the lightbox, and
   * once zoomed in the same gesture is panning the photo.
   */
  const canSwipe = useCallback(
    (event: React.PointerEvent): boolean =>
      event.pointerType !== 'mouse' && manifest.count > 1 && !view.zoomed,
    [manifest.count, view.zoomed],
  );

  const endSwipe = useCallback(
    (commit: boolean) => {
      const gesture = swipe.current;
      swipe.current = null;
      if (!gesture || gesture.axis !== 'x') return;

      setSwipeDx(0);
      // A short flick counts as much as a slow drag across the whole stage.
      const distance = Math.min(SWIPE_COMMIT, stage.width * 0.2 || SWIPE_COMMIT);
      if (commit && Math.abs(gesture.dx) > distance) go(gesture.dx < 0 ? 1 : -1);
      else setSettling(true);
    },
    [go, stage.width],
  );

  const download = useCallback(() => {
    if (id === undefined) return;
    const link = document.createElement('a');
    link.href = photoDownloadUrl(id);
    link.download = detail?.name ?? '';
    document.body.appendChild(link);
    link.click();
    link.remove();
  }, [detail?.name, id]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;

      switch (event.key) {
        case 'Escape':
          event.preventDefault();
          onClose();
          break;
        case 'ArrowRight':
          event.preventDefault();
          go(1);
          break;
        case 'ArrowLeft':
          event.preventDefault();
          go(-1);
          break;
        case 'i':
        case 'I':
          event.preventDefault();
          setShowMeta((value) => !value);
          break;
        case 'd':
        case 'D':
          event.preventDefault();
          download();
          break;
        case 'f':
        case 'F':
        case 'Enter':
          event.preventDefault();
          toggleZoom();
          break;
        case '0':
          event.preventDefault();
          reset();
          break;
        case '+':
        case '=':
          event.preventDefault();
          zoomBy(1.4);
          break;
        case '-':
        case '_':
          event.preventDefault();
          zoomBy(1 / 1.4);
          break;
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [download, go, onClose, reset, toggleZoom, zoomBy]);

  // The page behind must not scroll while the lightbox is open.
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  if (id === undefined) return null;

  const transform = `translate3d(${view.x + swipeDx}px, ${view.y}px, 0) scale(${view.scale})`;
  const imageStyle: React.CSSProperties = {
    width: `${natural.width}px`,
    height: `${natural.height}px`,
    transform,
  };
  // Percentage of the photo's real pixels, so 100% genuinely means 1:1.
  const zoomPercent = Math.round(view.scale * 100);
  const atFit = Math.abs(view.scale - view.fitScale) < 0.005;
  // For a photo smaller than the screen these coincide: it is both fitted and
  // at actual size, because fit never enlarges.
  const atActualSize = Math.abs(view.scale - 1) < 0.005;

  return (
    <div className="lightbox" role="dialog" aria-modal="true">
      <div className="lightbox-bar">
        <button className="btn btn-icon" onClick={onClose} title="Close (Esc)" aria-label="Close">
          <IconClose />
        </button>
        <div className="lightbox-title">{detail?.name ?? ''}</div>
        <div className="lightbox-sub">
          {formatCount(index + 1)} / {formatCount(manifest.count)}
        </div>
        <div className="topbar-spacer" />

        <div className="zoom-slider" title="Drag to zoom">
          <IconZoom size={14} className="zoom-slider-icon" />
          <input
            ref={sliderRef}
            type="range"
            min={0}
            max={1000}
            step={1}
            defaultValue={0}
            onChange={(event) => zoomTo(sliderToScale(Number(event.target.value) / 1000, view.fitScale))}
            aria-label="Zoom"
          />
          <span className="zoom-slider-value">{zoomPercent}%</span>
        </div>

        {/* A mode indicator, not an action button. The old single button was
            labelled with its *destination*, so a small photo sitting correctly
            at fit still read "100%" and looked like it had opened zoomed in.
            When a photo is smaller than the screen, fit and 1:1 are the same
            thing and both light up — which says exactly that. */}
        <div className="zoom-modes" role="group" aria-label="Zoom mode">
          <button
            className={`zoom-mode${atFit ? ' active' : ''}`}
            onClick={() => reset()}
            title="Fit to screen (F)"
            aria-label="Fit to screen"
            aria-pressed={atFit}
          >
            <IconCollapse size={13} />
            <span className="btn-label">Fit</span>
          </button>
          <button
            className={`zoom-mode${atActualSize ? ' active' : ''}`}
            onClick={() => zoomTo(1)}
            title="Actual size, 1:1"
            aria-label="Actual size"
            aria-pressed={atActualSize}
          >
            <IconExpand size={13} />
            <span className="btn-label">1:1</span>
          </button>
        </div>
        <button
          className={`btn${showMeta ? ' btn-on' : ''}`}
          onClick={() => setShowMeta((value) => !value)}
          title="Toggle details (I)"
          aria-label="Toggle details"
          aria-pressed={showMeta}
        >
          <IconInfo />
          <span className="btn-label">Details</span>
        </button>
        <button
          className="btn"
          onClick={download}
          title="Download original (D)"
          aria-label="Download original"
        >
          <IconDownload />
          <span className="btn-label">Download</span>
        </button>
      </div>

      <div className="lightbox-body">
        <div
          ref={stageRef}
          className={`lightbox-stage${view.zoomed ? ' zoomed' : ''}${view.panning ? ' panning' : ''}${settling ? ' settling' : ''}`}
          onDoubleClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            toggleZoom(event.clientX - rect.left, event.clientY - rect.top);
          }}
          {...handlers}
          onPointerDown={(event) => {
            press.current = { x: event.clientX, y: event.clientY, moved: false };

            touches.current += 1;
            if (touches.current > 1) endSwipe(false);
            else if (canSwipe(event)) {
              setSettling(false);
              swipe.current = { x: event.clientX, y: event.clientY, dx: 0, axis: null };
            }

            handlers.onPointerDown(event);
          }}
          onPointerMove={(event) => {
            const start = press.current;
            if (start && (Math.abs(event.clientX - start.x) > 4 || Math.abs(event.clientY - start.y) > 4)) {
              start.moved = true;
            }

            const gesture = swipe.current;
            if (gesture) {
              const dx = event.clientX - gesture.x;
              const dy = event.clientY - gesture.y;
              // Locking the axis once, on the first real movement, stops a
              // wobbly finger from flip-flopping mid-drag.
              if (gesture.axis === null && Math.hypot(dx, dy) > SWIPE_LOCK) {
                gesture.axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
              }
              if (gesture.axis === 'x') {
                gesture.dx = dx;
                setSwipeDx(dx);
                // Withheld from the pan handler, which would fight it.
                return;
              }
            }

            handlers.onPointerMove(event);
          }}
          onPointerUp={(event) => {
            touches.current = Math.max(0, touches.current - 1);
            endSwipe(true);
            handlers.onPointerUp(event);
          }}
          onPointerCancel={(event) => {
            touches.current = Math.max(0, touches.current - 1);
            endSwipe(false);
            handlers.onPointerUp(event);
          }}
          onClick={(event) => {
            // Only the bare backdrop closes: a click that landed on the photo,
            // an arrow or anything else bubbles up with a different target.
            if (event.target !== event.currentTarget) return;
            if (press.current?.moved) return;
            onClose();
          }}
        >
          {!previewLoaded && <div className="loading-bar" />}

          {/* The neighbours ride along under the finger, so a swipe reads as
              travelling through the library rather than dragging one photo off
              into the void. They are drawn before the current photo so it stays
              on top, and only exist for the duration of the gesture. */}
          {(swipeDx !== 0 || settling) && manifest.count > 1 && (
            <>
              <img
                className="swipe-peek"
                src={thumbUrl(manifest.ids[(index - 1 + manifest.count) % manifest.count]!, 1600)}
                alt=""
                draggable={false}
                style={{ transform: `translate3d(${swipeDx - stage.width - SWIPE_GAP}px, 0, 0)` }}
              />
              <img
                className="swipe-peek"
                src={thumbUrl(manifest.ids[(index + 1) % manifest.count]!, 1600)}
                alt=""
                draggable={false}
                style={{ transform: `translate3d(${swipeDx + stage.width + SWIPE_GAP}px, 0, 0)` }}
              />
            </>
          )}

          {/* The 1600px preview appears immediately — it is usually already
              cached from the grid's own thumbnail pipeline. */}
          <img
            key={`preview-${id}`}
            src={thumbUrl(id, 1600)}
            alt=""
            style={{ ...imageStyle, visibility: previewLoaded ? 'visible' : 'hidden' }}
            draggable={false}
            onLoad={(event) => {
              setPreviewLoaded(true);
              if (manifestWidth === 0 || manifestHeight === 0) {
                const image = event.currentTarget;
                setMeasured({ width: image.naturalWidth, height: image.naturalHeight });
              }
            }}
          />

          {/* Full resolution is fetched only once it can actually be seen. */}
          {wantOriginal && (
            <img
              key={`original-${id}`}
              src={originalUrl(id)}
              alt=""
              style={{ ...imageStyle, visibility: originalLoaded ? 'visible' : 'hidden' }}
              draggable={false}
              onLoad={() => setOriginalLoaded(true)}
            />
          )}

          {manifest.count > 1 && (
            <>
              <button
                className="lightbox-nav prev"
                onClick={(event) => {
                  event.stopPropagation();
                  go(-1);
                }}
                aria-label="Previous photo"
              >
                <IconChevronLeft size={22} />
              </button>
              <button
                className="lightbox-nav next"
                onClick={(event) => {
                  event.stopPropagation();
                  go(1);
                }}
                aria-label="Next photo"
              >
                <IconChevronRight size={22} />
              </button>
            </>
          )}

          {view.zoomed && (
            <div className="zoom-badge">
              {zoomPercent}%{wantOriginal && !originalLoaded ? ' · loading full size…' : ''}
            </div>
          )}
        </div>

        {showMeta && <MetadataPanel photo={detail} loading={detailLoading} />}
      </div>
    </div>
  );
}

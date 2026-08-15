import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useElementSize } from '../lib/hooks';
import type { YearTick } from './layout';

/**
 * Minimum vertical gap between two rendered year labels, in pixels. Wide enough
 * that the taller touch chips still keep clear of each other — neighbouring tap
 * targets that all but touch are targets you hit by accident.
 */
const MIN_TICK_GAP = 32;
/** Rail inset assumed until the element itself has been measured. */
const FALLBACK_RAIL_INSET = 16;
/** Look-ahead when deciding which year the feed shows; matches the sticky day. */
const HEADING_LEAD = 8;
/**
 * How far a press that landed on a year label may wander before it counts as a
 * drag. No finger holds perfectly still, and without this slop the first stray
 * pixel would scrub straight back off the year that was just tapped.
 */
const TAP_SLOP = 10;

interface YearRailProps {
  ticks: YearTick[];
  totalHeight: number;
  viewportHeight: number;
  scrollTop: number;
  onScrubTo: (offsetY: number) => void;
}

interface PlacedTick extends YearTick {
  /** Position down the rail, in pixels. */
  railY: number;
}

/**
 * The year scrubber down the right edge: year labels positioned by how far you
 * would have to scroll to reach them, draggable to jump anywhere in the feed.
 */
export function YearRail({
  ticks,
  totalHeight,
  viewportHeight,
  scrollTop,
  onScrubTo,
}: YearRailProps): React.ReactElement | null {
  const [railEl, setRailEl] = useState<HTMLDivElement | null>(null);
  const [dragging, setDragging] = useState(false);
  const [hoverY, setHoverY] = useState<number | null>(null);
  /** Origin of a press that snapped to a label, until it turns into a drag. */
  const tapAnchor = useRef<number | null>(null);

  const { height: measuredRail } = useElementSize(railEl);

  const scrollable = Math.max(1, totalHeight - viewportHeight);
  const railHeight = Math.max(1, measuredRail || viewportHeight - FALLBACK_RAIL_INSET * 2);

  /**
   * Years in a dense library land on top of each other, so thin them out — but
   * never drop the oldest one, since it is the anchor at the end of the rail.
   */
  const placed: PlacedTick[] = useMemo(() => {
    if (ticks.length === 0) return [];

    const railYOf = (tick: YearTick): number =>
      Math.min(1, Math.max(0, tick.y / scrollable)) * railHeight;

    const kept: PlacedTick[] = [];
    for (const tick of ticks) {
      const railY = railYOf(tick);
      const previous = kept[kept.length - 1];
      if (!previous || railY - previous.railY >= MIN_TICK_GAP) kept.push({ ...tick, railY });
    }

    const oldest = ticks[ticks.length - 1]!;
    const last = kept[kept.length - 1];
    if (last && last.year !== oldest.year) {
      const railY = railYOf(oldest);
      // Evict whatever it would collide with rather than overlapping it.
      if (railY - last.railY < MIN_TICK_GAP) kept.pop();
      kept.push({ ...oldest, railY });
    }
    return kept;
  }, [ticks, scrollable, railHeight]);

  const scrubToClientY = useCallback(
    (clientY: number) => {
      const rail = railEl;
      if (!rail) return;
      const rect = rail.getBoundingClientRect();
      const fraction = Math.min(1, Math.max(0, (clientY - rect.top) / rect.height));
      onScrubTo(fraction * scrollable);
    },
    [onScrubTo, scrollable],
  );

  /**
   * A press that lands on a label jumps to that year exactly, rather than to
   * wherever on the rail the pointer happened to be. A fingertip covers a good
   * chunk of the rail, and a few pixels there is worth months of photos.
   */
  const tickUnder = useCallback(
    (target: EventTarget | null): PlacedTick | null => {
      const label = (target as Element | null)?.closest?.('.year-tick');
      const year = (label as HTMLElement | null)?.dataset.year;
      return placed.find((tick) => String(tick.year) === year) ?? null;
    },
    [placed],
  );

  useEffect(() => {
    if (!dragging) return;

    const move = (event: PointerEvent): void => {
      event.preventDefault();
      const anchor = tapAnchor.current;
      if (anchor !== null) {
        if (Math.abs(event.clientY - anchor) < TAP_SLOP) return;
        tapAnchor.current = null;
      }
      setHoverY(event.clientY);
      scrubToClientY(event.clientY);
    };
    const up = (): void => {
      setDragging(false);
      setHoverY(null);
      tapAnchor.current = null;
    };

    window.addEventListener('pointermove', move, { passive: false });
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
  }, [dragging, scrubToClientY]);

  if (ticks.length < 2) return null;

  // Measured on the rail, so both sides go through the same clamp and the
  // oldest year — whose position is clamped to the end — can light up at all.
  const railYNow = Math.min(1, Math.max(0, (scrollTop + HEADING_LEAD) / scrollable)) * railHeight;
  const currentYear = yearAtRail(placed, railYNow);
  const bubbleYear =
    hoverY !== null && railEl
      ? yearAt(
          ticks,
          Math.min(
            1,
            Math.max(0, (hoverY - railEl.getBoundingClientRect().top) / railHeight),
          ) * scrollable,
        )
      : null;

  return (
    <div
      ref={setRailEl}
      className={`year-rail${dragging ? ' dragging' : ''}`}
      onPointerDown={(event) => {
        event.preventDefault();
        setDragging(true);

        const tick = tickUnder(event.target);
        if (tick) {
          const rect = event.currentTarget.getBoundingClientRect();
          tapAnchor.current = event.clientY;
          setHoverY(rect.top + tick.railY);
          onScrubTo(tick.y);
          return;
        }

        tapAnchor.current = null;
        setHoverY(event.clientY);
        scrubToClientY(event.clientY);
      }}
      onPointerMove={(event) => {
        if (!dragging) setHoverY(event.clientY);
      }}
      onPointerLeave={() => {
        if (!dragging) setHoverY(null);
      }}
    >
      <div className="year-rail-track" />
      {placed.map((tick) => (
        <div
          key={tick.year}
          className={`year-tick${tick.year === currentYear ? ' current' : ''}`}
          data-year={tick.year}
          style={{ top: `${tick.railY}px` }}
        >
          {tick.year}
        </div>
      ))}
      {bubbleYear !== null && railEl && (
        <div
          className="rail-bubble"
          style={{ top: `${hoverY! - railEl.getBoundingClientRect().top}px` }}
        >
          {bubbleYear}
        </div>
      )}
    </div>
  );
}

/** The last label at or above a point on the rail. */
function yearAtRail(ticks: PlacedTick[], railY: number): number | null {
  let current: number | null = ticks[0]?.year ?? null;
  for (const tick of ticks) {
    if (tick.railY <= railY) current = tick.year;
    else break;
  }
  return current;
}

/** The year covering a given document offset. */
function yearAt(ticks: YearTick[], offsetY: number): number | null {
  let current: number | null = ticks[0]?.year ?? null;
  for (const tick of ticks) {
    if (tick.y <= offsetY) current = tick.year;
    else break;
  }
  return current;
}

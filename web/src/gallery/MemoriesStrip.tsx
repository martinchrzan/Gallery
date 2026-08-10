import { useCallback, useEffect, useRef, useState } from 'react';
import { isVideoAt, thumbUrl, type Manifest } from '../api/client';
import { IconChevronLeft, IconChevronRight, IconPlay } from '../components/icons';
import { formatDateTime, formatDuration, formatMonthDay } from '../lib/format';
import type { Memory } from './memories';

/** Pause between automatic steps, in ms. */
const STEP_INTERVAL = 4500;
/** How long a touch, a wheel or a hover holds the slideshow still. */
const PAUSE_AFTER_INPUT = 9000;
/** Fraction of the visible rail an arrow press travels. */
const ARROW_PAGE = 0.8;
/** Aspect used for a photo whose dimensions were never extracted. */
const FALLBACK_ASPECT = 3 / 2;

interface MemoriesStripProps {
  memories: Memory[];
  manifest: Manifest;
  onOpen: (index: number) => void;
}

/**
 * A single row of "on this day" photos above the feed.
 *
 * One row is the whole design constraint: it has to sit on top of the gallery
 * without pushing it off a phone screen. So it scrolls sideways — natively on
 * touch, by arrow or by the slow auto-advance on a desktop — rather than
 * wrapping. It scrolls away with the page and is not pinned.
 */
export function MemoriesStrip({
  memories,
  manifest,
  onOpen,
}: MemoriesStripProps): React.ReactElement | null {
  const trackRef = useRef<HTMLDivElement>(null);
  const [sectionEl, setSectionEl] = useState<HTMLElement | null>(null);
  /** Arrows and auto-advance are pointless when everything already fits. */
  const [overflowing, setOverflowing] = useState(false);
  /** Off while the strip is scrolled out of view: nothing to animate. */
  const [onScreen, setOnScreen] = useState(false);
  /** Timestamp until which the slideshow keeps out of the user's way. */
  const pausedUntil = useRef(0);

  const hold = useCallback(() => {
    pausedUntil.current = Date.now() + PAUSE_AFTER_INPUT;
  }, []);

  /* Does the rail actually have somewhere to go? Re-measured on resize, since
     the answer changes with the viewport and with the tiles' own aspects. */
  useEffect(() => {
    const track = trackRef.current;
    if (!track) return;

    const measure = (): void =>
      setOverflowing(track.scrollWidth - track.clientWidth > 8);
    measure();

    const observer = new ResizeObserver(measure);
    observer.observe(track);
    for (const child of track.children) observer.observe(child);
    return () => observer.disconnect();
  }, [memories]);

  useEffect(() => {
    if (!sectionEl) return;
    const observer = new IntersectionObserver(
      ([entry]) => setOnScreen(entry?.isIntersecting ?? false),
      { threshold: 0.25 },
    );
    observer.observe(sectionEl);
    return () => observer.disconnect();
  }, [sectionEl]);

  /**
   * The slideshow. It steps to the next tile's edge rather than by a fixed
   * distance, so it always lands on a whole photo — the same place the CSS
   * scroll snapping would have put a flick.
   */
  useEffect(() => {
    if (!overflowing || !onScreen) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    const timer = window.setInterval(() => {
      const track = trackRef.current;
      if (!track || Date.now() < pausedUntil.current || document.hidden) return;

      const limit = track.scrollWidth - track.clientWidth;
      const next = Array.from(track.children).find(
        (child) => (child as HTMLElement).offsetLeft > track.scrollLeft + 8,
      ) as HTMLElement | undefined;

      // Once the last photo is on screen the row starts over; until then, a tile
      // near the end is capped at the scroll limit rather than skipped.
      const atEnd = track.scrollLeft >= limit - 8;
      const left = atEnd || !next ? 0 : Math.min(next.offsetLeft, limit);
      track.scrollTo({ left, behavior: 'smooth' });
    }, STEP_INTERVAL);

    return () => window.clearInterval(timer);
  }, [overflowing, onScreen]);

  const page = useCallback(
    (direction: 1 | -1) => {
      const track = trackRef.current;
      if (!track) return;
      hold();
      track.scrollBy({ left: direction * track.clientWidth * ARROW_PAGE, behavior: 'smooth' });
    },
    [hold],
  );

  if (memories.length === 0) return null;

  return (
    <section className="memories" ref={setSectionEl} aria-label="On this day">
      <div className="memories-head">
        <h2>On this day</h2>
        <span className="memories-date">{formatMonthDay(memories[0]!.time * 1000)}</span>
      </div>

      <div className="memories-rail">
        <div
          className="memories-track"
          ref={trackRef}
          onPointerDown={hold}
          onWheel={hold}
          onMouseEnter={hold}
        >
          {memories.map((memory) => {
            const width = manifest.widths[memory.index] ?? 0;
            const height = manifest.heights[memory.index] ?? 0;
            const video = isVideoAt(manifest, memory.index);
            const duration = manifest.durations[memory.index] ?? 0;
            const years = `${memory.yearsAgo} ${memory.yearsAgo === 1 ? 'year' : 'years'} ago`;

            return (
              <button
                key={memory.id}
                className="memory"
                style={{
                  aspectRatio:
                    width > 0 && height > 0 ? `${width} / ${height}` : String(FALLBACK_ASPECT),
                }}
                onClick={() => onOpen(memory.index)}
                title={`${years} — ${formatDateTime(memory.time * 1000)}`}
                aria-label={`${video ? 'Video' : 'Photo'} from ${years}`}
              >
                {/* Fades in the way a grid tile does, but through the class
                    rather than state: the strip is a dozen tiles that never
                    re-render, and React never touches a className it was not
                    given. */}
                <img
                  src={thumbUrl(memory.id, 320)}
                  srcSet={`${thumbUrl(memory.id, 320)} 1x, ${thumbUrl(memory.id, 640)} 2x`}
                  alt=""
                  draggable={false}
                  decoding="async"
                  onLoad={(event) => event.currentTarget.classList.add('loaded')}
                />
                <span className="memory-years">{years}</span>
                {video && (
                  <span className="memory-video">
                    <IconPlay size={9} />
                    {duration > 0 && formatDuration(duration)}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {overflowing && (
          <>
            <button
              className="memories-arrow prev"
              onClick={() => page(-1)}
              aria-label="Previous memories"
            >
              <IconChevronLeft size={18} />
            </button>
            <button
              className="memories-arrow next"
              onClick={() => page(1)}
              aria-label="More memories"
            >
              <IconChevronRight size={18} />
            </button>
          </>
        )}
      </div>
    </section>
  );
}

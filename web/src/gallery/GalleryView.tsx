import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { EMPTY_MANIFEST, fetchManifest, type Manifest } from '../api/client';
import { Thumb } from '../components/Thumb';
import { Lightbox } from '../lightbox/Lightbox';
import { formatCount, formatDay } from '../lib/format';
import { useElementSize, useIndexStatus } from '../lib/hooks';
import {
  computeLayout,
  DEFAULT_LAYOUT,
  EMPTY_LAYOUT,
  firstRowAt,
  sectionAt,
  yearTicks,
  type Layout,
} from './layout';
import { YearRail } from './YearRail';
import type { Settings } from '@shared';

/** Extra content rendered beyond the viewport, as a multiple of its height. */
const OVERSCAN = 1.5;
const SIDE_PADDING = 16;

interface GalleryViewProps {
  settings: Settings | null;
}

export function GalleryView({ settings }: GalleryViewProps): React.ReactElement {
  const [manifest, setManifest] = useState<Manifest>(EMPTY_MANIFEST);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [openIndex, setOpenIndex] = useState<number | null>(null);

  // Held as state, not a ref: the loading placeholder renders first, so the
  // measuring effects have to re-run once the real scroller mounts.
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);
  const { width: scrollWidth, height: viewportHeight } = useElementSize(scrollEl);
  const containerWidth = scrollWidth;
  const indexStatus = useIndexStatus();

  const rowHeight = settings?.rowHeight ?? DEFAULT_LAYOUT.targetRowHeight;

  /* ------------------------------------------------------------- manifest */

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const next = await fetchManifest(signal);
      if (signal?.aborted) return;
      setManifest(next);
      setError(null);
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
      setError((err as Error).message);
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    void load(controller.signal);
    return () => controller.abort();
  }, [load, settings?.galleryFolders]);

  // Refresh once indexing settles, so newly-dated photos slot into place.
  const wasScanning = useRef(false);
  useEffect(() => {
    const scanning = indexStatus?.scanning ?? false;
    if (wasScanning.current && !scanning) void load();
    wasScanning.current = scanning;
  }, [indexStatus?.scanning, load]);

  /* --------------------------------------------------------------- layout */

  const layout: Layout = useMemo(() => {
    if (containerWidth <= 0) return EMPTY_LAYOUT;
    return computeLayout(manifest, {
      ...DEFAULT_LAYOUT,
      targetRowHeight: rowHeight,
      containerWidth: containerWidth - SIDE_PADDING * 2,
    });
  }, [manifest, containerWidth, rowHeight]);

  const ticks = useMemo(() => yearTicks(layout), [layout]);

  /* --------------------------------------------------------------- scroll */

  useEffect(() => {
    if (!scrollEl) return;

    let frame = 0;
    const onScroll = (): void => {
      // Coalesce to one state update per frame; the scroll event can fire far
      // more often than that and each update re-renders the grid.
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        setScrollTop(scrollEl.scrollTop);
      });
    };

    onScroll();
    scrollEl.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      scrollEl.removeEventListener('scroll', onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [scrollEl]);

  const scrubTo = useCallback(
    (offsetY: number) => scrollEl?.scrollTo({ top: offsetY, behavior: 'auto' }),
    [scrollEl],
  );

  /* ------------------------------------------------------- visible window */

  const visible = useMemo(() => {
    if (layout.rows.length === 0 || viewportHeight === 0) {
      return { rowStart: 0, rowEnd: 0, sectionStart: 0, sectionEnd: 0 };
    }

    const top = scrollTop - viewportHeight * OVERSCAN;
    const bottom = scrollTop + viewportHeight * (1 + OVERSCAN);

    const rowStart = firstRowAt(layout, top);
    let rowEnd = rowStart;
    while (rowEnd < layout.rows.length && layout.rows[rowEnd]!.y <= bottom) rowEnd++;

    // Day headers live between rows, so track sections over the same band.
    let sectionStart = 0;
    while (
      sectionStart < layout.sections.length &&
      layout.sections[sectionStart]!.endY < top
    ) {
      sectionStart++;
    }
    let sectionEnd = sectionStart;
    while (
      sectionEnd < layout.sections.length &&
      layout.sections[sectionEnd]!.headerY <= bottom
    ) {
      sectionEnd++;
    }

    return { rowStart, rowEnd, sectionStart, sectionEnd };
  }, [layout, scrollTop, viewportHeight]);

  const stickySection = useMemo(
    () => (layout.sections.length > 0 ? sectionAt(layout, scrollTop + 8) : null),
    [layout, scrollTop],
  );

  const tiles = useMemo(() => {
    const nodes: React.ReactElement[] = [];
    for (let r = visible.rowStart; r < visible.rowEnd; r++) {
      const row = layout.rows[r];
      if (!row) continue;
      for (let i = row.start; i < row.end; i++) {
        const id = manifest.ids[i]!;
        nodes.push(
          <Thumb
            key={id}
            id={id}
            x={layout.x[i]!}
            y={layout.y[i]!}
            width={layout.width[i]!}
            height={layout.height[i]!}
            onOpen={() => setOpenIndex(i)}
          />,
        );
      }
    }
    return nodes;
  }, [layout, manifest, visible.rowStart, visible.rowEnd]);

  /* ----------------------------------------------------------------- view */

  if (loading) {
    return (
      <div className="empty">
        <div className="spinner" />
        <p>Loading your photos…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="empty">
        <h2>Could not load the gallery</h2>
        <p>{error}</p>
        <button className="btn" onClick={() => void load()}>
          Try again
        </button>
      </div>
    );
  }

  if (manifest.count === 0) {
    const scanning = indexStatus?.scanning ?? false;
    const nothingSelected = settings !== null && settings.galleryFolders.length === 0;

    return (
      <div className="empty">
        {scanning && <div className="spinner" />}
        <h2>
          {scanning
            ? 'Indexing your library…'
            : nothingSelected
              ? 'No folders chosen yet'
              : 'No photos here'}
        </h2>
        <p>
          {scanning
            ? `Found ${formatCount(indexStatus?.discovered ?? 0)} photos so far. They will appear here as they are indexed.`
            : nothingSelected
              ? 'Choose which folders feed the chronological gallery, or pick “All photos” for the whole library.'
              : 'The selected folders contain no photos the gallery can display.'}
        </p>
        {!scanning && (
          <Link className="btn btn-primary" to="/settings">
            Choose folders
          </Link>
        )}
      </div>
    );
  }

  return (
    <div className="gallery">
      <div className="gallery-scroll" ref={setScrollEl}>
        <div className="gallery-canvas" style={{ height: `${layout.totalHeight}px` }}>
          {layout.sections.slice(visible.sectionStart, visible.sectionEnd).map((section) => (
            <div
              key={`${section.dayStart}-${section.photoStart}`}
              className="day-header"
              style={{ transform: `translate3d(0, ${section.headerY}px, 0)` }}
            >
              {formatDay(section.dayStart)}
            </div>
          ))}
          {tiles}
        </div>
      </div>

      <div className={`sticky-day${scrollTop > 40 && stickySection ? ' visible' : ''}`}>
        {stickySection ? formatDay(stickySection.dayStart) : ''}
      </div>

      <YearRail
        ticks={ticks}
        totalHeight={layout.totalHeight}
        viewportHeight={viewportHeight}
        scrollTop={scrollTop}
        onScrubTo={scrubTo}
      />

      {indexStatus?.scanning && (
        <div className="pill gallery-status">
          <div className="spinner" />
          {indexStatus.phase === 'walking'
            ? `Scanning — ${formatCount(indexStatus.discovered)} found`
            : indexStatus.phase === 'prewarming'
              ? `Preparing thumbnails — ${formatCount(indexStatus.processed)} / ${formatCount(indexStatus.total)}`
              : `Reading photo dates — ${formatCount(indexStatus.processed)} / ${formatCount(indexStatus.total)}`}
        </div>
      )}

      {openIndex !== null && (
        <Lightbox
          manifest={manifest}
          index={openIndex}
          showMetadataDefault={settings?.showMetadata ?? false}
          onIndexChange={setOpenIndex}
          onClose={() => setOpenIndex(null)}
        />
      )}
    </div>
  );
}

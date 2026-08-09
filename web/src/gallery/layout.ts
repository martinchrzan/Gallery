import type { Manifest } from '../api/client';

/**
 * Justified-row layout, computed in one linear pass over the manifest's typed
 * arrays. No objects are allocated per photo — positions live in flat
 * Float32/Uint32 arrays — so a 50k-photo library lays out in a couple of
 * milliseconds and can be recomputed on every resize without a stutter.
 */

export interface LayoutOptions {
  containerWidth: number;
  /** Preferred row height before justification nudges it. */
  targetRowHeight: number;
  gap: number;
  headerHeight: number;
  /** Space above a day header, except the first. */
  sectionSpacing: number;
}

export const DEFAULT_LAYOUT: Omit<LayoutOptions, 'containerWidth'> = {
  targetRowHeight: 240,
  gap: 4,
  headerHeight: 46,
  sectionSpacing: 24,
};

/** Aspect ratio used until a photo's real dimensions have been extracted. */
const FALLBACK_ASPECT = 3 / 2;

export interface Row {
  /** Index of the first photo in this row. */
  start: number;
  /** One past the last photo in this row. */
  end: number;
  y: number;
  height: number;
}

export interface Section {
  /** Local midnight of the day, in epoch ms. */
  dayStart: number;
  /** Index into `rows` of this day's first row. */
  firstRow: number;
  rowCount: number;
  photoStart: number;
  photoCount: number;
  /** Y position of the day header. */
  headerY: number;
  /** Y position where the day's content ends (used for sticky-header handoff). */
  endY: number;
}

export interface Layout {
  totalHeight: number;
  rows: Row[];
  sections: Section[];
  /** Per-photo geometry, indexed by manifest position. */
  x: Float32Array;
  y: Float32Array;
  width: Float32Array;
  height: Float32Array;
  /** Row index each photo belongs to, for hit-testing. */
  rowOf: Uint32Array;
  options: LayoutOptions;
}

export const EMPTY_LAYOUT: Layout = {
  totalHeight: 0,
  rows: [],
  sections: [],
  x: new Float32Array(0),
  y: new Float32Array(0),
  width: new Float32Array(0),
  height: new Float32Array(0),
  rowOf: new Uint32Array(0),
  options: { containerWidth: 0, ...DEFAULT_LAYOUT },
};

/** Local midnight for an epoch-seconds timestamp. */
export function dayStartOf(epochSeconds: number): number {
  const date = new Date(epochSeconds * 1000);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/**
 * A day resolver that remembers the day it last returned.
 *
 * `Date` construction dominates the layout pass otherwise — one per photo, tens
 * of thousands of times. Because the manifest is sorted by time, consecutive
 * photos nearly always share a day, so caching the current day's bounds turns
 * that into one `Date` per *day*. Still goes through `Date` for the boundaries,
 * so daylight-saving shifts stay correct.
 */
function makeDayResolver(): (epochSeconds: number) => number {
  let dayStart = 0;
  let rangeStartSec = Number.POSITIVE_INFINITY;
  let rangeEndSec = Number.NEGATIVE_INFINITY;

  return (epochSeconds: number): number => {
    if (epochSeconds >= rangeStartSec && epochSeconds < rangeEndSec) return dayStart;

    const date = new Date(epochSeconds * 1000);
    date.setHours(0, 0, 0, 0);
    dayStart = date.getTime();

    const next = new Date(dayStart);
    next.setDate(next.getDate() + 1);

    rangeStartSec = Math.floor(dayStart / 1000);
    rangeEndSec = Math.floor(next.getTime() / 1000);
    return dayStart;
  };
}

export function computeLayout(manifest: Manifest, options: LayoutOptions): Layout {
  const { containerWidth, targetRowHeight, gap, headerHeight, sectionSpacing } = options;
  const count = manifest.count;

  if (count === 0 || containerWidth <= 0) {
    return { ...EMPTY_LAYOUT, options };
  }

  const x = new Float32Array(count);
  const y = new Float32Array(count);
  const width = new Float32Array(count);
  const height = new Float32Array(count);
  const rowOf = new Uint32Array(count);
  const rows: Row[] = [];
  const sections: Section[] = [];

  const resolveDay = makeDayResolver();
  let cursorY = 0;
  let index = 0;

  while (index < count) {
    // --- one day ------------------------------------------------------------
    const dayStart = manifest.times[index] ? resolveDay(manifest.times[index]!) : 0;
    const dayFirstPhoto = index;
    const firstRow = rows.length;

    if (sections.length > 0) cursorY += sectionSpacing;
    const headerY = cursorY;
    cursorY += headerHeight;

    let dayEnd = index;
    while (dayEnd < count) {
      const t = manifest.times[dayEnd]!;
      const start = t ? resolveDay(t) : 0;
      if (start !== dayStart) break;
      dayEnd++;
    }

    // --- justified rows within the day -------------------------------------
    let rowStart = index;
    let aspectSum = 0;

    while (index < dayEnd) {
      const w = manifest.widths[index]!;
      const h = manifest.heights[index]!;
      const aspect = w > 0 && h > 0 ? w / h : FALLBACK_ASPECT;
      aspectSum += aspect;
      index++;

      const itemsInRow = index - rowStart;
      const gapTotal = gap * (itemsInRow - 1);
      // Height this row would need to fill the container exactly.
      const fittedHeight = (containerWidth - gapTotal) / aspectSum;
      const lastOfDay = index === dayEnd;

      // Close the row once fitting it would squash it below the target, or when
      // the day runs out.
      if (fittedHeight <= targetRowHeight || lastOfDay) {
        // Never enlarge a photo past its own pixels. A day holding a single
        // small photo shows it at its natural size rather than stretching it
        // across the whole row, where upscaling makes it look soft and ugly.
        let naturalLimit = Number.POSITIVE_INFINITY;
        for (let i = rowStart; i < index; i++) {
          const ih = manifest.heights[i]!;
          if (ih > 0) naturalLimit = Math.min(naturalLimit, ih);
        }

        const rowHeight = Math.min(fittedHeight, targetRowHeight, naturalLimit);

        let cursorX = 0;
        for (let i = rowStart; i < index; i++) {
          const iw = manifest.widths[i]!;
          const ih = manifest.heights[i]!;
          const itemAspect = iw > 0 && ih > 0 ? iw / ih : FALLBACK_ASPECT;
          const itemWidth = itemAspect * rowHeight;

          x[i] = cursorX;
          y[i] = cursorY;
          width[i] = itemWidth;
          height[i] = rowHeight;
          rowOf[i] = rows.length;
          cursorX += itemWidth + gap;
        }

        rows.push({ start: rowStart, end: index, y: cursorY, height: rowHeight });
        cursorY += rowHeight + gap;

        rowStart = index;
        aspectSum = 0;
      }
    }

    sections.push({
      dayStart,
      firstRow,
      rowCount: rows.length - firstRow,
      photoStart: dayFirstPhoto,
      photoCount: dayEnd - dayFirstPhoto,
      headerY,
      endY: cursorY,
    });
  }

  // The last row contributes a trailing gap that isn't real content.
  const totalHeight = Math.max(0, cursorY - gap);

  return { totalHeight, rows, sections, x, y, width, height, rowOf, options };
}

/** Index of the first row whose bottom edge is at or below `top`. */
export function firstRowAt(layout: Layout, top: number): number {
  const { rows } = layout;
  let lo = 0;
  let hi = rows.length - 1;
  let result = rows.length;

  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const row = rows[mid]!;
    if (row.y + row.height >= top) {
      result = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  return result;
}

/** The section visible at a given scroll offset, for the sticky header. */
export function sectionAt(layout: Layout, top: number): Section | null {
  const { sections } = layout;
  if (sections.length === 0) return null;

  let lo = 0;
  let hi = sections.length - 1;
  let result = 0;

  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (sections[mid]!.headerY <= top) {
      result = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return sections[result] ?? null;
}

export interface YearTick {
  year: number;
  /** Fraction of total height where this year begins, 0–1. */
  offset: number;
  y: number;
}

/** Year markers for the scrubber rail down the right edge. */
export function yearTicks(layout: Layout): YearTick[] {
  const ticks: YearTick[] = [];
  let lastYear: number | null = null;

  for (const section of layout.sections) {
    if (section.dayStart === 0) continue;
    const year = new Date(section.dayStart).getFullYear();
    if (year !== lastYear) {
      ticks.push({
        year,
        offset: layout.totalHeight > 0 ? section.headerY / layout.totalHeight : 0,
        y: section.headerY,
      });
      lastYear = year;
    }
  }
  return ticks;
}

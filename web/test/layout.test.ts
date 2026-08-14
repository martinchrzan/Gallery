import { describe, expect, it } from 'vitest';
import { makeManifest, type Manifest } from '../src/api/client';
import {
  computeLayout,
  DEFAULT_LAYOUT,
  dayStartOf,
  firstRowAt,
  type LayoutOptions,
  sectionAt,
  yearTicks,
} from '../src/gallery/layout';

const OPTIONS: LayoutOptions = { containerWidth: 1200, ...DEFAULT_LAYOUT };

/** Epoch seconds for a local date-time, which is what the manifest carries. */
function seconds(year: number, month: number, day: number, hour = 12): number {
  return Math.floor(new Date(year, month - 1, day, hour).getTime() / 1000);
}

/**
 * A manifest from a list of `[timeSeconds, width, height]` triples, newest
 * first — the order the server sends.
 */
function manifestOf(items: [number, number, number][]): Manifest {
  const count = items.length;
  const ids = new Uint32Array(count);
  const times = new Uint32Array(count);
  const widths = new Uint16Array(count);
  const heights = new Uint16Array(count);

  items.forEach(([time, width, height], i) => {
    ids[i] = i + 1;
    times[i] = time;
    widths[i] = width;
    heights[i] = height;
  });

  return makeManifest({ count, ids, times, widths, heights });
}

/** `n` landscape photos, all on the same day. */
function sameDay(n: number, day = seconds(2024, 5, 10)): Manifest {
  return manifestOf(Array.from({ length: n }, () => [day, 1200, 800] as [number, number, number]));
}

describe('an empty feed', () => {
  it('lays out to nothing', () => {
    const layout = computeLayout(manifestOf([]), OPTIONS);
    expect(layout.totalHeight).toBe(0);
    expect(layout.rows).toHaveLength(0);
    expect(layout.sections).toHaveLength(0);
  });

  it('lays out to nothing before the container has been measured', () => {
    const layout = computeLayout(sameDay(10), { ...OPTIONS, containerWidth: 0 });
    expect(layout.totalHeight).toBe(0);
  });
});

describe('justified rows', () => {
  it('fills the container width, allowing for the gaps', () => {
    const layout = computeLayout(sameDay(24), OPTIONS);

    // Every row but the last is justified to the full width.
    for (let r = 0; r < layout.rows.length - 1; r++) {
      const row = layout.rows[r]!;
      const last = row.end - 1;
      const right = layout.x[last]! + layout.width[last]!;
      expect(right, `row ${r}`).toBeCloseTo(OPTIONS.containerWidth, 0);
    }
  });

  it('never exceeds the target row height', () => {
    const layout = computeLayout(sameDay(24), OPTIONS);
    for (const row of layout.rows) {
      expect(row.height).toBeLessThanOrEqual(DEFAULT_LAYOUT.targetRowHeight + 0.001);
    }
  });

  it('leaves exactly one gap between neighbours in a row', () => {
    const layout = computeLayout(sameDay(24), OPTIONS);
    const row = layout.rows[0]!;

    for (let i = row.start; i < row.end - 1; i++) {
      const gap = layout.x[i + 1]! - (layout.x[i]! + layout.width[i]!);
      expect(gap).toBeCloseTo(DEFAULT_LAYOUT.gap, 4);
    }
  });

  it('gives every photo in a row the same height and the same y', () => {
    const layout = computeLayout(sameDay(24), OPTIONS);
    const row = layout.rows[1]!;

    for (let i = row.start; i < row.end; i++) {
      expect(layout.height[i]).toBeCloseTo(row.height, 4);
      expect(layout.y[i]).toBeCloseTo(row.y, 4);
      expect(layout.rowOf[i]).toBe(1);
    }
  });

  it('preserves each photo`s aspect ratio', () => {
    const layout = computeLayout(
      manifestOf([
        [seconds(2024, 5, 10), 1200, 800],
        [seconds(2024, 5, 10), 800, 1200],
        [seconds(2024, 5, 10), 1000, 1000],
        [seconds(2024, 5, 10), 1600, 700],
      ]),
      OPTIONS,
    );

    const expected = [1200 / 800, 800 / 1200, 1, 1600 / 700];
    expected.forEach((aspect, i) => {
      expect(layout.width[i]! / layout.height[i]!).toBeCloseTo(aspect, 3);
    });
  });

  it('falls back to 3:2 for a photo whose dimensions are not known yet', () => {
    const layout = computeLayout(manifestOf([[seconds(2024, 5, 10), 0, 0]]), OPTIONS);
    expect(layout.width[0]! / layout.height[0]!).toBeCloseTo(3 / 2, 3);
  });

  it('never enlarges a photo past its own pixels', () => {
    // A day holding one small photo shows it at its natural size rather than
    // stretching it across the row, where upscaling looks soft.
    const layout = computeLayout(manifestOf([[seconds(2024, 5, 10), 120, 90]]), OPTIONS);
    expect(layout.height[0]).toBeLessThanOrEqual(90);
    expect(layout.width[0]).toBeLessThanOrEqual(120);
  });

  it('covers every photo exactly once, across all rows', () => {
    const layout = computeLayout(sameDay(37), OPTIONS);

    let covered = 0;
    for (const row of layout.rows) {
      expect(row.end).toBeGreaterThan(row.start);
      covered += row.end - row.start;
    }
    expect(covered).toBe(37);
    expect(layout.rows[0]!.start).toBe(0);
    expect(layout.rows.at(-1)!.end).toBe(37);
  });
});

describe('day sections', () => {
  it('starts a new section on each day', () => {
    const layout = computeLayout(
      manifestOf([
        [seconds(2024, 5, 12), 1200, 800],
        [seconds(2024, 5, 12, 9), 1200, 800],
        [seconds(2024, 5, 11), 1200, 800],
        [seconds(2024, 5, 9), 1200, 800],
      ]),
      OPTIONS,
    );

    expect(layout.sections).toHaveLength(3);
    expect(layout.sections.map((s) => s.photoCount)).toEqual([2, 1, 1]);
    expect(layout.sections.map((s) => s.photoStart)).toEqual([0, 2, 3]);
  });

  it('keeps photos from the same day together whatever the hour', () => {
    const layout = computeLayout(
      manifestOf([
        [seconds(2024, 5, 12, 23), 1200, 800],
        [seconds(2024, 5, 12, 0), 1200, 800],
      ]),
      OPTIONS,
    );
    expect(layout.sections).toHaveLength(1);
  });

  it('groups undated photos into their own section', () => {
    const layout = computeLayout(
      manifestOf([
        [seconds(2024, 5, 12), 1200, 800],
        [0, 1200, 800],
        [0, 1200, 800],
      ]),
      OPTIONS,
    );

    expect(layout.sections).toHaveLength(2);
    expect(layout.sections[1]!.dayStart).toBe(0);
    expect(layout.sections[1]!.photoCount).toBe(2);
  });

  it('reserves the header band, and spaces every section but the first', () => {
    const layout = computeLayout(
      manifestOf([
        [seconds(2024, 5, 12), 1200, 800],
        [seconds(2024, 5, 11), 1200, 800],
      ]),
      OPTIONS,
    );

    const [first, second] = layout.sections as [typeof layout.sections[0], typeof layout.sections[0]];
    expect(first.headerY).toBe(0);
    expect(layout.y[0]).toBe(DEFAULT_LAYOUT.headerHeight);
    expect(second.headerY).toBe(first.endY + DEFAULT_LAYOUT.sectionSpacing);
  });

  it('never lets a row span two days', () => {
    const layout = computeLayout(
      manifestOf([
        [seconds(2024, 5, 12), 1200, 800],
        [seconds(2024, 5, 11), 1200, 800],
      ]),
      OPTIONS,
    );
    expect(layout.rows).toHaveLength(2);
  });
});

describe('total height', () => {
  it('does not count the trailing gap after the last row', () => {
    const layout = computeLayout(sameDay(6), OPTIONS);
    const last = layout.rows.at(-1)!;
    expect(layout.totalHeight).toBeCloseTo(last.y + last.height, 4);
  });

  it('grows monotonically with the number of photos', () => {
    const small = computeLayout(sameDay(10), OPTIONS).totalHeight;
    const large = computeLayout(sameDay(100), OPTIONS).totalHeight;
    expect(large).toBeGreaterThan(small);
  });
});

describe('dayStartOf', () => {
  it('returns local midnight', () => {
    const midnight = new Date(dayStartOf(seconds(2024, 5, 12, 17)));
    expect(midnight.getHours()).toBe(0);
    expect(midnight.getDate()).toBe(12);
    expect(midnight.getMonth()).toBe(4);
  });

  it('agrees with the resolver the layout pass caches', () => {
    // The layout caches a day's bounds to avoid one Date per photo; if that
    // cache ever drifted from the plain calculation, days would split wrongly.
    const times: [number, number, number][] = [];
    for (let day = 20; day >= 1; day--) {
      times.push([seconds(2024, 3, day, 3), 1200, 800]);
      times.push([seconds(2024, 3, day, 22), 1200, 800]);
    }

    const layout = computeLayout(manifestOf(times), OPTIONS);
    expect(layout.sections).toHaveLength(20);
    layout.sections.forEach((section, i) => {
      expect(section.dayStart).toBe(dayStartOf(seconds(2024, 3, 20 - i, 3)));
    });
  });
});

describe('firstRowAt', () => {
  it('finds the first row still visible at a scroll offset', () => {
    const layout = computeLayout(sameDay(60), OPTIONS);

    expect(firstRowAt(layout, 0)).toBe(0);
    for (const index of [1, 3, 5]) {
      const row = layout.rows[index]!;
      // Just inside the row: it is the first whose bottom edge is at or below.
      expect(firstRowAt(layout, row.y + 1)).toBe(index);
      // Exactly at its bottom edge, it still counts as visible.
      expect(firstRowAt(layout, row.y + row.height)).toBe(index);
    }
  });

  it('returns one past the end when scrolled beyond everything', () => {
    const layout = computeLayout(sameDay(20), OPTIONS);
    expect(firstRowAt(layout, layout.totalHeight + 5000)).toBe(layout.rows.length);
  });
});

describe('sectionAt', () => {
  it('reports the day whose header the sticky bar should show', () => {
    const layout = computeLayout(
      manifestOf([
        [seconds(2024, 5, 12), 1200, 800],
        [seconds(2024, 5, 11), 1200, 800],
        [seconds(2024, 5, 10), 1200, 800],
      ]),
      OPTIONS,
    );

    expect(sectionAt(layout, 0)?.dayStart).toBe(layout.sections[0]!.dayStart);
    expect(sectionAt(layout, layout.sections[1]!.headerY)?.dayStart).toBe(layout.sections[1]!.dayStart);
    // Between two headers, the earlier one is still the current day.
    expect(sectionAt(layout, layout.sections[1]!.headerY - 1)?.dayStart).toBe(
      layout.sections[0]!.dayStart,
    );
  });

  it('returns null for an empty layout', () => {
    expect(sectionAt(computeLayout(manifestOf([]), OPTIONS), 0)).toBeNull();
  });
});

describe('yearTicks', () => {
  it('emits one tick per year, in feed order', () => {
    const layout = computeLayout(
      manifestOf([
        [seconds(2024, 5, 12), 1200, 800],
        [seconds(2024, 1, 3), 1200, 800],
        [seconds(2023, 8, 9), 1200, 800],
        [seconds(2021, 2, 1), 1200, 800],
      ]),
      OPTIONS,
    );

    expect(yearTicks(layout).map((t) => t.year)).toEqual([2024, 2023, 2021]);
  });

  it('places each tick as a fraction of the total height, 0 to 1', () => {
    const layout = computeLayout(
      manifestOf([
        [seconds(2024, 5, 12), 1200, 800],
        [seconds(2022, 5, 12), 1200, 800],
      ]),
      OPTIONS,
    );

    const ticks = yearTicks(layout);
    expect(ticks[0]!.offset).toBe(0);
    for (const tick of ticks) {
      expect(tick.offset).toBeGreaterThanOrEqual(0);
      expect(tick.offset).toBeLessThanOrEqual(1);
      expect(tick.y).toBeCloseTo(tick.offset * layout.totalHeight, 3);
    }
  });

  it('skips the undated section, which belongs to no year', () => {
    const layout = computeLayout(
      manifestOf([
        [seconds(2024, 5, 12), 1200, 800],
        [0, 1200, 800],
      ]),
      OPTIONS,
    );
    expect(yearTicks(layout).map((t) => t.year)).toEqual([2024]);
  });
});

describe('scale', () => {
  it('lays out 50 000 photos quickly enough to redo on every resize', () => {
    const count = 50_000;
    const ids = new Uint32Array(count);
    const times = new Uint32Array(count);
    const widths = new Uint16Array(count);
    const heights = new Uint16Array(count);

    // Roughly 60 photos a day, walking backwards — a realistic large library.
    let time = seconds(2024, 12, 31);
    for (let i = 0; i < count; i++) {
      ids[i] = i + 1;
      times[i] = time;
      widths[i] = 1200;
      heights[i] = 800;
      if (i % 60 === 59) time -= 86_400;
    }

    const started = performance.now();
    const layout = computeLayout(makeManifest({ count, ids, times, widths, heights }), OPTIONS);
    const elapsed = performance.now() - started;

    expect(layout.sections.length).toBeGreaterThan(800);
    expect(layout.totalHeight).toBeGreaterThan(0);
    // Generous next to the ~8 ms the README quotes: this is a regression guard
    // against an accidental O(n²), not a benchmark.
    expect(elapsed).toBeLessThan(500);
  });
});

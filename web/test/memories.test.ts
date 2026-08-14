import { describe, expect, it } from 'vitest';
import { makeManifest, type Manifest } from '../src/api/client';
import { MEMORY_YEARS, pickMemories } from '../src/gallery/memories';

/** Epoch seconds, local time — the manifest's unit. */
const secs = (d: Date): number => Math.floor(d.getTime() / 1000);

function daysAgoFrom(now: Date, yearsAgo: number, hour = 10): Date {
  const d = new Date(now);
  d.setFullYear(d.getFullYear() - yearsAgo);
  d.setHours(hour, 0, 0, 0);
  return d;
}

/** A manifest from explicit dates, sorted newest first the way the server sends. */
function manifestFrom(dates: Date[]): Manifest {
  const sorted = [...dates].sort((a, b) => b.getTime() - a.getTime());
  const count = sorted.length;
  const ids = new Uint32Array(count);
  const times = new Uint32Array(count);

  sorted.forEach((date, i) => {
    ids[i] = i + 1;
    times[i] = secs(date);
  });

  return makeManifest({ count, ids, times });
}

const NOW = new Date(2026, 6, 15, 14, 30);

describe('pickMemories', () => {
  it('finds nothing in an empty manifest', () => {
    expect(pickMemories(makeManifest({ count: 0, ids: new Uint32Array(0) }), NOW)).toEqual([]);
  });

  it('finds nothing when this date holds no photos from earlier years', () => {
    const manifest = manifestFrom([
      new Date(2026, 6, 15, 9),
      new Date(2025, 6, 14, 9),
      new Date(2024, 0, 1, 9),
    ]);
    expect(pickMemories(manifest, NOW)).toEqual([]);
  });

  it('picks photos taken on this date in earlier years', () => {
    const manifest = manifestFrom([
      daysAgoFrom(NOW, 1, 9),
      daysAgoFrom(NOW, 1, 17),
      daysAgoFrom(NOW, 2, 12),
      new Date(2026, 6, 15, 8),
      new Date(2025, 6, 14, 8),
    ]);

    const memories = pickMemories(manifest, NOW);
    expect(memories).toHaveLength(3);
    expect(new Set(memories.map((m) => m.yearsAgo))).toEqual(new Set([1, 2]));
  });

  it('never includes today itself', () => {
    const manifest = manifestFrom([new Date(2026, 6, 15, 9), daysAgoFrom(NOW, 1)]);
    const memories = pickMemories(manifest, NOW);

    expect(memories).toHaveLength(1);
    expect(memories[0]!.yearsAgo).toBe(1);
  });

  it('looks back only as far as MEMORY_YEARS', () => {
    const tooOld = MEMORY_YEARS[MEMORY_YEARS.length - 1]! + 1;
    const manifest = manifestFrom([daysAgoFrom(NOW, tooOld)]);
    expect(pickMemories(manifest, NOW)).toEqual([]);
  });

  it('excludes a photo from the day either side', () => {
    const before = daysAgoFrom(NOW, 1);
    before.setDate(before.getDate() - 1);
    const after = daysAgoFrom(NOW, 1);
    after.setDate(after.getDate() + 1);

    expect(pickMemories(manifestFrom([before, after]), NOW)).toEqual([]);
  });

  it('includes a photo at either edge of the day', () => {
    const start = daysAgoFrom(NOW, 1, 0);
    const end = daysAgoFrom(NOW, 1, 23);
    end.setMinutes(59, 59, 0);

    expect(pickMemories(manifestFrom([start, end]), NOW)).toHaveLength(2);
  });

  it('ignores undated photos, which carry 0 and sort last', () => {
    const count = 3;
    const ids = new Uint32Array([1, 2, 3]);
    const times = new Uint32Array([secs(daysAgoFrom(NOW, 1)), 0, 0]);

    const memories = pickMemories(makeManifest({ count, ids, times }), NOW);
    expect(memories).toHaveLength(1);
    expect(memories[0]!.id).toBe(1);
  });

  it('points at the right manifest position, so opening one lands in the feed', () => {
    const manifest = manifestFrom([
      new Date(2026, 6, 15, 9),
      daysAgoFrom(NOW, 1, 11),
      new Date(2024, 0, 1),
    ]);

    for (const memory of pickMemories(manifest, NOW)) {
      expect(manifest.ids[memory.index]).toBe(memory.id);
      expect(manifest.times[memory.index]).toBe(memory.time);
    }
  });

  it('is stable within a day, so a rescan does not reshuffle mid-scroll', () => {
    const manifest = manifestFrom(
      Array.from({ length: 60 }, (_, i) => daysAgoFrom(NOW, 1, i % 24)),
    );

    const first = pickMemories(manifest, NOW).map((m) => m.id);
    const second = pickMemories(manifest, new Date(2026, 6, 15, 22, 5)).map((m) => m.id);
    expect(second).toEqual(first);
  });

  it('picks a different set on a different day', () => {
    const dates = Array.from({ length: 60 }, (_, i) => daysAgoFrom(NOW, 1, i % 24));
    const sameDayNextYear = new Date(2027, 6, 15, 14, 30);
    const shifted = dates.map((d) => {
      const copy = new Date(d);
      copy.setFullYear(copy.getFullYear() + 1);
      return copy;
    });

    const today = pickMemories(manifestFrom(dates), NOW).map((m) => m.id);
    const tomorrow = pickMemories(manifestFrom(shifted), sameDayNextYear).map((m) => m.id);
    expect(tomorrow).not.toEqual(today);
  });

  it('caps the strip and shares the budget across years', () => {
    // A busy day three years ago must not crowd out the single photo from last
    // year — every year that has something gets an equal share first.
    const dates = [
      daysAgoFrom(NOW, 1, 9),
      ...Array.from({ length: 80 }, (_, i) => daysAgoFrom(NOW, 3, i % 24)),
    ];

    const memories = pickMemories(manifestFrom(dates), NOW);
    expect(memories.length).toBeLessThanOrEqual(12);
    expect(memories.some((m) => m.yearsAgo === 1)).toBe(true);
    expect(memories.filter((m) => m.yearsAgo === 3).length).toBeGreaterThan(1);
  });

  it('hands unused budget to the years that have more', () => {
    // Only one year has photos, so it should get the whole allowance rather
    // than a third of it.
    const dates = Array.from({ length: 40 }, (_, i) => daysAgoFrom(NOW, 2, i % 24));
    expect(pickMemories(manifestFrom(dates), NOW)).toHaveLength(12);
  });

  it('reads oldest first within a year', () => {
    const dates = [
      daysAgoFrom(NOW, 1, 8),
      daysAgoFrom(NOW, 1, 13),
      daysAgoFrom(NOW, 1, 19),
    ];

    const times = pickMemories(manifestFrom(dates), NOW)
      .filter((m) => m.yearsAgo === 1)
      .map((m) => m.time);
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  it('has no counterpart for 29 February in a common year', () => {
    // `setFullYear` rolls 29 Feb forward to 1 March, which is a different day —
    // so that year simply has no memory rather than the wrong one.
    const leapDay = new Date(2028, 1, 29, 12);
    const yearBefore = new Date(2027, 1, 28, 12);

    const memories = pickMemories(manifestFrom([yearBefore]), leapDay);
    expect(memories.every((m) => m.yearsAgo !== 1)).toBe(true);
  });
});

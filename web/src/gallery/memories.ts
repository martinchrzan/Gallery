import type { Manifest } from '../api/client';

/**
 * "On this day" — the handful of photos taken on today's date in earlier years.
 *
 * Computed entirely on the client. The manifest already carries every capture
 * time, sorted newest first, so a day's photos are one binary search away and
 * the strip costs no extra request and no server work at all.
 */

/** How far back the strip looks, nearest year first. */
export const MEMORY_YEARS = [1, 2, 3];
/** Most tiles the strip will ever show, across all years. */
const MAX_TILES = 12;

export interface Memory {
  /** Position in the manifest, so opening one lands in the main feed. */
  index: number;
  id: number;
  /** 1, 2 or 3 — what the tile labels itself with. */
  yearsAgo: number;
  /** Capture time, epoch seconds. */
  time: number;
}

/**
 * First position whose timestamp is below `seconds`, in a manifest sorted
 * newest first. Undated photos carry 0 and sort last, so they fall out of every
 * range on their own.
 */
function firstBelow(times: Uint32Array, count: number, seconds: number): number {
  let lo = 0;
  let hi = count;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid]! >= seconds) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * A small deterministic PRNG (mulberry32), seeded from the date.
 *
 * The selection has to be random — a day with 200 photos should not always show
 * the same three — but it must also be *stable*: the strip is rebuilt whenever
 * the manifest reloads after a scan, and a shuffle on every rebuild would swap
 * the photos out from under someone mid-scroll. Seeding by day gives a fresh
 * pick each morning and a fixed one within the day.
 */
function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher–Yates over a copy, so the caller's order is untouched. */
function shuffled<T>(items: T[], random: () => number): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/**
 * A random sample of the photos taken on today's date in each of the previous
 * {@link MEMORY_YEARS} years, nearest year first and chronological within a
 * year. Empty when nothing was taken on this date — which is the common case,
 * and the caller renders nothing at all.
 */
export function pickMemories(manifest: Manifest, now: Date = new Date()): Memory[] {
  if (manifest.count === 0) return [];

  const today = new Date(now);
  today.setHours(0, 0, 0, 0);

  const random = seededRandom(Math.floor(today.getTime() / 86_400_000) * 2_654_435_761);

  const groups: Memory[][] = [];
  for (const yearsAgo of MEMORY_YEARS) {
    const dayStart = new Date(today);
    dayStart.setFullYear(dayStart.getFullYear() - yearsAgo);
    // 29 February has no counterpart in a common year, and `setFullYear` rolls
    // it forward to 1 March — a different day. That year simply has no memory.
    if (dayStart.getDate() !== today.getDate()) continue;

    const dayEnd = new Date(dayStart);
    dayEnd.setDate(dayEnd.getDate() + 1);

    // Newest first, so the *end* of the day bounds the start of the range.
    const start = firstBelow(manifest.times, manifest.count, Math.floor(dayEnd.getTime() / 1000));
    const end = firstBelow(manifest.times, manifest.count, Math.floor(dayStart.getTime() / 1000));
    if (start >= end) continue;

    const candidates: Memory[] = [];
    for (let i = start; i < end; i++) {
      candidates.push({ index: i, id: manifest.ids[i]!, yearsAgo, time: manifest.times[i]! });
    }
    groups.push(shuffled(candidates, random));
  }

  if (groups.length === 0) return [];

  // Every year that has something gets an equal share first, so a busy day three
  // years ago cannot crowd out the single photo from last year. Whatever budget
  // the smaller years leave behind is then handed round to those with more.
  const share = Math.max(1, Math.floor(MAX_TILES / groups.length));
  const taken = groups.map((group) => group.slice(0, share));
  let total = taken.reduce((sum, group) => sum + group.length, 0);

  while (total < MAX_TILES) {
    let added = false;
    for (let i = 0; i < groups.length && total < MAX_TILES; i++) {
      const next = groups[i]![taken[i]!.length];
      if (!next) continue;
      taken[i]!.push(next);
      total++;
      added = true;
    }
    if (!added) break;
  }

  // Within a year the photos read as the day they came from, oldest first.
  return taken.flatMap((group) => group.sort((a, b) => a.time - b.time));
}

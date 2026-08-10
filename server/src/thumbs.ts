import fsp from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { getImagePool, WorkerCrashError } from './workers/pool.js';

/**
 * Whitelisted thumbnail heights. An open-ended `?h=` would let anyone fill the
 * disk with one-pixel-apart variants, so only these three exist:
 *   320  grid tile          640  grid tile on HiDPI          1600 lightbox preview
 */
export const THUMB_SIZES = [320, 640, 1600] as const;
export type ThumbSize = (typeof THUMB_SIZES)[number];

export function isThumbSize(value: unknown): value is ThumbSize {
  return THUMB_SIZES.includes(Number(value) as ThumbSize);
}

/**
 * A thumbnail that could not be produced.
 *
 * `fatal` separates "libvips refused this image" from "libvips died on this
 * image". The second kind is worth remembering: the file is a live grenade, and
 * re-rendering it on every request would cost a worker process each time.
 */
export class ThumbError extends Error {
  readonly fatal: boolean;

  constructor(message: string, fatal: boolean) {
    super(message);
    this.name = 'ThumbError';
    this.fatal = fatal;
  }
}

/** Coalesces concurrent requests for the same thumbnail onto one render. */
const inFlight = new Map<string, Promise<string>>();

export function thumbPath(contentKey: string, size: ThumbSize): string {
  return path.join(config().thumbDir, String(size), contentKey.slice(0, 2), `${contentKey}.webp`);
}

/**
 * How a source becomes pixels. A video needs a poster frame pulled out of it
 * first; everything downstream — the cache key, the WebP, the HTTP response —
 * is then identical for both.
 */
export interface ThumbSource {
  /** True when `absSource` is a video and the tile is a frame from it. */
  video: boolean;
  /** Runtime in ms, when known; picks which frame the poster comes from. */
  durationMs: number | null;
}

const IMAGE_SOURCE: ThumbSource = { video: false, durationMs: null };

/**
 * Returns the on-disk path of a cached thumbnail, rendering it on first sight.
 * Subsequent calls are a plain `stat` hit.
 */
export async function getThumb(
  absSource: string,
  contentKey: string,
  size: ThumbSize,
  source: ThumbSource = IMAGE_SOURCE,
): Promise<string> {
  const dest = thumbPath(contentKey, size);

  try {
    const stat = await fsp.stat(dest);
    if (stat.size > 0) return dest;
  } catch {
    // Cache miss — fall through and render.
  }

  const cacheKey = `${size}:${contentKey}`;
  const existing = inFlight.get(cacheKey);
  if (existing) return existing;

  const job = renderThumb(absSource, dest, size, source).finally(() => inFlight.delete(cacheKey));
  inFlight.set(cacheKey, job);
  return job;
}

/**
 * Renders through the worker pool. Nothing in this process ever hands bytes to
 * libvips, so a file that aborts the decoder costs one worker, not the server.
 * The pool also bounds how many renders run at once.
 */
async function renderThumb(
  absSource: string,
  dest: string,
  size: ThumbSize,
  source: ThumbSource,
): Promise<string> {
  try {
    await getImagePool().renderThumb({ absPath: absSource, dest, size, ...source });
  } catch (err) {
    throw new ThumbError((err as Error).message, err instanceof WorkerCrashError);
  }
  return dest;
}

/** Removes every cached size for a photo (called when its source disappears). */
export async function deleteThumbs(contentKey: string): Promise<void> {
  await Promise.all(
    THUMB_SIZES.map((size) => fsp.rm(thumbPath(contentKey, size), { force: true }).catch(() => {})),
  );
}

/** True when the grid-size thumbnail already exists (used by the pre-warm pass). */
export async function hasThumb(contentKey: string, size: ThumbSize): Promise<boolean> {
  try {
    const stat = await fsp.stat(thumbPath(contentKey, size));
    return stat.size > 0;
  } catch {
    return false;
  }
}

export async function clearThumbCache(): Promise<void> {
  await fsp.rm(config().thumbDir, { recursive: true, force: true });
  await fsp.mkdir(config().thumbDir, { recursive: true });
}

export interface CacheStats {
  files: number;
  bytes: number;
}

export async function thumbCacheStats(): Promise<CacheStats> {
  let files = 0;
  let bytes = 0;

  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() && entry.name.endsWith('.webp')) {
        files++;
        try {
          bytes += (await fsp.stat(full)).size;
        } catch {
          // Deleted underneath us; ignore.
        }
      }
    }
  };

  await walk(config().thumbDir);
  return { files, bytes };
}

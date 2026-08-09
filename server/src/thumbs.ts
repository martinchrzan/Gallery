import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { config } from './config.js';

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

// libvips is already multi-threaded per operation; running one job per core on
// top of that just thrashes. Cap concurrent jobs and let sharp use the rest.
const MAX_CONCURRENT = Math.max(2, Math.min(8, (os.cpus().length || 4) - 1));
sharp.concurrency(Math.max(1, Math.floor((os.cpus().length || 4) / 2)));
// Long scans stream thousands of distinct files; the pixel cache only wastes RAM.
sharp.cache({ files: 0, items: 0, memory: 64 });

let active = 0;
const waiting: (() => void)[] = [];
/** Coalesces concurrent requests for the same thumbnail onto one render. */
const inFlight = new Map<string, Promise<string>>();

async function acquire(): Promise<void> {
  if (active < MAX_CONCURRENT) {
    active++;
    return;
  }
  await new Promise<void>((resolve) => waiting.push(resolve));
  active++;
}

function release(): void {
  active--;
  waiting.shift()?.();
}

export function thumbPath(contentKey: string, size: ThumbSize): string {
  return path.join(config().thumbDir, String(size), contentKey.slice(0, 2), `${contentKey}.webp`);
}

/**
 * Returns the on-disk path of a cached thumbnail, rendering it on first sight.
 * Subsequent calls are a plain `stat` hit.
 */
export async function getThumb(
  absSource: string,
  contentKey: string,
  size: ThumbSize,
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

  const job = renderThumb(absSource, dest, size).finally(() => inFlight.delete(cacheKey));
  inFlight.set(cacheKey, job);
  return job;
}

async function renderThumb(absSource: string, dest: string, size: ThumbSize): Promise<string> {
  await acquire();
  try {
    await fsp.mkdir(path.dirname(dest), { recursive: true });

    const buffer = await sharp(absSource, { failOn: 'none', animated: false })
      // `rotate()` with no argument applies the EXIF orientation and strips it,
      // so the browser never double-rotates.
      .rotate()
      .resize({
        height: size,
        width: size * 3,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .webp({ quality: size >= 1600 ? 82 : 78, effort: 4 })
      .toBuffer();

    // Write to a temp name first: a crash mid-write must never leave a
    // truncated file that later looks like a valid cache hit.
    const tmp = `${dest}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    await fsp.writeFile(tmp, buffer);
    await fsp.rename(tmp, dest).catch(async (err: NodeJS.ErrnoException) => {
      // Another process won the race; its file is equally valid.
      await fsp.rm(tmp, { force: true });
      if (err.code !== 'EEXIST' && err.code !== 'EPERM') throw err;
    });

    return dest;
  } finally {
    release();
  }
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

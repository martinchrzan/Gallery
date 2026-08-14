import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';

/** Formats sharp can decode and therefore thumbnail. */
export const SUPPORTED_EXTS = new Set([
  '.jpg',
  '.jpeg',
  '.jpe',
  '.png',
  '.webp',
  '.avif',
  '.gif',
  '.tif',
  '.tiff',
]);

/**
 * Video containers that join the gallery feed.
 *
 * Wider than what a browser will actually play: the poster frame comes from
 * ffmpeg, which reads all of these, so an `.avi` still gets a proper tile in the
 * chronological feed and a download button. The lightbox says so plainly if the
 * browser then refuses the stream itself.
 */
export const VIDEO_EXTS = new Set([
  '.mp4',
  '.m4v',
  '.mov',
  '.webm',
  '.ogv',
  '.3gp',
  '.3g2',
  '.mkv',
  '.avi',
  '.mpg',
  '.mpeg',
  '.mts',
  '.m2ts',
  '.wmv',
  '.flv',
]);

/**
 * Image types we recognise but cannot thumbnail with the stock libvips build.
 * They show up in Files (downloadable, with a placeholder tile) but never in
 * the gallery feed.
 */
export const UNSUPPORTED_IMAGE_EXTS = new Set([
  '.heic',
  '.heif',
  '.cr2',
  '.cr3',
  '.nef',
  '.arw',
  '.dng',
  '.orf',
  '.rw2',
  '.raf',
  '.pef',
  '.srw',
]);

export function isSupportedImage(name: string): boolean {
  return SUPPORTED_EXTS.has(path.extname(name).toLowerCase());
}

export function isUnsupportedImage(name: string): boolean {
  return UNSUPPORTED_IMAGE_EXTS.has(path.extname(name).toLowerCase());
}

export function isSupportedVideo(name: string): boolean {
  return VIDEO_EXTS.has(path.extname(name).toLowerCase());
}

/** Anything the scanner puts in the index — photos and videos alike. */
export function isIndexableMedia(name: string): boolean {
  return isSupportedImage(name) || isSupportedVideo(name);
}

export class PathError extends Error {
  readonly statusCode = 403;
}

/** Reserved device names on Windows — a file called `con.jpg` cannot be created. */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** Characters no Windows path may contain. `/` and `\` are separators anywhere. */
const FORBIDDEN_CHARS = '<>:"/|?*';

/**
 * Reduces a client-supplied name to a single safe path segment — for anything
 * this server creates inside the library, which today means an uploaded file
 * and a new folder.
 *
 * No directory part survives, nor any separator, nor anything Windows rejects,
 * and never a dotfile: the scanner, the watcher and the file browser all skip
 * those, so a name beginning with a dot would land somewhere invisible.
 *
 * Returns null when nothing usable is left, so each caller can answer in its
 * own terms rather than inheriting an error status from here.
 */
export function safeSegment(raw: string, maxLength = 150): string | null {
  const base = path.basename(String(raw).replace(/\\/g, '/'));

  // Character by character rather than a regex: the set to strip includes the
  // control characters, and a literal NUL in a source file is its own hazard.
  const cleaned = [...base]
    .map((ch) => (ch < ' ' || FORBIDDEN_CHARS.includes(ch) ? '_' : ch))
    .join('')
    .replace(/^[.\s]+/, '')
    // Windows silently drops a trailing dot or space, which would leave the
    // name on disk differing from the one we report back.
    .replace(/[.\s]+$/, '');

  const suffix = path.extname(cleaned);
  const ext = suffix.slice(0, 24);
  const stem = cleaned.slice(0, cleaned.length - suffix.length).slice(0, maxLength).trim();
  if (stem === '') return null;

  return `${WINDOWS_RESERVED.test(stem) ? `_${stem}` : stem}${ext}`;
}

/** Normalises a client-supplied relative path to POSIX form with no leading slash. */
export function toRelPosix(input: string): string {
  return input.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
}

/**
 * Resolves a client-supplied relative path against the photo root.
 *
 * Rejects absolute paths, drive letters, UNC prefixes, NUL bytes and any `..`
 * segment before resolving, then verifies containment. This is the *syntactic*
 * guard — call {@link realpathWithin} as well before opening anything, so a
 * symlink cannot point outside the root.
 */
export function resolveWithinRoot(relInput: string | undefined | null): {
  rel: string;
  abs: string;
} {
  const root = config().photosRoot;
  const raw = (relInput ?? '').trim();

  if (raw.includes('\0')) throw new PathError('Invalid path');

  const rel = toRelPosix(raw);
  if (rel === '') return { rel: '', abs: root };

  if (path.isAbsolute(rel) || /^[a-zA-Z]:/.test(rel) || rel.startsWith('//')) {
    throw new PathError('Absolute paths are not allowed');
  }
  if (rel.split('/').some((segment) => segment === '..' || segment === '.')) {
    throw new PathError('Path traversal is not allowed');
  }

  const abs = path.resolve(root, rel);
  if (!isInside(root, abs)) throw new PathError('Path escapes the photo root');

  return { rel, abs };
}

/** True when `target` is `root` itself or lives underneath it. */
export function isInside(root: string, target: string): boolean {
  const rootNorm = path.resolve(root);
  const targetNorm = path.resolve(target);
  if (rootNorm === targetNorm) return true;
  const withSep = rootNorm.endsWith(path.sep) ? rootNorm : rootNorm + path.sep;
  // Windows paths are case-insensitive; comparing raw would let `C:\PHOTOS\..`
  // style differences slip through.
  return process.platform === 'win32'
    ? targetNorm.toLowerCase().startsWith(withSep.toLowerCase())
    : targetNorm.startsWith(withSep);
}

/**
 * Resolves symlinks and re-checks containment. Use this immediately before any
 * read of a client-addressable path.
 */
export async function realpathWithin(abs: string): Promise<string> {
  let real: string;
  try {
    real = await fsp.realpath(abs);
  } catch {
    throw new PathError('Not found');
  }
  if (!isInside(config().photosRoot, real)) {
    throw new PathError('Path escapes the photo root');
  }
  return real;
}

/** Synchronous variant for the scanner's hot loop. */
export function realpathWithinSync(abs: string): string | null {
  try {
    const real = fs.realpathSync.native(abs);
    return isInside(config().photosRoot, real) ? real : null;
  } catch {
    return null;
  }
}

/** Absolute on-disk path for a stored relative path. */
export function absFromRel(rel: string): string {
  return path.resolve(config().photosRoot, rel.replace(/\//g, path.sep));
}

/** Stored relative path (POSIX) for an absolute path inside the root. */
export function relFromAbs(abs: string): string {
  return toRelPosix(path.relative(config().photosRoot, abs));
}

/** The parent of a relative path, or null at the root. */
export function parentOf(rel: string): string | null {
  if (rel === '') return null;
  const idx = rel.lastIndexOf('/');
  return idx === -1 ? '' : rel.slice(0, idx);
}

/** Directory names skipped entirely by the scanner and the folder tree. */
const IGNORED_DIRS = new Set([
  '.git',
  'node_modules',
  '$RECYCLE.BIN',
  'System Volume Information',
  '@eaDir',
  '.thumbnails',
]);

export function isIgnoredDir(name: string): boolean {
  return name.startsWith('.') || IGNORED_DIRS.has(name);
}

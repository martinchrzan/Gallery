import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  isIgnoredDir,
  isIndexableMedia,
  isInside,
  isSupportedImage,
  isSupportedVideo,
  isUnsupportedImage,
  parentOf,
  PathError,
  resolveWithinRoot,
  safeSegment,
  toRelPosix,
} from '../../src/paths.js';
import { TEST_PHOTOS_ROOT } from '../setup.js';

describe('extension classification', () => {
  it('accepts the image types libvips can decode, case-insensitively', () => {
    for (const name of ['a.jpg', 'a.JPEG', 'a.png', 'a.WebP', 'a.avif', 'a.gif', 'a.tiff']) {
      expect(isSupportedImage(name), name).toBe(true);
    }
  });

  it('classifies HEIC and RAW as recognised but unthumbnailable', () => {
    for (const name of ['a.heic', 'a.HEIF', 'a.cr3', 'a.nef', 'a.arw', 'a.dng']) {
      expect(isUnsupportedImage(name), name).toBe(true);
      expect(isSupportedImage(name), name).toBe(false);
      // They are browsable in Files but must never enter the gallery feed.
      expect(isIndexableMedia(name), name).toBe(false);
    }
  });

  it('accepts video containers wider than what a browser plays', () => {
    for (const name of ['a.mp4', 'a.MOV', 'a.mkv', 'a.avi', 'a.wmv', 'a.m2ts']) {
      expect(isSupportedVideo(name), name).toBe(true);
      expect(isIndexableMedia(name), name).toBe(true);
    }
  });

  it('rejects everything else', () => {
    for (const name of ['notes.txt', 'archive.zip', 'a.jpg.txt', 'noextension', 'a.psd']) {
      expect(isIndexableMedia(name), name).toBe(false);
    }
  });
});

describe('safeSegment', () => {
  it('keeps an ordinary name unchanged', () => {
    expect(safeSegment('holiday.jpg')).toBe('holiday.jpg');
    expect(safeSegment('Trip to Norway')).toBe('Trip to Norway');
  });

  it('strips every directory part, on either separator', () => {
    expect(safeSegment('../../etc/passwd')).toBe('passwd');
    expect(safeSegment('..\\..\\windows\\system32\\evil.jpg')).toBe('evil.jpg');
    expect(safeSegment('a/b/c.jpg')).toBe('c.jpg');
    expect(safeSegment('/absolute/path.jpg')).toBe('path.jpg');
  });

  it('replaces characters Windows forbids', () => {
    expect(safeSegment('a<b>c:d"e|f?g*h.jpg')).toBe('a_b_c_d_e_f_g_h.jpg');
  });

  it('replaces control characters, NUL included', () => {
    expect(safeSegment('bad\u0000name.jpg')).toBe('bad_name.jpg');
    expect(safeSegment('tab\tsep.jpg')).toBe('tab_sep.jpg');
  });

  it('never returns a dotfile — the scanner and browser both skip those', () => {
    expect(safeSegment('.hidden.jpg')).toBe('hidden.jpg');
    expect(safeSegment('...leading.jpg')).toBe('leading.jpg');
  });

  it('drops a trailing dot or space, which Windows would silently remove anyway', () => {
    expect(safeSegment('name.  ')).toBe('name');
    expect(safeSegment('folder.')).toBe('folder');
  });

  it('escapes reserved device names', () => {
    expect(safeSegment('con.jpg')).toBe('_con.jpg');
    expect(safeSegment('NUL')).toBe('_NUL');
    expect(safeSegment('COM1.txt')).toBe('_COM1.txt');
    // Only the exact stem is reserved — `console.jpg` is a perfectly good name.
    expect(safeSegment('console.jpg')).toBe('console.jpg');
  });

  it('returns null when nothing usable survives', () => {
    expect(safeSegment('')).toBeNull();
    expect(safeSegment('...')).toBeNull();
    expect(safeSegment('   ')).toBeNull();
    expect(safeSegment('..')).toBeNull();
  });

  it('caps the stem while keeping the extension', () => {
    const result = safeSegment(`${'a'.repeat(400)}.jpg`, 150);
    expect(result).toHaveLength(154);
    expect(result?.endsWith('.jpg')).toBe(true);
  });
});

describe('toRelPosix', () => {
  it('normalises separators and trims slashes at both ends', () => {
    expect(toRelPosix('a\\b\\c')).toBe('a/b/c');
    expect(toRelPosix('/a/b/')).toBe('a/b');
    expect(toRelPosix('///a///')).toBe('a');
    expect(toRelPosix('')).toBe('');
  });
});

describe('resolveWithinRoot', () => {
  it('treats an empty path as the root itself', () => {
    expect(resolveWithinRoot('')).toEqual({ rel: '', abs: TEST_PHOTOS_ROOT });
    expect(resolveWithinRoot(null)).toEqual({ rel: '', abs: TEST_PHOTOS_ROOT });
  });

  it('resolves a relative path under the root', () => {
    const { rel, abs } = resolveWithinRoot('Travel/Norway');
    expect(rel).toBe('Travel/Norway');
    expect(abs).toBe(path.join(TEST_PHOTOS_ROOT, 'Travel', 'Norway'));
  });

  it('rejects traversal in any spelling', () => {
    for (const attempt of ['..', '../etc', 'a/../../b', 'a/./b', '..\\..\\windows']) {
      expect(() => resolveWithinRoot(attempt), attempt).toThrow(PathError);
    }
  });

  it('rejects drive letters, which would leave the root entirely', () => {
    for (const attempt of ['C:/Windows', 'd:\\data']) {
      expect(() => resolveWithinRoot(attempt), attempt).toThrow(PathError);
    }
  });

  it('reads a leading slash as root-relative rather than absolute', () => {
    // The leading separator is stripped before resolution, so `/etc/passwd`
    // addresses `<root>/etc/passwd` — inside the library, and therefore
    // harmless — rather than the real /etc. Containment is the property that
    // matters here; rejecting the spelling is not.
    expect(resolveWithinRoot('/etc/passwd').rel).toBe('etc/passwd');
    expect(resolveWithinRoot('//server/share').rel).toBe('server/share');
    expect(isInside(TEST_PHOTOS_ROOT, resolveWithinRoot('/etc/passwd').abs)).toBe(true);
  });

  it('rejects a NUL byte, which would truncate the path at the syscall', () => {
    expect(() => resolveWithinRoot('a\u0000.jpg')).toThrow(PathError);
  });

  it('answers 403, not 500, so the error handler classifies it as the caller`s fault', () => {
    expect(new PathError('nope').statusCode).toBe(403);
  });
});

describe('isInside', () => {
  it('counts the root itself as inside', () => {
    expect(isInside('/photos', '/photos')).toBe(true);
  });

  it('accepts descendants and rejects siblings', () => {
    expect(isInside('/photos', '/photos/a/b.jpg')).toBe(true);
    // The prefix matches as a string but the path is a sibling directory.
    expect(isInside('/photos', '/photos-private/secret.jpg')).toBe(false);
    expect(isInside('/photos', '/etc/passwd')).toBe(false);
  });

  it.runIf(process.platform === 'win32')('compares case-insensitively on Windows', () => {
    expect(isInside('C:\\Photos', 'c:\\photos\\a.jpg')).toBe(true);
  });
});

describe('parentOf', () => {
  it('walks up one level and stops at the root', () => {
    expect(parentOf('a/b/c')).toBe('a/b');
    expect(parentOf('a')).toBe('');
    expect(parentOf('')).toBeNull();
  });
});

describe('isIgnoredDir', () => {
  it('skips dotfolders and the usual system clutter', () => {
    for (const name of ['.git', '.thumbnails', '$RECYCLE.BIN', 'System Volume Information', '@eaDir']) {
      expect(isIgnoredDir(name), name).toBe(true);
    }
    expect(isIgnoredDir('Travel')).toBe(false);
  });
});

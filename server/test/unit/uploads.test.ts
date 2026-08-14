import { describe, expect, it } from 'vitest';
import { safeFileName } from '../../src/uploads.js';

describe('safeFileName', () => {
  it('keeps an ordinary photo or video name', () => {
    expect(safeFileName('holiday.jpg')).toBe('holiday.jpg');
    expect(safeFileName('clip.MP4')).toBe('clip.MP4');
  });

  it('accepts the types Files shows but cannot thumbnail', () => {
    // HEIC and RAW never reach the feed, but refusing to *store* them would make
    // the gallery useless as a place to put what came off the camera.
    expect(safeFileName('IMG_0001.heic')).toBe('IMG_0001.heic');
    expect(safeFileName('DSC_0002.cr3')).toBe('DSC_0002.cr3');
  });

  it('reduces a path to its last segment', () => {
    // Browsers send a bare name, but nothing stops a scripted client sending a
    // path — and the destination folder is the server's decision, not the
    // caller's.
    expect(safeFileName('../../../etc/passwd.jpg')).toBe('passwd.jpg');
    expect(safeFileName('C:\\Windows\\evil.jpg')).toBe('evil.jpg');
  });

  it('refuses a name that reduces to nothing rather than inventing one', () => {
    for (const raw of ['', '...', '   ']) {
      expect(() => safeFileName(raw), JSON.stringify(raw)).toThrow(/cannot be used/);
    }
  });

  it('refuses anything that is not a photo or a video', () => {
    for (const raw of ['notes.txt', 'payload.exe', 'archive.zip', 'index.html', 'noextension']) {
      expect(() => safeFileName(raw), raw).toThrow(/Only photos and videos/);
    }
  });

  it('refuses a double extension that only looks like an image', () => {
    expect(() => safeFileName('shell.jpg.php')).toThrow(/Only photos and videos/);
  });
});

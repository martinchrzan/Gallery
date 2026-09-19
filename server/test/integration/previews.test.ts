/**
 * Previews that failed once must not stay broken: a video's poster is not
 * hostage to one bad ffprobe read, and an admin can start any file over.
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  getDb,
  KIND_VIDEO,
  MAX_META_ATTEMPTS,
  META_DONE,
  META_FAILED,
  META_INFLIGHT,
  META_PENDING,
} from '../../src/db.js';
import { toolPath } from '../../src/video.js';
import { resetLibrary, seedLibrary, signIn, startTestApp, type TestUser } from '../helpers.js';
import { TEST_PHOTOS_ROOT } from '../setup.js';

const run = promisify(execFile);

let app: FastifyInstance;
let admin: TestUser;
let viewer: TestUser;
let photoId: number;

/** A real clip, or null where no ffmpeg is installed to make one. */
let videoId: number | null = null;

beforeAll(async () => {
  app = await startTestApp();
  await resetLibrary();
  const { byDir } = await seedLibrary();
  photoId = byDir.get('Travel/Norway')![0]!;

  admin = await signIn(app, { label: 'Ana', role: 'admin', folders: [''] });
  viewer = await signIn(app, { label: 'Guest', role: 'viewer', folders: [''] });

  const ffmpeg = await toolPath('ffmpeg');
  if (!ffmpeg) return;

  const dir = path.join(TEST_PHOTOS_ROOT, 'Clips');
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, 'clip.mp4');
  // One second — shorter than the default poster seek, so this also covers
  // the fall back to the first frame.
  await run(ffmpeg, [
    '-y',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    'testsrc=duration=1:size=320x240:rate=15',
    '-pix_fmt',
    'yuv420p',
    file,
  ]);
  const stat = await fs.stat(file);

  // Recorded the way a probe that failed once leaves it.
  const info = getDb()
    .prepare(
      `INSERT INTO photos (rel_path, dir, name, ext, size, mtime_ms, content_key, kind,
                           meta_state, meta_attempts, taken_at, taken_src)
       VALUES ('Clips/clip.mp4', 'Clips', 'clip.mp4', '.mp4', ?, ?, 'key-clip', ${KIND_VIDEO},
               ${META_FAILED}, 1, ?, 'mtime')`,
    )
    .run(stat.size, Math.round(stat.mtimeMs), Math.round(stat.mtimeMs));
  videoId = Number(info.lastInsertRowid);
}, 60_000);

afterAll(async () => {
  await app.close();
});

const post = (url: string, user: TestUser = admin) =>
  app.inject({ method: 'POST', url, headers: { cookie: user.cookie } });

const thumb = (id: number) =>
  app.inject({
    method: 'GET',
    url: `/api/media/${id}/thumb?h=320`,
    headers: { cookie: admin.cookie },
  });

function row(id: number): { meta_state: number; meta_attempts: number } {
  return getDb().prepare('SELECT meta_state, meta_attempts FROM photos WHERE id = ?').get(id) as {
    meta_state: number;
    meta_attempts: number;
  };
}

describe('a video whose probe failed', () => {
  it('still gets a poster', async (ctx) => {
    if (videoId === null) return ctx.skip();

    const res = await thumb(videoId);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/webp');
  }, 60_000);

  it('is refused without trying once it has been retired', async (ctx) => {
    if (videoId === null) return ctx.skip();

    getDb()
      .prepare('UPDATE photos SET meta_attempts = ?, content_key = ? WHERE id = ?')
      .run(MAX_META_ATTEMPTS, 'key-clip-retired', videoId);

    const res = await thumb(videoId);
    expect(res.statusCode).toBe(415);
    // A failure is not something a browser may hold on to.
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('is brought back by a repair', async (ctx) => {
    if (videoId === null) return ctx.skip();

    const res = await post(`/api/media/${videoId}/repair`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, error: null });

    // ffprobe read it this time, so the verdict and the attempts are gone.
    expect(row(videoId).meta_state).toBe(META_DONE);
    expect(row(videoId).meta_attempts).toBeLessThan(MAX_META_ATTEMPTS);
    expect((await thumb(videoId)).statusCode).toBe(200);
  }, 60_000);
});

describe('repairing one file', () => {
  it('is for admins only', async () => {
    expect((await post(`/api/media/${photoId}/repair`, viewer)).statusCode).toBe(403);
  });

  it('answers 404 for an id that is not indexed', async () => {
    expect((await post('/api/media/99999999/repair')).statusCode).toBe(404);
  });

  it('reports what went wrong when the file cannot be read', async () => {
    const info = getDb()
      .prepare(
        `INSERT INTO photos (rel_path, dir, name, ext, size, mtime_ms, content_key, kind)
         VALUES ('Travel/garbage.jpg', 'Travel', 'garbage.jpg', '.jpg', 9, 0, 'key-garbage', 0)`,
      )
      .run();
    const id = Number(info.lastInsertRowid);
    await fs.writeFile(path.join(TEST_PHOTOS_ROOT, 'Travel', 'garbage.jpg'), 'not a jpeg');

    const res = await post(`/api/media/${id}/repair`);
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; error: string | null };
    expect(body.ok).toBe(false);
    expect(body.error).toBeTruthy();
  }, 60_000);
});

describe('retrying every failed file', () => {
  it('is for admins only', async () => {
    expect((await post('/api/index/retry-failed', viewer)).statusCode).toBe(403);
  });

  it('queues each one with a fresh set of attempts, and the stats count them', async () => {
    getDb()
      .prepare('UPDATE photos SET meta_state = ?, meta_attempts = ? WHERE id = ?')
      .run(META_FAILED, MAX_META_ATTEMPTS, photoId);

    const stats = await app.inject({
      method: 'GET',
      url: '/api/stats',
      headers: { cookie: admin.cookie },
    });
    expect((stats.json() as { failed: number }).failed).toBeGreaterThanOrEqual(1);

    const res = await post('/api/index/retry-failed');
    expect(res.statusCode).toBe(200);
    expect((res.json() as { queued: number }).queued).toBeGreaterThanOrEqual(1);

    // Pending now; the background pass may already have picked it up.
    expect([META_PENDING, META_INFLIGHT, META_DONE]).toContain(row(photoId).meta_state);
    expect(row(photoId).meta_attempts).toBeLessThan(MAX_META_ATTEMPTS);
  });
});

/**
 * What a browser is allowed to assume about `/api/media/:id/...`, given that a
 * rescan can hand an id to a different file.
 */

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { getDb } from '../../src/db.js';
import { MANIFEST_FLAG_FILE_DATE, MANIFEST_RECORD_BYTES } from '../../src/routes/gallery.js';
import { resetLibrary, seedLibrary, signIn, startTestApp, type TestUser } from '../helpers.js';

let app: FastifyInstance;
let admin: TestUser;
let photoId: number;

beforeAll(async () => {
  app = await startTestApp();
  await resetLibrary();

  const { byDir } = await seedLibrary();
  photoId = byDir.get('Travel/Norway')![0]!;

  admin = await signIn(app, { label: 'Ana', role: 'admin', folders: [''] });

  // An admin's feed follows the library-wide setting, which starts empty.
  await app.inject({
    method: 'PUT',
    url: '/api/settings',
    headers: { cookie: admin.cookie },
    payload: { galleryFolders: [''] },
  });
});

afterAll(async () => {
  await app.close();
});

function thumb(headers: Record<string, string> = {}) {
  return app.inject({
    method: 'GET',
    url: `/api/media/${photoId}/thumb?h=320`,
    headers: { cookie: admin.cookie, ...headers },
  });
}

it('never promises a thumbnail is immutable', async () => {
  const res = await thumb();
  expect(res.statusCode).toBe(200);

  const cache = String(res.headers['cache-control']);
  expect(cache).not.toContain('immutable');
  expect(cache).toContain('private');

  const maxAge = Number(/max-age=(\d+)/.exec(cache)?.[1]);
  expect(maxAge).toBeGreaterThan(0);
  expect(maxAge).toBeLessThanOrEqual(3600);
});

it('answers a revalidation without resending the bytes', async () => {
  const first = await thumb();
  const etag = String(first.headers.etag);
  expect(etag).toBeTruthy();

  const again = await thumb({ 'if-none-match': etag });
  expect(again.statusCode).toBe(304);
  expect(again.rawPayload.length).toBe(0);
});

it('changes its validator when an id comes to mean a different file', async () => {
  const first = await thumb();
  expect(first.statusCode).toBe(200);
  const before = String(first.headers.etag);

  // Another file the library really has, so this still renders a thumbnail.
  const other = getDb()
    .prepare('SELECT id, rel_path, name, content_key FROM photos WHERE id <> ? LIMIT 1')
    .get(photoId) as { id: number; rel_path: string; name: string; content_key: string };

  getDb().transaction(() => {
    // `rel_path` is unique, so it has to leave its old row first.
    getDb().prepare('DELETE FROM photos WHERE id = ?').run(other.id);
    getDb()
      .prepare('UPDATE photos SET rel_path = ?, name = ?, content_key = ? WHERE id = ?')
      .run(other.rel_path, other.name, other.content_key, photoId);
  })();

  const second = await thumb();
  expect(second.statusCode).toBe(200);
  expect(String(second.headers.etag)).not.toBe(before);

  // The copy the browser holds is refused, so it refetches.
  const stale = await thumb({ 'if-none-match': before });
  expect(stale.statusCode).toBe(200);
});

it('marks a photo dated only by its file timestamp', async () => {
  getDb().prepare("UPDATE photos SET taken_src = 'mtime' WHERE id = ?").run(photoId);

  const res = await app.inject({
    method: 'GET',
    url: '/api/gallery/manifest',
    headers: { cookie: admin.cookie },
  });
  expect(res.statusCode).toBe(200);

  const flagsFor = (id: number): number => {
    const { rawPayload } = res;
    for (let at = 0; at + MANIFEST_RECORD_BYTES <= rawPayload.length; at += MANIFEST_RECORD_BYTES) {
      if (rawPayload.readUInt32LE(at) === id) return rawPayload.readUInt16LE(at + 14);
    }
    throw new Error(`photo ${id} is not in the manifest`);
  };

  expect(flagsFor(photoId) & MANIFEST_FLAG_FILE_DATE).toBe(MANIFEST_FLAG_FILE_DATE);

  // Its neighbours, which the fixture dates from EXIF, must not pick it up.
  const other = getDb().prepare('SELECT id FROM photos WHERE id <> ? LIMIT 1').get(photoId) as {
    id: number;
  };
  expect(flagsFor(other.id) & MANIFEST_FLAG_FILE_DATE).toBe(0);
});

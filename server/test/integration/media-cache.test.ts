/**
 * What a browser is allowed to assume about `/api/media/:id/...`.
 *
 * The URL names a photo by id, and an id is not a permanent name for a file:
 * `photos.id` is a plain rowid, a scan deletes the rows of files that have gone
 * and a later insert takes the freed number — and a rebuilt index reassigns
 * every id at once. A response that claimed to be immutable therefore poisoned
 * the browser's cache for a year, and a tile would show one photo and open a
 * completely different one.
 */

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { getDb } from '../../src/db.js';
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

  // Bounded, so a reassigned id corrects itself rather than sticking for a year.
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

  // Exactly what a rescan does when the file behind this row goes away and the
  // number is handed to another one: same id, a different photo entirely. Aimed
  // at a file that really is in the library, so the response is a rendered
  // thumbnail rather than the 415 a dangling row would give.
  const other = getDb()
    .prepare('SELECT id, rel_path, name, content_key FROM photos WHERE id <> ? LIMIT 1')
    .get(photoId) as { id: number; rel_path: string; name: string; content_key: string };

  getDb().transaction(() => {
    // `rel_path` is unique, so the file has to leave its old row before it can
    // arrive at this one — which is the order a rescan does it in anyway.
    getDb().prepare('DELETE FROM photos WHERE id = ?').run(other.id);
    getDb()
      .prepare('UPDATE photos SET rel_path = ?, name = ?, content_key = ? WHERE id = ?')
      .run(other.rel_path, other.name, other.content_key, photoId);
  })();

  const second = await thumb();
  expect(second.statusCode).toBe(200);
  expect(String(second.headers.etag)).not.toBe(before);

  // And the copy the browser is holding is refused, so it refetches rather than
  // going on showing the photo that used to live at this id.
  const stale = await thumb({ 'if-none-match': before });
  expect(stale.statusCode).toBe(200);
});

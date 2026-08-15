/**
 * What a browser is allowed to assume about `/api/media/:id/...`, given that a
 * rescan can hand an id to a different file.
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

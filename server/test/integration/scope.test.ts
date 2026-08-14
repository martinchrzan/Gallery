/**
 * The authorization claim the README makes, tested against the real routes:
 * a viewer confined to some folders cannot reach a photo outside them by any
 * route, and cannot learn that it exists.
 */

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MANIFEST_RECORD_BYTES } from '../../src/routes/gallery.js';
import { resetLibrary, seedLibrary, signIn, startTestApp, type TestUser } from '../helpers.js';

let app: FastifyInstance;
let admin: TestUser;
let viewer: TestUser;
let norwayId: number;
let familyId: number;
let totalPhotos: number;

beforeAll(async () => {
  app = await startTestApp();
  await resetLibrary();

  const { count, byDir } = await seedLibrary();
  totalPhotos = count;
  norwayId = byDir.get('Travel/Norway')![0]!;
  familyId = byDir.get('Family/Birthdays')![0]!;

  admin = await signIn(app, { label: 'Ana', role: 'admin', folders: [''] });
  viewer = await signIn(app, { label: 'Guest', role: 'viewer', folders: ['Travel'] });

  // The gallery feed for an admin follows the library-wide setting, so open it
  // up to everything for the comparisons below.
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

function manifestIds(body: Buffer): number[] {
  const ids: number[] = [];
  for (let offset = 0; offset + MANIFEST_RECORD_BYTES <= body.length; offset += MANIFEST_RECORD_BYTES) {
    ids.push(body.readUInt32LE(offset));
  }
  return ids;
}

async function manifestFor(user: TestUser): Promise<number[]> {
  const res = await app.inject({
    method: 'GET',
    url: '/api/gallery/manifest',
    headers: { cookie: user.cookie },
  });
  expect(res.statusCode).toBe(200);
  return manifestIds(res.rawPayload);
}

describe('the feed', () => {
  it('gives an admin the whole library', async () => {
    expect(await manifestFor(admin)).toHaveLength(totalPhotos);
  });

  it('gives a viewer only their folders', async () => {
    const ids = await manifestFor(viewer);
    expect(ids).toContain(norwayId);
    expect(ids).not.toContain(familyId);
    expect(ids.length).toBeGreaterThan(0);
    expect(ids.length).toBeLessThan(totalPhotos);
  });

  it('is sorted newest first', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/gallery/manifest',
      headers: { cookie: admin.cookie },
    });

    let previous = Number.POSITIVE_INFINITY;
    for (let o = 0; o + MANIFEST_RECORD_BYTES <= res.rawPayload.length; o += MANIFEST_RECORD_BYTES) {
      const takenAt = res.rawPayload.readUInt32LE(o + 4);
      expect(takenAt).toBeLessThanOrEqual(previous);
      previous = takenAt;
    }
  });

  it('packs each record into exactly 16 bytes', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/gallery/manifest',
      headers: { cookie: admin.cookie },
    });
    expect(res.rawPayload.length).toBe(totalPhotos * MANIFEST_RECORD_BYTES);
    expect(res.headers['x-photo-count']).toBe(String(totalPhotos));
  });

  it('keys its ETag by user, so two people never share a cached feed', async () => {
    const first = await app.inject({
      method: 'GET',
      url: '/api/gallery/manifest',
      headers: { cookie: admin.cookie },
    });
    const second = await app.inject({
      method: 'GET',
      url: '/api/gallery/manifest',
      headers: { cookie: viewer.cookie },
    });
    expect(first.headers.etag).not.toBe(second.headers.etag);

    // The admin's own validator still works.
    const revalidated = await app.inject({
      method: 'GET',
      url: '/api/gallery/manifest',
      headers: { cookie: admin.cookie, 'if-none-match': String(first.headers.etag) },
    });
    expect(revalidated.statusCode).toBe(304);

    // …and the viewer's does not unlock the admin's feed.
    const crossed = await app.inject({
      method: 'GET',
      url: '/api/gallery/manifest',
      headers: { cookie: admin.cookie, 'if-none-match': String(second.headers.etag) },
    });
    expect(crossed.statusCode).toBe(200);
  });

  it('marks the response private', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/gallery/manifest',
      headers: { cookie: viewer.cookie },
    });
    expect(res.headers['cache-control']).toContain('private');
  });
});

describe('id-addressed routes re-check scope', () => {
  const routes = (id: number): string[] => [
    `/api/photos/${id}`,
    `/api/media/${id}/thumb?h=320`,
    `/api/media/${id}/original`,
  ];

  it('serves a photo inside the viewer`s folders', async () => {
    for (const url of routes(norwayId)) {
      const res = await app.inject({ method: 'GET', url, headers: { cookie: viewer.cookie } });
      expect([200, 404].includes(res.statusCode), `${url} → ${res.statusCode}`).toBe(true);
      // 404 only ever from a missing file on disk, never from scope — the photo
      // detail route reads no file at all, so it must succeed.
      if (url.includes('/api/photos/')) expect(res.statusCode).toBe(200);
    }
  });

  it('answers 404 — not 403 — for a photo outside them', async () => {
    // Filtering the feed alone would leave the rest of the library readable by
    // anyone who counted upwards, and a 403 would confirm the id was real.
    for (const url of routes(familyId)) {
      const res = await app.inject({ method: 'GET', url, headers: { cookie: viewer.cookie } });
      expect(res.statusCode, url).toBe(404);
    }
  });

  it('leaks nothing about the photo in that answer', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/photos/${familyId}`,
      headers: { cookie: viewer.cookie },
    });
    expect(res.body).not.toMatch(/Family|Birthdays|\.jpg/);
  });

  it('walking every id yields nothing outside the viewer`s folders', async () => {
    const reachable: number[] = [];
    for (let id = 1; id <= totalPhotos + 5; id++) {
      const res = await app.inject({
        method: 'GET',
        url: `/api/photos/${id}`,
        headers: { cookie: viewer.cookie },
      });
      if (res.statusCode === 200) reachable.push(id);
    }

    const allowed = new Set(await manifestFor(viewer));
    expect(reachable.length).toBe(allowed.size);
    for (const id of reachable) expect(allowed.has(id)).toBe(true);
  });

  it('lets the admin reach the same ids', async () => {
    for (const id of [norwayId, familyId]) {
      const res = await app.inject({
        method: 'GET',
        url: `/api/photos/${id}`,
        headers: { cookie: admin.cookie },
      });
      expect(res.statusCode, String(id)).toBe(200);
    }
  });

  it('rejects a non-numeric id', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/photos/notanumber',
      headers: { cookie: admin.cookie },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('a viewer with no folders', () => {
  it('sees an empty gallery rather than the whole library', async () => {
    // An empty folder selection is an explicit choice. Reading it as "no filter"
    // would be the single worst defaulting bug this code could have.
    const nobody = await signIn(app, { label: 'Nobody', role: 'viewer', folders: [] });
    expect(await manifestFor(nobody)).toHaveLength(0);

    const res = await app.inject({
      method: 'GET',
      url: `/api/photos/${norwayId}`,
      headers: { cookie: nobody.cookie },
    });
    expect(res.statusCode).toBe(404);
  });
});

/**
 * The chunked upload protocol.
 *
 * The behaviours here are the ones a phone on a flaky connection depends on: a
 * lost reply must not duplicate bytes, a retried finish must answer the same way
 * twice, and nothing may be written outside the library or over an existing
 * photo.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resetLibrary, seedLibrary, signIn, startTestApp, type TestUser } from '../helpers.js';
import { TEST_PHOTOS_ROOT } from '../setup.js';

let app: FastifyInstance;
let admin: TestUser;

/** A real JPEG, so `finishUpload` can index it the way it would in production. */
let jpeg: Buffer;

beforeAll(async () => {
  app = await startTestApp();
  await resetLibrary();
  await seedLibrary();
  admin = await signIn(app, { label: 'Ana', role: 'admin', folders: [''] });

  const sample = (await fs.readdir(path.join(TEST_PHOTOS_ROOT, 'Travel', 'Norway')))[0]!;
  jpeg = await fs.readFile(path.join(TEST_PHOTOS_ROOT, 'Travel', 'Norway', sample));
});

afterAll(async () => {
  await app.close();
});

interface Session {
  uploadId: string;
  received: number;
  chunkSize: number;
  maxChunkSize: number;
}

async function begin(input: { path: string; name: string; size: number }) {
  return app.inject({
    method: 'POST',
    url: '/api/files/upload',
    headers: { cookie: admin.cookie },
    payload: input,
  });
}

function sendChunk(id: string, offset: number, body: Buffer) {
  return app.inject({
    method: 'POST',
    url: `/api/files/upload/${id}/chunk?offset=${offset}`,
    headers: { cookie: admin.cookie, 'content-type': 'application/octet-stream' },
    payload: body,
  });
}

const finish = (id: string) =>
  app.inject({
    method: 'POST',
    url: `/api/files/upload/${id}/finish`,
    headers: { cookie: admin.cookie },
  });

/** Uploads a whole buffer in fixed-size pieces and finishes the session. */
async function upload(dir: string, name: string, body: Buffer, pieceSize = 4096) {
  const started = await begin({ path: dir, name, size: body.length });
  expect(started.statusCode).toBe(200);
  const session = started.json() as Session;

  for (let offset = 0; offset < body.length; offset += pieceSize) {
    const res = await sendChunk(session.uploadId, offset, body.subarray(offset, offset + pieceSize));
    expect(res.statusCode, `chunk at ${offset}`).toBe(200);
  }
  return { session, finished: await finish(session.uploadId) };
}

describe('a complete upload', () => {
  it('lands in the library with its bytes intact', async () => {
    const { finished } = await upload('Family/Garden', 'uploaded.jpg', jpeg);

    expect(finished.statusCode).toBe(200);
    expect(finished.json()).toMatchObject({ name: 'uploaded.jpg', path: 'Family/Garden/uploaded.jpg' });

    const written = await fs.readFile(path.join(TEST_PHOTOS_ROOT, 'Family', 'Garden', 'uploaded.jpg'));
    expect(written.equals(jpeg)).toBe(true);
  });

  it('joins the index straight away rather than waiting for a scan', async () => {
    await upload('Family/Garden', 'indexed-now.jpg', jpeg);

    const browse = await app.inject({
      method: 'GET',
      url: '/api/files/browse?path=Family/Garden',
      headers: { cookie: admin.cookie },
    });
    const entry = browse.json().files.find((f: { name: string }) => f.name === 'indexed-now.jpg');
    expect(entry?.photoId).not.toBeNull();
  });

  it('leaves no .part file behind', async () => {
    await upload('Scans', 'clean.jpg', jpeg);

    const left = await fs.readdir(path.join(TEST_PHOTOS_ROOT, 'Scans'));
    expect(left.some((n) => n.includes('.part'))).toBe(false);
  });
});

describe('resumption', () => {
  it('answers a stale offset with where the server actually is', async () => {
    const started = await begin({ path: 'Scans', name: 'resume.jpg', size: jpeg.length });
    const session = started.json() as Session;

    await sendChunk(session.uploadId, 0, jpeg.subarray(0, 4096));

    // The reply to that chunk was "lost", so the client sends it again.
    const replayed = await sendChunk(session.uploadId, 0, jpeg.subarray(0, 4096));
    expect(replayed.statusCode).toBe(409);
    expect(replayed.json().expectedOffset).toBe(4096);

    // Carrying on from the offset it was given completes the file exactly once.
    for (let offset = 4096; offset < jpeg.length; offset += 4096) {
      expect((await sendChunk(session.uploadId, offset, jpeg.subarray(offset, offset + 4096))).statusCode).toBe(200);
    }
    expect((await finish(session.uploadId)).statusCode).toBe(200);

    const written = await fs.readFile(path.join(TEST_PHOTOS_ROOT, 'Scans', 'resume.jpg'));
    expect(written.length).toBe(jpeg.length);
    expect(written.equals(jpeg)).toBe(true);
  });

  it('refuses a chunk that would skip a gap', async () => {
    const started = await begin({ path: 'Scans', name: 'gap.jpg', size: jpeg.length });
    const session = started.json() as Session;

    const res = await sendChunk(session.uploadId, 9999, jpeg.subarray(0, 100));
    expect(res.statusCode).toBe(409);
    expect(res.json().expectedOffset).toBe(0);
  });

  it('reports progress as bytes received', async () => {
    const started = await begin({ path: 'Scans', name: 'progress.jpg', size: jpeg.length });
    const session = started.json() as Session;

    const first = await sendChunk(session.uploadId, 0, jpeg.subarray(0, 1000));
    expect(first.json().received).toBe(1000);

    const second = await sendChunk(session.uploadId, 1000, jpeg.subarray(1000, 3000));
    expect(second.json().received).toBe(3000);
  });
});

describe('finishing', () => {
  it('answers the same way twice, so a lost reply is not a failed upload', async () => {
    const { session, finished } = await upload('Scans', 'twice.jpg', jpeg);
    expect(finished.statusCode).toBe(200);

    // Every byte is already on the server; the client simply never heard so.
    const again = await finish(session.uploadId);
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual(finished.json());

    // And it did not produce a second file.
    const names = await fs.readdir(path.join(TEST_PHOTOS_ROOT, 'Scans'));
    expect(names.filter((n) => n.startsWith('twice'))).toEqual(['twice.jpg']);
  });

  it('refuses to finish a short file', async () => {
    const started = await begin({ path: 'Scans', name: 'short.jpg', size: jpeg.length });
    const session = started.json() as Session;
    await sendChunk(session.uploadId, 0, jpeg.subarray(0, 500));

    expect((await finish(session.uploadId)).statusCode).toBeGreaterThanOrEqual(400);
  });

  it('refuses an unknown session', async () => {
    expect((await finish('no-such-session')).statusCode).toBeGreaterThanOrEqual(400);
  });
});

describe('naming', () => {
  it('never overwrites — a taken name gets ` (1)` the way a file manager does', async () => {
    await upload('Family/Birthdays', 'dup.jpg', jpeg);
    const second = await upload('Family/Birthdays', 'dup.jpg', jpeg);
    const third = await upload('Family/Birthdays', 'dup.jpg', jpeg);

    expect(second.finished.json().name).toBe('dup (1).jpg');
    expect(third.finished.json().name).toBe('dup (2).jpg');

    const names = await fs.readdir(path.join(TEST_PHOTOS_ROOT, 'Family', 'Birthdays'));
    expect(names).toContain('dup.jpg');
    expect(names).toContain('dup (1).jpg');
  });

  it('strips a path from the name rather than honouring it', async () => {
    const started = await begin({
      path: 'Scans',
      name: '../../escaped.jpg',
      size: jpeg.length,
    });
    expect(started.statusCode).toBe(200);

    const session = started.json() as Session;
    for (let o = 0; o < jpeg.length; o += 8192) {
      await sendChunk(session.uploadId, o, jpeg.subarray(o, o + 8192));
    }
    await finish(session.uploadId);

    // It became a plain file inside the destination folder…
    expect(await fs.stat(path.join(TEST_PHOTOS_ROOT, 'Scans', 'escaped.jpg')).catch(() => null)).not.toBeNull();
    // …and nothing appeared above the library root.
    const parent = path.dirname(TEST_PHOTOS_ROOT);
    expect(await fs.stat(path.join(parent, 'escaped.jpg')).catch(() => null)).toBeNull();
  });

  it('refuses a destination outside the library', async () => {
    const res = await begin({ path: '../../elsewhere', name: 'x.jpg', size: 10 });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });

  it('refuses anything that is not a photo or a video', async () => {
    for (const name of ['notes.txt', 'payload.exe', 'shell.jpg.php']) {
      const res = await begin({ path: 'Scans', name, size: 10 });
      expect(res.statusCode, name).toBeGreaterThanOrEqual(400);
      expect(res.json().error).toMatch(/photos and videos/i);
    }
  });
});

describe('cancelling', () => {
  it('discards its own partial file', async () => {
    const dir = path.join(TEST_PHOTOS_ROOT, 'Scans');
    // Other tests here deliberately leave sessions open, and their `.part` files
    // correctly survive until the sweep — so only the ones this test creates can
    // be asserted on.
    const before = new Set(await fs.readdir(dir));

    const started = await begin({ path: 'Scans', name: 'aborted.jpg', size: jpeg.length });
    const session = started.json() as Session;
    await sendChunk(session.uploadId, 0, jpeg.subarray(0, 4096));

    const staged = (await fs.readdir(dir)).filter((n) => !before.has(n));
    expect(staged, 'the chunk should have staged a hidden .part file').toHaveLength(1);
    expect(staged[0]).toMatch(/^\.upload-.*\.part$/);

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/files/upload/${session.uploadId}`,
      headers: { cookie: admin.cookie },
    });
    expect(res.statusCode).toBe(200);

    const after = (await fs.readdir(dir)).filter((n) => !before.has(n));
    expect(after).toHaveLength(0);
  });
});

describe('a viewer', () => {
  it('cannot start an upload at all', async () => {
    const viewer = await signIn(app, { label: 'Guest', role: 'viewer', folders: ['Travel'] });

    const res = await app.inject({
      method: 'POST',
      url: '/api/files/upload',
      headers: { cookie: viewer.cookie },
      payload: { path: 'Travel', name: 'x.jpg', size: 10 },
    });
    expect(res.statusCode).toBe(403);
  });
});

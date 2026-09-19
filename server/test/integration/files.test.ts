/**
 * Containment for the path-addressed routes: nothing a client can spell reaches
 * outside `photosRoot`, in either direction — reading or writing.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resetLibrary, seedLibrary, signIn, startTestApp, type TestUser } from '../helpers.js';
import { TEST_PHOTOS_ROOT } from '../setup.js';

let app: FastifyInstance;
let admin: TestUser;

/** A file that plainly is not in the library, to aim the traversal attempts at. */
let outsideFile: string;

beforeAll(async () => {
  app = await startTestApp();
  await resetLibrary();
  await seedLibrary();
  admin = await signIn(app, { label: 'Ana', role: 'admin', folders: [''] });

  outsideFile = path.join(os.tmpdir(), `gallery-outside-${process.pid}.txt`);
  await fs.writeFile(outsideFile, 'this must never be served');
});

afterAll(async () => {
  await app.close();
  await fs.rm(outsideFile, { force: true });
});

const get = (url: string) =>
  app.inject({ method: 'GET', url, headers: { cookie: admin.cookie } });

interface Browse {
  path: string;
  parent: string | null;
  dirs: { name: string; path: string }[];
  files: { name: string; photoId: number | null; unsupportedImage: boolean }[];
}

async function browse(relPath: string): Promise<Browse> {
  const res = await get(`/api/files/browse?path=${encodeURIComponent(relPath)}`);
  expect(res.statusCode, relPath).toBe(200);
  return res.json() as Browse;
}

describe('browse', () => {
  it('lists the library root', async () => {
    const names = (await browse('')).dirs.map((d) => d.name);
    expect(names).toContain('Travel');
    expect(names).toContain('Family');
  });

  it('descends into a subfolder', async () => {
    const result = await browse('Travel/Norway');
    expect(result.files.length).toBeGreaterThan(0);
    expect(result.parent).toBe('Travel');
  });

  it('reports the photo id for an indexed file', async () => {
    const result = await browse('Travel/Norway');
    expect(result.files.every((f) => f.photoId !== null)).toBe(true);
  });

  it('lists non-media files too, and flags what cannot be thumbnailed', async () => {
    expect((await browse('Travel')).files.map((f) => f.name)).toContain('packing-list.txt');

    const raw = (await browse('Scans')).files.find((f) => f.name.endsWith('.dng'));
    expect(raw?.unsupportedImage).toBe(true);
    expect(raw?.photoId).toBeNull();
  });

  it('hides dotfiles, so a part-finished upload is invisible', async () => {
    await fs.writeFile(path.join(TEST_PHOTOS_ROOT, 'Travel', '.upload-abc.part'), 'partial');

    const names = (await browse('Travel')).files.map((f) => f.name);
    expect(names.some((n) => n.startsWith('.'))).toBe(false);
  });

  it('rejects every spelling of a traversal', async () => {
    const attempts = [
      '..',
      '../',
      '../../',
      'Travel/../..',
      '..%2f..',
      '....//',
      'Travel/./../../etc',
      '..\\..\\Windows',
    ];

    for (const attempt of attempts) {
      const res = await get(`/api/files/browse?path=${encodeURIComponent(attempt)}`);
      expect([403, 404].includes(res.statusCode), `${attempt} → ${res.statusCode}`).toBe(true);
    }
  });

  it('rejects an absolute path with a drive letter', async () => {
    const res = await get(`/api/files/browse?path=${encodeURIComponent('C:/Windows')}`);
    expect([403, 404]).toContain(res.statusCode);
  });

  it('refuses a folder that is not there without saying which it was', async () => {
    // 403, the same answer a path outside the root gets: "absent" and "not
    // yours" are deliberately indistinguishable from the outside.
    const res = await get('/api/files/browse?path=NoSuchFolder');
    expect([403, 404]).toContain(res.statusCode);
    expect(res.body).not.toContain(TEST_PHOTOS_ROOT);
  });

  it('never leaks a filesystem path in an error', async () => {
    for (const attempt of ['..', 'NoSuchFolder', 'C:/Windows']) {
      const res = await get(`/api/files/browse?path=${encodeURIComponent(attempt)}`);
      expect(res.body, attempt).not.toContain(TEST_PHOTOS_ROOT);
      expect(res.body, attempt).not.toMatch(/[A-Z]:\\/);
    }
  });
});

describe('download', () => {
  it('serves a file from inside the library', async () => {
    const res = await get('/api/files/download?path=Travel/packing-list.txt');
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('boots');
  });

  it('refuses to serve anything outside it', async () => {
    const attempts = [
      outsideFile.replace(/\\/g, '/'),
      `../${path.basename(outsideFile)}`,
      '../../../../../../etc/passwd',
      '../../../Windows/System32/drivers/etc/hosts',
    ];

    for (const attempt of attempts) {
      const res = await get(`/api/files/download?path=${encodeURIComponent(attempt)}`);
      expect([403, 404].includes(res.statusCode), `${attempt} → ${res.statusCode}`).toBe(true);
      expect(res.body).not.toContain('this must never be served');
    }
  });

  it('rejects a NUL byte, which would truncate the path at the syscall', async () => {
    const res = await get(`/api/files/download?path=${encodeURIComponent('Travel/x.jpg\u0000.txt')}`);
    expect([400, 403, 404]).toContain(res.statusCode);
  });
});

describe('symlinks', () => {
  it('refuses to follow one that points outside the library', async () => {
    const link = path.join(TEST_PHOTOS_ROOT, 'escape.txt');
    try {
      await fs.symlink(outsideFile, link);
    } catch {
      // Creating a symlink needs elevation or developer mode on Windows. The
      // syntactic guard is covered above; this adds the post-realpath check,
      // which simply cannot be exercised where symlinks are unavailable.
      return;
    }

    const res = await get('/api/files/download?path=escape.txt');
    expect([403, 404]).toContain(res.statusCode);
    expect(res.body).not.toContain('this must never be served');
    await fs.rm(link, { force: true });
  });
});

describe('creating a folder', () => {
  const create = (payload: unknown) =>
    app.inject({
      method: 'POST',
      url: '/api/files/folder',
      headers: { cookie: admin.cookie },
      payload,
    });

  it('creates one inside the library', async () => {
    const res = await create({ path: 'Travel', name: 'Iceland' });
    expect(res.statusCode).toBeLessThan(300);

    const stat = await fs.stat(path.join(TEST_PHOTOS_ROOT, 'Travel', 'Iceland'));
    expect(stat.isDirectory()).toBe(true);
  });

  it('creates one level only — `a/b/c` makes a folder called `c`', async () => {
    await create({ path: '', name: 'a/b/c' });

    expect(await fs.stat(path.join(TEST_PHOTOS_ROOT, 'c')).catch(() => null)).not.toBeNull();
    expect(await fs.stat(path.join(TEST_PHOTOS_ROOT, 'a')).catch(() => null)).toBeNull();
  });

  it('never escapes the library through the name', async () => {
    await create({ path: '', name: '../escaped' });

    const parent = path.dirname(TEST_PHOTOS_ROOT);
    expect(await fs.stat(path.join(parent, 'escaped')).catch(() => null)).toBeNull();
  });

  it('never escapes through the destination path', async () => {
    const res = await create({ path: '../..', name: 'escaped2' });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);

    const parent = path.dirname(TEST_PHOTOS_ROOT);
    expect(await fs.stat(path.join(parent, 'escaped2')).catch(() => null)).toBeNull();
  });

  it('reports a name already taken rather than adopting the folder', async () => {
    await create({ path: '', name: 'Twice' });
    const second = await create({ path: '', name: 'Twice' });
    expect(second.statusCode).toBeGreaterThanOrEqual(400);
  });

  it('refuses a name that reduces to nothing', async () => {
    for (const name of ['', '...', '   ']) {
      expect((await create({ path: '', name })).statusCode, JSON.stringify(name)).toBeGreaterThanOrEqual(400);
    }
  });
});

describe('the folder tree', () => {
  it('never lists an ignored directory', async () => {
    await fs.mkdir(path.join(TEST_PHOTOS_ROOT, '.git'), { recursive: true });
    await fs.mkdir(path.join(TEST_PHOTOS_ROOT, 'node_modules'), { recursive: true });

    const body = (await get('/api/folders/tree')).body;
    expect(body).not.toContain('node_modules');
    expect(body).not.toContain('.git');
  });
});

describe('starred folders', () => {
  const star = (folder: string, favorite: boolean, cookie = admin.cookie) =>
    app.inject({
      method: 'PUT',
      url: '/api/files/favorite',
      headers: { cookie },
      payload: { path: folder, favorite },
    });

  it('sort ahead of their siblings', async () => {
    const before = (await browse('')).dirs.map((d) => d.name);
    const last = before[before.length - 1]!;

    expect((await star(last, true)).statusCode).toBe(200);

    const after = (await browse('')).dirs as { name: string; favorite?: boolean }[];
    expect(after[0]?.name).toBe(last);
    expect(after[0]?.favorite).toBe(true);

    await star(last, false);
    expect((await browse('')).dirs.map((d) => d.name)).toEqual(before);
  });

  it('show up at the top level when they are nested deeper', async () => {
    await star('Travel/Norway', true);

    const top = (await get('/api/files/browse?path=')).json() as {
      favorites: { name: string; path: string }[];
    };
    expect(top.favorites.map((f) => f.path)).toContain('Travel/Norway');

    // Only the top level carries the shortcut row.
    const inside = (await get('/api/files/browse?path=Travel')).json() as {
      favorites: unknown[];
      dirs: { name: string; favorite?: boolean }[];
    };
    expect(inside.favorites).toEqual([]);
    expect(inside.dirs[0]).toMatchObject({ name: 'Norway', favorite: true });

    await star('Travel/Norway', false);
  });

  it('drop out of the shortcut row once the folder is gone', async () => {
    await fs.mkdir(path.join(TEST_PHOTOS_ROOT, 'Travel', 'Doomed'), { recursive: true });
    await star('Travel/Doomed', true);
    await fs.rm(path.join(TEST_PHOTOS_ROOT, 'Travel', 'Doomed'), { recursive: true });

    const top = (await get('/api/files/browse?path=')).json() as { favorites: { path: string }[] };
    expect(top.favorites.map((f) => f.path)).not.toContain('Travel/Doomed');

    // Unstarring a folder that no longer exists still works.
    expect((await star('Travel/Doomed', false)).statusCode).toBe(200);
  });

  it('refuse a file, the top level, and anything outside the library', async () => {
    expect((await star('Travel/packing-list.txt', true)).statusCode).toBe(400);
    expect((await star('', true)).statusCode).toBe(400);
    expect([403, 404]).toContain((await star('../..', true)).statusCode);
  });

  it('are an admin tool, and never reach a viewer', async () => {
    await star('Travel', true);
    const viewer = await signIn(app, { label: 'Guest', role: 'viewer', folders: ['Travel'] });

    expect((await star('Travel', false, viewer.cookie)).statusCode).toBe(403);

    const settings = await app.inject({
      method: 'GET',
      url: '/api/settings',
      headers: { cookie: viewer.cookie },
    });
    expect((settings.json() as { favoriteFolders: string[] }).favoriteFolders).toEqual([]);

    await star('Travel', false);
  });
});

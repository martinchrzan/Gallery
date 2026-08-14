/**
 * Integration-test harness.
 *
 * Builds the real app — same plugins, same root auth hook, same error handler —
 * against the throwaway library `setup.ts` created, and drives it through
 * `app.inject()` so no port is ever opened.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import pino from 'pino';
import { createLibrary } from '../../tools/fixture-library.mjs';
import { buildApp } from '../src/app.js';
import { createUser } from '../src/auth.js';
import { config } from '../src/config.js';
import { getDb } from '../src/db.js';
import { TEST_PHOTOS_ROOT } from './setup.js';

export interface TestUser {
  id: number;
  code: string;
  /** Ready-to-send `Cookie` header for this user's session. */
  cookie: string;
}

export async function startTestApp(): Promise<FastifyInstance> {
  const app = await buildApp(config(), pino({ level: 'silent' }), { serveWeb: false });
  await app.ready();
  return app;
}

/**
 * A fresh source address per sign-in.
 *
 * The login route is rate-limited by IP, and every injected request otherwise
 * looks like the same caller — so a suite with more than ten sign-ins would trip
 * a limiter that is working exactly as intended. `login.test.ts` pins the
 * address deliberately to test the limit itself.
 */
let nextOctet = 0;
function uniqueAddress(): string {
  nextOctet++;
  return `10.${(nextOctet >> 16) & 255}.${(nextOctet >> 8) & 255}.${nextOctet & 255}`;
}

/** Creates a user and signs them in, returning the cookie to send as them. */
export async function signIn(
  app: FastifyInstance,
  input: { label: string; role: 'admin' | 'viewer'; folders: string[] },
): Promise<TestUser> {
  const { user, code } = await createUser(input);

  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { code },
    remoteAddress: uniqueAddress(),
  });
  if (res.statusCode !== 200) {
    throw new Error(`sign-in failed for ${input.label}: ${res.statusCode} ${res.body}`);
  }

  const setCookie = res.headers['set-cookie'];
  const raw = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  if (!raw) throw new Error('login returned no session cookie');

  return { id: user.id, code, cookie: raw.split(';')[0]! };
}

/**
 * Fills the library and the index directly.
 *
 * The real indexer runs a worker pool and a filesystem watcher, neither of which
 * a route test needs; inserting the rows is both faster and deterministic. The
 * indexer itself is covered end to end by the Playwright suite, which runs the
 * actual server.
 */
export async function seedLibrary(): Promise<{ count: number; byDir: Map<string, number[]> }> {
  const { files } = await createLibrary(TEST_PHOTOS_ROOT);

  const db = getDb();
  const insert = db.prepare(
    `INSERT INTO photos (rel_path, dir, name, ext, size, mtime_ms, content_key,
                         width, height, taken_at, taken_src, kind)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'exif', 0)`,
  );

  const byDir = new Map<string, number[]>();
  db.transaction(() => {
    for (const file of files) {
      const dir = path.posix.dirname(file.rel);
      const name = path.posix.basename(file.rel);
      const info = insert.run(
        file.rel,
        dir,
        name,
        '.jpg',
        1024,
        file.takenAt,
        `key-${file.rel}`,
        1200,
        800,
        file.takenAt,
      );
      const id = Number(info.lastInsertRowid);
      byDir.set(dir, [...(byDir.get(dir) ?? []), id]);
    }
  })();

  return { count: files.length, byDir };
}

/** Empties the library folder and every table a test might have written to. */
export async function resetLibrary(): Promise<void> {
  const db = getDb();
  db.exec('DELETE FROM photos; DELETE FROM sessions; DELETE FROM users;');
  await fs.rm(TEST_PHOTOS_ROOT, { recursive: true, force: true });
  await fs.mkdir(TEST_PHOTOS_ROOT, { recursive: true });
}

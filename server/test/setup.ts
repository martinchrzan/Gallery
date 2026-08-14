/**
 * Gives every test file a private photo root and data directory.
 *
 * `config()` reads the environment once and memoises, and `getDb()` opens the
 * database at whatever path it found — so the environment has to be right before
 * any source module is imported. A setup file is the only hook that runs early
 * enough.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll } from 'vitest';
import { closeDb } from '../src/db.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gallery-test-'));

export const TEST_PHOTOS_ROOT = path.join(root, 'photos');
export const TEST_DATA_DIR = path.join(root, 'data');

fs.mkdirSync(TEST_PHOTOS_ROOT, { recursive: true });
fs.mkdirSync(TEST_DATA_DIR, { recursive: true });

process.env.PHOTOS_ROOT = TEST_PHOTOS_ROOT;
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.LOG_TO_FILE = 'false';
process.env.LOG_CONSOLE = 'false';
// A config.json in the repo root would otherwise win over these on a developer's
// machine and point the tests at their real library.
process.env.GALLERY_CONFIG = path.join(root, 'config.json');
fs.writeFileSync(process.env.GALLERY_CONFIG, JSON.stringify({ photosRoot: TEST_PHOTOS_ROOT }));

afterAll(() => {
  // Windows will not unlink a file that still has an open handle, and the
  // database is the one thing here that holds one.
  closeDb();
  fs.rmSync(root, { recursive: true, force: true });
});

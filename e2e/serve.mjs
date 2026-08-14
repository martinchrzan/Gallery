/**
 * Launches the built server for the E2E suite, generating its photo library
 * first.
 *
 * The library has to exist before the server boots — it refuses to start on a
 * missing `photosRoot`, and its first scan is what the suite waits for. Playwright
 * starts `webServer` before any global setup hook, so the generation happens
 * here rather than there.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { createLibrary } from '../tools/fixture-library.mjs';

const photosRoot = process.env.PHOTOS_ROOT;
const dataDir = process.env.DATA_DIR;
if (!photosRoot || !dataDir) {
  throw new Error('PHOTOS_ROOT and DATA_DIR must be set — run this through playwright.config.ts');
}

// A stale index from a previous run would hide a scanning bug behind rows that
// were already there, so both fixtures start empty every time.
await fs.rm(dataDir, { recursive: true, force: true });
await fs.mkdir(dataDir, { recursive: true });

// The server prefers GALLERY_CONFIG over the repo-root config.json; an empty
// object there means the environment alone decides.
if (process.env.GALLERY_CONFIG) {
  await fs.mkdir(path.dirname(process.env.GALLERY_CONFIG), { recursive: true });
  await fs.writeFile(process.env.GALLERY_CONFIG, '{}');
}

const library = await createLibrary(photosRoot);
console.log(`[e2e] generated ${library.count} photos in ${photosRoot}`);

// Starts the server: importing it runs its `main()`.
await import('../server/dist/index.js');

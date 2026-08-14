import os from 'node:os';
import path from 'node:path';
import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests against the real server, serving a generated photo library.
 *
 * The whole stack runs: the SQLite index, the worker pool that reads EXIF, the
 * libvips thumbnailer and the built SPA. Nothing is stubbed, so a green run here
 * means `npm run build && npm start` genuinely works.
 */

const PORT = Number(process.env.E2E_PORT ?? 4300);
export const BASE_URL = `http://127.0.0.1:${PORT}`;

/** Both fixtures live under one directory so a run can be cleaned up wholesale. */
export const E2E_ROOT = path.join(os.tmpdir(), 'gallery-e2e');
export const E2E_PHOTOS = path.join(E2E_ROOT, 'photos');
export const E2E_DATA = path.join(E2E_ROOT, 'data');

/** Seeded into the server on first boot, so the suite knows how to sign in. */
export const ADMIN_CODE = 'E2E1-TEST-ADMN-CODE';

/** Where the setup project parks the signed-in sessions. */
export const ADMIN_STATE = path.join(E2E_ROOT, 'admin-state.json');
export const VIEWER_STATE = path.join(E2E_ROOT, 'viewer-state.json');

export default defineConfig({
  testDir: './e2e',
  outputDir: path.join(E2E_ROOT, 'results'),
  // A scan of the whole fixture library happens once, in the setup project.
  timeout: 45_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  // One worker: every test shares a single server and one photo library, and a
  // test that uploads or renames would race the others.
  workers: 1,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],

  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: process.env.E2E_VIDEO ? 'on' : 'retain-on-failure',
  },

  projects: [
    {
      // Waits for the first scan to finish and saves the signed-in sessions.
      name: 'setup',
      testMatch: /global\.setup\.ts/,
    },
    {
      name: 'desktop',
      dependencies: ['setup'],
      testIgnore: [/mobile\.spec\.ts/, /screenshots\.spec\.ts/],
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
    {
      name: 'mobile',
      dependencies: ['setup'],
      testMatch: /mobile\.spec\.ts/,
      use: { ...devices['Pixel 7'] },
    },
    {
      // Writes the README's images rather than asserting anything. Opt in with
      // `npm run screenshots`; never part of an ordinary test run.
      name: 'screenshots',
      dependencies: ['setup'],
      testMatch: /screenshots\.spec\.ts/,
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  webServer: {
    // Generates the photo library, then starts the built server. Playwright
    // launches this before any global hook, and the server refuses to boot on a
    // missing photosRoot — so the two steps have to share a process.
    command: 'node e2e/serve.mjs',
    url: `${BASE_URL}/api/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      NODE_ENV: 'production',
      PORT: String(PORT),
      HOST: '127.0.0.1',
      PHOTOS_ROOT: E2E_PHOTOS,
      DATA_DIR: E2E_DATA,
      GALLERY_ADMIN_CODE: ADMIN_CODE,
      // A developer's own config.json sits at the repo root and would otherwise
      // point this run at their real photo library.
      GALLERY_CONFIG: path.join(E2E_ROOT, 'config.json'),
      LOG_TO_FILE: 'false',
      LOG_CONSOLE: 'true',
      LOG_LEVEL: 'warn',
    },
  },
});

/**
 * Records the README's demo GIF.
 *
 * Starts the same generated-library server the E2E suite uses, drives a short
 * scripted tour with Playwright's video recorder, and converts the result with
 * the ffmpeg that ships as an optional dependency. Standalone rather than a
 * Playwright project because a good GIF needs deliberate pacing, which reads far
 * better as a plain script than as a test.
 *
 *   npm run demo
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import { chromium } from '@playwright/test';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORK = path.join(os.tmpdir(), 'gallery-demo');
const PORT = 4400;
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN_CODE = 'DEMO-TEST-ADMN-CODE';
const OUT = path.join(repoRoot, 'docs', 'images', 'demo.gif');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForHealth(timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return;
    } catch {
      // Not listening yet.
    }
    await wait(400);
  }
  throw new Error('the server never became healthy');
}

/** The scan runs on boot; the tour should not start against a half-full grid. */
async function waitForIndex(cookie) {
  let previous = -1;
  for (let i = 0; i < 200; i++) {
    const res = await fetch(`${BASE}/api/stats`, { headers: { cookie } });
    const { photos } = await res.json();
    if (photos > 0 && photos === previous) return photos;
    previous = photos;
    await wait(500);
  }
  throw new Error('indexing did not settle');
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegInstaller.path, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}\n${stderr.slice(-1500)}`)),
    );
  });
}

async function main() {
  await fs.rm(WORK, { recursive: true, force: true });
  await fs.mkdir(path.join(WORK, 'video'), { recursive: true });

  const server = spawn(process.execPath, [path.join(repoRoot, 'e2e', 'serve.mjs')], {
    cwd: repoRoot,
    stdio: ['ignore', 'inherit', 'inherit'],
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PORT: String(PORT),
      HOST: '127.0.0.1',
      PHOTOS_ROOT: path.join(WORK, 'photos'),
      DATA_DIR: path.join(WORK, 'data'),
      GALLERY_ADMIN_CODE: ADMIN_CODE,
      GALLERY_CONFIG: path.join(WORK, 'config.json'),
      LOG_TO_FILE: 'false',
      LOG_LEVEL: 'warn',
    },
  });

  let browser;
  try {
    await waitForHealth();

    const login = await fetch(`${BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: ADMIN_CODE }),
    });
    if (!login.ok) throw new Error(`login failed: ${login.status}`);
    const cookie = login.headers.getSetCookie()[0].split(';')[0];

    const photos = await waitForIndex(cookie);
    console.log(`[demo] indexed ${photos} photos`);

    // The feed follows the library-wide setting for an admin.
    await fetch(`${BASE}/api/settings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ galleryFolders: [''], showMemories: true }),
    });

    browser = await chromium.launch();
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      deviceScaleFactor: 1,
      recordVideo: { dir: path.join(WORK, 'video'), size: { width: 1280, height: 800 } },
    });
    const [name, value] = cookie.split('=');
    await context.addCookies([{ name, value, url: BASE }]);

    const page = await context.newPage();
    await tour(page);

    const video = page.video();
    await context.close();
    const webm = await video.path();

    console.log('[demo] converting to GIF…');
    // Two passes: a palette built from the whole clip, then applied. A GIF's
    // colours have to be chosen from the footage or these gradients band badly.
    //
    // 10fps at 720px with an ordered dither keeps the file around 2.5 MB, which
    // is about as much as a README should ask anyone to download. Error-diffusion
    // dithering looks marginally better and more than doubles the size, because
    // its noise defeats the inter-frame compression GIF relies on.
    const palette = path.join(WORK, 'palette.png');
    const filters = 'fps=10,scale=720:-1:flags=lanczos';
    await runFfmpeg(['-y', '-i', webm, '-vf', `${filters},palettegen=max_colors=128`, palette]);
    await runFfmpeg([
      '-y',
      '-i', webm,
      '-i', palette,
      '-lavfi', `${filters}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=3`,
      '-loop', '0',
      OUT,
    ]);

    const { size } = await fs.stat(OUT);
    console.log(`[demo] wrote ${path.relative(repoRoot, OUT)} (${(size / 1024 / 1024).toFixed(1)} MB)`);
  } finally {
    await browser?.close();
    server.kill();
  }
}

/** The scripted tour. Pauses are generous — a GIF that races is unreadable. */
async function tour(page) {
  await page.goto(BASE);
  await page.waitForSelector('.thumb img');
  await page.waitForFunction(() => {
    const images = [...document.querySelectorAll('.thumb img')];
    return images.length > 0 && images.every((img) => img.complete && img.naturalWidth > 0);
  });
  await wait(1200);

  // Scroll the feed, smoothly, so the day separators and the year rail read.
  await page.locator('.gallery-scroll').evaluate(async (el) => {
    const target = 1400;
    const start = performance.now();
    const step = () => {
      const t = Math.min(1, (performance.now() - start) / 2600);
      // Ease in and out, so it looks like a hand rather than a jump.
      el.scrollTop = target * (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
      if (t < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
    await new Promise((resolve) => setTimeout(resolve, 2800));
  });
  await wait(700);

  // Open one full screen.
  await page.locator('.thumb').nth(3).click();
  await page.waitForSelector('[role="dialog"]');
  await wait(1400);

  // Browse a few.
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press('ArrowRight');
    await wait(1000);
  }

  // Details, then zoom.
  await page.getByRole('button', { name: 'Toggle details' }).click();
  await wait(1800);
  await page.getByRole('button', { name: 'Toggle details' }).click();
  await wait(500);

  await page.keyboard.press('f');
  await wait(1300);
  await page.keyboard.press('0');
  await wait(900);

  await page.keyboard.press('Escape');
  await wait(900);

  // Finish on the file browser, which is the other half of the app.
  await page.getByRole('link', { name: 'Files' }).click();
  await page.waitForSelector('.folder-card');
  await wait(1000);
  await page.locator('.folder-card', { hasText: 'Travel' }).click();
  await wait(1400);
}

await main();

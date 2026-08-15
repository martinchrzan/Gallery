/**
 * The phone-sized layout. Runs under the `mobile` project, which uses a Pixel 7
 * profile — a touch device with a narrow viewport.
 */

import { expect, test } from '@playwright/test';
import { ADMIN_STATE } from '../playwright.config';

test.use({ storageState: ADMIN_STATE });

test('lays the feed out for a narrow screen', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.thumb').first()).toBeVisible();

  const viewport = page.viewportSize()!;
  expect(viewport.width).toBeLessThan(500);

  // Nothing may overflow sideways: the feed scrolls vertically only.
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
});

test('keeps every tile inside the viewport', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.thumb').first()).toBeVisible();

  const width = page.viewportSize()!.width;
  const boxes = await page.locator('.thumb').evaluateAll((nodes) =>
    nodes.map((n) => n.getBoundingClientRect().right),
  );

  for (const right of boxes) {
    expect(right).toBeLessThanOrEqual(width + 1);
  }
});

test('opens the viewer full screen', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.thumb').first()).toBeVisible();

  await page.locator('.thumb').first().tap();
  await expect(page.getByRole('dialog')).toBeVisible();

  await page.getByRole('button', { name: 'Close' }).tap();
  await expect(page.getByRole('dialog')).toBeHidden();
});

test('fits the file browser and its upload button on screen', async ({ page }) => {
  await page.goto('/files');
  await expect(page.locator('.folder-card').first()).toBeVisible();

  const upload = page.getByRole('button', { name: 'Upload' });
  await expect(upload).toBeVisible();

  // The bar holding it must not push the page sideways — this is the overflow
  // the mobile upload button was fixed for.
  const box = (await upload.boundingBox())!;
  expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width + 1);

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
});

test('keeps the year rail clear of the top bar and the bottom of the screen', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.thumb').first()).toBeVisible();

  const ticks = page.locator('.year-tick');
  await expect(ticks.first()).toBeVisible();

  // Half of a label hangs past each end of the rail, and the touch chips are
  // the tall ones — which is what used to tuck the newest year under the bar.
  const bar = (await page.locator('.topbar').boundingBox())!;
  const first = (await ticks.first().boundingBox())!;
  expect(first.y - (bar.y + bar.height)).toBeGreaterThanOrEqual(4);

  const last = (await ticks.last().boundingBox())!;
  expect(page.viewportSize()!.height - (last.y + last.height)).toBeGreaterThanOrEqual(4);
});

test('highlights the oldest year at the end of the feed', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.thumb').first()).toBeVisible();

  const years = (await page.locator('.year-tick').allTextContents()).map((y) => y.trim());
  expect(years.length).toBeGreaterThan(1);

  const scroller = page.locator('.gallery-scroll');
  await scroller.evaluate((el) => el.scrollTo({ top: el.scrollHeight, behavior: 'auto' }));
  await expect
    .poll(async () => scroller.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop))
    .toBeLessThanOrEqual(1);

  await expect(page.locator('.year-tick.current')).toHaveText(years[years.length - 1]!);
});

test('keeps a long watch warning inside the settings card', async ({ page }) => {
  await page.goto('/settings');
  const indexing = page.locator('.card', {
    has: page.getByRole('heading', { name: 'Indexing' }),
  });
  await expect(indexing).toBeVisible();

  // The "Watching files" warning quotes whatever path the watcher tripped over,
  // and a phone has nowhere near the width for one. Injected rather than
  // provoked: a file watcher failing is not something a test run can arrange.
  await indexing.locator('.desc').first().evaluate((node) => {
    node.textContent =
      "UNKNOWN: unknown error, watch " +
      "'C:\\Users\\someone\\OneDrive\\Pictures\\2019\\Summer-in-the-mountains" +
      "\\IMG_20190812_114233_HDR_edited_final.jpg'";
  });

  const settings = page.locator('.settings');
  expect(await settings.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
});

test('shows the login screen without overflow', async ({ page }) => {
  await page.context().clearCookies();
  await page.goto('/');

  await expect(page.getByLabel('Access code')).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
});

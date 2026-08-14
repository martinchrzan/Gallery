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

test('shows the login screen without overflow', async ({ page }) => {
  await page.context().clearCookies();
  await page.goto('/');

  await expect(page.getByLabel('Access code')).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
});

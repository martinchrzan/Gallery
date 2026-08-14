/**
 * Captures the README's screenshots from the running app.
 *
 * Not part of the test run: it writes files rather than asserting, and it is
 * excluded from every project except `screenshots`. Regenerate with
 * `npm run screenshots`.
 *
 * The library it photographs is the generated fixture, so no real photo ever
 * ends up in the repository.
 */

import path from 'node:path';
import { expect, test } from '@playwright/test';
import { ADMIN_STATE, VIEWER_STATE } from '../playwright.config';

const OUT = path.join('docs', 'images');

/** Waits until every mounted tile has actually decoded, so no shot has holes. */
async function thumbsSettled(page: import('@playwright/test').Page): Promise<void> {
  await expect(page.locator('.thumb, .file-card').first()).toBeVisible();
  await page.waitForFunction(() => {
    const images = [...document.querySelectorAll<HTMLImageElement>('.thumb img, .file-card img')];
    return images.length > 0 && images.every((img) => img.complete && img.naturalWidth > 0);
  });
  // One frame for the fade-in that follows the load.
  await page.waitForTimeout(400);
}

test.use({ storageState: ADMIN_STATE, viewport: { width: 1440, height: 900 } });

test('gallery', async ({ page }) => {
  await page.goto('/');
  await thumbsSettled(page);
  await page.screenshot({ path: path.join(OUT, 'gallery.png') });
});

test('gallery scrolled, showing the day separators and the year rail', async ({ page }) => {
  await page.goto('/');
  await thumbsSettled(page);

  await page.locator('.gallery-scroll').evaluate((el) => el.scrollTo(0, 900));
  await thumbsSettled(page);
  await page.screenshot({ path: path.join(OUT, 'gallery-scrolled.png') });
});

test('lightbox', async ({ page }) => {
  // From the file browser, so the shot lands on a fixture photo with full EXIF
  // rather than on whatever happens to be newest.
  await page.goto('/files/Travel/Norway');
  await thumbsSettled(page);
  await page.locator('.file-preview').first().click();

  await expect(page.getByRole('dialog')).toBeVisible();
  await page.waitForTimeout(700);
  await page.screenshot({ path: path.join(OUT, 'lightbox.png') });

  await page.getByRole('button', { name: 'Toggle details' }).click();
  await expect(page.locator('.lightbox-meta')).toContainText(/Camera/);
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(OUT, 'lightbox-details.png') });
});

test('files', async ({ page }) => {
  await page.goto('/files/Travel/Norway');
  await thumbsSettled(page);
  await page.screenshot({ path: path.join(OUT, 'files.png') });
});

test('settings', async ({ page }) => {
  await page.goto('/settings');
  await expect(page.getByRole('heading', { name: 'Gallery folders' })).toBeVisible();
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(OUT, 'settings.png') });
});

test('login', async ({ page, context }) => {
  await context.clearCookies();
  await page.goto('/');
  await expect(page.getByLabel('Access code')).toBeVisible();
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(OUT, 'login.png') });
});

test.describe('phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test('gallery on a phone', async ({ page }) => {
    await page.goto('/');
    await thumbsSettled(page);
    await page.screenshot({ path: path.join(OUT, 'mobile-gallery.png') });
  });
});

test.describe('what a viewer sees', () => {
  test.use({ storageState: VIEWER_STATE });

  test('viewer gallery', async ({ page }) => {
    await page.goto('/');
    await thumbsSettled(page);
    await page.screenshot({ path: path.join(OUT, 'viewer-gallery.png') });
  });
});

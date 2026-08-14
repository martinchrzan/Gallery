import { expect, test } from '@playwright/test';
import { ADMIN_STATE } from '../playwright.config';

test.use({ storageState: ADMIN_STATE });

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.thumb').first()).toBeVisible();
  await page.locator('.thumb').first().click();
  await expect(page.getByRole('dialog')).toBeVisible();
});

type Page = import('@playwright/test').Page;

const title = (page: Page) => page.locator('.lightbox-title');

/**
 * The id of the photo currently on the stage, read off the preview's URL.
 *
 * The title is empty until the details panel is opened — the lightbox does not
 * fetch metadata nobody has asked to see — so the image itself is what says
 * which photo is showing.
 */
async function shownId(page: Page): Promise<string> {
  // Excluding the swipe peeks: the neighbours are drawn *before* the current
  // photo so they sit underneath it, so during a transition `.first()` would
  // report whichever way the stage is moving rather than where it lands.
  const src = await page
    .locator('.lightbox-stage img:not(.swipe-peek)')
    .first()
    .getAttribute('src');
  return /\/api\/media\/(\d+)\//.exec(src ?? '')?.[1] ?? '';
}

/**
 * Opens the first photo in `Travel/Norway` instead of the newest in the feed.
 *
 * The feed's newest photo is whatever ran most recently — the upload spec adds
 * one, dated now, with no EXIF and smaller than the window. This folder is
 * fixture-only and nothing writes to it, so its photos reliably carry camera
 * data and are larger than the viewport.
 */
async function openFixturePhoto(page: Page): Promise<void> {
  await page.goto('/files/Travel/Norway');
  await expect(page.locator('.file-card').first()).toBeVisible();
  await page.locator('.file-preview').first().click();
  await expect(page.getByRole('dialog')).toBeVisible();
}

test('opens full screen showing the photo', async ({ page }) => {
  await expect(page.locator('.lightbox-stage img').first()).toBeVisible();
  expect(await shownId(page)).not.toBe('');
});

test('names the photo once the details panel is open', async ({ page }) => {
  // Deliberately lazy: opening the panel is what triggers the detail request.
  await expect(title(page)).toBeEmpty();

  await page.getByRole('button', { name: 'Toggle details' }).click();
  await expect(title(page)).toContainText(/\.jpg$/i);
});

test.describe('closing', () => {
  test('closes on Escape', async ({ page }) => {
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toBeHidden();
  });

  test('closes on the Close button', async ({ page }) => {
    await page.getByRole('button', { name: 'Close' }).click();
    await expect(page.getByRole('dialog')).toBeHidden();
  });

  test('closes on a click outside the photo', async ({ page }) => {
    // The bare backdrop only — a click on the photo itself must not close it.
    await page.locator('.lightbox-stage').click({ position: { x: 8, y: 8 } });
    await expect(page.getByRole('dialog')).toBeHidden();
  });
});

test.describe('browsing', () => {
  test('moves to the next and previous photo with the arrow keys', async ({ page }) => {
    const first = await shownId(page);

    await page.keyboard.press('ArrowRight');
    await expect.poll(() => shownId(page)).not.toBe(first);
    const second = await shownId(page);

    await page.keyboard.press('ArrowLeft');
    await expect.poll(() => shownId(page)).toBe(first);
    expect(second).not.toBe(first);
  });

  test('moves with the on-screen arrows', async ({ page }) => {
    const first = await shownId(page);

    await page.getByRole('button', { name: 'Next photo' }).click();
    await expect.poll(() => shownId(page)).not.toBe(first);

    await page.getByRole('button', { name: 'Previous photo' }).click();
    await expect.poll(() => shownId(page)).toBe(first);
  });

  test('wraps round from the first photo to the last', async ({ page }) => {
    // Opened from the file browser, so the starting point is position 1 of that
    // folder's own feed by construction.
    await openFixturePhoto(page);

    const position = page.locator('.lightbox-sub');
    await expect(position).toContainText(/^\s*1\s*\/\s*(\d+)/);
    const total = Number(/\/\s*(\d+)/.exec((await position.textContent()) ?? '')?.[1]);
    expect(total).toBeGreaterThan(1);

    const first = await shownId(page);

    // Back from the first goes to the last, rather than stopping — the viewer
    // is a ring, which is what `(index + delta + count) % count` is for.
    await page.keyboard.press('ArrowLeft');
    await expect(position).toContainText(new RegExp(`^\\s*${total}\\s*/\\s*${total}`));
    expect(await shownId(page)).not.toBe(first);

    // …and forward from the last comes back round to the first.
    await page.keyboard.press('ArrowRight');
    await expect(position).toContainText(/^\s*1\s*\//);
    await expect.poll(() => shownId(page)).toBe(first);
  });
});

test.describe('the details panel', () => {
  test('toggles with the I key', async ({ page }) => {
    const panel = page.locator('.metadata-panel, .lightbox-meta').first();

    await page.keyboard.press('i');
    await expect(panel).toBeVisible();

    await page.keyboard.press('i');
    await expect(panel).toBeHidden();
  });

  test('shows the EXIF the fixture wrote', async ({ page }) => {
    await openFixturePhoto(page);
    await page.getByRole('button', { name: 'Toggle details' }).click();

    const panel = page.locator('.lightbox-meta');
    await expect(panel).toBeVisible();
    // The generator writes a camera make and model into every photo.
    await expect(panel).toContainText(/FUJIFILM|Canon|iPhone|SONY|ILCE/i);
    // Dimensions come from libvips reading the file, not from the fixture.
    await expect(panel).toContainText(/\d+\s*×\s*\d+/);
    // The capture date came from EXIF, not from the filename or the file date.
    await expect(panel).not.toContainText(/from the file date/i);
  });
});

test.describe('zoom', () => {
  test('toggles between fit and zoomed with F', async ({ page }) => {
    const stage = page.locator('.lightbox-stage');
    await expect(stage).not.toHaveClass(/zoomed/);

    await page.keyboard.press('f');
    await expect(stage).toHaveClass(/zoomed/);

    await page.keyboard.press('0');
    await expect(stage).not.toHaveClass(/zoomed/);
  });

  test('zooms in and out with + and −', async ({ page }) => {
    // By role: `Zoom` alone also matches the `Zoom mode` button group.
    const slider = page.getByRole('slider', { name: 'Zoom' });
    const before = await slider.inputValue();

    await page.keyboard.press('+');
    await expect.poll(async () => slider.inputValue()).not.toBe(before);

    await page.keyboard.press('-');
    await expect.poll(async () => slider.inputValue()).toBe(before);
  });

});

test.describe('the Fit and 1:1 modes', () => {
  // Small enough that any fixture photo is larger than the window. For a photo
  // *smaller* than the window, fit and 1:1 are deliberately the same thing and
  // both light up — so a full-size viewport would be testing the wrong case.
  test.use({ viewport: { width: 700, height: 500 } });

  test('report which one the photo is currently at', async ({ page }) => {
    await openFixturePhoto(page);

    const fit = page.getByRole('button', { name: 'Fit to screen' });
    const actual = page.getByRole('button', { name: 'Actual size' });
    await expect(fit).toHaveAttribute('aria-pressed', 'true');
    await expect(actual).toHaveAttribute('aria-pressed', 'false');

    await actual.click();
    await expect(page.locator('.lightbox-stage')).toHaveClass(/zoomed/);
    await expect(actual).toHaveAttribute('aria-pressed', 'true');

    await fit.click();
    await expect(page.locator('.lightbox-stage')).not.toHaveClass(/zoomed/);
    await expect(fit).toHaveAttribute('aria-pressed', 'true');
  });
});

test('rotates on screen only, leaving the file alone', async ({ page }) => {
  const image = page.locator('.lightbox-stage img').first();
  const before = await image.evaluate((el) => getComputedStyle(el).transform);

  await page.keyboard.press('r');
  await expect.poll(async () => image.evaluate((el) => getComputedStyle(el).transform)).not.toBe(before);

  // Nothing was written: the photo's own bytes are untouched, so a reopen shows
  // it the way the camera stored it again.
  await page.keyboard.press('Escape');
  await page.locator('.thumb').first().click();
  const reopened = page.locator('.lightbox-stage img').first();
  await expect.poll(async () => reopened.evaluate((el) => getComputedStyle(el).transform)).toBe(before);
});

test('offers the original for download', async ({ page }) => {
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download original' }).click();

  const file = await download;
  expect(file.suggestedFilename()).toMatch(/\.jpg$/i);
});

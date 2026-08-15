import { expect, test } from '@playwright/test';
import { ADMIN_STATE } from '../playwright.config';
import { expectedPhotoCount } from '../tools/fixture-library.mjs';

test.use({ storageState: ADMIN_STATE });

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.thumb').first()).toBeVisible();
});

test('shows the whole library in one chronological feed', async ({ page }) => {
  const manifest = await page.request.get('/api/gallery/manifest');
  expect(manifest.ok()).toBe(true);
  const feed = Number(manifest.headers()['x-photo-count']);

  // Against the index rather than the fixture's own count: this admin's gallery
  // is scoped to everything, so "the feed shows the whole library" is the
  // invariant — and it survives another spec having uploaded a photo.
  const stats = await (await page.request.get('/api/stats')).json();
  expect(feed).toBe(stats.photos);
  expect(feed).toBeGreaterThanOrEqual(expectedPhotoCount());
});

test('mounts only the rows near the viewport', async ({ page }) => {
  // The whole point of the virtualiser: a 50k library must not put 50k nodes in
  // the DOM. With ~60 photos the window is still far smaller than the library.
  // Polled, because a manifest reload briefly unmounts every tile.
  await expect.poll(() => page.locator('.thumb').count()).toBeGreaterThan(0);
  expect(await page.locator('.thumb').count()).toBeLessThan(expectedPhotoCount());
});

test('groups photos under day headers', async ({ page }) => {
  const headers = page.locator('.day-header');
  await expect(headers.first()).toBeVisible();

  const text = await headers.first().textContent();
  expect(text?.trim().length ?? 0).toBeGreaterThan(0);
  // Locale-formatted, so assert the shape rather than an exact string.
  expect(text).toMatch(/\d/);
});

test('loads thumbnails rather than leaving broken tiles', async ({ page }) => {
  const image = page.locator('.thumb img').first();
  await expect(image).toHaveClass(/loaded/);

  const natural = await image.evaluate((img: HTMLImageElement) => img.naturalWidth);
  expect(natural).toBeGreaterThan(0);
  await expect(page.locator('.thumb-broken')).toHaveCount(0);
});

test('scrolls to the end without leaving gaps', async ({ page }) => {
  const scroller = page.locator('.gallery-scroll');

  await scroller.evaluate((el) => el.scrollTo(0, el.scrollHeight));
  // A tile stays mounted at the bottom: an off-by-one in the layout's total
  // height shows up here as an empty final screen.
  await expect(page.locator('.thumb').first()).toBeVisible();

  const atBottom = await scroller.evaluate(
    (el) => el.scrollTop + el.clientHeight >= el.scrollHeight - 2,
  );
  expect(atBottom).toBe(true);
});

test('shows a sticky day header once scrolled', async ({ page }) => {
  const sticky = page.locator('.sticky-day');
  await expect(sticky).not.toHaveClass(/visible/);

  await page.locator('.gallery-scroll').evaluate((el) => el.scrollTo(0, 600));
  await expect(sticky).toHaveClass(/visible/);
  await expect(sticky).not.toBeEmpty();
});

test.describe('the year rail', () => {
  test('lists a tick for each year in the library', async ({ page }) => {
    const ticks = page.locator('.year-tick');
    await expect(ticks.first()).toBeVisible();

    const years = await ticks.allTextContents();
    const numeric = years.map((y) => Number(y.trim())).filter((y) => !Number.isNaN(y));
    expect(numeric.length).toBeGreaterThanOrEqual(3);
    // Newest first, matching the feed.
    expect(numeric).toEqual([...numeric].sort((a, b) => b - a));
  });

  test('jumps the feed to the year you click', async ({ page }) => {
    const scroller = page.locator('.gallery-scroll');
    expect(await scroller.evaluate((el) => el.scrollTop)).toBe(0);

    await page.locator('.year-tick').last().click();

    await expect
      .poll(async () => scroller.evaluate((el) => el.scrollTop))
      .toBeGreaterThan(0);
  });

  test('highlights the year the feed is showing, the oldest one included', async ({ page }) => {
    const ticks = page.locator('.year-tick');
    const years = (await ticks.allTextContents()).map((y) => y.trim());

    await expect(page.locator('.year-tick.current')).toHaveText(years[0]!);

    // The oldest label sits at a clamped position, which is where the highlight
    // used to stop being able to reach it.
    await scrollToEnd(page);
    await expect(page.locator('.year-tick.current')).toHaveText(years[years.length - 1]!);
  });
});

/** Scrolls the feed to the bottom and waits for the view to settle there. */
async function scrollToEnd(page: import('@playwright/test').Page): Promise<void> {
  const scroller = page.locator('.gallery-scroll');
  await scroller.evaluate((el) => el.scrollTo({ top: el.scrollHeight, behavior: 'auto' }));
  await expect
    .poll(async () => scroller.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop))
    .toBeLessThanOrEqual(1);
}

test.describe('on this day', () => {
  test('shows the strip, since the fixture has anniversary photos', async ({ page }) => {
    const strip = page.getByRole('region', { name: 'On this day' });

    // 29 February has no counterpart in a common year, so the fixture's
    // anniversary photos land on a date that does not exist. That is correct
    // behaviour, not a failure.
    const today = new Date();
    test.skip(today.getMonth() === 1 && today.getDate() === 29, 'no anniversary on a leap day');

    await expect(strip).toBeVisible();
    await expect(strip.getByRole('heading', { name: 'On this day' })).toBeVisible();
    expect(await strip.locator('.memory').count()).toBeGreaterThan(0);
  });

  test('opens the viewer at the photo you click', async ({ page }) => {
    const today = new Date();
    test.skip(today.getMonth() === 1 && today.getDate() === 29, 'no anniversary on a leap day');

    const strip = page.getByRole('region', { name: 'On this day' });
    const tile = strip.locator('.memory').first();
    const id = await photoIdOf(tile);
    await tile.click();

    await expect(page.getByRole('dialog')).toBeVisible();
    // The viewer must land on the photo that was on the tile, not merely open.
    await expect(page.locator(`.lightbox img[src*="/api/media/${id}/"]`).first()).toBeAttached();
  });

  test('opens the photo that was pressed, not the one the rail slid into place', async ({
    page,
  }) => {
    const today = new Date();
    test.skip(today.getMonth() === 1 && today.getDate() === 29, 'no anniversary on a leap day');

    const strip = page.getByRole('region', { name: 'On this day' });
    const tiles = strip.locator('.memory');
    expect(await tiles.count()).toBeGreaterThan(1);

    const pressedId = await photoIdOf(tiles.nth(0));

    // The rail auto-advances, and the browser hit-tests a tap where the finger
    // lifts — so a press on one tile can be released over its neighbour. The
    // press is what decides, which is what these two events stand in for.
    await tiles.nth(0).dispatchEvent('pointerdown', { clientX: 40, clientY: 40 });
    await tiles.nth(1).dispatchEvent('click', { clientX: 42, clientY: 41, detail: 1 });

    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(
      page.locator(`.lightbox img[src*="/api/media/${pressedId}/"]`).first(),
    ).toBeAttached();
  });
});

/** The photo id behind a strip tile, read off the thumbnail it is showing. */
async function photoIdOf(tile: import('@playwright/test').Locator): Promise<string> {
  const src = await tile.locator('img').first().getAttribute('src');
  const id = /\/api\/media\/(\d+)\//.exec(src ?? '')?.[1];
  expect(id, `could not read a photo id from ${src}`).toBeTruthy();
  return id!;
}

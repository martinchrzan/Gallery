/**
 * What a viewer sees, and what they demonstrably cannot reach.
 *
 * The point of these is that the restriction is not cosmetic: the tabs are gone
 * *and* the routes behind them refuse the request, and a photo outside the
 * assigned folders is unreachable even by guessing its id.
 */

import { expect, test } from '@playwright/test';
import { ADMIN_STATE, VIEWER_STATE } from '../playwright.config';

test.describe('a viewer', () => {
  test.use({ storageState: VIEWER_STATE });

  test('gets the gallery and nothing else in the chrome', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.thumb').first()).toBeVisible();

    await expect(page.getByRole('link', { name: 'Files' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Settings' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
  });

  test('is sent back to the gallery when typing a URL they may not have', async ({ page }) => {
    await page.goto('/files');
    await expect(page.locator('.thumb').first()).toBeVisible();
    expect(new URL(page.url()).pathname).toBe('/');

    await page.goto('/settings');
    await expect(page.locator('.thumb').first()).toBeVisible();
    expect(new URL(page.url()).pathname).toBe('/');
  });

  test('sees only the folders they were given', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.thumb').first()).toBeVisible();

    const manifest = await page.request.get('/api/gallery/manifest');
    const scoped = Number(manifest.headers()['x-photo-count']);
    expect(scoped).toBeGreaterThan(0);

    // Fewer than the whole library: `Family` and `Scans` are not theirs.
    const settings = await page.request.get('/api/settings');
    expect((await settings.json()).galleryFolders).toEqual(['Travel']);
  });

  test('cannot reach the admin routes behind the missing tabs', async ({ page }) => {
    await page.goto('/');

    for (const url of ['/api/files/browse?path=', '/api/users', '/api/stats', '/api/folders/tree']) {
      const res = await page.request.get(url);
      expect(res.status(), url).toBe(403);
    }
  });

  test('cannot reach a photo outside their folders by guessing its id', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.thumb').first()).toBeVisible();

    // Every id in the library, walked from 1 — the attack the 404 exists for.
    const reachable: number[] = [];
    for (let id = 1; id <= 70; id++) {
      const res = await page.request.get(`/api/photos/${id}`);
      if (res.ok()) reachable.push(id);
      else expect(res.status(), `id ${id}`).toBe(404);
    }

    const manifest = await page.request.get('/api/gallery/manifest');
    expect(reachable).toHaveLength(Number(manifest.headers()['x-photo-count']));

    // And each one really is in the folder they were given.
    for (const id of reachable.slice(0, 5)) {
      const photo = await (await page.request.get(`/api/photos/${id}`)).json();
      expect(photo.dir).toMatch(/^Travel/);
    }
  });
});

test.describe('an admin', () => {
  test.use({ storageState: ADMIN_STATE });

  test('gets the full navigation', async ({ page }) => {
    await page.goto('/');

    await expect(page.getByRole('link', { name: 'Gallery' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Files' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Settings' })).toBeVisible();
  });
});

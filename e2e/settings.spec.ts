import { expect, test } from '@playwright/test';
import { ADMIN_STATE } from '../playwright.config';

test.use({ storageState: ADMIN_STATE });

test.beforeEach(async ({ page }) => {
  await page.goto('/settings');
  await expect(page.getByRole('heading', { name: 'Gallery folders' })).toBeVisible();
});

test('shows the configuration sections', async ({ page }) => {
  await expect(page.getByRole('heading', { name: 'Indexing' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Appearance' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'People' })).toBeVisible();
});

test('lists the library`s folders to choose from', async ({ page }) => {
  const tree = page.locator('.folder-tree');
  await expect(tree).toContainText('Travel');
  await expect(tree).toContainText('Family');
});

test('reports what has been indexed', async ({ page }) => {
  const stats = await (await page.request.get('/api/stats')).json();
  expect(stats.photos).toBeGreaterThan(0);
  expect(stats.totalBytes).toBeGreaterThan(0);
  // Thumbnails were generated during the scan, so the cache is not empty.
  expect(stats.thumbFiles).toBeGreaterThan(0);
});

test('saves the row height and keeps it across a reload', async ({ page }) => {
  const slider = page.locator('#row-height');
  const before = await slider.inputValue();

  // A real click, not a synthetic input event: the save fires on pointer-up, so
  // dispatching `input` alone would change the UI and never reach the server.
  const box = (await slider.boundingBox())!;
  const clickAt = async (fraction: number) =>
    slider.click({ position: { x: box.width * fraction, y: box.height / 2 } });

  await clickAt(0.15);
  if ((await slider.inputValue()) === before) await clickAt(0.85);

  const after = await slider.inputValue();
  expect(after).not.toBe(before);

  // Settings live on the server so they follow you between browsers.
  await expect
    .poll(async () => String((await (await page.request.get('/api/settings')).json()).rowHeight))
    .toBe(after);

  await page.reload();
  await expect(page.locator('#row-height')).toHaveValue(after);

  await page.request.put('/api/settings', { data: { rowHeight: Number(before) } });
});

test.describe('people', () => {
  test('creates a viewer and shows their code exactly once', async ({ page }) => {
    const label = `E2E Guest ${Date.now()}`;

    const created = await page.request.post('/api/users', {
      data: { label, role: 'viewer', folders: ['Scans'] },
    });
    expect(created.status()).toBe(201);
    const { code, user } = await created.json();
    expect(code).toMatch(/^[A-Z0-9]{4}(-[A-Z0-9]{4}){3}$/);

    await page.reload();
    await expect(page.locator('.settings')).toContainText(label);
    // Never readable again — only its hash is kept.
    await expect(page.locator('.settings')).not.toContainText(code);

    await page.request.delete(`/api/users/${user.id}`);
  });

  test('refuses to delete the last administrator', async ({ page }) => {
    const users = await (await page.request.get('/api/users')).json();
    const admin = users.find((u: { role: string }) => u.role === 'admin');

    const res = await page.request.delete(`/api/users/${admin.id}`);
    expect(res.status()).toBe(400);
  });
});

test('rescans on demand', async ({ page }) => {
  const res = await page.request.post('/api/index/rescan');
  expect(res.ok()).toBe(true);
  expect((await res.json()).started).toBe(true);

  // The scan finds the same files again and the count settles back where it was.
  const before = (await (await page.request.get('/api/stats')).json()).photos;
  await expect
    .poll(async () => (await (await page.request.get('/api/stats')).json()).photos, {
      timeout: 60_000,
    })
    .toBe(before);
});

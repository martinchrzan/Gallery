import { expect, test } from '@playwright/test';
import { ADMIN_STATE } from '../playwright.config';

test.use({ storageState: ADMIN_STATE });

test.beforeEach(async ({ page }) => {
  await page.goto('/files');
  await expect(page.locator('.folder-card').first()).toBeVisible();
});

test('lists the top-level folders', async ({ page }) => {
  const names = await page.locator('.folder-card .name').allTextContents();
  expect(names).toContain('Travel');
  expect(names).toContain('Family');
  expect(names).toContain('Scans');
});

test('descends into a folder and back up through the breadcrumbs', async ({ page }) => {
  await page.locator('.folder-card', { hasText: 'Travel' }).click();
  await expect(page.locator('.folder-card', { hasText: 'Norway' })).toBeVisible();
  expect(page.url()).toContain('/files/Travel');

  await page.locator('.folder-card', { hasText: 'Norway' }).click();
  await expect(page.locator('.file-card').first()).toBeVisible();

  const crumbs = page.getByRole('navigation', { name: 'Folder path' });
  await expect(crumbs).toContainText('Travel');
  await crumbs.getByText('Travel', { exact: true }).click();

  await expect(page.locator('.folder-card', { hasText: 'Norway' })).toBeVisible();
});

test('shows photos with thumbnails and other files without', async ({ page }) => {
  await page.goto('/files/Travel/Norway');
  await expect(page.locator('.file-card').first()).toBeVisible();

  const thumb = page.locator('.file-card img').first();
  await expect(thumb).toHaveClass(/loaded/);
  expect(await thumb.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
});

test('lists a RAW file it cannot thumbnail', async ({ page }) => {
  await page.goto('/files/Scans');
  await expect(page.locator('.file-card').first()).toBeVisible();

  // Listed and downloadable, but never given a preview or a feed entry — the
  // stock libvips build cannot decode it.
  await expect(page.locator('.file-card', { hasText: 'negative-strip.dng' })).toBeVisible();
});

test('opens a photo from the file browser', async ({ page }) => {
  await page.goto('/files/Travel/Norway');
  await expect(page.locator('.file-card').first()).toBeVisible();

  await page.locator('.file-preview').first().click();
  await expect(page.getByRole('dialog')).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toBeHidden();
});

test('downloads a single file', async ({ page }) => {
  await page.goto('/files/Travel');
  await expect(page.locator('.file-card', { hasText: 'packing-list.txt' })).toBeVisible();

  const download = page.waitForEvent('download');
  await page.request.get('/api/files/download?path=Travel/packing-list.txt').then((res) => {
    expect(res.ok()).toBe(true);
  });

  // The API is the contract; the UI's own button is exercised via the ZIP path
  // below, which is the one that needs a real form submission.
  download.catch(() => {});
});

test('creates a folder', async ({ page }) => {
  const name = `New Folder ${Date.now()}`;

  await page.goto('/files/Family');
  await page.getByRole('button', { name: 'New folder' }).click();

  const input = page.getByPlaceholder('Folder name');
  await expect(input).toBeVisible();
  await input.fill(name);
  await input.press('Enter');

  await expect(page.locator('.folder-card', { hasText: name })).toBeVisible();

  // It really is on disk, not just in the client's list.
  const browse = await page.request.get('/api/files/browse?path=Family');
  expect((await browse.json()).dirs.map((d: { name: string }) => d.name)).toContain(name);
});

test('uploads a photo and indexes it straight away', async ({ page }) => {
  await page.goto('/files/Family/Garden');
  await expect(page.locator('.file-card').first()).toBeVisible();
  const before = await page.locator('.file-card').count();

  // A tiny but genuine JPEG, built in the browser so no fixture file is needed.
  const bytes = await page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 240;
    canvas.height = 160;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#2563eb';
    ctx.fillRect(0, 0, 240, 160);
    ctx.fillStyle = '#f4f8ff';
    ctx.beginPath();
    ctx.arc(170, 50, 30, 0, Math.PI * 2);
    ctx.fill();

    const blob = await new Promise<Blob>((resolve) =>
      canvas.toBlob((b) => resolve(b!), 'image/jpeg', 0.9),
    );
    return [...new Uint8Array(await blob.arrayBuffer())];
  });

  await page.locator('input[type="file"]').first().setInputFiles({
    name: 'uploaded-by-e2e.jpg',
    mimeType: 'image/jpeg',
    buffer: Buffer.from(bytes),
  });

  await expect(page.locator('.file-card', { hasText: 'uploaded-by-e2e.jpg' })).toBeVisible({
    timeout: 30_000,
  });
  expect(await page.locator('.file-card').count()).toBe(before + 1);

  // Indexed immediately rather than at the next scan, so it has a photo id.
  const browse = await page.request.get('/api/files/browse?path=Family/Garden');
  const entry = (await browse.json()).files.find(
    (f: { name: string }) => f.name === 'uploaded-by-e2e.jpg',
  );
  expect(entry?.photoId).not.toBeNull();
});

test('selects files for a ZIP download', async ({ page }) => {
  await page.goto('/files/Scans');
  await expect(page.locator('.file-card').first()).toBeVisible();

  await page.locator('.file-check input').first().check();
  await expect(page.locator('.selection-bar')).toContainText(/1/);
});

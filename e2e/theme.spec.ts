import { expect, test } from '@playwright/test';
import { ADMIN_STATE } from '../playwright.config';

test.use({ storageState: ADMIN_STATE });

const pageColour = (page: import('@playwright/test').Page) =>
  page.evaluate(() => getComputedStyle(document.body).backgroundColor);

test.describe('the theme', () => {
  test('follows a device set to dark', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto('/');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    expect(await pageColour(page)).toBe('rgb(17, 19, 22)');
    await expect(page.getByRole('button', { name: 'Theme: Automatic (dark)' })).toBeVisible();
  });

  test('follows the device when it switches while the page is open', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto('/');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');

    await page.emulateMedia({ colorScheme: 'dark' });
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  });

  test('keeps a chosen theme across a reload, whatever the device says', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto('/');

    // From automatic, the first press always changes what is on screen.
    await page.getByRole('button', { name: /^Theme: Automatic/ }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(page.getByRole('button', { name: 'Theme: Dark' })).toBeVisible();

    // Blocking the bundle leaves only the pre-paint script to set the theme —
    // which is what stops the page flashing light before the app starts.
    await page.route('**/assets/*.js', (route) => route.abort());
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    expect(await pageColour(page)).toBe('rgb(17, 19, 22)');
    await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute('content', '#111316');
  });

  test('comes back to the device after light and dark', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto('/');

    const toggle = page.getByRole('button', { name: /^Theme:/ });
    await toggle.click();
    await expect(toggle).toHaveAccessibleName('Theme: Dark');
    await toggle.click();
    await expect(toggle).toHaveAccessibleName('Theme: Light');
    await toggle.click();
    await expect(toggle).toHaveAccessibleName('Theme: Automatic (light)');
    expect(await page.evaluate(() => localStorage.getItem('gallery.theme'))).toBeNull();
  });
});

test.describe('installing to a home screen', () => {
  // The browser fetches these before anyone has signed in.
  test.use({ storageState: { cookies: [], origins: [] } });

  test('serves the manifest and every icon it names without a session', async ({ request }) => {
    const res = await request.get('/manifest.webmanifest');
    expect(res.ok()).toBe(true);
    expect(res.headers()['content-type']).toContain('application/manifest+json');

    const manifest = (await res.json()) as {
      display: string;
      start_url: string;
      icons: { src: string; purpose: string }[];
    };
    expect(manifest.display).toBe('standalone');
    expect(manifest.start_url).toBe('/');
    expect(manifest.icons.some((icon) => icon.purpose === 'maskable')).toBe(true);

    for (const src of [...manifest.icons.map((icon) => icon.src), '/icons/apple-touch-icon.png']) {
      const icon = await request.get(src);
      expect(icon.ok(), src).toBe(true);
      expect(icon.headers()['content-type'], src).toBe('image/png');
    }
  });

  test('links the manifest from the page', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('link[rel="manifest"]')).toHaveAttribute(
      'href',
      '/manifest.webmanifest',
    );
  });
});

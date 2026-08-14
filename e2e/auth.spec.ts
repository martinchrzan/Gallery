import { expect, test } from '@playwright/test';
import { ADMIN_CODE } from '../playwright.config';

test.describe('signing in', () => {
  // These start from a clean browser: the login screen is the thing under test.
  test.use({ storageState: { cookies: [], origins: [] } });

  test('shows the login screen to a visitor', async ({ page }) => {
    await page.goto('/');

    await expect(page.getByLabel('Access code')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeDisabled();
    // Nothing of the gallery leaks before sign-in.
    await expect(page.locator('.thumb')).toHaveCount(0);
  });

  test('rejects a wrong code and stays put', async ({ page }) => {
    await page.goto('/');

    await page.getByLabel('Access code').fill('ZZZZ-ZZZZ-ZZZZ-ZZZZ');
    await page.getByRole('button', { name: 'Sign in' }).click();

    await expect(page.getByRole('alert')).toContainText(/not valid/i);
    await expect(page.getByLabel('Access code')).toBeVisible();
  });

  test('accepts the code without dashes or capitals', async ({ page }) => {
    await page.goto('/');

    await page.getByLabel('Access code').fill(ADMIN_CODE.replace(/-/g, '').toLowerCase());
    await page.getByRole('button', { name: 'Sign in' }).click();

    await expect(page.locator('.thumb').first()).toBeVisible();
    await expect(page.getByLabel('Access code')).toHaveCount(0);
  });

  test('keeps the session across a reload', async ({ page }) => {
    await page.goto('/');
    await page.getByLabel('Access code').fill(ADMIN_CODE);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.locator('.thumb').first()).toBeVisible();

    await page.reload();
    await expect(page.locator('.thumb').first()).toBeVisible();
  });
});

test.describe('signing out', () => {
  // Signs in for itself rather than borrowing the shared session: signing out
  // destroys the session server-side, and the saved state holds that same
  // cookie — every later spec would inherit a dead one.
  test.use({ storageState: { cookies: [], origins: [] } });

  test('returns to the login screen', async ({ page }) => {
    await page.goto('/');
    await page.getByLabel('Access code').fill(ADMIN_CODE);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.locator('.thumb').first()).toBeVisible();

    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page.getByLabel('Access code')).toBeVisible();

    // And the session is genuinely gone, not merely hidden by the client.
    const res = await page.request.get('/api/gallery/manifest');
    expect(res.status()).toBe(401);
  });
});

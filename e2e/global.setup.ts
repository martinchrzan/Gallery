/**
 * Waits for the first scan, then parks a signed-in session for each role.
 *
 * Runs as a Playwright project the others depend on, which is the only hook that
 * fires *after* `webServer` is up.
 */

import fs from 'node:fs/promises';
import { expect, request, test as setup } from '@playwright/test';
import { ADMIN_CODE, ADMIN_STATE, BASE_URL, VIEWER_STATE } from '../playwright.config';
import { expectedPhotoCount } from '../tools/fixture-library.mjs';

/** Indexing 60-odd photos includes reading EXIF on a worker pool. */
setup.setTimeout(180_000);

setup('index the library and sign in', async () => {
  const api = await request.newContext({ baseURL: BASE_URL });

  const login = await api.post('/api/auth/login', { data: { code: ADMIN_CODE } });
  expect(login.ok(), `admin login failed: ${login.status()} ${await login.text()}`).toBe(true);

  // The scan starts on boot and the feed fills in as it goes, so the suite waits
  // for the count to settle rather than for a "done" flag it would have to poll
  // for anyway.
  const expected = expectedPhotoCount();
  await expect
    .poll(
      async () => {
        const res = await api.get('/api/stats');
        return res.ok() ? ((await res.json()) as { photos: number }).photos : -1;
      },
      {
        message: `indexer never reached ${expected} photos`,
        timeout: 150_000,
        intervals: [500, 1000, 2000],
      },
    )
    .toBe(expected);

  await api.storageState({ path: ADMIN_STATE });

  // A viewer scoped to Travel alone, for the tests that prove Family is
  // unreachable rather than merely unlisted.
  const created = await api.post('/api/users', {
    data: { label: 'Guest', role: 'viewer', folders: ['Travel'] },
  });
  expect(created.ok(), `could not create the viewer: ${await created.text()}`).toBe(true);
  const { code } = (await created.json()) as { code: string };

  const viewerApi = await request.newContext({ baseURL: BASE_URL });
  const viewerLogin = await viewerApi.post('/api/auth/login', { data: { code } });
  expect(viewerLogin.ok()).toBe(true);
  await viewerApi.storageState({ path: VIEWER_STATE });

  // The gallery feed for an admin follows the library-wide setting; open it to
  // everything so the desktop tests see the whole fixture.
  const settings = await api.put('/api/settings', {
    data: { galleryFolders: [''], showMemories: true },
  });
  expect(settings.ok()).toBe(true);

  await fs.access(ADMIN_STATE);
  await api.dispose();
  await viewerApi.dispose();
});

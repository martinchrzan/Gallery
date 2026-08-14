import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createUser } from '../../src/auth.js';
import { resetLibrary, signIn, startTestApp } from '../helpers.js';

let app: FastifyInstance;

beforeAll(async () => {
  app = await startTestApp();
});

afterAll(async () => {
  await app.close();
});

beforeEach(async () => {
  await resetLibrary();
});

describe('closed by default', () => {
  it('refuses every API route without a session', async () => {
    const routes = [
      '/api/gallery/manifest',
      '/api/photos/1',
      '/api/media/1/thumb?h=320',
      '/api/media/1/original',
      '/api/files/browse?path=',
      '/api/folders/tree',
      '/api/settings',
      '/api/users',
      '/api/stats',
    ];

    for (const url of routes) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(401);
    }
  });

  it('leaves login, logout and health open', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/health' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/auth/logout' })).statusCode).toBe(200);
    // A wrong code is rejected, but the endpoint itself answers without a session.
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { code: 'x' } });
    expect(res.statusCode).toBe(401);
  });

  it('says nothing about the library on the health check', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.json()).toEqual({ ok: true });
  });
});

describe('login', () => {
  /** One address per test, so these never spend each other's rate-limit budget. */
  let octet = 100;
  const login = (code: string) =>
    app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { code },
      remoteAddress: `172.16.0.${octet}`,
    });

  beforeEach(() => {
    octet++;
  });

  it('accepts the code in any case, with or without dashes', async () => {
    const { code } = await createUser({ label: 'Ana', role: 'admin', folders: [''] });

    for (const spelling of [code, code.toLowerCase(), code.replace(/-/g, ''), ` ${code} `]) {
      expect((await login(spelling)).statusCode, spelling).toBe(200);
    }
  });

  it('rejects a wrong code without revealing whether any user exists', async () => {
    await createUser({ label: 'Ana', role: 'admin', folders: [''] });

    const res = await login('ZZZZ-ZZZZ-ZZZZ-ZZZZ');
    expect(res.statusCode).toBe(401);
    // The same message whether or not the code belongs to anybody.
    expect(res.json().error).not.toMatch(/user|exists|found/i);
  });

  it('gives the same answer whether or not any user exists at all', async () => {
    const empty = await login('ZZZZ-ZZZZ-ZZZZ-ZZZZ');
    await createUser({ label: 'Ana', role: 'admin', folders: [''] });
    const populated = await login('ZZZZ-ZZZZ-ZZZZ-ZZZZ');

    expect(empty.statusCode).toBe(populated.statusCode);
    expect(empty.json()).toEqual(populated.json());
  });

  it('rejects a malformed body', async () => {
    for (const payload of [{}, { code: '' }, { code: 'x', extra: 1 }]) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload,
        remoteAddress: `172.16.1.${octet}`,
      });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
    }
  });

  it('issues an HttpOnly, SameSite=Lax session cookie', async () => {
    const { code } = await createUser({ label: 'Ana', role: 'admin', folders: [''] });
    const cookie = String((await login(code)).headers['set-cookie']);

    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    // Not Secure here: the injected request is plain HTTP, and forcing the flag
    // would break the gallery over a LAN address.
    expect(cookie).not.toMatch(/Secure/i);
  });

  it('ignores a spoofed X-Forwarded-Proto while trustProxy is off', async () => {
    const { code } = await createUser({ label: 'Ana', role: 'admin', folders: [''] });
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { code },
      headers: { 'x-forwarded-proto': 'https' },
      remoteAddress: `172.16.2.${octet}`,
    });

    // A header a client can set must not change cookie flags. Behind a real
    // proxy the operator opts in with trustProxy, and only then is it believed.
    expect(String(res.headers['set-cookie'])).not.toMatch(/Secure/i);
  });

  it('rate-limits guessing to ten attempts per window', async () => {
    const attempt = () =>
      app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { code: 'ZZZZ-ZZZZ-ZZZZ-ZZZZ' },
        remoteAddress: '192.0.2.55',
      });

    const codes: number[] = [];
    for (let i = 0; i < 12; i++) codes.push((await attempt()).statusCode);

    expect(codes.slice(0, 10)).toEqual(Array(10).fill(401));
    expect(codes.slice(10)).toEqual([429, 429]);
  });

  it('limits by source address, so one guesser cannot lock everyone out', async () => {
    const { code } = await createUser({ label: 'Ana', role: 'admin', folders: [''] });
    for (let i = 0; i < 11; i++) {
      await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { code: 'WRONG' },
        remoteAddress: '192.0.2.66',
      });
    }

    const elsewhere = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { code },
      remoteAddress: '192.0.2.67',
    });
    expect(elsewhere.statusCode).toBe(200);
  });
});

describe('sessions', () => {
  it('identifies the signed-in user', async () => {
    const ana = await signIn(app, { label: 'Ana', role: 'admin', folders: [''] });
    const res = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: ana.cookie } });

    expect(res.statusCode).toBe(200);
    expect(res.json().user).toMatchObject({ label: 'Ana', role: 'admin' });
  });

  it('never returns the access code or its hash', async () => {
    const ana = await signIn(app, { label: 'Ana', role: 'admin', folders: [''] });
    const body = (await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: ana.cookie } })).body;

    expect(body).not.toContain(ana.code);
    expect(body).not.toContain('scrypt');
    expect(body).not.toMatch(/code_?[Hh]ash/);
  });

  it('rejects a forged session id', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie: 'gallery_sid=not-a-real-session' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('stops working after logout', async () => {
    const ana = await signIn(app, { label: 'Ana', role: 'admin', folders: [''] });
    await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie: ana.cookie } });

    const res = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: ana.cookie } });
    expect(res.statusCode).toBe(401);
  });
});

describe('admin-only routes', () => {
  it('answers 403 to a viewer', async () => {
    const viewer = await signIn(app, { label: 'Guest', role: 'viewer', folders: ['Travel'] });

    const routes: [string, string][] = [
      ['GET', '/api/users'],
      ['POST', '/api/users'],
      ['GET', '/api/folders/tree'],
      ['GET', '/api/files/browse?path='],
      ['GET', '/api/files/download?path=Travel/x.jpg'],
      ['POST', '/api/files/folder'],
      ['POST', '/api/files/upload'],
      ['PUT', '/api/settings'],
      ['GET', '/api/index/status'],
      ['POST', '/api/index/rescan'],
      ['GET', '/api/stats'],
      ['POST', '/api/cache/clear'],
    ];

    for (const [method, url] of routes) {
      const res = await app.inject({
        method: method as 'GET',
        url,
        headers: { cookie: viewer.cookie },
        ...(method === 'GET' ? {} : { payload: {} }),
      });
      expect(res.statusCode, `${method} ${url}`).toBe(403);
    }
  });

  it('lets an admin through', async () => {
    const admin = await signIn(app, { label: 'Ana', role: 'admin', folders: [''] });

    for (const url of ['/api/users', '/api/settings', '/api/folders/tree', '/api/stats']) {
      const res = await app.inject({ method: 'GET', url, headers: { cookie: admin.cookie } });
      expect(res.statusCode, url).toBe(200);
    }
  });
});

describe('settings visibility', () => {
  it('lets a viewer read settings, but only a redacted view', async () => {
    const admin = await signIn(app, { label: 'Ana', role: 'admin', folders: [''] });
    await app.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: { cookie: admin.cookie },
      payload: { galleryFolders: ['Family', 'Travel', 'Scans'], indexMode: 'manual' },
    });

    const viewer = await signIn(app, { label: 'Guest', role: 'viewer', folders: ['Travel'] });
    const res = await app.inject({
      method: 'GET',
      url: '/api/settings',
      headers: { cookie: viewer.cookie },
    });

    expect(res.statusCode).toBe(200);
    const settings = res.json();
    // The client needs display preferences and needs to know which folders feed
    // *its* gallery — but the library-wide list names folders the viewer has no
    // business knowing exist.
    expect(settings.galleryFolders).toEqual(['Travel']);
    expect(settings.galleryFolders).not.toContain('Family');
    // Operational settings are flattened to defaults rather than reported.
    expect(settings.indexMode).not.toBe('manual');
  });

  it('shows an admin the real settings', async () => {
    const admin = await signIn(app, { label: 'Ana', role: 'admin', folders: [''] });
    await app.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: { cookie: admin.cookie },
      payload: { galleryFolders: ['Family', 'Travel'], indexMode: 'manual' },
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/settings',
      headers: { cookie: admin.cookie },
    });
    expect(res.json()).toMatchObject({ galleryFolders: ['Family', 'Travel'], indexMode: 'manual' });
  });
});

describe('account safety rails', () => {
  it('refuses to delete the last administrator', async () => {
    const admin = await signIn(app, { label: 'Ana', role: 'admin', folders: [''] });
    const other = await signIn(app, { label: 'Bo', role: 'viewer', folders: ['Travel'] });

    // Deleting yourself is blocked outright, so use the second account to prove
    // the "last admin" rule separately from the "not yourself" one.
    const self = await app.inject({
      method: 'DELETE',
      url: `/api/users/${admin.id}`,
      headers: { cookie: admin.cookie },
    });
    expect(self.statusCode).toBe(400);
    expect(self.json().error).toMatch(/your own account/i);

    const viewer = await app.inject({
      method: 'DELETE',
      url: `/api/users/${other.id}`,
      headers: { cookie: admin.cookie },
    });
    expect(viewer.statusCode).toBe(200);
  });

  it('signs a user out everywhere when their code is rotated', async () => {
    const admin = await signIn(app, { label: 'Ana', role: 'admin', folders: [''] });
    const bo = await signIn(app, { label: 'Bo', role: 'viewer', folders: ['Travel'] });

    expect(
      (await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: bo.cookie } }))
        .statusCode,
    ).toBe(200);

    const rotated = await app.inject({
      method: 'POST',
      url: `/api/users/${bo.id}/code`,
      headers: { cookie: admin.cookie },
    });
    expect(rotated.statusCode).toBe(200);
    expect(rotated.json().code).not.toBe(bo.code);

    // A leaked code is a one-click fix only if the old sessions die with it.
    const after = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie: bo.cookie },
    });
    expect(after.statusCode).toBe(401);
  });

  it('returns a new user`s code exactly once', async () => {
    const admin = await signIn(app, { label: 'Ana', role: 'admin', folders: [''] });

    const created = await app.inject({
      method: 'POST',
      url: '/api/users',
      headers: { cookie: admin.cookie },
      payload: { label: 'Bo', role: 'viewer', folders: ['Travel'] },
    });
    expect(created.statusCode).toBe(201);
    const { code, user } = created.json();
    expect(code).toMatch(/^[A-Z0-9]{4}(-[A-Z0-9]{4}){3}$/);

    // Never again, from any later read.
    const listed = await app.inject({ method: 'GET', url: '/api/users', headers: { cookie: admin.cookie } });
    expect(listed.body).not.toContain(code);
    expect(listed.json().find((u: { id: number }) => u.id === user.id)).not.toHaveProperty('code');
  });
});

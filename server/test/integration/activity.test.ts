import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { deleteUser, getUser } from '../../src/auth.js';
import { getDb } from '../../src/db.js';
import type { ActivityReport } from '../../src/types.js';
import { resetLibrary, signIn, startTestApp, type TestUser } from '../helpers.js';

const PHONE_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Mobile Safari/537.36';

let app: FastifyInstance;
let admin: TestUser;
let viewer: TestUser;

beforeAll(async () => {
  app = await startTestApp();
});

afterAll(async () => {
  await app.close();
});

beforeEach(async () => {
  await resetLibrary();
  admin = await signIn(app, { label: 'Admin', role: 'admin', folders: [''] });
  viewer = await signIn(app, { label: 'Anna', role: 'viewer', folders: [''] });
});

const visit = (user: TestUser, remoteAddress: string, url = '/api/settings') =>
  app.inject({
    method: 'GET',
    url,
    headers: { cookie: user.cookie, 'user-agent': PHONE_UA },
    remoteAddress,
  });

async function report(): Promise<ActivityReport> {
  const res = await app.inject({
    method: 'GET',
    url: '/api/activity?since=0',
    headers: { cookie: admin.cookie },
  });
  expect(res.statusCode).toBe(200);
  return res.json<ActivityReport>();
}

describe('recording', () => {
  it('records who visited, from which address and on what device', async () => {
    await visit(viewer, '192.168.1.20');

    const { devices, hours } = await report();
    const anna = devices.filter((d) => d.userId === viewer.id);
    expect(anna).toHaveLength(1);
    expect(anna[0]).toMatchObject({
      ip: '192.168.1.20',
      ipCount: 1,
      userAgent: PHONE_UA,
      activeHours: 1,
      signedIn: true,
      current: false,
    });
    expect(hours.filter((h) => h.userId === viewer.id)).toHaveLength(1);
  });

  it('writes once however many requests a device makes', async () => {
    for (let i = 0; i < 25; i++) await visit(viewer, '192.168.1.20');

    const rows = getDb()
      .prepare('SELECT count(*) AS n FROM activity WHERE user_id = ?')
      .get(viewer.id) as { n: number };
    expect(rows.n).toBe(1);
  });

  it('keeps each address a device used', async () => {
    await visit(viewer, '192.168.1.20');
    await visit(viewer, '203.0.113.7');

    const anna = (await report()).devices.find((d) => d.userId === viewer.id);
    // Two addresses within the hour are still a single hour of use.
    expect(anna).toMatchObject({ ip: '203.0.113.7', ipCount: 2, activeHours: 1 });
  });

  it('reports an IPv4 client on a dual-stack socket as plain IPv4', async () => {
    await visit(viewer, '::ffff:10.1.2.3');
    const anna = (await report()).devices.find((d) => d.userId === viewer.id);
    expect(anna?.ip).toBe('10.1.2.3');
  });

  it('never stores the session id, which is the credential itself', async () => {
    await visit(viewer, '192.168.1.20');
    const sessionId = viewer.cookie.split('=')[1]!;
    const stored = JSON.stringify(getDb().prepare('SELECT * FROM activity').all());
    expect(stored).not.toContain(sessionId);
  });

  it('moves "last seen" forward on use, not only on sign-in', async () => {
    getDb().prepare('UPDATE users SET last_seen_at = 1 WHERE id = ?').run(viewer.id);
    await visit(viewer, '192.168.1.20');
    expect(getUser(viewer.id)?.lastSeenAt).toBeGreaterThan(1);
  });

  it('does not count the scan-progress stream, which reconnects on its own', async () => {
    const before = (await report()).devices.find((d) => d.current);
    const res = await app.inject({
      method: 'GET',
      url: '/api/index/events',
      headers: { cookie: admin.cookie },
      remoteAddress: '198.51.100.9',
      payloadAsStream: true,
    });
    res.stream().destroy();

    const after = (await report()).devices.find((d) => d.current);
    expect(after?.ipCount).toBe(before?.ipCount);
  });
});

describe('the report', () => {
  it('is for admins only', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/activity',
      headers: { cookie: viewer.cookie },
    });
    expect(res.statusCode).toBe(403);
  });

  it('lists everyone, including people who have not visited', async () => {
    const { people } = await report();
    expect(people.map((p) => p.label).sort()).toEqual(['Admin', 'Anna']);
  });

  it('marks the browser asking as the current one', async () => {
    const { devices } = await report();
    const mine = devices.filter((d) => d.current);
    expect(mine).toHaveLength(1);
    expect(mine[0]?.userId).toBe(admin.id);
  });

  it('keeps a device that signed out, marked as such', async () => {
    await visit(viewer, '192.168.1.20');
    await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie: viewer.cookie } });

    const anna = (await report()).devices.find((d) => d.userId === viewer.id);
    expect(anna?.signedIn).toBe(false);
  });

  it('leaves out what happened before the window', async () => {
    await visit(viewer, '192.168.1.20');
    const res = await app.inject({
      method: 'GET',
      url: `/api/activity?since=${Date.now() + 60 * 60 * 1000}`,
      headers: { cookie: admin.cookie },
    });
    const { devices, hours } = res.json<ActivityReport>();
    expect(devices).toHaveLength(0);
    expect(hours).toHaveLength(0);
  });

  it('drops a deleted user’s history with them', async () => {
    await visit(viewer, '192.168.1.20');
    deleteUser(viewer.id);

    const { devices, people } = await report();
    expect(devices.some((d) => d.userId === viewer.id)).toBe(false);
    expect(people.some((p) => p.id === viewer.id)).toBe(false);
  });
});

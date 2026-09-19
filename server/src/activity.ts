/**
 * Who has been using the gallery, on which devices, from where, and when.
 *
 * Every signed-in request passes through {@link recordActivity}, but very few of
 * them reach the database. Scrolling the feed fires dozens of thumbnail requests
 * a second, and one row per device, per address, per hour answers everything the
 * admin screen asks — so the rest are absorbed by an in-memory note of when each
 * device was last written, and a row's `last_at` stays within
 * {@link WRITE_EVERY_MS} of the truth.
 *
 * Rows older than {@link RETENTION_DAYS} are pruned, at most once a day, from the
 * same write path. Deleting a user drops theirs with them.
 */

import type { FastifyRequest } from 'fastify';
import { deviceFromRequest, listUsers, signedInDevices } from './auth.js';
import { getDb } from './db.js';
import type { ActivityDevice, ActivityHour, ActivityReport, User } from './types.js';

export const RETENTION_DAYS = 90;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const WRITE_EVERY_MS = 5 * 60 * 1000;

/**
 * Requests that say nothing about a person using the gallery. The scan-progress
 * stream reconnects by itself whenever it drops, so counting it would show an
 * admin's forgotten tab as hours of use.
 */
const BACKGROUND_ROUTES = new Set(['/api/index/events']);

interface Written {
  hour: number;
  ip: string;
  at: number;
}

/** When each device's row was last written, so most requests can skip the write. */
const lastWritten = new Map<string, Written>();
let lastPruneAt = 0;

/** `::ffff:192.168.1.5` is an IPv4 client on a dual-stack socket; report it as one. */
export function normalizeIp(ip: string): string {
  const plain = ip.startsWith('::ffff:') && ip.includes('.') ? ip.slice(7) : ip;
  return plain.slice(0, 64);
}

export function recordActivity(req: FastifyRequest, user: User): void {
  if (BACKGROUND_ROUTES.has(req.routeOptions.url ?? '')) return;
  const device = deviceFromRequest(req);
  if (!device) return;

  const now = Date.now();
  const hour = now - (now % HOUR_MS);
  const ip = normalizeIp(req.ip);

  const seen = lastWritten.get(device);
  if (seen && seen.hour === hour && seen.ip === ip && now - seen.at < WRITE_EVERY_MS) return;

  // A statistic that cannot be written must never cost someone their photo.
  try {
    const db = getDb();
    db.transaction(() => {
      db.prepare(
        `INSERT INTO activity (hour, device, ip, user_id, user_agent, first_at, last_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(hour, device, ip) DO UPDATE
           SET last_at = excluded.last_at, user_agent = excluded.user_agent`,
      ).run(hour, device, ip, user.id, (req.headers['user-agent'] ?? '').slice(0, 400), now, now);
      // "Last seen" means last used, not last signed in — a session lasts a month.
      db.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').run(now, user.id);
    })();
    lastWritten.set(device, { hour, ip, at: now });
  } catch (err) {
    req.log.warn({ reason: (err as Error).message }, 'could not record activity');
    return;
  }

  if (now - lastPruneAt > DAY_MS) {
    lastPruneAt = now;
    pruneActivity(now);
  }
}

export function pruneActivity(now = Date.now()): void {
  getDb().prepare('DELETE FROM activity WHERE hour < ?').run(now - RETENTION_DAYS * DAY_MS);
  for (const [device, written] of lastWritten) {
    if (now - written.at > HOUR_MS) lastWritten.delete(device);
  }
}

interface ActivityRow {
  hour: number;
  device: string;
  ip: string;
  user_id: number;
  user_agent: string;
  first_at: number;
  last_at: number;
}

/** Everything that happened at or after `since`, for the browser named `current`. */
export function activityReport(since: number, current: string | null): ActivityReport {
  const from = Math.max(since, Date.now() - RETENTION_DAYS * DAY_MS);

  // The hour bound lets the primary key find the window; `last_at` then drops the
  // part of the first hour that fell before it.
  const rows = getDb()
    .prepare(
      `SELECT hour, device, ip, user_id, user_agent, first_at, last_at FROM activity
       WHERE hour > ? AND last_at >= ?
       ORDER BY hour, last_at`,
    )
    .all(from - HOUR_MS, from) as ActivityRow[];

  const signedIn = signedInDevices();
  const devices = new Map<string, ActivityDevice & { ips: Set<string>; lastHour: number }>();

  for (const row of rows) {
    let device = devices.get(row.device);
    if (!device) {
      device = {
        id: row.device,
        userId: row.user_id,
        userAgent: row.user_agent,
        ip: row.ip,
        ipCount: 0,
        firstAt: row.first_at,
        lastAt: row.last_at,
        activeHours: 0,
        signedIn: signedIn.has(row.device),
        current: row.device === current,
        ips: new Set(),
        lastHour: -1,
      };
      devices.set(row.device, device);
    }

    device.ips.add(row.ip);
    // Two addresses in the same hour are still one hour of use.
    if (row.hour !== device.lastHour) device.activeHours++;
    device.lastHour = row.hour;
    device.firstAt = Math.min(device.firstAt, row.first_at);
    if (row.last_at >= device.lastAt) {
      device.lastAt = row.last_at;
      device.ip = row.ip;
      device.userAgent = row.user_agent;
    }
  }

  const hours: ActivityHour[] = rows.map((row) => ({
    hour: row.hour,
    userId: row.user_id,
    device: row.device,
    ip: row.ip,
  }));

  return {
    since: from,
    retentionDays: RETENTION_DAYS,
    people: listUsers().map(({ id, label, role, lastSeenAt }) => ({ id, label, role, lastSeenAt })),
    hours,
    devices: [...devices.values()]
      .map(({ ips, lastHour: _lastHour, ...device }) => ({ ...device, ipCount: ips.size }))
      .sort((a, b) => b.lastAt - a.lastAt),
  };
}

/**
 * Access codes, users and sessions.
 *
 * Login is by access code alone — there is no username field. The code *is* the
 * identity: it is looked up across every user, and whoever owns it is who you
 * become. That costs exactly log2(number of users) bits of brute-force
 * resistance versus a username+password pair (~2 bits for a handful of users),
 * which is why codes are generated here at 80 bits rather than chosen by a
 * human. A user-chosen password would make this scheme genuinely weak; a
 * generated one makes the missing username irrelevant.
 *
 * The trade the scheme does make is that login has to try every user's hash,
 * since there is no username to index by. That is fine for the handful of people
 * a self-hosted gallery is shared with, and the login route is rate-limited so
 * it cannot be used to burn CPU.
 */

import { createHash, randomBytes, randomInt, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { getDb } from './db.js';
import { toRelPosix } from './paths.js';
import type { Role, User } from './types.js';

const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/* ------------------------------------------------------------- constants -- */

/**
 * Crockford-style alphabet: no 0/O, 1/I/L, or U. 30 symbols is ~4.9 bits each,
 * so a 16-character code carries ~78 bits — comfortably beyond brute force even
 * with the log2(users) discount above.
 */
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_LENGTH = 16;
const CODE_GROUP = 4;

/** scrypt at 16 MB / ~50 ms. Node's default maxmem is 32 MB, so raise it explicitly. */
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;
const SCRYPT_KEYLEN = 32;

const SESSION_COOKIE = 'gallery_sid';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/* ----------------------------------------------------------------- codes -- */

/** A fresh access code, dash-grouped for reading aloud: `A7K2-9F3M-QX4T-VB7N`. */
export function generateCode(): string {
  let raw = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    raw += CODE_ALPHABET[randomInt(0, CODE_ALPHABET.length)];
  }
  return (raw.match(new RegExp(`.{1,${CODE_GROUP}}`, 'g')) ?? [raw]).join('-');
}

/**
 * Canonical form of a code as typed by a human: case and dashes are cosmetic.
 * Applied identically when hashing and when verifying, so the two cannot drift.
 */
export function normalizeCode(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

async function hashCode(code: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scrypt(normalizeCode(code), salt, SCRYPT_KEYLEN, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${derived.toString('base64')}`;
}

async function verifyCode(code: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const [, nRaw, rRaw, pRaw, saltRaw, hashRaw] = parts as [string, string, string, string, string, string];
  const expected = Buffer.from(hashRaw, 'base64');

  let derived: Buffer;
  try {
    derived = await scrypt(normalizeCode(code), Buffer.from(saltRaw, 'base64'), expected.length, {
      N: Number(nRaw),
      r: Number(rRaw),
      p: Number(pRaw),
      maxmem: SCRYPT.maxmem,
    });
  } catch {
    return false;
  }

  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

/* ----------------------------------------------------------------- users -- */

interface UserRow {
  id: number;
  label: string;
  role: string;
  code_hash: string;
  folders: string;
  created_at: number;
  last_seen_at: number | null;
}

function toUser(row: UserRow): User {
  let folders: string[] = [];
  try {
    const parsed: unknown = JSON.parse(row.folders);
    if (Array.isArray(parsed)) folders = parsed.filter((f): f is string => typeof f === 'string');
  } catch {
    // A corrupt row must not lock everyone out; an empty list shows nothing,
    // which is the safe direction to fail in.
  }
  return {
    id: row.id,
    label: row.label,
    role: row.role === 'admin' ? 'admin' : 'viewer',
    folders: row.role === 'admin' ? [''] : folders,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
  };
}

export function normalizeFolders(folders: string[]): string[] {
  return [...new Set(folders.map(toRelPosix))];
}

export function listUsers(): User[] {
  const rows = getDb()
    .prepare('SELECT * FROM users ORDER BY role = \'admin\' DESC, label COLLATE NOCASE')
    .all() as UserRow[];
  return rows.map(toUser);
}

export function getUser(id: number): User | null {
  const row = getDb().prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
  return row ? toUser(row) : null;
}

export function countAdmins(): number {
  const row = getDb()
    .prepare("SELECT count(*) AS n FROM users WHERE role = 'admin'")
    .get() as { n: number };
  return row.n;
}

export async function createUser(input: {
  label: string;
  role: Role;
  folders: string[];
}): Promise<{ user: User; code: string }> {
  const code = generateCode();
  const codeHash = await hashCode(code);
  const folders = input.role === 'admin' ? [''] : normalizeFolders(input.folders);

  const result = getDb()
    .prepare(
      `INSERT INTO users (label, role, code_hash, folders, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(input.label.trim() || 'User', input.role, codeHash, JSON.stringify(folders), Date.now());

  const user = getUser(Number(result.lastInsertRowid));
  if (!user) throw new Error('User vanished immediately after insert');
  return { user, code };
}

export function updateUser(id: number, patch: { label?: string; folders?: string[] }): User | null {
  const existing = getUser(id);
  if (!existing) return null;

  const label = patch.label?.trim() || existing.label;
  // An admin is never folder-restricted, so a folder patch is ignored for them.
  const folders =
    existing.role === 'admin' || !patch.folders ? existing.folders : normalizeFolders(patch.folders);

  getDb()
    .prepare('UPDATE users SET label = ?, folders = ? WHERE id = ?')
    .run(label, JSON.stringify(folders), id);
  return getUser(id);
}

/** Issues a new code for an existing user and invalidates all of their sessions. */
export async function rotateCode(id: number): Promise<string | null> {
  if (!getUser(id)) return null;
  const code = generateCode();
  const codeHash = await hashCode(code);

  const db = getDb();
  db.transaction(() => {
    db.prepare('UPDATE users SET code_hash = ? WHERE id = ?').run(codeHash, id);
    // A rotated code must not leave the old one's sessions usable, or rotating
    // after a leak would do nothing until the session expired.
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
  })();

  return code;
}

/** Deletes a user and, via `ON DELETE CASCADE`, every session they hold. */
export function deleteUser(id: number): boolean {
  return getDb().prepare('DELETE FROM users WHERE id = ?').run(id).changes > 0;
}

/* -------------------------------------------------------------- sessions -- */

interface SessionRow {
  user_id: number;
  expires_at: number;
}

function createSession(userId: number): string {
  const id = randomBytes(32).toString('base64url');
  const now = Date.now();
  getDb()
    .prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(id, userId, now, now + SESSION_TTL_MS);
  return id;
}

function destroySession(id: string): void {
  getDb().prepare('DELETE FROM sessions WHERE id = ?').run(id);
}

export function pruneSessions(): void {
  getDb().prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
}

function resolveSession(id: string): User | null {
  const row = getDb().prepare('SELECT user_id, expires_at FROM sessions WHERE id = ?').get(id) as
    | SessionRow
    | undefined;
  if (!row) return null;

  const now = Date.now();
  if (row.expires_at < now) {
    destroySession(id);
    return null;
  }

  // Sliding expiry, but only written once the session is past halfway, so an
  // active browser does not cause a DB write on every thumbnail request.
  if (row.expires_at - now < SESSION_TTL_MS / 2) {
    getDb().prepare('UPDATE sessions SET expires_at = ? WHERE id = ?').run(now + SESSION_TTL_MS, id);
  }

  return getUser(row.user_id);
}

/* ----------------------------------------------------------------- login -- */

/**
 * Resolves an access code to its owner. Every user's hash is tried — there is no
 * username to index by — and the loop deliberately runs to completion so a wrong
 * code costs the same as a right one regardless of position.
 */
export async function authenticateCode(code: string): Promise<User | null> {
  const normalized = normalizeCode(code);
  if (normalized.length === 0) return null;

  const rows = getDb().prepare('SELECT * FROM users').all() as UserRow[];
  let matched: UserRow | null = null;
  for (const row of rows) {
    if (await verifyCode(normalized, row.code_hash)) matched = row;
  }
  if (!matched) return null;

  getDb().prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').run(Date.now(), matched.id);
  return toUser(matched);
}

/** Cookies are marked `Secure` whenever the request itself arrived over TLS. */
function cookieOptions(req: FastifyRequest): {
  path: string;
  httpOnly: true;
  sameSite: 'lax';
  secure: boolean;
  maxAge: number;
} {
  return {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: req.protocol === 'https',
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  };
}

export function startSession(req: FastifyRequest, reply: FastifyReply, user: User): void {
  reply.setCookie(SESSION_COOKIE, createSession(user.id), cookieOptions(req));
}

export function clearSession(req: FastifyRequest, reply: FastifyReply): void {
  const id = req.cookies[SESSION_COOKIE];
  if (id) destroySession(id);
  reply.clearCookie(SESSION_COOKIE, { path: '/', sameSite: 'lax', secure: req.protocol === 'https' });
}

export function userFromRequest(req: FastifyRequest): User | null {
  const id = req.cookies[SESSION_COOKIE];
  return id ? resolveSession(id) : null;
}

/* --------------------------------------------------------------- devices -- */

/**
 * A stable, non-secret name for one signed-in browser.
 *
 * The session id is the credential itself, so it is never stored anywhere but
 * `sessions` and never shown. Its hash identifies the same browser just as well
 * without being usable to sign in as it — which is what lets the activity
 * record, and the admin screen that reads it, name a device at all.
 */
export function deviceId(sessionId: string): string {
  return createHash('sha256').update(sessionId).digest('base64url').slice(0, 16);
}

export function deviceFromRequest(req: FastifyRequest): string | null {
  const id = req.cookies[SESSION_COOKIE];
  return id ? deviceId(id) : null;
}

/** Devices that still hold a live session, as opposed to having signed out or expired. */
export function signedInDevices(): Set<string> {
  const rows = getDb().prepare('SELECT id FROM sessions WHERE expires_at >= ?').all(Date.now()) as {
    id: string;
  }[];
  return new Set(rows.map((row) => deviceId(row.id)));
}

/* ------------------------------------------------------------- bootstrap -- */

/**
 * Guarantees an admin exists, and prints its code when one had to be made.
 *
 * `GALLERY_ADMIN_CODE` both seeds the first admin and, on later starts, resets
 * the existing one — that is the recovery path when the code is lost, since
 * nothing here can be read back out of the database.
 */
export async function ensureAdminUser(
  log: (msg: string) => void,
): Promise<void> {
  const override = process.env.GALLERY_ADMIN_CODE?.trim();
  const existing = getDb()
    .prepare("SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1")
    .get() as { id: number } | undefined;

  if (existing) {
    if (override) {
      const db = getDb();
      const codeHash = await hashCode(override);
      db.transaction(() => {
        db.prepare('UPDATE users SET code_hash = ? WHERE id = ?').run(codeHash, existing.id);
        db.prepare('DELETE FROM sessions WHERE user_id = ?').run(existing.id);
      })();
      log('admin access code reset from GALLERY_ADMIN_CODE');
    }
    return;
  }

  if (override) {
    const codeHash = await hashCode(override);
    getDb()
      .prepare(
        `INSERT INTO users (label, role, code_hash, folders, created_at)
         VALUES ('Admin', 'admin', ?, '[""]', ?)`,
      )
      .run(codeHash, Date.now());
    log('admin created from GALLERY_ADMIN_CODE');
    return;
  }

  const { code } = await createUser({ label: 'Admin', role: 'admin', folders: [''] });
  const line = '='.repeat(58);
  log(
    `\n${line}\n  Admin access code: ${code}\n` +
      `  Sign in with this — it is not stored in readable form and\n` +
      `  cannot be shown again. To reset it, restart with\n` +
      `  GALLERY_ADMIN_CODE set.\n${line}\n`,
  );
}

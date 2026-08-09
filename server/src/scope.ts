/**
 * Folder scoping — the authorization half of access control.
 *
 * Filtering the gallery manifest is *not* enough on its own: photos are also
 * addressable by id through `/api/photos/:id` and `/api/media/:id/...`, and ids
 * are sequential, so a viewer who was only filtered at the feed level could walk
 * the entire library by counting. Every id-addressed route therefore re-checks
 * the photo's directory against the caller's scope here.
 */

import { getDb, getSettings } from './db.js';
import { toRelPosix } from './paths.js';
import type { User } from './types.js';

/** A list of permitted folders, or `null` for "no restriction" (admins). */
export type Scope = string[] | null;

/**
 * Everything the user may read at all, regardless of which view asks for it.
 * Admins are unrestricted; a viewer is confined to their assigned folders.
 */
export function accessScope(user: User): Scope {
  return user.role === 'admin' ? null : user.folders;
}

/**
 * The folders feeding this user's gallery feed.
 *
 * For an admin that is the library-wide `galleryFolders` setting; for a viewer
 * it is their own assignment, which the admin picked explicitly and which is
 * therefore not narrowed further by the library-wide setting.
 */
export function galleryScope(user: User): string[] {
  return user.role === 'admin' ? getSettings().galleryFolders : user.folders;
}

/** True when `dir` is one of the scoped folders or lives beneath one. */
export function dirAllowed(scope: Scope, dir: string): boolean {
  if (scope === null) return true;
  const target = toRelPosix(dir);
  for (const raw of scope) {
    const folder = toRelPosix(raw);
    if (folder === '') return true;
    if (target === folder || target.startsWith(`${folder}/`)) return true;
  }
  return false;
}

/** True when the photo with this id is inside the caller's scope. */
export function photoAllowed(scope: Scope, id: number): boolean {
  if (scope === null) return true;
  const row = getDb().prepare('SELECT dir FROM photos WHERE id = ?').get(id) as
    | { dir: string }
    | undefined;
  return row !== undefined && dirAllowed(scope, row.dir);
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/**
 * Builds the SQL fragment restricting `photos` to a set of folders.
 *
 * An empty selection shows *nothing*: the gallery is an explicit choice of
 * folders, so an empty choice is an empty gallery rather than a silent
 * "everything". Selecting the root entry ('') is how you ask for the lot.
 */
export function folderFilter(folders: string[]): { sql: string; params: string[] } {
  const cleaned = [...new Set(folders.map(toRelPosix))];
  if (cleaned.length === 0) return { sql: ' WHERE 0', params: [] };
  if (cleaned.includes('')) return { sql: '', params: [] };

  const clauses: string[] = [];
  const params: string[] = [];
  for (const folder of cleaned) {
    // The folder itself, plus everything beneath it.
    clauses.push("(dir = ? OR dir LIKE ? ESCAPE '\\')");
    params.push(folder, `${escapeLike(folder)}/%`);
  }
  return { sql: ` WHERE ${clauses.join(' OR ')}`, params };
}

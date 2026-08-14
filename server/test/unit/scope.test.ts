import { describe, expect, it } from 'vitest';
import { accessScope, dirAllowed, folderFilter, galleryScope } from '../../src/scope.js';
import type { User } from '../../src/types.js';

function user(overrides: Partial<User> = {}): User {
  return {
    id: 1,
    label: 'Test',
    role: 'viewer',
    folders: [],
    createdAt: 0,
    lastSeenAt: null,
    ...overrides,
  };
}

describe('accessScope', () => {
  it('leaves an admin unrestricted', () => {
    expect(accessScope(user({ role: 'admin', folders: [''] }))).toBeNull();
  });

  it('confines a viewer to their assigned folders', () => {
    expect(accessScope(user({ folders: ['Travel'] }))).toEqual(['Travel']);
  });

  it('gives a viewer with no folders access to nothing', () => {
    expect(accessScope(user({ folders: [] }))).toEqual([]);
  });
});

describe('galleryScope', () => {
  it('uses a viewer`s own assignment, not the library-wide setting', () => {
    expect(galleryScope(user({ folders: ['Travel/Norway'] }))).toEqual(['Travel/Norway']);
  });
});

describe('dirAllowed', () => {
  it('lets a null scope through — that is what admin means', () => {
    expect(dirAllowed(null, 'anything/at/all')).toBe(true);
  });

  it('allows the scoped folder itself and anything beneath it', () => {
    const scope = ['Travel'];
    expect(dirAllowed(scope, 'Travel')).toBe(true);
    expect(dirAllowed(scope, 'Travel/Norway')).toBe(true);
    expect(dirAllowed(scope, 'Travel/Norway/2024')).toBe(true);
  });

  it('refuses a sibling whose name merely starts the same way', () => {
    // The bug this guards: a prefix match without the separator would hand
    // `Travel-private` to anyone scoped to `Travel`.
    expect(dirAllowed(['Travel'], 'Travel-private')).toBe(false);
    expect(dirAllowed(['Travel'], 'Travelling')).toBe(false);
  });

  it('refuses a parent of the scoped folder', () => {
    expect(dirAllowed(['Travel/Norway'], 'Travel')).toBe(false);
    expect(dirAllowed(['Travel/Norway'], '')).toBe(false);
  });

  it('refuses an unrelated folder', () => {
    expect(dirAllowed(['Travel'], 'Family')).toBe(false);
  });

  it('treats the root entry as the whole library', () => {
    expect(dirAllowed([''], 'Family/Birthdays')).toBe(true);
  });

  it('shows nothing for an empty scope', () => {
    expect(dirAllowed([], 'Travel')).toBe(false);
  });

  it('normalises separators on both sides before comparing', () => {
    expect(dirAllowed(['Travel\\Norway'], 'Travel/Norway/2024')).toBe(true);
    expect(dirAllowed(['/Travel/'], 'Travel/Norway')).toBe(true);
  });

  it('honours any one of several scoped folders', () => {
    const scope = ['Travel', 'Scans'];
    expect(dirAllowed(scope, 'Scans/1998')).toBe(true);
    expect(dirAllowed(scope, 'Family')).toBe(false);
  });
});

describe('folderFilter', () => {
  it('shows nothing for an empty selection', () => {
    // An empty gallery selection is an explicit choice, not a shorthand for
    // "everything" — the opposite reading would leak the library by default.
    expect(folderFilter([])).toEqual({ sql: ' WHERE 0', params: [] });
  });

  it('drops the WHERE clause entirely when the root is selected', () => {
    expect(folderFilter([''])).toEqual({ sql: '', params: [] });
    expect(folderFilter(['Travel', ''])).toEqual({ sql: '', params: [] });
  });

  it('matches the folder and its descendants', () => {
    const { sql, params } = folderFilter(['Travel']);
    expect(sql).toBe(" WHERE (dir = ? OR dir LIKE ? ESCAPE '\\')");
    expect(params).toEqual(['Travel', 'Travel/%']);
  });

  it('ORs several folders together', () => {
    const { sql, params } = folderFilter(['Travel', 'Scans']);
    expect(sql.match(/dir = \?/g)).toHaveLength(2);
    expect(params).toEqual(['Travel', 'Travel/%', 'Scans', 'Scans/%']);
  });

  it('de-duplicates after normalising', () => {
    expect(folderFilter(['Travel', '/Travel/', 'Travel\\']).params).toEqual(['Travel', 'Travel/%']);
  });

  it('escapes LIKE wildcards in a folder name', () => {
    // A folder genuinely called `100%_backup` must not become a wildcard that
    // matches every sibling.
    const { params } = folderFilter(['100%_backup']);
    expect(params[1]).toBe('100\\%\\_backup/%');
  });
});

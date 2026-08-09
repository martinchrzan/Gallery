/**
 * Toggles one folder in a selection, keeping the set canonical.
 *
 * Selecting a folder implies everything beneath it, so its descendants are
 * dropped rather than left as redundant entries — which also means selecting the
 * root collapses the whole selection to `['']`. Shared by the library-wide
 * gallery setting and each viewer's own folder assignment so the two can never
 * interpret a selection differently.
 */
export function toggleFolder(selected: Iterable<string>, path: string): string[] {
  const next = new Set(selected);

  if (next.has(path)) {
    next.delete(path);
    return [...next];
  }

  next.add(path);
  for (const existing of [...next]) {
    if (existing !== path && (path === '' || existing.startsWith(`${path}/`))) {
      next.delete(existing);
    }
  }
  return [...next];
}

/** Human summary of a folder selection, for a list row. */
export function describeFolders(folders: string[]): string {
  if (folders.includes('')) return 'All photos';
  if (folders.length === 0) return 'No folders — sees nothing';
  return `${folders.length} folder${folders.length === 1 ? '' : 's'}`;
}

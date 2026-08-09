import type {
  BrowseResult,
  FolderNode,
  IndexStatus,
  PhotoDetail,
  Settings,
  StatsResult,
} from '@shared';

export type { BrowseResult, FolderNode, IndexStatus, PhotoDetail, Settings, StatsResult };

/**
 * The gallery feed, decoded from the server's packed binary manifest.
 * Parallel typed arrays rather than an array of objects: 50k photos cost ~600 KB
 * and zero parse time, and the layout pass iterates them without touching the heap.
 */
export interface Manifest {
  count: number;
  /** Photo ids, ordered newest first. */
  ids: Uint32Array;
  /** Capture time in epoch seconds; 0 when unknown. */
  times: Uint32Array;
  widths: Uint16Array;
  heights: Uint16Array;
}

export const RECORD_BYTES = 12;

export const EMPTY_MANIFEST: Manifest = {
  count: 0,
  ids: new Uint32Array(0),
  times: new Uint32Array(0),
  widths: new Uint16Array(0),
  heights: new Uint16Array(0),
};

async function jsonRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: {
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...init?.headers,
    },
  });
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      // Non-JSON error body; the status line is all we have.
    }
    throw new Error(message);
  }
  return (await res.json()) as T;
}

export async function fetchManifest(signal?: AbortSignal): Promise<Manifest> {
  const res = await fetch('/api/gallery/manifest', { signal });
  if (!res.ok) throw new Error(`Could not load the gallery (${res.status})`);

  const buffer = await res.arrayBuffer();
  const count = Math.floor(buffer.byteLength / RECORD_BYTES);
  if (count === 0) return EMPTY_MANIFEST;

  const ids = new Uint32Array(count);
  const times = new Uint32Array(count);
  const widths = new Uint16Array(count);
  const heights = new Uint16Array(count);

  // DataView with an explicit little-endian read: the packed layout is not
  // 4-byte aligned per field, so typed-array views over the buffer won't work.
  const view = new DataView(buffer);
  for (let i = 0; i < count; i++) {
    const offset = i * RECORD_BYTES;
    ids[i] = view.getUint32(offset, true);
    times[i] = view.getUint32(offset + 4, true);
    widths[i] = view.getUint16(offset + 8, true);
    heights[i] = view.getUint16(offset + 10, true);
  }

  return { count, ids, times, widths, heights };
}

export const api = {
  photo: (id: number, signal?: AbortSignal) =>
    jsonRequest<PhotoDetail>(`/api/photos/${id}`, { signal }),

  browse: (path: string, signal?: AbortSignal) =>
    jsonRequest<BrowseResult>(`/api/files/browse?path=${encodeURIComponent(path)}`, { signal }),

  folderTree: (signal?: AbortSignal) => jsonRequest<FolderNode>('/api/folders/tree', { signal }),

  settings: (signal?: AbortSignal) => jsonRequest<Settings>('/api/settings', { signal }),

  saveSettings: (patch: Partial<Settings>) =>
    jsonRequest<Settings>('/api/settings', { method: 'PUT', body: JSON.stringify(patch) }),

  stats: (signal?: AbortSignal) => jsonRequest<StatsResult>('/api/stats', { signal }),

  indexStatus: (signal?: AbortSignal) => jsonRequest<IndexStatus>('/api/index/status', { signal }),

  rescan: () => jsonRequest<{ started: boolean }>('/api/index/rescan', { method: 'POST' }),

  clearCache: () => jsonRequest<{ cleared: boolean }>('/api/cache/clear', { method: 'POST' }),
};

/* ------------------------------------------------------------------ urls -- */

export function thumbUrl(id: number, size: 320 | 640 | 1600): string {
  return `/api/media/${id}/thumb?h=${size}`;
}

export function originalUrl(id: number): string {
  return `/api/media/${id}/original`;
}

export function photoDownloadUrl(id: number): string {
  return `/api/media/${id}/original?download=1`;
}

export function fileDownloadUrl(path: string): string {
  return `/api/files/download?path=${encodeURIComponent(path)}`;
}

/**
 * Downloads a ZIP of the given paths.
 *
 * Submits a real form rather than using `fetch`: the browser then streams the
 * archive straight to disk. Fetching it would buffer the whole ZIP in memory
 * first, which falls over as soon as you select a few gigabytes of photos.
 */
export function downloadZip(paths: string[], name?: string): void {
  const form = document.createElement('form');
  form.method = 'POST';
  form.action = '/api/files/zip';
  form.style.display = 'none';

  const field = document.createElement('input');
  field.type = 'hidden';
  field.name = 'payload';
  field.value = JSON.stringify({ paths, name });
  form.appendChild(field);

  document.body.appendChild(form);
  form.submit();
  form.remove();
}

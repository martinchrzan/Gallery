import type {
  ActivityReport,
  AuthState,
  BrowseResult,
  DirEntry,
  FolderNode,
  IndexStatus,
  MediaKind,
  PhotoDetail,
  Role,
  Settings,
  StatsResult,
  UploadedFile,
  UploadSession,
  User,
  UserWithCode,
} from '@shared';

export type {
  ActivityReport,
  AuthState,
  BrowseResult,
  DirEntry,
  FolderNode,
  IndexStatus,
  MediaKind,
  PhotoDetail,
  Role,
  Settings,
  StatsResult,
  UploadedFile,
  UploadSession,
  User,
  UserWithCode,
};

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
  /** 1 for a video, 0 for a photo — {@link MANIFEST_FLAG_VIDEO} unpacked. */
  videos: Uint8Array;
  /** Runtime in whole seconds; 0 for photos and for videos of unknown length. */
  durations: Uint16Array;
  /** 1 when `times` holds the file's own timestamp rather than a capture date. */
  fileDates: Uint8Array;
}

export const RECORD_BYTES = 16;

/** Bit 0 of a record's flags field. */
const MANIFEST_FLAG_VIDEO = 1;
/** Bit 1: the date is the file's timestamp, so it is not when it was taken. */
const MANIFEST_FLAG_FILE_DATE = 2;

export const EMPTY_MANIFEST: Manifest = {
  count: 0,
  ids: new Uint32Array(0),
  times: new Uint32Array(0),
  widths: new Uint16Array(0),
  heights: new Uint16Array(0),
  videos: new Uint8Array(0),
  durations: new Uint16Array(0),
  fileDates: new Uint8Array(0),
};

/** Builds a manifest from parallel arrays, filling in whatever was omitted. */
export function makeManifest(
  fields: Partial<Manifest> & { count: number; ids: Uint32Array },
): Manifest {
  const { count } = fields;
  return {
    count,
    ids: fields.ids,
    times: fields.times ?? new Uint32Array(count),
    widths: fields.widths ?? new Uint16Array(count),
    heights: fields.heights ?? new Uint16Array(count),
    videos: fields.videos ?? new Uint8Array(count),
    durations: fields.durations ?? new Uint16Array(count),
    fileDates: fields.fileDates ?? new Uint8Array(count),
  };
}

/** True when the item at this position is a video rather than a photo. */
export function isVideoAt(manifest: Manifest, index: number): boolean {
  return manifest.videos[index] === 1;
}

/**
 * True when this photo's date is its file timestamp rather than a capture date.
 * Anything presenting a date as when the photo was taken has to check.
 */
export function isFileDatedAt(manifest: Manifest, index: number): boolean {
  return manifest.fileDates[index] === 1;
}

/**
 * Called whenever the server rejects a request for want of a session, so a
 * cookie that expired mid-browse drops straight back to the login screen
 * instead of leaving the UI wedged on an error.
 */
let onUnauthorized: (() => void) | null = null;

export function setUnauthorizedHandler(handler: (() => void) | null): void {
  onUnauthorized = handler;
}

/**
 * A failed request, carrying the status so a caller can tell "try again" from
 * "this will never work" — which is what the upload retry loop decides on.
 */
export class RequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** The server's `{ error }` message for a failed response, or its status line. */
async function failure(res: Response): Promise<RequestError> {
  let message = `${res.status} ${res.statusText}`;
  try {
    const body = (await res.json()) as { error?: string };
    if (body.error) message = body.error;
  } catch {
    // Non-JSON error body; the status line is all we have.
  }
  return new RequestError(message, res.status);
}

async function jsonRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: {
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...init?.headers,
    },
  });
  if (res.status === 401) onUnauthorized?.();
  if (!res.ok) throw await failure(res);
  return (await res.json()) as T;
}

export async function fetchManifest(signal?: AbortSignal): Promise<Manifest> {
  const res = await fetch('/api/gallery/manifest', { signal });
  if (res.status === 401) onUnauthorized?.();
  if (!res.ok) throw new Error(`Could not load the gallery (${res.status})`);

  setMediaVersion(res.headers.get('X-Media-Version') ?? '');

  const buffer = await res.arrayBuffer();
  const count = Math.floor(buffer.byteLength / RECORD_BYTES);
  if (count === 0) return EMPTY_MANIFEST;

  const ids = new Uint32Array(count);
  const times = new Uint32Array(count);
  const widths = new Uint16Array(count);
  const heights = new Uint16Array(count);
  const videos = new Uint8Array(count);
  const durations = new Uint16Array(count);
  const fileDates = new Uint8Array(count);

  // DataView with an explicit little-endian read: the packed layout is not
  // 4-byte aligned per field, so typed-array views over the buffer won't work.
  const view = new DataView(buffer);
  for (let i = 0; i < count; i++) {
    const offset = i * RECORD_BYTES;
    ids[i] = view.getUint32(offset, true);
    times[i] = view.getUint32(offset + 4, true);
    widths[i] = view.getUint16(offset + 8, true);
    heights[i] = view.getUint16(offset + 10, true);
    durations[i] = view.getUint16(offset + 12, true);
    const flags = view.getUint16(offset + 14, true);
    videos[i] = flags & MANIFEST_FLAG_VIDEO ? 1 : 0;
    fileDates[i] = flags & MANIFEST_FLAG_FILE_DATE ? 1 : 0;
  }

  return { count, ids, times, widths, heights, videos, durations, fileDates };
}

/**
 * Probes the current session without tripping {@link setUnauthorizedHandler} —
 * a 401 here is the expected answer for a signed-out visitor, not an event.
 */
export async function probeSession(signal?: AbortSignal): Promise<AuthState | null> {
  const res = await fetch('/api/auth/me', { signal });
  if (res.status === 401) return null;
  if (!res.ok) throw new Error(`Could not reach the server (${res.status})`);
  return (await res.json()) as AuthState;
}

export const api = {
  login: (code: string) =>
    jsonRequest<AuthState>('/api/auth/login', { method: 'POST', body: JSON.stringify({ code }) }),

  logout: () => jsonRequest<{ ok: boolean }>('/api/auth/logout', { method: 'POST' }),

  users: (signal?: AbortSignal) => jsonRequest<User[]>('/api/users', { signal }),

  createUser: (input: { label: string; folders: string[] }) =>
    jsonRequest<UserWithCode>('/api/users', { method: 'POST', body: JSON.stringify(input) }),

  updateUser: (id: number, patch: { label?: string; folders?: string[] }) =>
    jsonRequest<User>(`/api/users/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),

  rotateUserCode: (id: number) =>
    jsonRequest<UserWithCode>(`/api/users/${id}/code`, { method: 'POST' }),

  deleteUser: (id: number) =>
    jsonRequest<{ deleted: boolean }>(`/api/users/${id}`, { method: 'DELETE' }),

  photo: (id: number, signal?: AbortSignal) =>
    jsonRequest<PhotoDetail>(`/api/photos/${id}`, { signal }),

  browse: (path: string, signal?: AbortSignal) =>
    jsonRequest<BrowseResult>(`/api/files/browse?path=${encodeURIComponent(path)}`, { signal }),

  folderTree: (signal?: AbortSignal) => jsonRequest<FolderNode>('/api/folders/tree', { signal }),

  createFolder: (input: { path: string; name: string }) =>
    jsonRequest<DirEntry>('/api/files/folder', { method: 'POST', body: JSON.stringify(input) }),

  setFavorite: (path: string, favorite: boolean) =>
    jsonRequest<{ favoriteFolders: string[] }>('/api/files/favorite', {
      method: 'PUT',
      body: JSON.stringify({ path, favorite }),
    }),

  /** Re-reads one file and renders its preview again; says whether that worked. */
  repairMedia: (id: number) =>
    jsonRequest<{ ok: boolean; error: string | null }>(`/api/media/${id}/repair`, {
      method: 'POST',
    }),

  retryFailed: () =>
    jsonRequest<{ queued: number }>('/api/index/retry-failed', { method: 'POST' }),

  settings: (signal?: AbortSignal) => jsonRequest<Settings>('/api/settings', { signal }),

  saveSettings: (patch: Partial<Settings>) =>
    jsonRequest<Settings>('/api/settings', { method: 'PUT', body: JSON.stringify(patch) }),

  stats: (signal?: AbortSignal) => jsonRequest<StatsResult>('/api/stats', { signal }),

  activity: (since: number, signal?: AbortSignal) =>
    jsonRequest<ActivityReport>(`/api/activity?since=${since}`, { signal }),

  indexStatus: (signal?: AbortSignal) => jsonRequest<IndexStatus>('/api/index/status', { signal }),

  rescan: () => jsonRequest<{ started: boolean }>('/api/index/rescan', { method: 'POST' }),

  clearCache: () => jsonRequest<{ cleared: boolean }>('/api/cache/clear', { method: 'POST' }),

  uploadInit: (input: { path: string; name: string; size: number }) =>
    jsonRequest<UploadSession>('/api/files/upload', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  uploadFinish: (uploadId: string) =>
    jsonRequest<UploadedFile>(`/api/files/upload/${uploadId}/finish`, { method: 'POST' }),

  uploadAbort: (uploadId: string) =>
    jsonRequest<{ aborted: boolean }>(`/api/files/upload/${uploadId}`, { method: 'DELETE' }),
};

/**
 * Sends one chunk and returns how many bytes the server now holds.
 *
 * A 409 is not treated as a failure: it means the chunk landed but its reply
 * was lost — a routine event on a phone changing cells — and the body says
 * where the server actually is, which is exactly what the caller needs to
 * carry on from.
 */
export async function uploadChunk(
  uploadId: string,
  offset: number,
  chunk: Blob,
  signal?: AbortSignal,
): Promise<number> {
  const res = await fetch(`/api/files/upload/${uploadId}/chunk?offset=${offset}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: chunk,
    signal,
  });

  if (res.status === 401) onUnauthorized?.();

  if (res.status === 409) {
    const body = (await res.json().catch(() => ({}))) as {
      error?: string;
      expectedOffset?: number;
    };
    if (typeof body.expectedOffset === 'number') return body.expectedOffset;
    throw new RequestError(body.error ?? 'Upload conflict', 409);
  }

  if (!res.ok) throw await failure(res);

  const body = (await res.json()) as { received: number };
  return body.received;
}

/* ------------------------------------------------------------------ urls -- */

/**
 * Cache-busting token for media URLs, refreshed with every manifest.
 *
 * A media URL names its photo by id, and an id is a rowid a rescan can hand to
 * a different file — so a browser that cached one is holding an image it has no
 * way to know is stale. Moving the URL when the index changes is what lets a
 * client escape a copy it would otherwise never re-request.
 */
let mediaVersion = '';

export function setMediaVersion(version: string): void {
  mediaVersion = version;
}

function versioned(url: string): string {
  if (!mediaVersion) return url;
  return `${url}${url.includes('?') ? '&' : '?'}v=${encodeURIComponent(mediaVersion)}`;
}

/**
 * `attempt` moves the URL for a retry, so the browser asks the server again
 * instead of answering from whatever it remembers about the failed request.
 */
export function thumbUrl(id: number, size: 320 | 640 | 1600, attempt = 0): string {
  const url = versioned(`/api/media/${id}/thumb?h=${size}`);
  return attempt > 0 ? `${url}&r=${attempt}` : url;
}

export function originalUrl(id: number): string {
  return versioned(`/api/media/${id}/original`);
}

export function photoDownloadUrl(id: number): string {
  return versioned(`/api/media/${id}/original?download=1`);
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

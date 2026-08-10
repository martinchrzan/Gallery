/**
 * Types shared between the server and the web client.
 * Kept dependency-free so `web` can import it directly via a path alias.
 */

export type IndexMode = 'watch' | 'interval' | 'manual';

/**
 * `admin` sees and configures everything. `viewer` gets the gallery feed for an
 * explicit list of folders and nothing else — no Files tab, no settings, and no
 * way to address a photo outside those folders.
 */
export type Role = 'admin' | 'viewer';

export interface User {
  id: number;
  /** Display name, shown in the admin's user list. Not a login credential. */
  label: string;
  role: Role;
  /**
   * Folders this viewer may see, same semantics as {@link Settings.galleryFolders}.
   * Always `['']` for an admin, who is never folder-restricted.
   */
  folders: string[];
  createdAt: number;
  lastSeenAt: number | null;
}

/** A newly created or rotated access code. Returned once and never stored in the clear. */
export interface UserWithCode {
  user: User;
  code: string;
}

export interface Settings {
  /**
   * Relative folder paths (POSIX separators) whose photos appear in the gallery
   * feed, including their subfolders. `''` is the library root, i.e. everything.
   *
   * An empty array means an empty gallery — the selection is explicit, so
   * deselecting everything shows nothing rather than silently reverting to all.
   * New installs start at `[]` so a fresh admin must opt in to a folder rather
   * than the whole library being exposed by default.
   */
  galleryFolders: string[];
  indexMode: IndexMode;
  /** Rescan period for indexMode === 'interval'. */
  indexIntervalHours: number;
  /** Target height of a justified gallery row, in CSS pixels. */
  rowHeight: number;
  /** Whether the lightbox metadata panel starts open. */
  showMetadata: boolean;
  /** Generate all grid thumbnails in the background after a scan. */
  prewarmThumbs: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  galleryFolders: [],
  indexMode: 'watch',
  indexIntervalHours: 6,
  rowHeight: 240,
  showMetadata: false,
  prewarmThumbs: false,
};

/**
 * Photos and videos share one feed, one id space and one set of routes; this is
 * the only thing that separates them on the client.
 */
export type MediaKind = 'photo' | 'video';

export interface PhotoDetail {
  id: number;
  kind: MediaKind;
  /** Runtime in milliseconds for a video; null for a photo. */
  duration: number | null;
  path: string;
  name: string;
  dir: string;
  size: number;
  width: number | null;
  height: number | null;
  takenAt: number | null;
  takenSource: 'exif' | 'filename' | 'mtime' | null;
  modifiedAt: number;
  camera: string | null;
  lens: string | null;
  iso: number | null;
  aperture: number | null;
  exposure: string | null;
  focalLength: number | null;
  gps: { lat: number; lon: number } | null;
}

export interface DirEntry {
  name: string;
  path: string;
}

export interface FileEntry {
  name: string;
  path: string;
  size: number;
  modifiedAt: number;
  /** Present when the file is indexed, and so has a thumbnail and a viewer. */
  photoId: number | null;
  width: number | null;
  height: number | null;
  /** True for image types we can display but not thumbnail (e.g. HEIC). */
  unsupportedImage: boolean;
  /** True when this entry is an indexed video rather than a photo. */
  video: boolean;
}

export interface BrowseResult {
  path: string;
  parent: string | null;
  dirs: DirEntry[];
  files: FileEntry[];
}

export interface FolderNode {
  name: string;
  path: string;
  children: FolderNode[];
  photoCount: number;
}

export interface IndexStatus {
  scanning: boolean;
  phase: 'idle' | 'walking' | 'extracting' | 'prewarming';
  /** Files discovered by the walk so far. */
  discovered: number;
  /** Photos whose metadata has been extracted in this pass. */
  processed: number;
  /** Photos still awaiting metadata extraction. */
  pending: number;
  total: number;
  lastScanAt: number | null;
  lastError: string | null;
  /**
   * Paths the filesystem watcher could not attach to — a Windows/OneDrive/SMB
   * condition, not an indexing failure. Kept apart from {@link lastError} so a
   * single unwatchable file does not report the whole index as broken; the
   * gallery is complete either way, those files just wait for the next scan.
   */
  watchIssue: string | null;
}

export interface AuthState {
  user: User;
}

export interface StatsResult {
  /** Everything in the index, videos included. */
  photos: number;
  videos: number;
  totalBytes: number;
  thumbBytes: number;
  thumbFiles: number;
  oldest: number | null;
  newest: number | null;
}

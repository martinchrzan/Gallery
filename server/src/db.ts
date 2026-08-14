import Database from 'better-sqlite3';
import { config } from './config.js';
import { DEFAULT_SETTINGS, type Settings } from './types.js';

export interface PhotoRow {
  id: number;
  rel_path: string;
  dir: string;
  name: string;
  ext: string;
  size: number;
  mtime_ms: number;
  width: number | null;
  height: number | null;
  orientation: number | null;
  taken_at: number | null;
  taken_src: string | null;
  camera: string | null;
  lens: string | null;
  iso: number | null;
  fnum: number | null;
  exposure: string | null;
  focal: number | null;
  gps_lat: number | null;
  gps_lon: number | null;
  /** {@link KIND_IMAGE} or {@link KIND_VIDEO}, decided by extension at scan time. */
  kind: number;
  /** Runtime of a video in milliseconds; always null for a photo. */
  duration_ms: number | null;
  content_key: string;
  meta_state: number;
  /** Extraction attempts so far. Lets a file that crashes the extractor be retired. */
  meta_attempts: number;
  seen_gen: number;
}

/**
 * The `photos` table holds videos too — one chronological feed is the whole
 * point, so splitting them into a second table would only mean merging it back
 * on every query. `kind` is what the two differ by.
 */
export const KIND_IMAGE = 0;
export const KIND_VIDEO = 1;

export const META_PENDING = 0;
export const META_DONE = 1;
export const META_FAILED = 2;
/** Claimed by a worker batch. Reset to pending on startup after a crash. */
export const META_INFLIGHT = 3;

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (db) return db;

  const instance = new Database(config().dbPath);
  instance.pragma('journal_mode = WAL');
  instance.pragma('synchronous = NORMAL');
  instance.pragma('foreign_keys = ON');
  // Big page cache: the manifest query touches every row and should stay in memory.
  instance.pragma('cache_size = -32000');
  instance.pragma('mmap_size = 268435456');

  migrate(instance);
  db = instance;
  return instance;
}

/**
 * Closes the database, checkpointing the WAL on the way out.
 *
 * SQLite recovers from an abrupt exit on its own, so this is not a correctness
 * requirement — but it leaves no `-wal` file behind after a clean shutdown, and
 * it lets a test delete its temporary data directory on Windows, where an open
 * handle blocks the unlink.
 */
export function closeDb(): void {
  if (!db) return;
  db.close();
  db = null;
}

function migrate(instance: Database.Database): void {
  instance.exec(`
    CREATE TABLE IF NOT EXISTS photos (
      id          INTEGER PRIMARY KEY,
      rel_path    TEXT    NOT NULL UNIQUE,
      dir         TEXT    NOT NULL,
      name        TEXT    NOT NULL,
      ext         TEXT    NOT NULL,
      size        INTEGER NOT NULL,
      mtime_ms    INTEGER NOT NULL,
      width       INTEGER,
      height      INTEGER,
      orientation INTEGER,
      taken_at    INTEGER,
      taken_src   TEXT,
      camera      TEXT,
      lens        TEXT,
      iso         INTEGER,
      fnum        REAL,
      exposure    TEXT,
      focal       REAL,
      gps_lat     REAL,
      gps_lon     REAL,
      content_key TEXT    NOT NULL,
      meta_state  INTEGER NOT NULL DEFAULT 0,
      seen_gen    INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_photos_taken   ON photos(taken_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_photos_dir     ON photos(dir);
    CREATE INDEX IF NOT EXISTS idx_photos_pending ON photos(meta_state) WHERE meta_state = 0;

    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS users (
      id           INTEGER PRIMARY KEY,
      label        TEXT    NOT NULL,
      role         TEXT    NOT NULL,
      -- scrypt digest of the access code. The code itself is never stored.
      code_hash    TEXT    NOT NULL,
      -- JSON array of relative folder paths; '' means the whole library.
      folders      TEXT    NOT NULL DEFAULT '[]',
      created_at   INTEGER NOT NULL,
      last_seen_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id         TEXT    PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
  `);

  addColumn(instance, 'photos', 'meta_attempts', 'INTEGER NOT NULL DEFAULT 0');
  // Existing rows are all images, which is exactly what the default says. The
  // next scan sets `kind` properly for anything new.
  addColumn(instance, 'photos', 'kind', `INTEGER NOT NULL DEFAULT ${KIND_IMAGE}`);
  addColumn(instance, 'photos', 'duration_ms', 'INTEGER');
}

/** `ALTER TABLE ... ADD COLUMN` is not idempotent in SQLite, so check first. */
function addColumn(
  instance: Database.Database,
  table: string,
  column: string,
  definition: string,
): void {
  const columns = instance.pragma(`table_info(${table})`) as { name: string }[];
  if (columns.some((c) => c.name === column)) return;
  instance.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

/* ------------------------------------------------------------------ meta -- */

export function getMeta(key: string): string | null {
  const row = getDb().prepare('SELECT value FROM meta WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

export function setMeta(key: string, value: string): void {
  getDb()
    .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value);
}

/* --------------------------------------------------------------- photos -- */

/**
 * Records that this photo's bytes cannot be read. Called when a file kills the
 * worker that touched it, so nothing hands it to libvips a second time.
 */
export function markMetaFailed(id: number): void {
  getDb().prepare(`UPDATE photos SET meta_state = ${META_FAILED} WHERE id = ?`).run(id);
}

/* -------------------------------------------------------------- settings -- */

export function getSettings(): Settings {
  const rows = getDb().prepare('SELECT key, value FROM settings').all() as {
    key: string;
    value: string;
  }[];

  const stored: Record<string, unknown> = {};
  for (const row of rows) {
    try {
      stored[row.key] = JSON.parse(row.value);
    } catch {
      // Ignore a corrupt row rather than failing the whole app; the default wins.
    }
  }
  return { ...DEFAULT_SETTINGS, ...stored } as Settings;
}

export function saveSettings(patch: Partial<Settings>): Settings {
  const stmt = getDb().prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  );
  const write = getDb().transaction((entries: [string, unknown][]) => {
    for (const [key, value] of entries) stmt.run(key, JSON.stringify(value));
  });
  write(Object.entries(patch));
  return getSettings();
}

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
  content_key: string;
  meta_state: number;
  seen_gen: number;
}

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
  `);
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

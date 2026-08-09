import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { z } from 'zod';

const here = path.dirname(url.fileURLToPath(import.meta.url));
/** Repo root: <root>/server/src (dev) or <root>/server/dist (built). */
export const repoRoot = path.resolve(here, '..', '..');

const ConfigSchema = z.object({
  photosRoot: z.string().min(1),
  port: z.number().int().positive().default(4000),
  host: z.string().default('0.0.0.0'),
  dataDir: z.string().default('./data'),
});

export interface Config {
  /** Absolute, real (symlink-resolved) path to the photo library root. */
  photosRoot: string;
  port: number;
  host: string;
  /** Absolute path holding the SQLite index and the thumbnail cache. */
  dataDir: string;
  thumbDir: string;
  dbPath: string;
}

function readConfigFile(): unknown {
  const explicit = process.env.GALLERY_CONFIG;
  const candidates = explicit
    ? [path.resolve(explicit)]
    : [path.join(repoRoot, 'config.json'), path.join(process.cwd(), 'config.json')];

  for (const file of candidates) {
    if (fs.existsSync(file)) {
      try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch (err) {
        throw new Error(`Could not parse ${file}: ${(err as Error).message}`);
      }
    }
  }
  return {};
}

export function loadConfig(): Config {
  const fromFile = readConfigFile() as Record<string, unknown>;

  // Environment always wins over the file, so a service unit can override it.
  const merged = {
    ...fromFile,
    ...(process.env.PHOTOS_ROOT ? { photosRoot: process.env.PHOTOS_ROOT } : {}),
    ...(process.env.PORT ? { port: Number(process.env.PORT) } : {}),
    ...(process.env.HOST ? { host: process.env.HOST } : {}),
    ...(process.env.DATA_DIR ? { dataDir: process.env.DATA_DIR } : {}),
  };

  const parsed = ConfigSchema.safeParse(merged);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n');
    throw new Error(
      `Invalid configuration:\n${detail}\n\n` +
        `Copy config.example.json to config.json and set "photosRoot" to your photo folder,\n` +
        `or set the PHOTOS_ROOT environment variable.`,
    );
  }

  const raw = parsed.data;
  const photosRootAbs = path.resolve(repoRoot, raw.photosRoot);

  if (!fs.existsSync(photosRootAbs)) {
    throw new Error(`photosRoot does not exist: ${photosRootAbs}`);
  }
  if (!fs.statSync(photosRootAbs).isDirectory()) {
    throw new Error(`photosRoot is not a directory: ${photosRootAbs}`);
  }

  // Resolve symlinks once here so every later containment check compares real paths.
  const photosRoot = fs.realpathSync.native(photosRootAbs);
  const dataDir = path.resolve(repoRoot, raw.dataDir);
  fs.mkdirSync(dataDir, { recursive: true });

  return {
    photosRoot,
    port: raw.port,
    host: raw.host,
    dataDir,
    thumbDir: path.join(dataDir, 'thumbs'),
    dbPath: path.join(dataDir, 'gallery.db'),
  };
}

let cached: Config | null = null;

/** The process-wide config, loaded and validated on first use. */
export function config(): Config {
  if (!cached) cached = loadConfig();
  return cached;
}

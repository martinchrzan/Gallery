import exifr from 'exifr';
import sharp from 'sharp';

export interface ExtractedMeta {
  width: number | null;
  height: number | null;
  orientation: number | null;
  takenAt: number | null;
  takenSrc: 'exif' | 'filename' | 'mtime' | null;
  camera: string | null;
  lens: string | null;
  iso: number | null;
  fnum: number | null;
  exposure: string | null;
  focal: number | null;
  gpsLat: number | null;
  gpsLon: number | null;
  failed: boolean;
}

const EXIF_OPTIONS = {
  // Only the blocks we actually read — skipping the rest is most of the speedup.
  tiff: true,
  ifd0: true,
  exif: true,
  gps: true,
  interop: false,
  ifd1: false,
  translateKeys: true,
  translateValues: true,
  reviveValues: true,
  sanitize: true,
  mergeOutput: true,
  pick: [
    'DateTimeOriginal',
    'CreateDate',
    'ModifyDate',
    'OffsetTimeOriginal',
    'Orientation',
    'ExifImageWidth',
    'ExifImageHeight',
    'Make',
    'Model',
    'LensModel',
    'ISO',
    'FNumber',
    'ExposureTime',
    'FocalLength',
    'latitude',
    'longitude',
  ],
} as const;

/** `2019-07-04 13:22:31` / `20190704_132231` / `IMG-20190704-WA0001` style names. */
const FILENAME_DATE = /(19|20)(\d{2})[-_.]?(\d{2})[-_.]?(\d{2})(?:[-_.T]?(\d{2})[-_.:]?(\d{2})[-_.:]?(\d{2}))?/;

/**
 * Recovers a date from the filename when EXIF has none — very common for
 * WhatsApp exports, screenshots and scanner output.
 */
export function dateFromFilename(name: string): number | null {
  const m = FILENAME_DATE.exec(name);
  if (!m) return null;

  const year = Number(`${m[1]}${m[2]}`);
  const month = Number(m[3]);
  const day = Number(m[4]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  const hour = m[5] ? Number(m[5]) : 12;
  const minute = m[6] ? Number(m[6]) : 0;
  const second = m[7] ? Number(m[7]) : 0;
  if (hour > 23 || minute > 59 || second > 59) return null;

  const ts = new Date(year, month - 1, day, hour, minute, second).getTime();
  if (Number.isNaN(ts)) return null;
  // Guard against matching an unrelated run of digits far in the future.
  if (ts > Date.now() + 86_400_000) return null;
  return ts;
}

function toEpoch(value: unknown): number | null {
  if (value instanceof Date) {
    const ts = value.getTime();
    return Number.isFinite(ts) && ts > 0 ? ts : null;
  }
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  return null;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return null;
}

function toNumber(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Renders a shutter speed as `1/250` or `2.5s`. */
function formatExposure(value: unknown): string | null {
  const n = toNumber(value);
  if (n === null || n <= 0) return null;
  return n >= 1 ? `${Number(n.toFixed(1))}s` : `1/${Math.round(1 / n)}`;
}

/**
 * Reads dimensions and EXIF for one image. Never throws: a file that cannot be
 * parsed comes back with `failed: true` and whatever could be salvaged, so a
 * single bad photo never stalls a scan.
 */
export async function extractMetadata(
  absPath: string,
  fileName: string,
  mtimeMs: number,
): Promise<ExtractedMeta> {
  const result: ExtractedMeta = {
    width: null,
    height: null,
    orientation: null,
    takenAt: null,
    takenSrc: null,
    camera: null,
    lens: null,
    iso: null,
    fnum: null,
    exposure: null,
    focal: null,
    gpsLat: null,
    gpsLon: null,
    failed: false,
  };

  let dimensionsOk = false;
  try {
    const meta = await sharp(absPath, { failOn: 'none' }).metadata();
    const rotated = (meta.orientation ?? 1) >= 5;
    const w = meta.width ?? null;
    const h = meta.height ?? null;
    // Report post-rotation dimensions so the client's layout matches the pixels
    // it will actually receive from the thumbnailer.
    result.width = rotated ? h : w;
    result.height = rotated ? w : h;
    result.orientation = meta.orientation ?? null;
    dimensionsOk = result.width !== null && result.height !== null;
  } catch {
    result.failed = true;
  }

  try {
    const exif = (await exifr.parse(absPath, EXIF_OPTIONS as never)) as Record<string, unknown> | undefined;
    if (exif) {
      const taken = toEpoch(exif.DateTimeOriginal) ?? toEpoch(exif.CreateDate);
      if (taken !== null) {
        result.takenAt = taken;
        result.takenSrc = 'exif';
      }

      const make = firstString(exif.Make);
      const model = firstString(exif.Model);
      result.camera =
        make && model
          ? model.toLowerCase().startsWith(make.toLowerCase())
            ? model
            : `${make} ${model}`
          : (model ?? make);
      result.lens = firstString(exif.LensModel);
      result.iso = toNumber(exif.ISO);
      result.fnum = toNumber(exif.FNumber);
      result.exposure = formatExposure(exif.ExposureTime);
      result.focal = toNumber(exif.FocalLength);

      const lat = toNumber(exif.latitude);
      const lon = toNumber(exif.longitude);
      if (lat !== null && lon !== null && (lat !== 0 || lon !== 0)) {
        result.gpsLat = lat;
        result.gpsLon = lon;
      }

      if (!dimensionsOk) {
        result.width ??= toNumber(exif.ExifImageWidth);
        result.height ??= toNumber(exif.ExifImageHeight);
      }
    }
  } catch {
    // No EXIF block, or an unreadable one. Fall through to the other sources.
  }

  if (result.takenAt === null) {
    const fromName = dateFromFilename(fileName);
    if (fromName !== null) {
      result.takenAt = fromName;
      result.takenSrc = 'filename';
    } else {
      result.takenAt = mtimeMs;
      result.takenSrc = 'mtime';
    }
  }

  return result;
}

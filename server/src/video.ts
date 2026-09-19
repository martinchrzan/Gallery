/**
 * Everything that shells out to ffmpeg.
 *
 * Videos are the one media type libvips cannot touch, so their dimensions,
 * duration, capture date and poster frame all come from ffmpeg/ffprobe. Both
 * tools are *optional*: without them a video is still indexed, still ordered by
 * whatever date its filename or mtime gives, and still plays in the browser —
 * it just has no poster tile and no probed metadata. Nothing here ever throws
 * because a tool is missing.
 */

import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import { config } from './config.js';

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);

export type VideoTool = 'ffmpeg' | 'ffprobe';

/** npm packages that ship a prebuilt binary. Optional deps — often absent. */
const BUNDLED: Record<VideoTool, string> = {
  ffmpeg: '@ffmpeg-installer/ffmpeg',
  ffprobe: '@ffprobe-installer/ffprobe',
};

/**
 * A frame from a 4K video is a few megabytes of MJPEG; the default 1 MB pipe
 * buffer would truncate it into a decode error.
 */
const PIPE_LIMIT = 64 * 1024 * 1024;
/** A file ffmpeg cannot make sense of can otherwise spin for a very long time. */
const PROBE_TIMEOUT_MS = 30_000;
const POSTER_TIMEOUT_MS = 60_000;

/**
 * Where in the video the poster frame is taken from: a tenth of the way in,
 * capped, because the opening frames of a clip are so often black or a fade.
 */
const POSTER_SEEK_FRACTION = 0.1;
const POSTER_SEEK_CAP_MS = 3000;

function configuredPath(tool: VideoTool): string | null {
  try {
    return tool === 'ffmpeg' ? config().ffmpegPath : config().ffprobePath;
  } catch {
    // Config is unreadable in this process; the other two sources still apply.
    return null;
  }
}

function bundledPath(tool: VideoTool): string | null {
  try {
    const mod = require(BUNDLED[tool]) as { path?: string };
    return typeof mod.path === 'string' && mod.path !== '' ? mod.path : null;
  } catch {
    return null;
  }
}

async function runnable(command: string): Promise<boolean> {
  try {
    await execFileAsync(command, ['-version'], { timeout: PROBE_TIMEOUT_MS });
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolution order: an explicit setting, then the bundled binary, then the
 * PATH. Memoised as a promise, so the `-version` probe runs once per process
 * however many videos are waiting on it.
 *
 * Only a *found* tool is remembered for good. Every image worker runs this
 * lookup for itself, and the `-version` check can fail for reasons that have
 * nothing to do with whether ffmpeg is installed — a spawn under load, an
 * antivirus scan of the binary on its first launch. Remembering that failure
 * for the life of the process left one worker unable to make any poster at
 * all, so a random share of videos had none. A miss is retried after
 * {@link MISS_RETRY_MS} instead.
 */
const resolved = new Map<VideoTool, Promise<string | null>>();
const missedAt = new Map<VideoTool, number>();
const MISS_RETRY_MS = 30_000;

export function toolPath(tool: VideoTool): Promise<string | null> {
  const missed = missedAt.get(tool);
  if (missed !== undefined && Date.now() - missed > MISS_RETRY_MS) {
    resolved.delete(tool);
    missedAt.delete(tool);
  }

  let lookup = resolved.get(tool);
  if (!lookup) {
    lookup = (async () => {
      const configured = configuredPath(tool);
      // Falling through to a working binary beats losing video support over a
      // typo — but silently, the setting would look like it had taken effect.
      if (configured && !(await runnable(configured))) {
        console.warn(`[video] ${tool} at ${configured} could not be run; looking elsewhere`);
      } else if (configured) {
        return configured;
      }

      for (const candidate of [bundledPath(tool), tool]) {
        if (candidate && (await runnable(candidate))) return candidate;
      }
      missedAt.set(tool, Date.now());
      return null;
    })();
    resolved.set(tool, lookup);
  }
  return lookup;
}

/** Both tool paths, for the one-line capability report at startup. */
export async function videoToolStatus(): Promise<Record<VideoTool, string | null>> {
  const [ffmpeg, ffprobe] = await Promise.all([toolPath('ffmpeg'), toolPath('ffprobe')]);
  return { ffmpeg, ffprobe };
}

/* ----------------------------------------------------------------- probe -- */

export interface VideoProbe {
  /** Display dimensions: already swapped when the file carries a rotation. */
  width: number | null;
  height: number | null;
  durationMs: number | null;
  takenAt: number | null;
  camera: string | null;
  gpsLat: number | null;
  gpsLon: number | null;
}

interface FfprobeStream {
  codec_type?: string;
  width?: number;
  height?: number;
  duration?: string;
  disposition?: Record<string, number>;
  tags?: Record<string, string>;
  side_data_list?: { rotation?: number }[];
}

interface FfprobeOutput {
  streams?: FfprobeStream[];
  format?: { duration?: string; tags?: Record<string, string> };
}

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * QuickTime's epoch is 1904 and an unset creation time comes back as that, or
 * as 1970 from a remuxer that wrote a zero. Either is worse than the filename.
 */
const EARLIEST_PLAUSIBLE = Date.UTC(1990, 0, 1);

function parseTagDate(value: string | undefined): number | null {
  if (!value) return null;
  const ts = Date.parse(value.trim());
  if (!Number.isFinite(ts)) return null;
  if (ts < EARLIEST_PLAUSIBLE || ts > Date.now() + 86_400_000) return null;
  return ts;
}

/** `+50.0755+014.4378+215.000/` — the ISO 6709 string Apple and Android write. */
function parseIso6709(value: string | undefined): { lat: number; lon: number } | null {
  if (!value) return null;
  const m = /^([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)/.exec(value.trim());
  if (!m) return null;
  const lat = Number(m[1]);
  const lon = Number(m[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat === 0 && lon === 0) return null;
  return { lat, lon };
}

/** Tag keys vary in case between containers, so match on a lowercased copy. */
function lowerKeys(...sources: (Record<string, string> | undefined)[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const source of sources) {
    if (!source) continue;
    for (const [key, value] of Object.entries(source)) out[key.toLowerCase()] = value;
  }
  return out;
}

/**
 * Reads one video's technical metadata.
 *
 * Returns `null` for "ffprobe is not installed" *and* for "ffprobe could not
 * read this file" — {@link toolPath} tells the two apart, and the caller needs
 * to, since only the second says anything about the file.
 */
export async function probeVideo(absPath: string): Promise<VideoProbe | null> {
  const ffprobe = await toolPath('ffprobe');
  if (!ffprobe) return null;

  let parsed: FfprobeOutput;
  try {
    const { stdout } = await execFileAsync(
      ffprobe,
      [
        '-v',
        'error',
        '-print_format',
        'json',
        '-show_format',
        '-show_streams',
        '-i',
        absPath,
      ],
      { timeout: PROBE_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
    );
    parsed = JSON.parse(stdout) as FfprobeOutput;
  } catch {
    return null;
  }

  // `attached_pic` is cover art carried as a one-frame video stream; the real
  // picture is the other one.
  const stream = (parsed.streams ?? []).find(
    (s) => s.codec_type === 'video' && !s.disposition?.attached_pic,
  );
  if (!stream) return null;

  const tags = lowerKeys(parsed.format?.tags, stream.tags);

  // ffmpeg auto-rotates on decode, so the poster we generate is upright — the
  // dimensions we report have to describe that same upright frame.
  const rotationTag = toNumber(tags.rotate);
  const rotationSide = stream.side_data_list?.find((s) => s.rotation !== undefined)?.rotation;
  const rotation = Math.abs((rotationTag ?? rotationSide ?? 0) % 180);
  const quarterTurned = rotation === 90;

  const width = toNumber(stream.width);
  const height = toNumber(stream.height);

  const seconds = toNumber(parsed.format?.duration) ?? toNumber(stream.duration);
  const location = parseIso6709(tags['com.apple.quicktime.location.iso6709'] ?? tags.location);
  const make = tags['com.apple.quicktime.make'];
  const model = tags['com.apple.quicktime.model'];

  return {
    width: quarterTurned ? height : width,
    height: quarterTurned ? width : height,
    durationMs: seconds !== null && seconds > 0 ? Math.round(seconds * 1000) : null,
    // Apple's own tag carries a UTC offset; the generic one is usually UTC.
    takenAt:
      parseTagDate(tags['com.apple.quicktime.creationdate']) ??
      parseTagDate(tags.creation_time) ??
      parseTagDate(tags.date),
    camera: model ? (make && !model.startsWith(make) ? `${make} ${model}` : model) : (make ?? null),
    gpsLat: location?.lat ?? null,
    gpsLon: location?.lon ?? null,
  };
}

/* ---------------------------------------------------------------- poster -- */

/**
 * Grabs a single frame as JPEG bytes, for the thumbnailer to resize the same
 * way it would a photo. Throws when ffmpeg is missing or the file yields no
 * frame — the caller turns that into the same placeholder tile an unreadable
 * photo gets.
 */
export async function extractPoster(absPath: string, durationMs: number | null): Promise<Buffer> {
  const ffmpeg = await toolPath('ffmpeg');
  if (!ffmpeg) throw new Error('ffmpeg is not available, so videos have no thumbnails');

  const seekMs =
    durationMs && durationMs > 0
      ? Math.min(POSTER_SEEK_CAP_MS, Math.floor(durationMs * POSTER_SEEK_FRACTION))
      : POSTER_SEEK_CAP_MS;

  // The seek first, then the very first frame, which always exists — a seek can
  // land past the end of a clip shorter than we guessed, and some ffmpeg builds
  // report that as an error rather than as empty output. No pause-and-retry for
  // a briefly locked file: this runs in a pool worker, and the tile already
  // asks again a few seconds later.
  const attempts = seekMs > 0 ? [seekMs, 0] : [0];
  let lastError: Error | null = null;

  for (const at of attempts) {
    try {
      const frame = await grabFrame(ffmpeg, absPath, at);
      if (frame.length > 0) return frame;
    } catch (err) {
      lastError = err as Error;
    }
  }

  throw new Error(
    lastError
      ? `ffmpeg could not read a frame: ${lastLine(lastError.message)}`
      : 'ffmpeg produced no frame for this video',
  );
}

/** execFile's message opens with the whole command line; the reason is last. */
function lastLine(message: string): string {
  const lines = message
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines[lines.length - 1] ?? message;
}

async function grabFrame(ffmpeg: string, absPath: string, seekMs: number): Promise<Buffer> {
  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    // Before `-i`: seeks by keyframe index instead of decoding up to the mark,
    // which is the difference between milliseconds and minutes on a long file.
    ...(seekMs > 0 ? ['-ss', (seekMs / 1000).toFixed(3)] : []),
    '-i',
    absPath,
    '-frames:v',
    '1',
    '-an',
    '-sn',
    '-dn',
    '-f',
    'image2pipe',
    '-vcodec',
    'mjpeg',
    '-q:v',
    '2',
    'pipe:1',
  ];

  const { stdout } = await execFileAsync(ffmpeg, args, {
    timeout: POSTER_TIMEOUT_MS,
    maxBuffer: PIPE_LIMIT,
    encoding: 'buffer',
  });
  return stdout;
}

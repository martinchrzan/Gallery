import fs from 'node:fs';
import path from 'node:path';
import pino from 'pino';
import type { Config } from './config.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** `gallery-2026-08-14.log` — one file per day, so name order is date order. */
const LOG_FILE = /^gallery-(\d{4})-(\d{2})-(\d{2})\.log$/;

/** Local date, not UTC: the day a line belongs to is the operator's day. */
function dayStamp(at: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

type Destination = ReturnType<typeof pino.destination>;

/**
 * A pino destination that appends to `gallery-<date>.log`, moves to a new file
 * on the first line written after local midnight, and deletes whatever has aged
 * out of the retention window while it is there.
 *
 * Rolling on write rather than on a timer: a server nobody is using writes
 * nothing, so there is nothing to roll, and a timer would only wake the process
 * up to discover that.
 */
class DailyLogFile {
  private day = '';
  private dest: Destination | null = null;
  /** Set once the directory turns out to be unwritable; the console takes over. */
  private broken = false;

  constructor(
    private readonly dir: string,
    /** Days of history to keep, or null to keep everything. */
    private readonly retentionDays: number | null,
  ) {
    fs.mkdirSync(dir, { recursive: true });
    this.roll(dayStamp(new Date()));
  }

  write(line: string): void {
    const today = dayStamp(new Date());
    if (today !== this.day) this.roll(today);
    this.dest?.write(line);
  }

  /** Shutdown calls `process.exit`, which does not wait for a buffered write. */
  flushSync(): void {
    try {
      this.dest?.flushSync();
    } catch {
      // Nothing useful is left to do with a log line at this point.
    }
  }

  private roll(day: string): void {
    if (this.broken) return;

    const file = path.join(this.dir, `gallery-${day}.log`);
    const previous = this.dest;
    try {
      const dest = pino.destination({ dest: file, append: true, mkdir: true, sync: false });
      // Without a listener, a log directory that fills up or loses its
      // permissions would take the server down with it — the wrong trade for a
      // log line, so the file is dropped and the console carries on. Yesterday's
      // descriptor failing on its way out says nothing about today's, hence the
      // identity check.
      dest.on('error', (err: Error) => {
        if (this.dest === dest) this.fail(`log file unavailable: ${err.message}`);
      });
      this.dest = dest;
      this.day = day;
    } catch (err) {
      this.fail(`could not open ${file}: ${(err as Error).message}`);
      return;
    }

    // A new destination rather than `reopen`, which hands the old file's
    // still-buffered lines to the new one: yesterday's tail belongs in
    // yesterday's file. `end` flushes it there and closes the descriptor.
    try {
      previous?.end();
    } catch {
      // Already closed itself after an error it reported at the time.
    }

    this.sweep();
  }

  private fail(reason: string): void {
    this.broken = true;
    this.dest = null;
    process.stderr.write(`${reason} — logging to the console only\n`);
  }

  private sweep(): void {
    if (this.retentionDays === null) return;

    const cutoff = Date.now() - this.retentionDays * DAY_MS;
    let names: string[];
    try {
      names = fs.readdirSync(this.dir);
    } catch {
      return;
    }

    let removed = 0;
    for (const name of names) {
      const match = LOG_FILE.exec(name);
      // Anything this class did not write — a service wrapper's stdout capture,
      // the installer's preflight output — is left alone.
      if (!match) continue;

      // Judged on the end of the day the file covers, so "keep 30 days" keeps
      // thirty whole days rather than expiring the oldest one mid-morning.
      const covers = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + 1);
      if (covers.getTime() > cutoff) continue;

      try {
        fs.unlinkSync(path.join(this.dir, name));
        removed += 1;
      } catch {
        // Locked by a tail, or already gone; the next roll tries again.
      }
    }

    // Deferred: this runs inside a pino write, and logging from there would
    // re-enter this stream mid-line.
    if (removed > 0) {
      const days = this.retentionDays;
      setImmediate(() => log?.info(`removed ${removed} log file(s) older than ${days} days`));
    }
  }
}

let file: DailyLogFile | null = null;
let log: pino.Logger | null = null;

/**
 * Pretty, human-readable output in development; raw JSON lines in production,
 * where something else — a service manager, `tee`, an eye — is reading them.
 */
async function consoleStream(): Promise<pino.DestinationStream> {
  if (process.env.NODE_ENV === 'production') return process.stdout;
  try {
    const { default: pretty } = await import('pino-pretty');
    return pretty({ translateTime: 'HH:MM:ss', ignore: 'pid,hostname' });
  } catch {
    // pino-pretty is a devDependency: a production install without it still logs.
    return process.stdout;
  }
}

/**
 * The server's logger: the console, a daily file under `<dataDir>/logs`, or
 * both, according to the configuration.
 */
export async function createLogger(cfg: Config): Promise<pino.Logger> {
  const level = (process.env.LOG_LEVEL ?? 'info') as pino.Level;
  const streams: pino.StreamEntry[] = [];

  if (cfg.logConsole) streams.push({ level, stream: await consoleStream() });
  if (cfg.logToFile) {
    file = new DailyLogFile(cfg.logDir, cfg.logCleanup ? cfg.logRetentionDays : null);
    streams.push({ level, stream: file });
  }
  // Turning both off would hide the first-run access code and every startup
  // failure with it, so the console stays as the floor.
  if (streams.length === 0) streams.push({ level, stream: process.stdout });

  log = pino({ level }, pino.multistream(streams));
  return log;
}

/** Flushes buffered lines to disk. Call before `process.exit`. */
export function flushLogs(): void {
  file?.flushSync();
}

/**
 * Chunked, resumable uploads into the photo library.
 *
 * The gallery is usually reached through a tunnel or reverse proxy, and those
 * cap a single request body — Cloudflare's free plan at 100 MB, which a phone
 * video passes without trying. So a file never arrives as one request: the
 * client opens a session, POSTs the bytes as a series of small chunks at
 * explicit offsets, and then asks for the session to be finished. Nothing in
 * the middle sees a body bigger than one chunk, and a dropped mobile connection
 * costs one chunk rather than the whole file.
 *
 * The partial file is staged *in the destination folder* as a dotfile, not in
 * `dataDir`. Staging elsewhere would mean copying the finished file across
 * volumes — `dataDir` is meant to live on a local SSD while the library sits on
 * a big spinning disk — and copying a 4 GB video after having just received it
 * doubles the wait for no benefit. In the destination folder the last step is a
 * rename within one filesystem, which is atomic and instant. The scanner, the
 * watcher and the file browser all skip dotfiles, so a partial upload is
 * invisible to the rest of the app while it is in flight.
 *
 * Sessions live in memory only. A server restart abandons whatever was in
 * flight — the client would have to start those files again anyway — and the
 * journal in `dataDir/uploads` exists so the abandoned `.part` files can be
 * removed on the next boot without walking the whole library to find them.
 */

import { randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { config } from './config.js';
import {
  isIndexableMedia,
  isInside,
  isUnsupportedImage,
  realpathWithin,
  resolveWithinRoot,
  safeSegment,
} from './paths.js';

/**
 * Chunk size handed to the client. Small enough to clear a proxy's body limit
 * with room to spare, and small enough that one of them completes well inside a
 * proxy's request timeout on a slow mobile uplink. The client is free to send
 * less — it shrinks its chunks when the network is slow — and up to
 * {@link MAX_CHUNK_BYTES} when it is fast.
 */
export const CHUNK_BYTES = 5 * 1024 * 1024;

/**
 * Hard ceiling on one chunk request, enforced as the bytes stream in.
 *
 * It cannot be delegated to Fastify: a route's `bodyLimit` is only applied by
 * the parsers that buffer the body into a string or a buffer, and a chunk goes
 * to disk as a raw stream instead. The check in {@link writeChunk} is the only
 * thing holding this line.
 */
export const MAX_CHUNK_BYTES = 16 * 1024 * 1024;

/** Ceiling on a single file. Well past any camera; a sanity bound, not a policy. */
const MAX_FILE_BYTES = 32 * 1024 * 1024 * 1024;

/** Concurrent upload sessions across all admins. Each holds one open `.part`. */
const MAX_SESSIONS = 64;

/** A session nobody has sent a chunk to for this long is abandoned and swept. */
const SESSION_IDLE_MS = 60 * 60 * 1000;

/** How long a finished upload's result stays answerable. See {@link finished}. */
const FINISHED_TTL_MS = 30 * 60 * 1000;

/** Finished results kept at once, so a long queue cannot grow the map forever. */
const MAX_FINISHED = 256;

const SWEEP_INTERVAL_MS = 10 * 60 * 1000;

export class UploadError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400,
  ) {
    super(message);
  }
}

/** Thrown when a chunk arrives at the wrong offset; carries where to resume. */
export class OffsetMismatch extends UploadError {
  constructor(readonly expectedOffset: number) {
    super('Chunk offset does not match what the server has', 409);
  }
}

interface Session {
  id: string;
  /** Destination folder, relative to the photo root, POSIX separators. */
  dir: string;
  /** Sanitised file name, without any collision suffix — that is picked at finish. */
  name: string;
  /** Total bytes the client promised. */
  size: number;
  /** Bytes safely on disk. The next chunk must start exactly here. */
  received: number;
  /** Symlink-resolved absolute destination folder. */
  dirAbs: string;
  /** The `.part` file being filled, inside {@link dirAbs}. */
  partAbs: string;
  /** True while a chunk is being written; a second one is refused, not interleaved. */
  busy: boolean;
  touchedAt: number;
}

const sessions = new Map<string, Session>();

/** Public view of a session, for the API. */
export interface UploadHandle {
  uploadId: string;
  name: string;
  size: number;
  received: number;
}

function toHandle(session: Session): UploadHandle {
  return {
    uploadId: session.id,
    name: session.name,
    size: session.size,
    received: session.received,
  };
}

/* ------------------------------------------------------------------ names -- */

/**
 * The name an upload will be stored under: a safe path segment, and one this
 * gallery has a use for. Anything it cannot decode or play has no business
 * being written into a photo library through a web form.
 */
export function safeFileName(raw: string): string {
  const name = safeSegment(raw);
  if (name === null) throw new UploadError('That file name cannot be used');

  if (!isIndexableMedia(name) && !isUnsupportedImage(name)) {
    throw new UploadError('Only photos and videos can be uploaded');
  }
  return name;
}

/**
 * The first free name in `dirAbs`, adding ` (1)`, ` (2)`… before the extension —
 * the same convention every desktop file manager uses. An upload never
 * overwrites an existing photo.
 */
async function freeName(dirAbs: string, name: string): Promise<string> {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);

  for (let n = 0; n < 1000; n++) {
    const candidate = n === 0 ? name : `${stem} (${n})${ext}`;
    try {
      await fsp.access(path.join(dirAbs, candidate));
    } catch {
      return candidate;
    }
  }
  throw new UploadError('Too many files already share that name', 409);
}

/* ---------------------------------------------------------------- journal -- */

function journalDir(): string {
  return path.join(config().dataDir, 'uploads');
}

function journalPath(id: string): string {
  return path.join(journalDir(), `${id}.json`);
}

async function writeJournal(session: Session): Promise<void> {
  await fsp.writeFile(
    journalPath(session.id),
    JSON.stringify({ part: session.partAbs, name: session.name, dir: session.dir }),
    'utf8',
  );
}

async function dropJournal(id: string): Promise<void> {
  await fsp.rm(journalPath(id), { force: true }).catch(() => {});
}

/* --------------------------------------------------------------- sessions -- */

/**
 * Opens a session and reserves its `.part` file, so a folder that cannot be
 * written to fails here — before the client spends ten minutes sending a video.
 */
export async function createUpload(input: {
  dir?: string | undefined;
  name: string;
  size: number;
}): Promise<UploadHandle> {
  if (!Number.isInteger(input.size) || input.size < 0) {
    throw new UploadError('Invalid file size');
  }
  if (input.size > MAX_FILE_BYTES) {
    throw new UploadError('That file is too large to upload', 413);
  }

  const name = safeFileName(input.name);

  const { rel, abs } = resolveWithinRoot(input.dir);
  const dirAbs = await realpathWithin(abs);
  const stat = await fsp.stat(dirAbs);
  if (!stat.isDirectory()) throw new UploadError('The destination is not a folder');

  sweepUploads();
  if (sessions.size >= MAX_SESSIONS) {
    throw new UploadError('Too many uploads are already in progress', 429);
  }

  const id = randomBytes(12).toString('hex');
  const session: Session = {
    id,
    dir: rel,
    name,
    size: input.size,
    received: 0,
    dirAbs,
    partAbs: path.join(dirAbs, `.upload-${id}.part`),
    busy: false,
    touchedAt: Date.now(),
  };

  try {
    // Exclusive create: also the write-permission check for this folder.
    await fsp.writeFile(session.partAbs, '', { flag: 'wx' });
  } catch (err) {
    throw new UploadError(
      `Cannot write to this folder (${(err as NodeJS.ErrnoException).code ?? 'error'})`,
      403,
    );
  }

  await fsp.mkdir(journalDir(), { recursive: true });
  await writeJournal(session);

  sessions.set(id, session);
  return toHandle(session);
}

function sessionOrThrow(id: string): Session {
  const session = sessions.get(id);
  if (!session) {
    // Also what an expired or already-finished session looks like. The client
    // starts the file again rather than guessing which of those it was.
    throw new UploadError('This upload session is no longer open', 404);
  }
  return session;
}

/**
 * Appends one chunk at `offset`.
 *
 * The offset has to match what is already on disk exactly. That is what makes
 * the transfer resumable without trusting the client's bookkeeping: a chunk
 * whose response was lost is re-sent, the offsets disagree, and the client is
 * told where to carry on from instead of the bytes being written twice.
 */
export async function writeChunk(
  id: string,
  offset: number,
  source: Readable,
): Promise<UploadHandle> {
  const session = sessionOrThrow(id);

  if (session.busy) {
    throw new UploadError('Another chunk of this file is still being written', 409);
  }
  if (!Number.isInteger(offset) || offset < 0) throw new UploadError('Invalid offset');
  if (offset !== session.received) {
    throw new OffsetMismatch(session.received);
  }

  session.busy = true;

  try {
    const out = createWriteStream(session.partAbs, { flags: 'r+', start: offset });

    // Watches the body on its way past, to cut a request that is going to be
    // refused before the whole of it has been read. It is a guard and nothing
    // more — what the session records is taken from the file below, not from
    // what was read towards it.
    let seen = 0;
    source.on('data', (chunk: Buffer) => {
      seen += chunk.length;
      // A body longer than the file it belongs to is a broken or hostile
      // client; stop reading rather than growing the file past its promise.
      if (offset + seen > session.size) {
        source.destroy(new UploadError('Upload is longer than the declared size', 413));
      }
      if (seen > MAX_CHUNK_BYTES) {
        source.destroy(new UploadError('Chunk is too large', 413));
      }
    });

    await pipeline(source, out);
    // The file's own account of what it took, which is what the next chunk's
    // offset has to agree with.
    session.received = offset + out.bytesWritten;
  } catch (err) {
    // Roll back to the last known-good length. A half-written chunk left in
    // place would corrupt the file, and the client is about to re-send it from
    // exactly this offset.
    await fsp.truncate(session.partAbs, session.received).catch(() => {});
    throw err;
  } finally {
    session.busy = false;
    session.touchedAt = Date.now();
  }

  return toHandle(session);
}

/**
 * Serialises the pick-a-name-then-take-it step in {@link finishUpload}. The
 * chain is kept settled on its own branch, so one failed finish does not
 * poison every later one.
 */
let renameLock: Promise<unknown> = Promise.resolve();

function withRenameLock<T>(work: () => Promise<T>): Promise<T> {
  const run = renameLock.then(work, work);
  renameLock = run.catch(() => undefined);
  return run;
}

export interface FinishedUpload {
  /** Path relative to the photo root, POSIX separators. */
  rel: string;
  abs: string;
  /** Final name on disk, which may carry a ` (1)` suffix. */
  name: string;
}

/**
 * Uploads already moved into place, kept for a while after their session ends.
 *
 * Finishing is the one step the client retries on its own: every byte is
 * already here, and a reply lost on the way back must not be reported as a
 * failed upload. Without this the retry would find no session and be told 404 —
 * "start again" — for a file sitting complete in the library. So a finished id
 * keeps answering with what it did, and the client's second ask gets the same
 * result as its first.
 */
const finished = new Map<string, { at: number; result: FinishedUpload }>();

function recordFinished(id: string, result: FinishedUpload): void {
  finished.set(id, { at: Date.now(), result });

  // Insertion order is time order, so the oldest are at the front.
  for (const oldest of finished.keys()) {
    if (finished.size <= MAX_FINISHED) break;
    finished.delete(oldest);
  }
}

/**
 * Moves the finished file into place and closes the session.
 *
 * Serialised across sessions: picking a free name and taking it have to be one
 * step, or two phones uploading `IMG_0001.jpg` at the same moment would both
 * see the name as free and one would overwrite the other.
 *
 * Idempotent, by way of {@link finished} — asking twice is not an error.
 */
export async function finishUpload(id: string): Promise<FinishedUpload> {
  const done = finished.get(id);
  if (done) return done.result;

  const session = sessionOrThrow(id);

  if (session.busy) throw new UploadError('A chunk is still being written', 409);
  if (session.received !== session.size) {
    throw new UploadError(
      `Upload is incomplete: ${session.received} of ${session.size} bytes received`,
      409,
    );
  }

  return withRenameLock(async () => {
    // Re-checked inside the lock: two requests to finish one session both get
    // this far, and the second has to be answered with the first one's result
    // rather than renaming a `.part` file that is no longer there.
    const already = finished.get(id);
    if (already) return already.result;

    const name = await freeName(session.dirAbs, session.name);
    const abs = path.join(session.dirAbs, name);

    await fsp.rename(session.partAbs, abs);
    sessions.delete(id);
    await dropJournal(id);

    const result: FinishedUpload = {
      rel: session.dir ? `${session.dir}/${name}` : name,
      abs,
      name,
    };
    recordFinished(id, result);
    return result;
  });
}

/** Cancels a session and removes its partial file. Safe to call twice. */
export async function abortUpload(id: string): Promise<void> {
  const session = sessions.get(id);
  if (!session) return;

  sessions.delete(id);
  await fsp.rm(session.partAbs, { force: true }).catch(() => {});
  await dropJournal(id);
}

/**
 * Drops sessions nobody has touched for an hour, with their partial files, and
 * forgets the results of uploads finished long enough ago that no client is
 * still retrying them.
 */
function sweepUploads(): void {
  const idleCutoff = Date.now() - SESSION_IDLE_MS;
  for (const session of sessions.values()) {
    if (!session.busy && session.touchedAt < idleCutoff) void abortUpload(session.id);
  }

  const finishedCutoff = Date.now() - FINISHED_TTL_MS;
  for (const [id, record] of finished) {
    if (record.at < finishedCutoff) finished.delete(id);
  }
}

/**
 * Clears partial files left behind by a previous run, and starts the sweeper.
 *
 * The journal is the only record of where those files are: without it, finding
 * them would mean walking the whole library on every boot.
 */
export async function initUploads(log: (msg: string) => void): Promise<void> {
  const dir = journalDir();
  await fsp.mkdir(dir, { recursive: true });

  let entries: string[] = [];
  try {
    entries = await fsp.readdir(dir);
  } catch {
    return;
  }

  let removed = 0;
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    try {
      const record = JSON.parse(await fsp.readFile(path.join(dir, entry), 'utf8')) as {
        part?: string;
      };
      // Re-check containment: this path is ours, but it has been round-tripped
      // through a file on disk, and a stale one must not delete anything odd.
      if (
        typeof record.part === 'string' &&
        isInside(config().photosRoot, record.part) &&
        path.basename(record.part).startsWith('.upload-')
      ) {
        await fsp.rm(record.part, { force: true });
        removed++;
      }
    } catch {
      // Unreadable record; the journal entry goes either way.
    }
    await fsp.rm(path.join(dir, entry), { force: true });
  }

  if (removed > 0) log(`discarded ${removed} unfinished upload(s) from a previous run`);

  const timer = setInterval(sweepUploads, SWEEP_INTERVAL_MS);
  timer.unref();
}

/** Abandons every in-flight upload, for shutdown. */
export async function stopUploads(): Promise<void> {
  await Promise.all([...sessions.keys()].map((id) => abortUpload(id)));
}

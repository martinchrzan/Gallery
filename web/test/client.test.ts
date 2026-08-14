// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  downloadZip,
  fetchManifest,
  isVideoAt,
  photoDownloadUrl,
  RECORD_BYTES,
  RequestError,
  setUnauthorizedHandler,
  thumbUrl,
  uploadChunk,
} from '../src/api/client';

interface Record {
  id: number;
  time: number;
  width: number;
  height: number;
  duration: number;
  video: boolean;
}

/** Packs records exactly as `buildManifest` on the server does. */
function packManifest(records: Record[]): ArrayBuffer {
  const buffer = new ArrayBuffer(records.length * RECORD_BYTES);
  const view = new DataView(buffer);

  records.forEach((r, i) => {
    const offset = i * RECORD_BYTES;
    view.setUint32(offset, r.id, true);
    view.setUint32(offset + 4, r.time, true);
    view.setUint16(offset + 8, r.width, true);
    view.setUint16(offset + 10, r.height, true);
    view.setUint16(offset + 12, r.duration, true);
    view.setUint16(offset + 14, r.video ? 1 : 0, true);
  });

  return buffer;
}

function mockFetch(response: Partial<Response> & { arrayBuffer?: () => Promise<ArrayBuffer> }) {
  const stub = vi.fn().mockResolvedValue({ ok: true, status: 200, ...response });
  vi.stubGlobal('fetch', stub);
  return stub;
}

afterEach(() => {
  vi.unstubAllGlobals();
  setUnauthorizedHandler(null);
});

describe('fetchManifest', () => {
  it('decodes packed records into parallel typed arrays', async () => {
    const records: Record[] = [
      { id: 7, time: 1_700_000_000, width: 4000, height: 3000, duration: 0, video: false },
      { id: 9, time: 1_600_000_000, width: 1920, height: 1080, duration: 125, video: true },
    ];
    mockFetch({ arrayBuffer: async () => packManifest(records) });

    const manifest = await fetchManifest();

    expect(manifest.count).toBe(2);
    expect([...manifest.ids]).toEqual([7, 9]);
    expect([...manifest.times]).toEqual([1_700_000_000, 1_600_000_000]);
    expect([...manifest.widths]).toEqual([4000, 1920]);
    expect([...manifest.heights]).toEqual([3000, 1080]);
    expect([...manifest.durations]).toEqual([0, 125]);
    expect([...manifest.videos]).toEqual([0, 1]);
  });

  it('reads the video flag from bit 0, ignoring the reserved bits', () => {
    const buffer = new ArrayBuffer(RECORD_BYTES);
    const view = new DataView(buffer);
    view.setUint32(0, 1, true);
    // Bit 0 clear, other bits set: still a photo.
    view.setUint16(14, 0b1111_1110, true);

    mockFetch({ arrayBuffer: async () => buffer });
    return fetchManifest().then((manifest) => {
      expect(manifest.videos[0]).toBe(0);
      expect(isVideoAt(manifest, 0)).toBe(false);
    });
  });

  it('survives a 32-bit timestamp near the 2106 ceiling', async () => {
    const time = 4_000_000_000;
    mockFetch({
      arrayBuffer: async () =>
        packManifest([{ id: 1, time, width: 100, height: 100, duration: 0, video: false }]),
    });

    expect((await fetchManifest()).times[0]).toBe(time);
  });

  it('returns an empty manifest for an empty body', async () => {
    mockFetch({ arrayBuffer: async () => new ArrayBuffer(0) });
    expect((await fetchManifest()).count).toBe(0);
  });

  it('ignores a trailing partial record rather than reading past the end', async () => {
    const whole = packManifest([
      { id: 1, time: 100, width: 10, height: 10, duration: 0, video: false },
    ]);
    const truncated = new Uint8Array(RECORD_BYTES + 5);
    truncated.set(new Uint8Array(whole));

    mockFetch({ arrayBuffer: async () => truncated.buffer });
    expect((await fetchManifest()).count).toBe(1);
  });

  it('reports a session that expired mid-browse', async () => {
    const onUnauthorized = vi.fn();
    setUnauthorizedHandler(onUnauthorized);
    mockFetch({ ok: false, status: 401 });

    await expect(fetchManifest()).rejects.toThrow(/401/);
    expect(onUnauthorized).toHaveBeenCalledOnce();
  });

  it('throws on any other failure', async () => {
    mockFetch({ ok: false, status: 500 });
    await expect(fetchManifest()).rejects.toThrow(/500/);
  });
});

describe('uploadChunk', () => {
  it('returns how many bytes the server now holds', async () => {
    mockFetch({ json: async () => ({ received: 8192 }) });
    expect(await uploadChunk('abc', 4096, new Blob(['x']))).toBe(8192);
  });

  it('treats a 409 as progress, not failure', async () => {
    // The chunk landed but its reply was lost — routine on a phone changing
    // cells. The body says where the server actually is.
    mockFetch({ ok: false, status: 409, json: async () => ({ expectedOffset: 4096 }) });
    expect(await uploadChunk('abc', 0, new Blob(['x']))).toBe(4096);
  });

  it('still fails on a 409 that carries no offset to resume from', async () => {
    mockFetch({ ok: false, status: 409, json: async () => ({ error: 'gone' }) });
    await expect(uploadChunk('abc', 0, new Blob(['x']))).rejects.toBeInstanceOf(RequestError);
  });

  it('surfaces the server`s message and status so the retry loop can judge it', async () => {
    mockFetch({ ok: false, status: 413, json: async () => ({ error: 'Chunk is too large' }) });

    await expect(uploadChunk('abc', 0, new Blob(['x']))).rejects.toMatchObject({
      message: 'Chunk is too large',
      status: 413,
    });
  });

  it('falls back to the status line when the error body is not JSON', async () => {
    mockFetch({
      ok: false,
      status: 502,
      statusText: 'Bad Gateway',
      json: async () => {
        throw new Error('not json');
      },
    });

    await expect(uploadChunk('abc', 0, new Blob(['x']))).rejects.toMatchObject({
      message: '502 Bad Gateway',
      status: 502,
    });
  });
});

describe('urls', () => {
  it('asks for the thumbnail size it needs', () => {
    expect(thumbUrl(42, 320)).toBe('/api/media/42/thumb?h=320');
    expect(thumbUrl(42, 1600)).toBe('/api/media/42/thumb?h=1600');
  });

  it('marks a download so the server sends Content-Disposition', () => {
    expect(photoDownloadUrl(42)).toContain('download=1');
  });
});

describe('downloadZip', () => {
  it('submits a real form so the browser streams the archive to disk', () => {
    // Fetching it would buffer the whole ZIP in memory, which falls over as
    // soon as a few gigabytes are selected.
    const submit = vi.fn();
    vi.spyOn(HTMLFormElement.prototype, 'submit').mockImplementation(submit);

    downloadZip(['Travel/a.jpg', 'Travel/Norway'], 'trip.zip');

    expect(submit).toHaveBeenCalledOnce();
    const form = submit.mock.instances[0] as HTMLFormElement;
    expect(form.method).toBe('post');
    expect(form.action).toContain('/api/files/zip');
    expect(JSON.parse((form.elements.namedItem('payload') as HTMLInputElement).value)).toEqual({
      paths: ['Travel/a.jpg', 'Travel/Norway'],
      name: 'trip.zip',
    });
  });

  it('leaves no form behind in the document', () => {
    vi.spyOn(HTMLFormElement.prototype, 'submit').mockImplementation(() => {});
    downloadZip(['a.jpg']);
    expect(document.querySelectorAll('form')).toHaveLength(0);
  });
});

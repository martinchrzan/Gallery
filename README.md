# Gallery

A self-hosted photo gallery for a folder of photos on your own machine. No cloud, no external
services, no database server — just Node, SQLite and a folder of pictures.

- **Gallery** — every photo from the folders you choose, in one chronological feed, sorted by the
  date the photo was taken. Day separators, a year scrubber down the side, and a full-screen viewer
  with zoom.
- **Files** — the raw folder tree, browsable to any depth, with single-file and ZIP downloads.

Built to stay fluid at tens of thousands of photos.

## Getting started

```bash
npm install
cp config.example.json config.json   # then set "photosRoot"
npm run build
npm start
```

Open <http://localhost:4000>. The first scan starts automatically; photos appear as they are
indexed, so you do not have to wait for it to finish.

### Configuration

`config.json` at the repo root:

| Key | Meaning | Default |
| --- | --- | --- |
| `photosRoot` | Folder to serve. Read-only — the gallery never writes here. | *required* |
| `port` | HTTP port. | `4000` |
| `host` | Bind address. `0.0.0.0` exposes it to your LAN. | `0.0.0.0` |
| `dataDir` | Where the index and thumbnail cache live. | `./data` |

Any of these can be overridden by the `PHOTOS_ROOT`, `PORT`, `HOST` and `DATA_DIR` environment
variables, which is handy when running as a service. Everything else — which folders feed the
gallery, how often it re-indexes, row height — is configured in the app's Settings page and stored
server-side, so it follows you between browsers.

### Development

```bash
npm run dev        # API on :4000, Vite dev server on :5173 with hot reload
npm run typecheck
```

## Keyboard shortcuts

In the full-screen viewer:

| Key | Action |
| --- | --- |
| `←` `→` | Previous / next photo |
| `Esc` | Close |
| `I` | Toggle the details panel |
| `D` | Download the original |
| `F` / `Enter` | Toggle between fit and zoomed |
| `+` `−` | Zoom in / out |
| `0` | Reset to fit |

Click anywhere outside the photo to close it. Drag the zoom slider, or use the **Fit** / **1:1**
buttons. A photo smaller than the window opens at its own size rather than being enlarged, so for
those two the *Fit* and *1:1* modes are the same thing and both light up.

Dates in day separators follow your system locale — no translation files needed.

Double-click or pinch to zoom, drag to pan.

## How it works

**The index.** A background scan walks `photosRoot` and records every image in a SQLite database
(`data/gallery.db`). A pool of worker threads then reads each photo's EXIF for the capture date,
dimensions and camera settings, so the HTTP server stays responsive while a large library is being
indexed. Photos with no EXIF date fall back to a date parsed from the filename (`IMG_20190704_...`),
then to the file's modification time.

**Staying in sync.** Settings offers three modes: watch the folder live via filesystem events,
re-scan on a timer (1–24 hours), or scan only on startup and on demand. A *Rescan now* button is
always available.

**The feed.** The client fetches the whole feed as a packed binary manifest — 12 bytes per photo
(id, timestamp, width, height) instead of ~45 for JSON. 50 000 photos is 600 KB and decodes straight
into typed arrays with no parse step. That lets the client compute the exact total scroll height up
front, so the scrollbar is honest and jumping to 2014 is instant. Layout is justified rows grouped
by day, recomputed in ~8 ms for a 50 000-photo library, and only the rows near the viewport are
mounted.

**Thumbnails.** Generated with libvips the first time a photo is seen and cached on disk as WebP
(`data/thumbs/`), keyed by a hash of the file's path, size and modification time. Because the key
covers the file's contents, thumbnails are served `immutable` and an edited photo automatically gets
a fresh URL. Three sizes exist: 320 px for the grid, 640 px for HiDPI screens, and 1600 px for the
viewer. The full-resolution original is only fetched when you actually zoom in past the fit.

No Redis or other cache server is needed — SQLite holds the metadata and the filesystem holds the
thumbnail bytes.

**Path safety.** Every path the client can supply is rejected if it is absolute or contains a `..`
segment, resolved against the root, and then re-checked *after* resolving symlinks, so nothing
outside `photosRoot` can be read.

## Supported formats

JPEG, PNG, WebP, AVIF, GIF and TIFF appear in the gallery. HEIC/HEIF and camera RAW files are listed
in **Files** and can be downloaded, but are not thumbnailed or shown in the feed — the stock libvips
build cannot decode them.

## Layout

```
server/   Fastify API, SQLite index, scanner, thumbnailer
web/      React + Vite front end
data/     Generated: the SQLite index and the thumbnail cache
```

In production the server also serves the built front end, so the whole thing is one process.

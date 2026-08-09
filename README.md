# Photo Gallery

A self-hosted photo gallery for a folder of photos on your own machine. No cloud, no external
services, no database server — just Node, SQLite and a folder of pictures.

- **Gallery** — every photo from the folders you choose, in one chronological feed, sorted by the
  date the photo was taken. Day separators, a year scrubber down the side, and a full-screen viewer
  with zoom.
- **Files** — the raw folder tree, browsable to any depth, with single-file and ZIP downloads.
- **Sharing** — hand someone an access code and they get the gallery for the folders you picked,
  and nothing else.

Built to stay fluid at tens of thousands of photos.

## Getting started

```bash
npm install
cp config.example.json config.json   # then set "photosRoot"
npm run build
npm start
```

On the first run the server prints an admin access code to the console. Open
<http://localhost:4000>, sign in with it, and the first scan starts automatically; photos appear as
they are indexed, so you do not have to wait for it to finish.

The code is stored only as a hash and cannot be shown again. If you lose it, restart once with
`GALLERY_ADMIN_CODE` set to whatever you want it to be:

```bash
GALLERY_ADMIN_CODE=my-new-code npm start
```

### Configuration

`config.json` at the repo root:

| Key | Meaning | Default |
| --- | --- | --- |
| `photosRoot` | Folder to serve. Read-only — the gallery never writes here. | *required* |
| `port` | HTTP port. | `4000` |
| `host` | Bind address. `0.0.0.0` exposes it to your LAN. | `0.0.0.0` |
| `dataDir` | Where the index and thumbnail cache live. | `./data` |
| `trustProxy` | Honour `X-Forwarded-*`. Turn this on behind a tunnel or reverse proxy. | `false` |

Any of these can be overridden by the `PHOTOS_ROOT`, `PORT`, `HOST`, `DATA_DIR` and `TRUST_PROXY`
environment variables, which is handy when running as a service. Everything else — which folders
feed the gallery, who can see it, how often it re-indexes, row height — is configured in the app's
Settings page and stored server-side, so it follows you between browsers.

### Development

```bash
npm run dev        # API on :4000, Vite dev server on :5173 with hot reload
npm run typecheck
```

### Running as a Windows service

Scripts in [`deploy/windows`](deploy/windows) register the gallery to start at boot and restart if
it exits. Build first (`npm ci && npm run build`), then run one of them from an **elevated**
PowerShell prompt.

The service route needs [NSSM](https://nssm.cc/download) — a single `nssm.exe`, either on `PATH` or
passed with `-NssmPath`:

```powershell
.\deploy\windows\install-service.ps1 -PhotosRoot 'D:\Photos' -DataDir 'C:\GalleryData'
```

The Scheduled Task route needs no download, but stopping it terminates Node instead of sending
Ctrl+C, so the `SIGINT` handler never runs. SQLite is in WAL mode and recovers, but the service is
cleaner:

```powershell
.\deploy\windows\install-task.ps1 -PhotosRoot 'D:\Photos' -DataDir 'C:\GalleryData'
```

Both accept `-Port`, `-BindHost`, `-TrustProxy`, and a `-ServiceName`/`-TaskName`, and both write
the settings as environment variables, so no `config.json` is needed on the server.
`.\deploy\windows\uninstall.ps1` removes whichever one you installed and leaves `DataDir` intact.

Two things worth getting right:

- **Keep `DataDir` on a local SSD.** The SQLite index and the thumbnail cache take far more small
  reads and writes than the photos themselves. Putting them on a network share costs more than any
  other tuning decision here.
- **A UNC `photosRoot` will not work as-is.** Services and tasks default to `LocalSystem`, which has
  no access to network shares; both scripts warn and tell you how to supply an account. Indexing
  over SMB is also much slower than local disk — running the gallery on the machine that physically
  holds the photos is the faster arrangement by a wide margin.

On the first run the admin access code is printed to `<DataDir>\logs\gallery.out.log`.

## Access control

There are two roles. An **admin** sees everything and configures the server. A **viewer** gets the
gallery for an explicit list of folders — no Files tab, no settings, and no way to address a photo
outside those folders. Add people under **Settings → People**: pick their folders, and you get a
code to send them.

**There is no username.** The access code is the identity as well as the proof of it, so sharing the
gallery means sending one string. That costs exactly log₂(number of users) bits of brute-force
resistance compared with a username and password — about two bits for a handful of people — which is
why codes are *generated*, never chosen: 16 characters from a 30-symbol alphabet, ~78 bits. A
user-chosen password would make this scheme genuinely weak. A generated one makes the missing
username irrelevant, since a username is not a secret anyway.

The trade it does make is that signing in has to try every user's hash, there being no username to
index by. That is fine for the handful of people a self-hosted gallery is shared with, and the login
route is rate-limited to ten attempts per quarter hour so it cannot be used to burn CPU either.

Codes are stored as scrypt digests and are shown exactly once, when created. Issuing a new one for
someone signs them out everywhere immediately, so a leaked code is a one-click fix.

### Exposing it to the internet

**Use HTTPS.** Everything above assumes the code is not readable in transit; over plain HTTP it is
sent in the clear on every sign-in. A tunnel — Cloudflare Tunnel, Tailscale — gets you TLS without
opening a port on your router. Set `trustProxy` to `true` when you do, so the rate limiter sees real
client addresses and session cookies get marked `Secure`.

Sessions are opaque 256-bit ids in an `HttpOnly`, `SameSite=Lax` cookie, held server-side in SQLite,
valid for 30 days and renewed as you browse. Deleting a user drops their sessions with them.

Photos are addressable by sequential id, so filtering the feed alone would leave the rest of the
library readable by anyone who counted upwards. Every id-addressed route — photo details,
thumbnails, originals — re-checks the photo's folder against the caller's scope and answers `404`,
not `403`, for anything outside it: whether that id exists is itself not their business.

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
a fresh URL. They are also `private` rather than `public`, since which photos you may fetch now
depends on who you are. Three sizes exist: 320 px for the grid, 640 px for HiDPI screens, and 1600 px for the
viewer. The full-resolution original is only fetched when you actually zoom in past the fit.

No Redis or other cache server is needed — SQLite holds the metadata and the filesystem holds the
thumbnail bytes.

**Path safety.** Every path the client can supply is rejected if it is absolute or contains a `..`
segment, resolved against the root, and then re-checked *after* resolving symlinks, so nothing
outside `photosRoot` can be read. That guard confines requests to the library as a whole, which is
exactly the boundary a per-viewer folder assignment subdivides — so the path-addressed endpoints
(browse, download, ZIP, folder tree) are admin-only, and viewers reach the library only through
id-addressed routes that check their scope.

## Supported formats

JPEG, PNG, WebP, AVIF, GIF and TIFF appear in the gallery. HEIC/HEIF and camera RAW files are listed
in **Files** and can be downloaded, but are not thumbnailed or shown in the feed — the stock libvips
build cannot decode them.

## Layout

```
server/   Fastify API, SQLite index, scanner, thumbnailer
  auth.ts   Access codes, users, sessions
  guard.ts  Authentication hook and the admin check
  scope.ts  Folder scoping — who may see which photos
web/      React + Vite front end
data/     Generated: the SQLite index, sessions and the thumbnail cache
```

In production the server also serves the built front end, so the whole thing is one process.

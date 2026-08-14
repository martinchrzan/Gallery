# Photo Gallery

A self-hosted photo gallery for a folder of photos on your own machine. No cloud, no external
services, no database server — just Node, SQLite and a folder of pictures.

- **Gallery** — every photo and video from the folders you choose, in one chronological feed,
  sorted by the date it was taken. Day separators, a year scrubber down the side, and a full-screen
  viewer with zoom.
- **Files** — the raw folder tree, browsable to any depth, with single-file and ZIP downloads. New
  folders, and uploads into any of them — including from a phone, over a tunnel that caps request
  bodies.
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
| `photosRoot` | Folder to serve. Written to only by an admin's upload; nothing else here modifies it. | *required* |
| `port` | HTTP port. | `4000` |
| `host` | Bind address. `0.0.0.0` exposes it to your LAN. | `0.0.0.0` |
| `dataDir` | Where the index and thumbnail cache live. | `./data` |
| `trustProxy` | Honour `X-Forwarded-*`. Turn this on behind a tunnel or reverse proxy. | `false` |
| `logToFile` | Write `<dataDir>/logs/gallery-<date>.log`, one file per day. | `true` |
| `logConsole` | Also write to stdout. | `true` |
| `logCleanup` | Delete dated log files once they age out. | `true` |
| `logRetentionDays` | How many days of them to keep. | `30` |
| `ffmpegPath` | Explicit ffmpeg binary, for video thumbnails. | bundled, else `PATH` |
| `ffprobePath` | Explicit ffprobe binary, for video metadata. | bundled, else `PATH` |

Any of these can be overridden by the `PHOTOS_ROOT`, `PORT`, `HOST`, `DATA_DIR`, `TRUST_PROXY`,
`LOG_TO_FILE`, `LOG_CONSOLE`, `LOG_CLEANUP`, `LOG_RETENTION_DAYS`, `FFMPEG_PATH` and `FFPROBE_PATH`
environment variables, which is handy when running as a service. Everything else — which folders
feed the gallery, who can see it, how often it re-indexes, row height — is configured in the app's
Settings page and stored server-side, so it follows you between browsers.

### Logs

The server writes one file per day, `<dataDir>/logs/gallery-2026-08-14.log`, as JSON lines. It moves
to a new file on the first line logged after midnight and, while it is there, deletes the dated files
that have fallen outside `logRetentionDays` — so the directory settles at a month of history rather
than one file that grows forever. Files it did not write are never touched. `LOG_LEVEL` (`info` by
default; `debug`, `warn`, `error`) sets how much gets in.

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

On the first run the admin access code is printed to that day's log, `<DataDir>\logs\gallery-<date>.log`.

Both installers pass `LOG_CONSOLE=false`, so the app's own dated files are the only copy of the log
and `gallery.out.log` / `gallery.err.log` are left holding just what dies before the logger exists —
a bad `photosRoot`, a native crash. Pass `-LogRetentionDays` to keep more or less than a month of
history, or `0` to keep it all.

If `install-service.ps1` reports `Unexpected status SERVICE_START_PENDING in response to START
control`, NSSM launched Node but the process died before the port opened — NSSM cannot show you
why. The script's preflight catches the usual causes first (dependencies not installed for that
copy of the tree, an unreadable `photosRoot`, a port already in use), and on a failed start it
prints those two files, the current day's log and NSSM's own event-log entries. To see a startup
error directly:

```powershell
cd <repo>\server
$env:PHOTOS_ROOT='D:\Photos'; $env:DATA_DIR='C:\GalleryData'; $env:NODE_ENV='production'
node dist\index.js
```

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

In the full-screen viewer. Everything below `I` acts on a still image, so a video ignores them and
keeps the keys for its own player instead — with the video focused, `←` `→` seek rather than
browse:

| Key | Action |
| --- | --- |
| `←` `→` | Previous / next photo |
| `Esc` | Close |
| `I` | Toggle the details panel |
| `D` | Download the original |
| `F` / `Enter` | Toggle between fit and zoomed |
| `+` `−` | Zoom in / out |
| `0` | Reset to fit |
| `R` / `Shift`+`R` | Rotate a quarter turn clockwise / anticlockwise |

The **Rotate** button turns the photo on screen only — for a picture the camera got the wrong way
up. Nothing is written to your photos folder or to the index, so the rotation lasts until you move
to another photo or close the viewer.

Click anywhere outside the photo to close it. Drag the zoom slider, or use the **Fit** / **1:1**
buttons. A photo smaller than the window opens at its own size rather than being enlarged, so for
those two the *Fit* and *1:1* modes are the same thing and both light up.

Dates in day separators follow your system locale — no translation files needed.

Double-click or pinch to zoom, drag to pan.

## How it works

**The index.** A background scan walks `photosRoot` and records every image and video in a SQLite
database (`data/gallery.db`). A pool of worker threads then reads each photo's EXIF for the capture
date, dimensions and camera settings — or, for a video, asks ffprobe the same questions — so the
HTTP server stays responsive while a large library is being indexed. Files with no embedded date
fall back to a date parsed from the filename (`IMG_20190704_...`), then to the file's modification
time.

**Staying in sync.** Settings offers three modes: watch the folder live via filesystem events,
re-scan on a timer (1–24 hours), or scan only on startup and on demand. A *Rescan now* button is
always available.

**The feed.** The client fetches the whole feed as a packed binary manifest — 16 bytes per item
(id, timestamp, width, height, duration, flags) instead of ~55 for JSON. 50 000 photos is 800 KB and
decodes straight into typed arrays with no parse step. That lets the client compute the exact total scroll height up
front, so the scrollbar is honest and jumping to 2014 is instant. Layout is justified rows grouped
by day, recomputed in ~8 ms for a 50 000-photo library, and only the rows near the viewport are
mounted.

**Thumbnails.** Generated with libvips the first time a photo is seen and cached on disk as WebP
(`data/thumbs/`), keyed by a hash of the file's path, size and modification time. A video takes one
extra step first — ffmpeg pulls a frame from a tenth of the way in, capped at three seconds, since
the opening frames of a clip are so often black — and from there it is the same pipeline, the same
cache and the same three sizes as any photo. Because the key
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
(browse, download, ZIP, folder tree, upload) are admin-only, and viewers reach the library only
through id-addressed routes that check their scope.

**Writing to the library.** The same containment applies in the other direction. Both things an
admin can create — an uploaded file and a new folder — take their destination through that guard,
and their name through one shared reduction to a bare path segment: no directory part, no
separators, nothing Windows forbids, never a dotfile. So all a request can choose is a name and
which existing folder inside the library it appears in; `a/b/c` creates a folder called `c`, not a
tree. Folders are made one level at a time and never silently reused — a name already taken is
reported rather than adopted.

An upload additionally has to be something this gallery has a use for: only photo and video
extensions are accepted, including the HEIC and RAW types listed under **Supported formats** that
Files shows but cannot thumbnail. An upload never overwrites either — a name already in use gets
` (1)` before the extension, the way a file manager does.

A file is not sent as one request. Reverse proxies and tunnels cap a request body — Cloudflare's
free plan at 100 MB, which one phone video passes without trying — so the client opens a session,
sends the bytes as a series of chunks at explicit offsets, and then asks for the session to be
finished. No single request is bigger than one chunk, and a dropped connection costs that chunk
rather than the whole file: chunks are retried, and a chunk whose reply was lost is answered with
the offset the server actually reached, so the transfer resumes instead of duplicating bytes.
Finishing is retried on the same footing and answers the same way twice, so a reply lost at the very
last step — with every byte already on the server — is not reported as a failed upload. Chunks start
at 5 MB and follow the connection from there — halving when one drags, doubling while they land
quickly — because on a slow uplink the limit you hit first is a proxy's *timeout*, not its body
size.

While it is in flight, the file is staged in its destination folder as a hidden `.upload-*.part`,
so the last step is a rename inside one filesystem rather than a copy across volumes (`dataDir` is
meant to be on a different, faster disk than the library). The scanner, the watcher and the file
browser all skip dotfiles, so a partial upload is invisible until it is complete. Sessions live in
memory: a restart abandons them, and the partial files are removed on the next boot, along with any
session nobody has touched for an hour.

A finished upload is indexed immediately rather than waiting for the next scan, so it joins the
gallery feed within seconds and its thumbnail follows. On a phone, the page holds a screen wake lock
while a transfer is running — Android suspends a backgrounded tab, which would stall the queue
mid-file.

## Supported formats

JPEG, PNG, WebP, AVIF, GIF and TIFF appear in the gallery. HEIC/HEIF and camera RAW files are listed
in **Files** and can be downloaded, but are not thumbnailed or shown in the feed — the stock libvips
build cannot decode them.

### Videos

MP4, M4V, MOV, WebM, MKV, AVI, 3GP, MPEG, MTS/M2TS, WMV, FLV and OGV sit in the same chronological
feed as the photos, with a play badge and their runtime on the tile. Clicking one opens the
full-screen viewer and plays it. Zoom, pan and rotate are a still-image affair and are hidden for a
video; the player's own controls take their place, and on a phone the previous/next arrows come back
because a swipe there belongs to the scrubber.

Capture dates come from the container's own tags (`creation_time`, and Apple's
`com.apple.quicktime.creationdate`, which carries a timezone), so a clip lands on the day it was
shot, next to the photos from the same afternoon. Failing that it falls back to the filename and
then the file date, exactly as a photo does. A file that says it should be displayed rotated is
reported — and thumbnailed — the right way up.

**This needs ffmpeg.** `npm install` fetches a prebuilt ffmpeg and ffprobe as *optional*
dependencies, so normally there is nothing to do. If that is skipped (`--no-optional`, an offline
install, an unsupported platform), the server falls back to whatever is on the `PATH`, and then to
nothing at all — it says which at startup. Without ffmpeg videos are still indexed, still ordered,
and still play in the browser; what they lose is their poster tiles, dimensions, durations and
container dates. Install it later and the next scan fills all of that in: the videos are re-read
automatically.

Thumbnailing a video is not the same as playing it. The poster frame is ffmpeg's work and exists for
every format above, but the stream itself goes to the browser untouched — so an AVI or a WMV gets a
proper tile in the feed and then tells you plainly that your browser cannot play it, with a download
button. MP4/H.264 plays everywhere.

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

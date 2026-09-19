# How it works

Notes on the parts of this gallery that are not obvious from the code, and the reasoning behind the
decisions that shaped them. For setup and features, see [the README](../README.md).

- [The index](#the-index)
- [The feed](#the-feed)
- [Thumbnails](#thumbnails)
- [Access control](#access-control)
- [Activity](#activity)
- [Path safety](#path-safety)
- [Writing to the library](#writing-to-the-library)
- [Uploads](#uploads)
- [Videos](#videos)
- [Logs](#logs)

## The index

A background scan walks `photosRoot` and records every image and video in a SQLite database
(`data/gallery.db`). A pool of worker threads then reads each photo's EXIF for the capture date,
dimensions and camera settings — or, for a video, asks ffprobe the same questions — so the HTTP
server stays responsive while a large library is being indexed.

Files with no embedded date fall back to a date parsed from the filename (`IMG_20190704_…`), then to
the file's modification time. Which of the three was used is recorded, and the details panel says so
when it was not EXIF.

Image decoding runs in isolated worker processes on purpose. A libvips crash is invisible from the
outside — it kills the process with a bare exit code and no stack — so a corrupt file taking down the
whole server would be both baffling and fatal. In a worker it costs one photo.

**Staying in sync.** Settings offers three modes: watch the folder live via filesystem events,
re-scan on a timer (1–24 hours), or scan only on startup and on demand. A *Rescan now* button is
always available.

## The feed

The client fetches the whole feed as a packed binary manifest — 16 bytes per item rather than the
~55 the equivalent JSON costs:

```
id u32 | takenAt(sec) u32 | width u16 | height u16 | duration(sec) u16 | flags u16
```

50 000 photos is 800 KB, and it decodes straight into typed arrays with no parse step. Timestamps
are seconds rather than milliseconds: it keeps the record compact and stays exact until 2106.
Undated photos carry 0 and sort last. Durations saturate at about 18 hours, because the badge only
needs a runtime a person can read and a clip that long is not one.

That the client holds every timestamp is what makes the rest work. It can compute the exact total
scroll height up front, so the scrollbar is honest and jumping to 2014 is instant; and "on this day"
is a binary search rather than a request.

**Layout.** Justified rows grouped by day, computed in one linear pass over those typed arrays with
no per-photo allocation — about 8 ms for a 50 000-photo library, which is cheap enough to redo on
every resize. Only the rows near the viewport are mounted.

A row is closed when fitting one more photo would squash it below the target height, and no photo is
ever enlarged past its own pixels: a day holding a single small photo shows it at its natural size
rather than stretching it across the row, where upscaling looks soft.

**The day resolver.** Constructing a `Date` per photo dominates the layout pass otherwise. Because
the manifest is sorted by time, consecutive photos nearly always share a day, so the resolver caches
the current day's bounds — one `Date` per *day* instead of per photo. It still goes through `Date`
for the boundaries themselves, so daylight-saving shifts stay correct.

**Caching.** The manifest's ETag includes the user's folder set, so two people signed in to the same
browser — or sharing any cache in front of the server — can never be served each other's feed on a
stale validator.

## Thumbnails

Generated with libvips the first time a photo is seen and cached on disk as WebP (`data/thumbs/`),
keyed by a hash of the file's path, size and modification time. Three sizes: 320 px for the grid,
640 px for HiDPI screens, and 1600 px for the viewer. The full-resolution original is only fetched
when you actually zoom in past the fit.

Because the key covers the file's contents, thumbnails are served `immutable` and an edited photo
automatically gets a fresh URL. They are also `private` rather than `public`, since which photos you
may fetch now depends on who you are.

A video takes one extra step first — ffmpeg pulls a frame from a tenth of the way in, capped at three
seconds, since the opening frames of a clip are so often black — and from there it is the same
pipeline, the same cache and the same three sizes as any photo.

No Redis or other cache server is needed: SQLite holds the metadata and the filesystem holds the
thumbnail bytes.

## Access control

There are two roles. An **admin** sees everything and configures the server. A **viewer** gets the
gallery for an explicit list of folders — no Files tab, no settings, and no way to address a photo
outside those folders.

**There is no username.** The access code is the identity as well as the proof of it, so sharing the
gallery means sending one string. That costs exactly log₂(number of users) bits of brute-force
resistance compared with a username and password — about two bits for a handful of people — which is
why codes are *generated*, never chosen: 16 characters from a 30-symbol alphabet, ~78 bits. A
user-chosen password would make this scheme genuinely weak. A generated one makes the missing
username irrelevant, since a username is not a secret anyway.

The alphabet omits `0`/`O`, `1`/`I`/`L` and `U` — the characters people mistype when copying a code
off a screen or hearing it read aloud.

The trade the scheme does make is that signing in has to try every user's hash, there being no
username to index by. That is fine for the handful of people a self-hosted gallery is shared with,
and the login route is rate-limited to ten attempts per quarter hour so it cannot be used to burn CPU
either. The loop deliberately runs to completion, so a wrong code costs the same as a right one
regardless of where in the list it sits.

Codes are stored as scrypt digests and are shown exactly once, when created. Issuing a new one for
someone drops all of their sessions in the same transaction — otherwise rotating after a leak would
do nothing until the old session expired.

**Sessions** are opaque 256-bit ids in an `HttpOnly`, `SameSite=Lax` cookie, held server-side in
SQLite, valid for 30 days and renewed as you browse — but only written once past halfway, so an
active browser does not cause a database write on every thumbnail request. Deleting a user drops
their sessions with them.

**Why 404 and not 403.** Photos are addressable by sequential id, so filtering the feed alone would
leave the rest of the library readable by anyone who counted upwards. Every id-addressed route —
photo details, thumbnails, originals — re-checks the photo's folder against the caller's scope and
answers `404`, not `403`, for anything outside it: whether that id exists is itself not their
business. There is a test that walks every id in the library as a restricted viewer and asserts that
exactly the permitted ones answer.

**Empty means empty.** An empty folder selection shows *nothing*. The gallery is an explicit choice
of folders, so an empty choice is an empty gallery rather than a silent "everything" — the opposite
reading would be the worst defaulting bug this code could have. Selecting the root entry is how you
ask for the lot.

## Activity

Settings shows who has been using the gallery, on which devices, from where and when. It is
recorded as one row per device, per address, per hour of use — which answers every question the
screen asks without a write per request. Scrolling the feed fires dozens of thumbnail requests a
second, and all but the first of them in any five minutes are absorbed by an in-memory note of when
that device was last written.

**A device is a session.** Each browser someone signs in on holds its own session, so that is what
the screen calls a device; signing in again on the same phone starts a new one. The session id
cannot name it, though, because the id *is* the credential — storing it anywhere else, or showing it
to an admin, would hand out a way to sign in as that browser. The record keeps a hash of it instead,
which identifies the same browser just as well and is useless as a cookie.

**Hours, not days.** The server reports raw hours and the client folds them into days, because which
day an hour belongs to depends on the reader's timezone. For the same reason the client asks for
activity *since its own local midnight* rather than for a number of days.

**What counts.** Any signed-in request, except the scan-progress stream: that reconnects by itself
whenever it drops, and would otherwise show an admin's forgotten tab as hours of use. "Last seen" on
the People list follows the same record, so it means last used rather than last signed in.

Addresses are only as good as what reaches the server — behind a tunnel or reverse proxy, every
visit arrives from the proxy unless `trustProxy` is on, and the screen says so when every address it
has is the server's own. Rows older than 90 days are pruned; deleting a user deletes theirs.

## Path safety

Every path the client can supply is rejected if it is absolute or contains a `..` segment, resolved
against the root, and then re-checked *after* resolving symlinks, so nothing outside `photosRoot` can
be read.

That guard confines requests to the library as a whole, which is exactly the boundary a per-viewer
folder assignment subdivides — so the path-addressed endpoints (browse, download, ZIP, folder tree,
upload) are admin-only, and viewers reach the library only through id-addressed routes that check
their scope.

## Writing to the library

The same containment applies in the other direction. Both things an admin can create — an uploaded
file and a new folder — take their destination through that guard, and their name through one shared
reduction to a bare path segment: no directory part, no separators, nothing Windows forbids, never a
dotfile.

So all a request can choose is a name and which existing folder inside the library it appears in;
`a/b/c` creates a folder called `c`, not a tree. Folders are made one level at a time and never
silently reused — a name already taken is reported rather than adopted.

An upload additionally has to be something this gallery has a use for: only photo and video
extensions are accepted, including the HEIC and RAW types that Files shows but cannot thumbnail. An
upload never overwrites either — a name already in use gets ` (1)` before the extension, the way a
file manager does.

## Uploads

A file is not sent as one request. Reverse proxies and tunnels cap a request body — Cloudflare's free
plan at 100 MB, which one phone video passes without trying — so the client opens a session, sends
the bytes as a series of chunks at explicit offsets, and then asks for the session to be finished.

No single request is bigger than one chunk, and a dropped connection costs that chunk rather than the
whole file. Chunks are retried, and a chunk whose reply was lost is answered with the offset the
server actually reached, so the transfer resumes instead of duplicating bytes. Finishing is retried
on the same footing and answers the same way twice, so a reply lost at the very last step — with
every byte already on the server — is not reported as a failed upload.

Chunks start at 5 MB and follow the connection from there, halving when one drags and doubling while
they land quickly, because on a slow uplink the limit you hit first is a proxy's *timeout*, not its
body size.

While it is in flight, the file is staged in its destination folder as a hidden `.upload-*.part`, so
the last step is a rename inside one filesystem rather than a copy across volumes (`dataDir` is meant
to be on a different, faster disk than the library). The scanner, the watcher and the file browser
all skip dotfiles, so a partial upload is invisible until it is complete.

Sessions live in memory: a restart abandons them, and the partial files are removed on the next boot,
along with any session nobody has touched for an hour.

A finished upload is indexed immediately rather than waiting for the next scan, so it joins the
gallery feed within seconds and its thumbnail follows. On a phone, the page holds a screen wake lock
while a transfer is running — Android suspends a backgrounded tab, which would stall the queue
mid-file.

## Videos

Videos sit in the same chronological feed as the photos, with a play badge and their runtime on the
tile. Clicking one opens the full-screen viewer and plays it. Zoom, pan and rotate are a still-image
affair and are hidden for a video; the player's own controls take their place, and on a phone the
previous/next arrows come back because a swipe there belongs to the scrubber.

Capture dates come from the container's own tags (`creation_time`, and Apple's
`com.apple.quicktime.creationdate`, which carries a timezone), so a clip lands on the day it was
shot, next to the photos from the same afternoon. Failing that it falls back to the filename and then
the file date, exactly as a photo does. A file that says it should be displayed rotated is reported —
and thumbnailed — the right way up.

Thumbnailing a video is not the same as playing it. The poster frame is ffmpeg's work and exists for
every format the gallery indexes, but the stream itself goes to the browser untouched — so an AVI or
a WMV gets a proper tile in the feed and then tells you plainly that your browser cannot play it,
with a download button.

A missing ffmpeg is deliberately not treated as a broken file: only a file that ffprobe *could* read
and did not is remembered as failed, so installing ffmpeg later lets the next scan fill in every
video's poster, dimensions, duration and date automatically.

## Logs

The server writes one file per day, `<dataDir>/logs/gallery-2026-08-14.log`, as JSON lines. It moves
to a new file on the first line logged after midnight and, while it is there, deletes the dated files
that have fallen outside `logRetentionDays` — so the directory settles at a month of history rather
than one file that grows forever. Files it did not write are never touched.

`LOG_LEVEL` (`info` by default; `debug`, `warn`, `error`) sets how much gets in.

A 4xx is the client being told something about its own request — a chunk resent at a stale offset, a
file type the gallery does not take — and on a flaky mobile upload it is routine, so it is logged as
a one-line reason. Only a 5xx is the server's own problem, and only that gets a stack trace.
Internal failures never leak a filesystem path in their response.

## Layout of the code

```
server/
  app.ts        Builds the HTTP app: plugins, guards, routes
  index.ts      Starts it: config, bootstrap, listen, shutdown
  auth.ts       Access codes, users, sessions
  guard.ts      Authentication hook and the admin check
  activity.ts   Who used the gallery, on which device, from where, and when
  scope.ts      Folder scoping — who may see which photos
  paths.ts      Containment: every client-supplied path goes through here
  indexer.ts    The scanner, the watcher and the metadata queue
  thumbs.ts     The WebP cache
  uploads.ts    Chunked upload sessions
  video.ts      ffmpeg/ffprobe
  workers/      Isolated image decoding
  routes/       auth, gallery, media, files, settings, activity

web/
  api/client.ts      The manifest decoder and every API call
  gallery/layout.ts  Justified-row layout over typed arrays
  gallery/memories.ts "On this day"
  lightbox/          The full-screen viewer, zoom and pan
  files/             The file browser and the upload queue
  settings/          The settings page
```

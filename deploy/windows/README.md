# Running the gallery as a Windows service

The scripts here register the gallery to start at boot and restart if it exits. Build first, then run
one of them from an **elevated** PowerShell prompt:

```powershell
npm ci
npm run build
```

## Which one

**A service, via [NSSM](https://nssm.cc/download)** — the better option. Needs a single `nssm.exe`,
either on `PATH` or passed with `-NssmPath`:

```powershell
.\install-service.ps1 -PhotosRoot 'D:\Photos' -DataDir 'C:\GalleryData'
```

**A Scheduled Task** — no download required, but stopping it terminates Node instead of sending
Ctrl+C, so the `SIGINT` handler never runs. SQLite is in WAL mode and recovers, but the service is
cleaner:

```powershell
.\install-task.ps1 -PhotosRoot 'D:\Photos' -DataDir 'C:\GalleryData'
```

Both accept `-Port`, `-BindHost`, `-TrustProxy`, `-LogRetentionDays` and a `-ServiceName` /
`-TaskName`, and both write the settings as environment variables — so no `config.json` is needed on
the server.

`.\uninstall.ps1` removes whichever one you installed and leaves `DataDir` intact.

## Two things worth getting right

**Keep `DataDir` on a local SSD.** The SQLite index and the thumbnail cache take far more small reads
and writes than the photos themselves. Putting them on a network share costs more than any other
tuning decision here.

**A UNC `photosRoot` will not work as-is.** Services and tasks default to `LocalSystem`, which has no
access to network shares; both scripts warn and tell you how to supply an account. Indexing over SMB
is also much slower than local disk — running the gallery on the machine that physically holds the
photos is the faster arrangement by a wide margin.

## Where the logs go

On the first run the admin access code is printed to that day's log,
`<DataDir>\logs\gallery-<date>.log`.

Both installers pass `LOG_CONSOLE=false`, so the app's own dated files are the only copy of the log,
and `gallery.out.log` / `gallery.err.log` are left holding just what dies before the logger exists —
a bad `photosRoot`, a native crash. Pass `-LogRetentionDays` to keep more or less than a month of
history, or `0` to keep it all.

## When the service will not start

If `install-service.ps1` reports:

```
Unexpected status SERVICE_START_PENDING in response to START control
```

NSSM launched Node but the process died before the port opened — and NSSM cannot show you why. The
script's preflight catches the usual causes first (dependencies not installed for that copy of the
tree, an unreadable `photosRoot`, a port already in use), and on a failed start it prints
`gallery.out.log`, `gallery.err.log`, the current day's log and NSSM's own event-log entries.

To see a startup error directly, run the server by hand with the same environment:

```powershell
cd <repo>\server
$env:PHOTOS_ROOT='D:\Photos'; $env:DATA_DIR='C:\GalleryData'; $env:NODE_ENV='production'
node dist\index.js
```

import { useCallback, useEffect, useState } from 'react';
import { api, type FolderNode, type Settings, type StatsResult } from '../api/client';
import { formatBytes, formatCount, formatDateTime } from '../lib/format';
import { useIndexStatus, useToast } from '../lib/hooks';
import { toggleFolder as toggleFolderSelection } from './folders';
import { FolderTree } from './FolderTree';
import { UsersPanel } from './UsersPanel';

const INTERVAL_PRESETS = [1, 2, 6, 12, 24];

interface SettingsViewProps {
  settings: Settings | null;
  onSettingsChange: (settings: Settings) => void;
  currentUserId: number;
}

export function SettingsView({
  settings,
  onSettingsChange,
  currentUserId,
}: SettingsViewProps): React.ReactElement {
  const [tree, setTree] = useState<FolderNode | null>(null);
  const [stats, setStats] = useState<StatsResult | null>(null);
  const [saving, setSaving] = useState(false);
  const [toast, showToast] = useToast();
  const indexStatus = useIndexStatus();

  // Stable so the users panel does not refetch on every re-render of this view.
  const reportError = useCallback((message: string) => showToast(message, true), [showToast]);
  const reportNotice = useCallback((message: string) => showToast(message), [showToast]);

  const loadStats = useCallback((signal?: AbortSignal) => {
    api
      .stats(signal)
      .then((result) => !signal?.aborted && setStats(result))
      .catch(() => {});
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    api
      .folderTree(controller.signal)
      .then((result) => !controller.signal.aborted && setTree(result))
      .catch(() => {});
    loadStats(controller.signal);
    return () => controller.abort();
  }, [loadStats]);

  // Refresh the counts once a scan finishes.
  const scanning = indexStatus?.scanning ?? false;
  useEffect(() => {
    if (scanning) return;
    loadStats();
    api
      .folderTree()
      .then(setTree)
      .catch(() => {});
  }, [scanning, loadStats]);

  const save = useCallback(
    async (patch: Partial<Settings>) => {
      setSaving(true);
      try {
        const next = await api.saveSettings(patch);
        onSettingsChange(next);
      } catch (err) {
        showToast((err as Error).message, true);
      } finally {
        setSaving(false);
      }
    },
    [onSettingsChange, showToast],
  );

  if (!settings) {
    return (
      <div className="empty">
        <div className="spinner" />
        <p>Loading settings…</p>
      </div>
    );
  }

  const selectedFolders = new Set(settings.galleryFolders);

  const toggleFolder = (path: string): void => {
    void save({ galleryFolders: toggleFolderSelection(selectedFolders, path) });
  };

  return (
    <div className="settings">
      <div className="settings-inner">
        <section className="card">
          <h2>Gallery folders</h2>
          <p className="hint">
            Photos from these folders — and everything inside them — appear in the chronological
            gallery. Select <strong>All photos</strong> for the whole library; with nothing ticked
            the gallery stays empty.
          </p>
          <div className="folder-tree">
            {tree ? (
              <FolderTree node={tree} selected={selectedFolders} onToggle={toggleFolder} />
            ) : (
              <div className="pill">
                <div className="spinner" />
                Reading folders…
              </div>
            )}
          </div>
          <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontSize: 12.5, color: 'var(--text-dim)' }}>
              {settings.galleryFolders.includes('')
                ? 'The whole library is shown'
                : settings.galleryFolders.length === 0
                  ? 'Nothing selected — the gallery is empty'
                  : `${formatCount(settings.galleryFolders.length)} folder${
                      settings.galleryFolders.length === 1 ? '' : 's'
                    } selected`}
            </span>
            {settings.galleryFolders.length > 0 && (
              <button className="btn btn-ghost" onClick={() => void save({ galleryFolders: [] })}>
                Clear selection
              </button>
            )}
          </div>
        </section>

        <UsersPanel
          tree={tree}
          currentUserId={currentUserId}
          onError={reportError}
          onNotice={reportNotice}
        />

        <section className="card">
          <h2>Indexing</h2>
          <p className="hint">
            How the gallery notices new photos on disk. A manual rescan is always available.
          </p>

          <div className="field">
            <div>
              <label htmlFor="index-mode">Mode</label>
              <div className="desc">
                {settings.indexMode === 'watch'
                  ? 'New photos appear as soon as they land in the folder.'
                  : settings.indexMode === 'interval'
                    ? 'The library is re-scanned on a timer.'
                    : 'The library is scanned on startup and when you ask.'}
              </div>
            </div>
            <div className="field-control">
              <select
                id="index-mode"
                value={settings.indexMode}
                onChange={(event) =>
                  void save({ indexMode: event.target.value as Settings['indexMode'] })
                }
              >
                <option value="watch">Watch folder (live)</option>
                <option value="interval">Rescan on a timer</option>
                <option value="manual">Manual only</option>
              </select>
            </div>
          </div>

          {settings.indexMode === 'interval' && (
            <div className="field">
              <div>
                <label htmlFor="index-interval">Rescan every</label>
                <div className="desc">How often the whole library is swept for changes.</div>
              </div>
              <div className="field-control">
                <select
                  id="index-interval"
                  value={settings.indexIntervalHours}
                  onChange={(event) =>
                    void save({ indexIntervalHours: Number(event.target.value) })
                  }
                >
                  {INTERVAL_PRESETS.map((hours) => (
                    <option key={hours} value={hours}>
                      {hours === 1 ? 'hour' : `${hours} hours`}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          )}

          <div className="field">
            <div>
              <label>Last scan</label>
              <div className="desc">
                {indexStatus?.scanning
                  ? describeProgress(indexStatus)
                  : formatDateTime(indexStatus?.lastScanAt ?? null)}
              </div>
            </div>
            <div className="field-control">
              <button
                className="btn"
                disabled={indexStatus?.scanning}
                onClick={() => {
                  void api.rescan();
                  showToast('Rescan started');
                }}
              >
                {indexStatus?.scanning ? 'Scanning…' : 'Rescan now'}
              </button>
            </div>
          </div>

          {indexStatus?.lastError && (
            <div className="field">
              <div>
                <label style={{ color: 'var(--danger)' }}>Last error</label>
                <div className="desc">{indexStatus.lastError}</div>
              </div>
            </div>
          )}

          {/* Deliberately not styled as an error: the gallery is complete, and
              the only cost is that these files wait for a scan instead of
              showing up the moment they land. */}
          {indexStatus?.watchIssue && (
            <div className="field">
              <div>
                <label>Watching files</label>
                <div className="desc">
                  Some files could not be watched for live changes, so they will appear on the next
                  scan rather than immediately. Common on OneDrive, network shares and very large
                  folders — switching to <strong>Re-scan on a timer</strong> avoids it entirely.
                  <div style={{ marginTop: 4, color: 'var(--text-faint)' }}>
                    {indexStatus.watchIssue}
                  </div>
                </div>
              </div>
            </div>
          )}
        </section>

        <section className="card">
          <h2>Appearance</h2>
          <p className="hint">How the chronological feed is laid out.</p>

          <div className="field">
            <div>
              <label htmlFor="row-height">Row height</label>
              <div className="desc">Taller rows mean bigger, fewer photos per row.</div>
            </div>
            <div className="field-control">
              <input
                id="row-height"
                type="range"
                min={140}
                max={420}
                step={10}
                value={settings.rowHeight}
                onChange={(event) =>
                  onSettingsChange({ ...settings, rowHeight: Number(event.target.value) })
                }
                onPointerUp={(event) =>
                  void save({ rowHeight: Number((event.target as HTMLInputElement).value) })
                }
              />
              <span style={{ width: 44, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                {settings.rowHeight}
              </span>
            </div>
          </div>

          <div className="field">
            <div>
              <label htmlFor="show-meta">Show details in the viewer</label>
              <div className="desc">Opens the metadata panel by default. Toggle it with I.</div>
            </div>
            <div className="field-control">
              <input
                id="show-meta"
                type="checkbox"
                checked={settings.showMetadata}
                onChange={(event) => void save({ showMetadata: event.target.checked })}
              />
            </div>
          </div>

          <div className="field">
            <div>
              <label htmlFor="show-memories">“On this day” strip</label>
              <div className="desc">
                A row above the feed with a few photos taken on today’s date one, two and three
                years ago. It only appears on days that have any, and scrolls away with the page.
              </div>
            </div>
            <div className="field-control">
              <input
                id="show-memories"
                type="checkbox"
                checked={settings.showMemories}
                onChange={(event) => void save({ showMemories: event.target.checked })}
              />
            </div>
          </div>
        </section>

        <section className="card">
          <h2>Thumbnails</h2>
          <p className="hint">
            Thumbnails are generated the first time a photo is seen and cached on disk from then on.
          </p>

          <div className="field">
            <div>
              <label htmlFor="prewarm">Generate ahead of time</label>
              <div className="desc">
                After each scan, build every missing thumbnail in the background. Uses CPU for a
                while, then scrolling is instant everywhere.
              </div>
            </div>
            <div className="field-control">
              <input
                id="prewarm"
                type="checkbox"
                checked={settings.prewarmThumbs}
                onChange={(event) => void save({ prewarmThumbs: event.target.checked })}
              />
            </div>
          </div>

          <div className="field">
            <div>
              <label>Cache on disk</label>
              <div className="desc">
                {stats
                  ? `${formatCount(stats.thumbFiles)} files · ${formatBytes(stats.thumbBytes)}`
                  : '—'}
              </div>
            </div>
            <div className="field-control">
              <button
                className="btn btn-danger"
                onClick={() => {
                  void api
                    .clearCache()
                    .then(() => {
                      showToast('Thumbnail cache cleared');
                      loadStats();
                    })
                    .catch((err: Error) => showToast(err.message, true));
                }}
              >
                Clear cache
              </button>
            </div>
          </div>
        </section>

        <section className="card">
          <h2>Library</h2>
          <div className="stat-grid">
            {/* `photos` counts everything indexed, so the photo tile subtracts
                the videos rather than double-counting them across the two. */}
            <div className="stat">
              <div className="value">
                {stats ? formatCount(stats.photos - stats.videos) : '—'}
              </div>
              <div className="label">Photos indexed</div>
            </div>
            <div className="stat">
              <div className="value">{stats ? formatCount(stats.videos) : '—'}</div>
              <div className="label">Videos indexed</div>
            </div>
            <div className="stat">
              <div className="value">{stats ? formatBytes(stats.totalBytes) : '—'}</div>
              <div className="label">Original size</div>
            </div>
            <div className="stat">
              <div className="value">
                {stats?.oldest ? new Date(stats.oldest).getFullYear() : '—'}
              </div>
              <div className="label">Oldest photo</div>
            </div>
            <div className="stat">
              <div className="value">
                {stats?.newest ? new Date(stats.newest).getFullYear() : '—'}
              </div>
              <div className="label">Newest photo</div>
            </div>
          </div>
        </section>
      </div>

      {saving && <div className="toast">Saving…</div>}
      {toast && !saving && (
        <div className={`toast${toast.error ? ' error' : ''}`}>{toast.message}</div>
      )}
    </div>
  );
}

function describeProgress(status: NonNullable<ReturnType<typeof useIndexStatus>>): string {
  switch (status.phase) {
    case 'walking':
      return `Scanning folders — ${formatCount(status.discovered)} photos found`;
    case 'extracting':
      return `Reading photo dates — ${formatCount(status.processed)} of ${formatCount(status.total)}`;
    case 'prewarming':
      return `Building thumbnails — ${formatCount(status.processed)} of ${formatCount(status.total)}`;
    default:
      return 'Working…';
  }
}

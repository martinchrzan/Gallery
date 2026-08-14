import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  api,
  downloadZip,
  fileDownloadUrl,
  makeManifest,
  thumbUrl,
  type BrowseResult,
  type Manifest,
} from '../api/client';
import {
  IconArchive,
  IconCheck,
  IconClose,
  IconDownload,
  IconFile,
  IconFolder,
  IconFolderPlus,
  IconImage,
  IconPlay,
  IconUpload,
} from '../components/icons';
import { Lightbox } from '../lightbox/Lightbox';
import { formatBytes, formatCount } from '../lib/format';
import { useToast } from '../lib/hooks';
import { UploadPanel } from './UploadPanel';
import { useUploader } from './uploads';
import type { FileEntry } from '@shared';

export function FilesView(): React.ReactElement {
  const params = useParams();
  const navigate = useNavigate();
  const currentPath = decodeURIComponent(params['*'] ?? '');

  const [data, setData] = useState<BrowseResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const [toast, showToast] = useToast();

  // State rather than a ref, so it is populated even though the first render
  // is the loading placeholder.
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setSelected(new Set());

    api
      .browse(currentPath, controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return;
        setData(result);
        setError(null);
        scrollEl?.scrollTo({ top: 0 });
      })
      .catch((err: Error) => {
        if (controller.signal.aborted) return;
        setError(err.message);
        setData(null);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
    // `scrollEl` is only read to reset the scroll position; re-running this
    // fetch when it attaches would be a wasted request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentPath]);

  const openFolder = useCallback(
    (path: string) => navigate(`/files/${path.split('/').map(encodeURIComponent).join('/')}`),
    [navigate],
  );

  /* --------------------------------------------------------------- uploads */

  /** The folder on screen right now, readable from a callback that outlived it. */
  const pathRef = useRef(currentPath);
  pathRef.current = currentPath;

  /** Re-reads this folder in place — no placeholder, no loss of the selection. */
  const refresh = useCallback(() => {
    const forPath = currentPath;
    api
      .browse(forPath)
      .then((result) => {
        // A refresh is bound to the folder it was asked for, and an upload's
        // arrives seconds late by design. Dropping it once the view has moved on
        // is what keeps another folder's contents from appearing under this
        // folder's path.
        if (pathRef.current !== forPath) return;
        setData(result);
        setError(null);
      })
      .catch(() => {
        // A refresh is opportunistic; the view already has something to show.
      });
  }, [currentPath]);

  const settleTimer = useRef<number | undefined>(undefined);
  // Keyed on the folder, so leaving it also drops the pending look — the result
  // would be discarded on arrival anyway, and the request is worth saving.
  useEffect(() => () => window.clearTimeout(settleTimer.current), [currentPath]);

  const uploader = useUploader(
    useCallback(
      ({ uploaded, failed }: { uploaded: number; failed: number }) => {
        if (uploaded > 0) {
          showToast(`Uploaded ${formatCount(uploaded)} file${uploaded === 1 ? '' : 's'}`);
          refresh();
          // The files are on disk immediately but their thumbnails are not: the
          // indexer reads them a couple of seconds later. One more look then,
          // so the tiles fill in without anyone reloading the page.
          window.clearTimeout(settleTimer.current);
          settleTimer.current = window.setTimeout(refresh, 6000);
        }
        if (failed > 0) {
          showToast(
            `${formatCount(failed)} file${failed === 1 ? '' : 's'} could not be uploaded`,
            true,
          );
        }
      },
      [refresh, showToast],
    ),
  );

  /* --------------------------------------------------------- new folder */

  const [naming, setNaming] = useState(false);
  const [newFolder, setNewFolder] = useState('');
  const [creating, setCreating] = useState(false);

  const createFolder = useCallback(async (): Promise<void> => {
    const name = newFolder.trim();
    if (name === '' || creating) return;

    setCreating(true);
    try {
      const dir = await api.createFolder({ path: currentPath, name });
      setNaming(false);
      setNewFolder('');
      // The server has the final say on the name — it strips whatever a folder
      // cannot be called — so the listing is re-read rather than patched.
      refresh();
      showToast(`Created ${dir.name}`);
    } catch (err) {
      showToast((err as Error).message, true);
    } finally {
      setCreating(false);
    }
  }, [creating, currentPath, newFolder, refresh, showToast]);

  const fileInput = useRef<HTMLInputElement | null>(null);
  const [dragging, setDragging] = useState(false);
  // Drag events fire for every child the pointer crosses, so leaving is counted
  // rather than assumed — otherwise the overlay flickers over the grid.
  const dragDepth = useRef(0);

  const { add: addUploads } = uploader;

  const onDrop = useCallback(
    (event: React.DragEvent): void => {
      event.preventDefault();
      dragDepth.current = 0;
      setDragging(false);

      const dropped: File[] = [];
      let folders = 0;

      for (const item of Array.from(event.dataTransfer.items)) {
        if (item.kind !== 'file') continue;
        // A dropped folder also arrives as a "file"; uploading it would fail on
        // the extension check, so it is skipped here where we can say why.
        if (item.webkitGetAsEntry()?.isFile === false) {
          folders++;
          continue;
        }
        const file = item.getAsFile();
        if (file) dropped.push(file);
      }

      // `items` is empty in a few older browsers; the flat file list is the
      // fallback, and it cannot tell a folder from a file either way.
      const files =
        dropped.length > 0 || folders > 0 ? dropped : Array.from(event.dataTransfer.files);

      if (folders > 0) {
        showToast('Folders cannot be dropped — open one and drop the files inside', true);
      }
      addUploads(files, currentPath);
    },
    [addUploads, currentPath, showToast],
  );

  /**
   * A folder-scoped manifest, so the lightbox can arrow through this folder's
   * indexed images using exactly the same component as the gallery.
   */
  const folderManifest: Manifest = useMemo(() => {
    const items = (data?.files ?? []).filter((file) => file.photoId !== null);
    const ids = new Uint32Array(items.length);
    const times = new Uint32Array(items.length);
    const widths = new Uint16Array(items.length);
    const heights = new Uint16Array(items.length);
    const videos = new Uint8Array(items.length);

    items.forEach((file, i) => {
      ids[i] = file.photoId!;
      times[i] = Math.floor(file.modifiedAt / 1000);
      widths[i] = Math.min(65535, file.width ?? 0);
      heights[i] = Math.min(65535, file.height ?? 0);
      videos[i] = file.video ? 1 : 0;
    });

    // Durations are left at zero: browsing files, nothing shows them, and the
    // lightbox reads the real one from the video itself.
    return makeManifest({ count: items.length, ids, times, widths, heights, videos });
  }, [data]);

  const viewableFiles = useMemo(
    () => (data?.files ?? []).filter((file) => file.photoId !== null),
    [data],
  );

  const toggleSelected = useCallback((path: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const selectAll = useCallback(() => {
    setSelected(new Set((data?.files ?? []).map((file) => file.path)));
  }, [data]);

  const downloadSelected = useCallback(() => {
    if (selected.size === 0) return;
    const name = currentPath ? `${currentPath.split('/').pop()}-selection.zip` : 'selection.zip';
    downloadZip([...selected], name);
    showToast(`Preparing a ZIP of ${formatCount(selected.size)} files…`);
  }, [currentPath, selected, showToast]);

  if (loading && !data) {
    return (
      <div className="empty">
        <div className="spinner" />
        <p>Loading folder…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="empty">
        <h2>Could not open this folder</h2>
        <p>{error}</p>
        <button className="btn" onClick={() => navigate('/files')}>
          Back to the top folder
        </button>
      </div>
    );
  }

  const crumbs = buildCrumbs(currentPath);
  const dirs = data?.dirs ?? [];
  const files = data?.files ?? [];

  return (
    <div
      className={`files${dragging ? ' dropping' : ''}`}
      ref={setScrollEl}
      onDragEnter={(event) => {
        if (!event.dataTransfer.types.includes('Files')) return;
        dragDepth.current++;
        setDragging(true);
      }}
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes('Files')) event.preventDefault();
      }}
      onDragLeave={() => {
        dragDepth.current--;
        if (dragDepth.current <= 0) {
          dragDepth.current = 0;
          setDragging(false);
        }
      }}
      onDrop={onDrop}
    >
      <input
        ref={fileInput}
        type="file"
        multiple
        // On Android this is what turns the system picker into the photo and
        // video one, with the camera offered alongside it.
        accept="image/*,video/*"
        style={{ display: 'none' }}
        onChange={(event) => {
          addUploads(Array.from(event.target.files ?? []), currentPath);
          // Cleared, so picking the same file twice in a row still fires.
          event.target.value = '';
        }}
      />

      <div className="files-bar">
        <nav className="crumbs" aria-label="Folder path">
          {crumbs.map((crumb, i) => (
            <span key={crumb.path} style={{ display: 'contents' }}>
              {i > 0 && <span className="crumb-sep">/</span>}
              <button onClick={() => openFolder(crumb.path)}>{crumb.name}</button>
            </span>
          ))}
        </nav>

        <div className="selection-bar">
          {selected.size > 0 ? (
            <>
              <span style={{ fontSize: 13, color: 'var(--text-dim)' }}>
                {formatCount(selected.size)} selected
              </span>
              <button className="btn btn-ghost" onClick={() => setSelected(new Set())}>
                Clear
              </button>
              <button className="btn btn-primary" onClick={downloadSelected}>
                Download ZIP
              </button>
            </>
          ) : (
            <>
              {files.length > 0 && (
                <>
                  <button className="btn btn-ghost" onClick={selectAll}>
                    Select all
                  </button>
                  {currentPath && (
                    <button
                      className="btn"
                      onClick={() => {
                        downloadZip([currentPath]);
                        showToast('Preparing a ZIP of this folder…');
                      }}
                    >
                      Download folder
                    </button>
                  )}
                </>
              )}
              {/* Both are offered in an empty folder too — that is where they
                  are needed most, and where there is nothing else to do. */}
              <button
                className="btn"
                onClick={() => {
                  setNewFolder('');
                  setNaming(true);
                }}
              >
                <IconFolderPlus size={15} />
                New folder
              </button>
              <button className="btn btn-primary" onClick={() => fileInput.current?.click()}>
                <IconUpload size={15} />
                Upload
              </button>
            </>
          )}
        </div>
      </div>

      {dirs.length === 0 && files.length === 0 && !naming && (
        <div className="empty" style={{ height: 'auto', paddingTop: 60 }}>
          <h2>This folder is empty</h2>
          <p>Upload photos and videos here, or drop them anywhere on this page.</p>
        </div>
      )}

      {(dirs.length > 0 || naming) && (
        <>
          <div className="section-label">Folders · {formatCount(dirs.length)}</div>
          <div className="folder-grid">
            {naming && (
              <div className="folder-card folder-draft">
                <IconFolder size={17} />
                <input
                  className="name"
                  type="text"
                  value={newFolder}
                  placeholder="Folder name"
                  maxLength={200}
                  autoFocus
                  disabled={creating}
                  onChange={(event) => setNewFolder(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') void createFolder();
                    if (event.key === 'Escape') setNaming(false);
                  }}
                />
                <button
                  className="btn btn-ghost btn-icon"
                  onClick={() => setNaming(false)}
                  title="Cancel"
                  aria-label="Cancel"
                >
                  <IconClose size={14} />
                </button>
                <button
                  className="btn btn-primary btn-icon"
                  disabled={newFolder.trim() === '' || creating}
                  onClick={() => void createFolder()}
                  title="Create folder"
                  aria-label="Create folder"
                >
                  <IconCheck size={14} />
                </button>
              </div>
            )}
            {dirs.map((dir) => (
              <div className="folder-card" key={dir.path} onClick={() => openFolder(dir.path)}>
                <IconFolder size={17} />
                <span className="name">{dir.name}</span>
                <button
                  className="zip"
                  title="Download this folder as a ZIP"
                  onClick={(event) => {
                    event.stopPropagation();
                    downloadZip([dir.path]);
                    showToast(`Preparing a ZIP of ${dir.name}…`);
                  }}
                >
                  <IconArchive size={15} />
                </button>
              </div>
            ))}
          </div>
        </>
      )}

      {files.length > 0 && (
        <>
          <div className="section-label">Files · {formatCount(files.length)}</div>
          <div className="file-grid">
            {files.map((file) => (
              <FileCard
                key={file.path}
                file={file}
                selected={selected.has(file.path)}
                onToggle={() => toggleSelected(file.path)}
                onOpen={() => {
                  const position = viewableFiles.findIndex((f) => f.path === file.path);
                  if (position >= 0) setOpenIndex(position);
                }}
              />
            ))}
          </div>
        </>
      )}

      {openIndex !== null && folderManifest.count > 0 && (
        <Lightbox
          manifest={folderManifest}
          index={openIndex}
          showMetadataDefault={false}
          onIndexChange={setOpenIndex}
          onClose={() => setOpenIndex(null)}
        />
      )}

      <UploadPanel uploader={uploader} />

      {dragging && (
        <div className="drop-veil">
          <IconUpload size={26} />
          <span>Drop to upload into {currentPath || 'All files'}</span>
        </div>
      )}

      {toast && <div className={`toast${toast.error ? ' error' : ''}`}>{toast.message}</div>}
    </div>
  );
}

interface FileCardProps {
  file: FileEntry;
  selected: boolean;
  onToggle: () => void;
  onOpen: () => void;
}

function FileCard({ file, selected, onToggle, onOpen }: FileCardProps): React.ReactElement {
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const viewable = file.photoId !== null && !failed;

  return (
    <div className={`file-card${selected ? ' selected' : ''}`}>
      <label className="file-check" title="Select for ZIP download">
        <input type="checkbox" checked={selected} onChange={onToggle} />
      </label>

      <div
        className="file-preview"
        onClick={() => viewable && onOpen()}
        style={{ cursor: viewable ? 'pointer' : 'default' }}
      >
        {file.photoId !== null && !failed ? (
          <img
            src={thumbUrl(file.photoId, 320)}
            className={loaded ? 'loaded' : undefined}
            alt=""
            loading="lazy"
            decoding="async"
            draggable={false}
            onLoad={() => setLoaded(true)}
            onError={() => setFailed(true)}
          />
        ) : (
          <span
            className="file-icon"
            title={file.unsupportedImage ? 'This format cannot be previewed' : undefined}
          >
            {file.unsupportedImage ? <IconImage size={30} /> : <IconFile size={30} />}
          </span>
        )}

        {file.video && (
          <div className="thumb-video">
            <IconPlay size={10} />
          </div>
        )}
      </div>

      <div className="file-info">
        <span className="name" title={file.name}>
          {file.name}
        </span>
        <span className="size">{formatBytes(file.size)}</span>
        <a
          className="btn btn-ghost btn-icon"
          href={fileDownloadUrl(file.path)}
          download={file.name}
          title="Download"
          onClick={(event) => event.stopPropagation()}
        >
          <IconDownload size={15} />
        </a>
      </div>
    </div>
  );
}

function buildCrumbs(path: string): { name: string; path: string }[] {
  const crumbs = [{ name: 'All files', path: '' }];
  if (path === '') return crumbs;

  const segments = path.split('/');
  let accumulated = '';
  for (const segment of segments) {
    accumulated = accumulated ? `${accumulated}/${segment}` : segment;
    crumbs.push({ name: segment, path: accumulated });
  }
  return crumbs;
}

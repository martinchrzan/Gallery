import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  api,
  downloadZip,
  fileDownloadUrl,
  thumbUrl,
  type BrowseResult,
  type Manifest,
} from '../api/client';
import {
  IconArchive,
  IconDownload,
  IconFile,
  IconFolder,
  IconImage,
} from '../components/icons';
import { Lightbox } from '../lightbox/Lightbox';
import { formatBytes, formatCount } from '../lib/format';
import { useToast } from '../lib/hooks';
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

  /**
   * A folder-scoped manifest, so the lightbox can arrow through this folder's
   * indexed images using exactly the same component as the gallery.
   */
  const folderManifest: Manifest = useMemo(() => {
    const images = (data?.files ?? []).filter((file) => file.photoId !== null);
    const ids = new Uint32Array(images.length);
    const times = new Uint32Array(images.length);
    const widths = new Uint16Array(images.length);
    const heights = new Uint16Array(images.length);

    images.forEach((file, i) => {
      ids[i] = file.photoId!;
      times[i] = Math.floor(file.modifiedAt / 1000);
      widths[i] = Math.min(65535, file.width ?? 0);
      heights[i] = Math.min(65535, file.height ?? 0);
    });

    return { count: images.length, ids, times, widths, heights };
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
    <div className="files" ref={setScrollEl}>
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
            files.length > 0 && (
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
            )
          )}
        </div>
      </div>

      {dirs.length === 0 && files.length === 0 && (
        <div className="empty" style={{ height: 'auto', paddingTop: 60 }}>
          <h2>This folder is empty</h2>
        </div>
      )}

      {dirs.length > 0 && (
        <>
          <div className="section-label">Folders · {formatCount(dirs.length)}</div>
          <div className="folder-grid">
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

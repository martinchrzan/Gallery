import { useEffect, useState } from 'react';
import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { api, type Settings } from './api/client';
import { FilesView } from './files/FilesView';
import { GalleryView } from './gallery/GalleryView';
import { SettingsView } from './settings/SettingsView';
import { IconImage, IconSettings } from './components/icons';
import { useIndexStatus } from './lib/hooks';
import { formatCount } from './lib/format';

export default function App(): React.ReactElement {
  // Settings live on the server so they follow you between browsers; they are
  // loaded once here and shared with every view.
  const [settings, setSettings] = useState<Settings | null>(null);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const indexStatus = useIndexStatus();

  useEffect(() => {
    const controller = new AbortController();
    api
      .settings(controller.signal)
      .then((next) => !controller.signal.aborted && setSettings(next))
      .catch((err: Error) => !controller.signal.aborted && setSettingsError(err.message));
    return () => controller.abort();
  }, []);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden>
            <IconImage size={16} />
          </span>
          <span>Gallery</span>
        </div>

        <nav className="nav">
          <NavLink to="/" end className={({ isActive }) => (isActive ? 'active' : undefined)}>
            Gallery
          </NavLink>
          <NavLink to="/files" className={({ isActive }) => (isActive ? 'active' : undefined)}>
            Files
          </NavLink>
        </nav>

        <div className="topbar-spacer" />

        {indexStatus?.scanning && (
          <div className="pill" title="Indexing in progress">
            <div className="spinner" />
            {indexStatus.phase === 'walking'
              ? formatCount(indexStatus.discovered)
              : `${formatCount(indexStatus.processed)} / ${formatCount(indexStatus.total)}`}
          </div>
        )}

        <NavLink
          to="/settings"
          className={({ isActive }) => `btn btn-ghost btn-icon${isActive ? ' active' : ''}`}
          title="Settings"
          aria-label="Settings"
        >
          <IconSettings size={17} />
        </NavLink>
      </header>

      <main className="content">
        {settingsError ? (
          <div className="empty">
            <h2>Cannot reach the server</h2>
            <p>{settingsError}</p>
          </div>
        ) : (
          <Routes>
            <Route path="/" element={<GalleryView settings={settings} />} />
            <Route path="/files/*" element={<FilesView />} />
            <Route
              path="/settings"
              element={<SettingsView settings={settings} onSettingsChange={setSettings} />}
            />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        )}
      </main>
    </div>
  );
}

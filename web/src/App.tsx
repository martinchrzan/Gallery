import { useCallback, useEffect, useState } from 'react';
import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import {
  api,
  probeSession,
  setUnauthorizedHandler,
  type Settings,
  type User,
} from './api/client';
import { LoginView } from './auth/LoginView';
import { FilesView } from './files/FilesView';
import { GalleryView } from './gallery/GalleryView';
import { SettingsView } from './settings/SettingsView';
import { IconSettings, IconSignOut } from './components/icons';
import { Logo } from './components/Logo';
import { ThemeToggle } from './components/ThemeToggle';
import { useIndexStatus } from './lib/hooks';
import { formatCount } from './lib/format';
import { useTheme } from './lib/theme';

export default function App(): React.ReactElement {
  // Up here, above every early return, so the sign-in screen follows the
  // device's light or dark switch too — not just the signed-in app.
  const themeState = useTheme();

  // `undefined` while the session is still being probed, `null` once we know
  // nobody is signed in — the two must not be conflated, or the login screen
  // flashes on every reload before the cookie has been checked.
  const [user, setUser] = useState<User | null | undefined>(undefined);
  const [reachable, setReachable] = useState(true);

  // Settings live on the server so they follow you between browsers; they are
  // loaded once here and shared with every view.
  const [settings, setSettings] = useState<Settings | null>(null);
  const [settingsError, setSettingsError] = useState<string | null>(null);

  const isAdmin = user?.role === 'admin';
  const indexStatus = useIndexStatus(isAdmin);

  useEffect(() => {
    const controller = new AbortController();
    probeSession(controller.signal)
      .then((state) => !controller.signal.aborted && setUser(state?.user ?? null))
      .catch(() => {
        if (controller.signal.aborted) return;
        setReachable(false);
        setUser(null);
      });
    return () => controller.abort();
  }, []);

  // A session that expires while the tab is open drops back to the login screen
  // rather than leaving every view stuck on an error.
  useEffect(() => {
    setUnauthorizedHandler(() => {
      setUser(null);
      setSettings(null);
    });
    return () => setUnauthorizedHandler(null);
  }, []);

  useEffect(() => {
    if (!user) return;
    const controller = new AbortController();
    setSettingsError(null);
    api
      .settings(controller.signal)
      .then((next) => !controller.signal.aborted && setSettings(next))
      .catch((err: Error) => !controller.signal.aborted && setSettingsError(err.message));
    return () => controller.abort();
  }, [user]);

  const signOut = useCallback(() => {
    void api.logout().catch(() => {});
    setUser(null);
    setSettings(null);
  }, []);

  if (user === undefined) {
    return (
      <div className="empty">
        <div className="spinner" />
      </div>
    );
  }

  if (!user) {
    if (!reachable) {
      return (
        <div className="empty">
          <h2>Cannot reach the server</h2>
          <p>Check that the gallery is running, then reload.</p>
        </div>
      );
    }
    return (
      <LoginView
        onSignedIn={(state) => {
          setReachable(true);
          setUser(state.user);
        }}
      />
    );
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <Logo size={28} />
          <span className="brand-name">Photo Gallery</span>
        </div>

        {/* A viewer has one destination, so the nav would be a single tab. */}
        {isAdmin && (
          <nav className="nav">
            <NavLink to="/" end className={({ isActive }) => (isActive ? 'active' : undefined)}>
              Gallery
            </NavLink>
            <NavLink to="/files" className={({ isActive }) => (isActive ? 'active' : undefined)}>
              Files
            </NavLink>
          </nav>
        )}

        <div className="topbar-spacer" />

        {indexStatus?.scanning && (
          <div className="pill" title="Indexing in progress">
            <div className="spinner" />
            {indexStatus.phase === 'walking'
              ? formatCount(indexStatus.discovered)
              : `${formatCount(indexStatus.processed)} / ${formatCount(indexStatus.total)}`}
          </div>
        )}

        <span className="who" title={isAdmin ? 'Administrator' : 'Gallery access'}>
          {user.label}
        </span>

        <ThemeToggle {...themeState} />

        {isAdmin && (
          <NavLink
            to="/settings"
            className={({ isActive }) => `btn btn-ghost btn-icon${isActive ? ' active' : ''}`}
            title="Settings"
            aria-label="Settings"
          >
            <IconSettings size={17} />
          </NavLink>
        )}

        <button
          className="btn btn-ghost btn-icon"
          onClick={signOut}
          title="Sign out"
          aria-label="Sign out"
        >
          <IconSignOut size={17} />
        </button>
      </header>

      <main className="content">
        {settingsError ? (
          <div className="empty">
            <h2>Cannot reach the server</h2>
            <p>{settingsError}</p>
          </div>
        ) : (
          <Routes>
            <Route path="/" element={<GalleryView settings={settings} canRepair={isAdmin} />} />
            {/* Not merely hidden: the server refuses these to a viewer too. */}
            {isAdmin && <Route path="/files/*" element={<FilesView />} />}
            {isAdmin && (
              <Route
                path="/settings"
                element={
                  <SettingsView
                    settings={settings}
                    onSettingsChange={setSettings}
                    currentUserId={user.id}
                  />
                }
              />
            )}
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        )}
      </main>
    </div>
  );
}

import { useCallback, useEffect, useState } from 'react';

/** What the person picked. `system` follows the device, and is the default. */
export type ThemePreference = 'system' | 'light' | 'dark';
export type Theme = 'light' | 'dark';

/**
 * Where the choice is kept. Per device rather than on the server: the same
 * person may want dark on a phone in bed and light on a desk monitor, and a
 * viewer — who has no settings page — gets to choose too.
 *
 * public/theme.js reads the same key before the first paint; keep them in step.
 */
const STORAGE_KEY = 'gallery.theme';

const DARK_QUERY = '(prefers-color-scheme: dark)';

function readPreference(): ThemePreference {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved === 'light' || saved === 'dark' ? saved : 'system';
  } catch {
    // Storage can be blocked outright (some private modes); follow the device.
    return 'system';
  }
}

function writePreference(preference: ThemePreference): void {
  try {
    if (preference === 'system') localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, preference);
  } catch {
    // Not remembered, but still applied for as long as the tab is open.
  }
}

/**
 * Puts the theme on <html>, where the stylesheet picks it up, and repaints the
 * browser's own chrome to match — the address bar on Android, and the status
 * bar once the gallery is installed to a home screen.
 */
function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  root.dataset.theme = theme;

  // Read back from the stylesheet so the page colour is defined in one place.
  const background = getComputedStyle(root).getPropertyValue('--bg').trim();
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta && background) meta.setAttribute('content', background);
}

/**
 * The next choice for a single toggle button. From `system` it always flips
 * what is on screen, so the first press is never a no-op; the explicit choice
 * that matches the device comes next, and after that control goes back to the
 * device.
 */
export function nextPreference(preference: ThemePreference, systemTheme: Theme): ThemePreference {
  const opposite: Theme = systemTheme === 'dark' ? 'light' : 'dark';
  if (preference === 'system') return opposite;
  return preference === opposite ? systemTheme : 'system';
}

export interface ThemeState {
  preference: ThemePreference;
  /** What is actually on screen. */
  theme: Theme;
  /** What the device asks for, whatever the preference says. */
  systemTheme: Theme;
  setPreference: (preference: ThemePreference) => void;
}

export function useTheme(): ThemeState {
  const [preference, setPreferenceState] = useState(readPreference);
  const [systemTheme, setSystemTheme] = useState<Theme>(() =>
    window.matchMedia(DARK_QUERY).matches ? 'dark' : 'light',
  );

  // The device can switch on its own schedule — sunset, a battery saver.
  useEffect(() => {
    const query = window.matchMedia(DARK_QUERY);
    const onChange = (): void => setSystemTheme(query.matches ? 'dark' : 'light');
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  // A choice made in another tab applies here too, rather than the two
  // disagreeing until one is reloaded.
  useEffect(() => {
    const onStorage = (event: StorageEvent): void => {
      if (event.key === STORAGE_KEY || event.key === null) setPreferenceState(readPreference());
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const theme: Theme = preference === 'system' ? systemTheme : preference;

  useEffect(() => applyTheme(theme), [theme]);

  const setPreference = useCallback((next: ThemePreference) => {
    setPreferenceState(next);
    writePreference(next);
  }, []);

  return { preference, theme, systemTheme, setPreference };
}

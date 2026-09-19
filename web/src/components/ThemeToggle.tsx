import { nextPreference, type ThemePreference, type ThemeState } from '../lib/theme';
import { IconMoon, IconSun, IconThemeAuto } from './icons';

const NAMES: Record<ThemePreference, string> = {
  system: 'Automatic',
  light: 'Light',
  dark: 'Dark',
};

/**
 * One button that steps through the three choices. The icon shows the current
 * one; the tooltip says what the next press does, since a cycle is only
 * predictable when the next step is spelled out.
 */
export function ThemeToggle({
  preference,
  theme,
  systemTheme,
  setPreference,
}: ThemeState): React.ReactElement {
  const next = nextPreference(preference, systemTheme);
  const current =
    preference === 'system' ? `${NAMES.system} (${NAMES[theme].toLowerCase()})` : NAMES[preference];
  const upcoming = next === 'system' ? 'follow this device' : `switch to ${NAMES[next].toLowerCase()}`;

  return (
    <button
      className="btn btn-ghost btn-icon"
      onClick={() => setPreference(next)}
      title={`Theme: ${current} — click to ${upcoming}`}
      aria-label={`Theme: ${current}`}
    >
      {preference === 'dark' ? (
        <IconMoon size={17} />
      ) : preference === 'light' ? (
        <IconSun size={17} />
      ) : (
        <IconThemeAuto size={17} />
      )}
    </button>
  );
}

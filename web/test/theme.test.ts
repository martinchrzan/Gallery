import { describe, expect, it } from 'vitest';
import { nextPreference, type Theme, type ThemePreference } from '../src/lib/theme';

/** Every preference the toggle visits from `system`, in order, until it returns. */
function cycle(systemTheme: Theme): ThemePreference[] {
  const seen: ThemePreference[] = ['system'];
  let at: ThemePreference = 'system';
  for (let i = 0; i < 5; i++) {
    at = nextPreference(at, systemTheme);
    if (at === 'system') break;
    seen.push(at);
  }
  return seen;
}

describe('nextPreference', () => {
  it('flips what is on screen on the first press, whichever way the device leans', () => {
    expect(nextPreference('system', 'light')).toBe('dark');
    expect(nextPreference('system', 'dark')).toBe('light');
  });

  it('visits all three choices and comes back to the device', () => {
    expect(cycle('light')).toEqual(['system', 'dark', 'light']);
    expect(cycle('dark')).toEqual(['system', 'light', 'dark']);
  });
});

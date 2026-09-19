import { describe, expect, it } from 'vitest';
import {
  formatBytes,
  formatDateTime,
  formatDay,
  formatDimensions,
  formatDuration,
  formatRelative,
  formatShortDate,
} from '../src/lib/format';

describe('formatDuration', () => {
  it('reads like a video player`s scrubber', () => {
    expect(formatDuration(42)).toBe('0:42');
    expect(formatDuration(247)).toBe('4:07');
    expect(formatDuration(3750)).toBe('1:02:30');
    expect(formatDuration(3600)).toBe('1:00:00');
  });

  it('pads seconds and minutes so the badge does not jitter', () => {
    expect(formatDuration(61)).toBe('1:01');
    expect(formatDuration(3661)).toBe('1:01:01');
  });

  it('rounds to the nearest second', () => {
    expect(formatDuration(41.6)).toBe('0:42');
  });

  it('shows nothing rather than 0:00 for a length it does not know', () => {
    // The tile hides the badge entirely on an empty string; `0:00` would claim
    // the clip is empty.
    expect(formatDuration(0)).toBe('');
    expect(formatDuration(-5)).toBe('');
    expect(formatDuration(Number.NaN)).toBe('');
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBe('');
  });
});

describe('formatBytes', () => {
  it('picks the unit a person would use', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
    expect(formatBytes(3.5 * 1024 ** 3)).toBe('3.5 GB');
    expect(formatBytes(2 * 1024 ** 4)).toBe('2.0 TB');
  });

  it('drops the decimal once the number is big enough not to need it', () => {
    expect(formatBytes(150 * 1024)).toBe('150 KB');
    expect(formatBytes(99 * 1024)).toBe('99.0 KB');
  });

  it('never shows a fractional byte', () => {
    expect(formatBytes(1)).toBe('1 B');
    expect(formatBytes(999)).toBe('999 B');
  });

  it('saturates at the largest unit it knows', () => {
    expect(formatBytes(1024 ** 6)).toMatch(/TB$/);
  });

  it('handles nothing at all', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(-1)).toBe('0 B');
    expect(formatBytes(Number.NaN)).toBe('0 B');
  });
});

describe('formatDimensions', () => {
  it('gives pixels and megapixels', () => {
    expect(formatDimensions(4000, 3000)).toBe('4000 × 3000 (12.0 MP)');
    expect(formatDimensions(1920, 1080)).toBe('1920 × 1080 (2.1 MP)');
  });

  it('falls back to a dash when either side is unknown', () => {
    expect(formatDimensions(null, 3000)).toBe('—');
    expect(formatDimensions(4000, null)).toBe('—');
    expect(formatDimensions(0, 0)).toBe('—');
  });
});

describe('formatDay', () => {
  it('labels the undated section', () => {
    expect(formatDay(0)).toBe('Undated');
  });

  it('omits the year for the current year and includes it otherwise', () => {
    const thisYear = new Date();
    thisYear.setMonth(0, 15);
    const current = formatDay(new Date(thisYear.getFullYear(), 0, 15).getTime());
    const old = formatDay(new Date(2019, 0, 15).getTime());

    expect(current).not.toContain(String(thisYear.getFullYear()));
    expect(old).toContain('2019');
  });
});

describe('formatDateTime', () => {
  it('falls back to a dash for a missing timestamp', () => {
    expect(formatDateTime(null)).toBe('—');
    expect(formatDateTime(0)).toBe('—');
  });

  it('renders a real timestamp', () => {
    expect(formatDateTime(new Date(2024, 4, 12, 15, 30).getTime())).toMatch(/2024/);
  });
});

describe('formatRelative', () => {
  const now = new Date(2026, 8, 18, 12, 0).getTime();
  const minutesAgo = (n: number) => now - n * 60_000;

  it('says "just now" inside the first minute', () => {
    expect(formatRelative(minutesAgo(0.4), now)).toBe('just now');
  });

  it('counts minutes, then hours, then days', () => {
    expect(formatRelative(minutesAgo(5), now)).toMatch(/5/);
    expect(formatRelative(minutesAgo(3 * 60), now)).toMatch(/3/);
    expect(formatRelative(minutesAgo(3 * 24 * 60), now)).toMatch(/3/);
  });

  it('gives a date, not a distance, past a week', () => {
    const old = minutesAgo(20 * 24 * 60);
    expect(formatRelative(old, now)).toBe(formatShortDate(old));
  });
});

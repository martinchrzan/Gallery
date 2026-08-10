const dayFormatter = new Intl.DateTimeFormat(undefined, {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
});

const dayWithYearFormatter = new Intl.DateTimeFormat(undefined, {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  year: 'numeric',
});

const dateTimeFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
});

const numberFormatter = new Intl.NumberFormat();

/** Day headings omit the year for the current year, the way phones do. */
export function formatDay(dayStart: number): string {
  if (dayStart === 0) return 'Undated';
  const date = new Date(dayStart);
  return date.getFullYear() === new Date().getFullYear()
    ? dayFormatter.format(date)
    : dayWithYearFormatter.format(date);
}

export function formatDateTime(ms: number | null): string {
  return ms ? dateTimeFormatter.format(new Date(ms)) : '—';
}

export function formatCount(n: number): string {
  return numberFormatter.format(n);
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const exp = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** exp;
  return `${value >= 100 || exp === 0 ? Math.round(value) : value.toFixed(1)} ${units[exp]}`;
}

/**
 * `0:42`, `4:07`, `1:02:30` — the shape a video player uses, so the badge on a
 * tile reads the same as the scrubber that appears when you open it.
 */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  const total = Math.round(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;

  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
    : `${minutes}:${String(secs).padStart(2, '0')}`;
}

export function formatDimensions(width: number | null, height: number | null): string {
  if (!width || !height) return '—';
  const megapixels = (width * height) / 1e6;
  return `${width} × ${height} (${megapixels.toFixed(1)} MP)`;
}

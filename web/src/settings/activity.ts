import type { ActivityReport, Role } from '../api/client';

/** The windows the activity card offers. The server keeps 90 days. */
export const ACTIVITY_RANGES = [7, 30, 90] as const;

/** Start of each local day in the window, oldest first, ending with today. */
export function localDays(count: number, now = Date.now()): number[] {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);

  const days: number[] = [];
  for (let back = count - 1; back >= 0; back--) {
    // Through the calendar rather than 24-hour steps, so a daylight-saving
    // change never lands two days on one date.
    const day = new Date(today);
    day.setDate(today.getDate() - back);
    days.push(day.getTime());
  }
  return days;
}

function startOfDay(ms: number): number {
  const date = new Date(ms);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

export interface PersonActivity {
  id: number;
  label: string;
  role: Role;
  /** Distinct hours of use on each day of the window, in the order of `days`. */
  hoursByDay: number[];
  activeDays: number;
  /** Last use this window saw, falling back to the account's own record. */
  lastAt: number | null;
}

export interface ActivitySummary {
  /** Everyone, most recently active first; people never seen last. */
  people: PersonActivity[];
  activePeople: number;
  activeToday: number;
  devices: number;
  addresses: number;
  /** True when every request so far came from the server's own machine. */
  loopbackOnly: boolean;
}

/**
 * Folds the server's hours into local days. An hour counts once per person
 * however many devices or addresses were busy in it.
 */
export function summarize(report: ActivityReport, days: number[]): ActivitySummary {
  const dayIndex = new Map(days.map((day, index) => [day, index]));
  const people = new Map<number, PersonActivity>(
    report.people.map((person) => [
      person.id,
      {
        id: person.id,
        label: person.label,
        role: person.role,
        hoursByDay: days.map(() => 0),
        activeDays: 0,
        lastAt: person.lastSeenAt,
      },
    ]),
  );

  const counted = new Set<string>();
  const addresses = new Set<string>();
  for (const entry of report.hours) {
    const index = dayIndex.get(startOfDay(entry.hour));
    const person = people.get(entry.userId);
    if (index === undefined || !person) continue;

    addresses.add(entry.ip);
    const key = `${entry.userId}:${entry.hour}`;
    if (counted.has(key)) continue;
    counted.add(key);

    if (person.hoursByDay[index] === 0) person.activeDays++;
    person.hoursByDay[index]!++;
  }

  for (const device of report.devices) {
    const person = people.get(device.userId);
    if (person && device.lastAt > (person.lastAt ?? 0)) person.lastAt = device.lastAt;
  }

  const sorted = [...people.values()].sort(
    (a, b) => (b.lastAt ?? 0) - (a.lastAt ?? 0) || a.label.localeCompare(b.label),
  );
  const last = days.length - 1;

  return {
    people: sorted,
    activePeople: sorted.filter((person) => person.activeDays > 0).length,
    activeToday: sorted.filter((person) => (person.hoursByDay[last] ?? 0) > 0).length,
    devices: report.devices.length,
    addresses: addresses.size,
    loopbackOnly: addresses.size > 0 && [...addresses].every(isLoopback),
  };
}

function isLoopback(ip: string): boolean {
  return ip === '::1' || ip.startsWith('127.');
}

/**
 * Hours of use on a day, binned for the heatmap. A short look at the photos
 * touches one clock hour, so the low end is where the detail matters.
 */
export function activityLevel(hours: number): 0 | 1 | 2 | 3 | 4 {
  if (hours <= 0) return 0;
  if (hours === 1) return 1;
  if (hours === 2) return 2;
  if (hours <= 4) return 3;
  return 4;
}

export const LEVEL_LABELS = ['1 h', '2 h', '3–4 h', '5 h +'] as const;

const SYSTEMS: [RegExp, string][] = [
  [/iPhone/, 'iPhone'],
  // iPadOS 13 and later claims to be a Mac unless asked for the mobile site, so
  // many iPads land in the Mac line below. The browser cannot tell us otherwise.
  [/iPad/, 'iPad'],
  [/Android/, 'Android'],
  [/CrOS/, 'ChromeOS'],
  [/Windows/, 'Windows'],
  [/Macintosh|Mac OS X/, 'Mac'],
  [/Linux/, 'Linux'],
];

/** Order matters: nearly every browser also claims to be Chrome, and Chrome claims to be Safari. */
const BROWSERS: [RegExp, string][] = [
  [/Edg(e|A|iOS)?\//, 'Edge'],
  [/OPR\/|Opera/, 'Opera'],
  [/SamsungBrowser\//, 'Samsung Internet'],
  [/Firefox\/|FxiOS\//, 'Firefox'],
  [/Chrome\/|CriOS\//, 'Chrome'],
  [/Safari\//, 'Safari'],
];

/** `Chrome on Android`, from a user-agent string — a name a person recognises. */
export function describeDevice(userAgent: string): string {
  const ua = userAgent.trim();
  if (!ua) return 'Unknown device';

  const system = SYSTEMS.find(([pattern]) => pattern.test(ua))?.[1];
  const browser = BROWSERS.find(([pattern]) => pattern.test(ua))?.[1];

  if (browser && system) return `${browser} on ${system}`;
  const either = browser ?? system;
  if (either) return either;
  // Not a browser at all — curl, a download manager. Its own name is the best there is.
  return ua.split(/[\s/]/)[0] || 'Unknown device';
}

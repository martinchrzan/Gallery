import { describe, expect, it } from 'vitest';
import type { ActivityReport } from '../src/api/client';
import { activityLevel, describeDevice, localDays, summarize } from '../src/settings/activity';

const HOUR = 60 * 60 * 1000;

/** Noon on a fixed local date, well clear of any midnight. */
const NOW = new Date(2026, 8, 18, 12, 0, 0).getTime();

function at(daysAgo: number, hour: number): number {
  const date = new Date(NOW);
  date.setDate(date.getDate() - daysAgo);
  date.setHours(hour, 0, 0, 0);
  return date.getTime();
}

function report(partial: Partial<ActivityReport>): ActivityReport {
  return {
    since: 0,
    retentionDays: 90,
    people: [
      { id: 1, label: 'Admin', role: 'admin', lastSeenAt: null },
      { id: 2, label: 'Anna', role: 'viewer', lastSeenAt: null },
      { id: 3, label: 'Ben', role: 'viewer', lastSeenAt: null },
    ],
    hours: [],
    devices: [],
    ...partial,
  };
}

describe('localDays', () => {
  it('ends today and runs oldest first', () => {
    const days = localDays(7, NOW);
    expect(days).toHaveLength(7);
    expect(days[6]).toBe(at(0, 0));
    expect(days[0]).toBe(at(6, 0));
  });

  it('lands every day on a local midnight, across a daylight-saving change', () => {
    // Spans the end of summer time in both the EU (late October) and the US
    // (early November), whichever zone the tests run in.
    const days = localDays(30, new Date(2026, 10, 15, 12).getTime());
    for (const day of days) {
      const date = new Date(day);
      expect([date.getHours(), date.getMinutes()]).toEqual([0, 0]);
    }
    expect(new Set(days.map((day) => new Date(day).getDate())).size).toBe(30);
  });
});

describe('summarize', () => {
  const days = localDays(7, NOW);

  it('counts an hour once however many devices were busy in it', () => {
    const summary = summarize(
      report({
        hours: [
          { hour: at(0, 9), userId: 2, device: 'phone', ip: '10.0.0.2' },
          { hour: at(0, 9), userId: 2, device: 'laptop', ip: '10.0.0.3' },
          { hour: at(0, 10), userId: 2, device: 'phone', ip: '10.0.0.2' },
        ],
      }),
      days,
    );

    const anna = summary.people.find((p) => p.id === 2)!;
    expect(anna.hoursByDay[6]).toBe(2);
    expect(anna.activeDays).toBe(1);
    expect(summary.addresses).toBe(2);
  });

  it('puts each hour on its own local day', () => {
    const summary = summarize(
      report({
        hours: [
          { hour: at(1, 23), userId: 2, device: 'phone', ip: '10.0.0.2' },
          { hour: at(0, 0), userId: 2, device: 'phone', ip: '10.0.0.2' },
        ],
      }),
      days,
    );

    const anna = summary.people.find((p) => p.id === 2)!;
    expect(anna.hoursByDay.slice(5)).toEqual([1, 1]);
    expect(anna.activeDays).toBe(2);
  });

  it('ignores hours from before the window', () => {
    const summary = summarize(
      report({ hours: [{ hour: at(30, 9), userId: 2, device: 'phone', ip: '10.0.0.2' }] }),
      days,
    );
    expect(summary.activePeople).toBe(0);
    expect(summary.addresses).toBe(0);
  });

  it('counts who was active today and in the window', () => {
    const summary = summarize(
      report({
        hours: [
          { hour: at(0, 9), userId: 1, device: 'desk', ip: '10.0.0.1' },
          { hour: at(3, 9), userId: 2, device: 'phone', ip: '10.0.0.2' },
        ],
      }),
      days,
    );
    expect(summary.activeToday).toBe(1);
    expect(summary.activePeople).toBe(2);
  });

  it('lists the most recently active first and people never seen last', () => {
    const summary = summarize(
      report({
        people: [
          { id: 1, label: 'Admin', role: 'admin', lastSeenAt: at(40, 9) },
          { id: 2, label: 'Anna', role: 'viewer', lastSeenAt: null },
          { id: 3, label: 'Ben', role: 'viewer', lastSeenAt: null },
        ],
        devices: [
          {
            id: 'phone',
            userId: 3,
            userAgent: '',
            ip: '10.0.0.3',
            ipCount: 1,
            firstAt: at(1, 9),
            lastAt: at(1, 9),
            activeHours: 1,
            signedIn: true,
            current: false,
          },
        ],
      }),
      days,
    );
    expect(summary.people.map((p) => p.label)).toEqual(['Ben', 'Admin', 'Anna']);
  });

  it('notices when every address is the server itself', () => {
    const local = summarize(
      report({ hours: [{ hour: at(0, 9), userId: 1, device: 'desk', ip: '127.0.0.1' }] }),
      days,
    );
    const remote = summarize(
      report({ hours: [{ hour: at(0, 9), userId: 1, device: 'desk', ip: '203.0.113.7' }] }),
      days,
    );
    expect(local.loopbackOnly).toBe(true);
    expect(remote.loopbackOnly).toBe(false);
  });
});

describe('activityLevel', () => {
  it('bins hours of use, with the detail at the low end', () => {
    expect([0, 1, 2, 3, 4, 5, 12].map(activityLevel)).toEqual([0, 1, 2, 3, 3, 4, 4]);
  });
});

describe('describeDevice', () => {
  const cases: [string, string][] = [
    [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
      'Chrome on Windows',
    ],
    [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 Edg/128.0.0.0',
      'Edge on Windows',
    ],
    [
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
      'Safari on iPhone',
    ],
    [
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/128.0 Mobile/15E148 Safari/604.1',
      'Chrome on iPhone',
    ],
    [
      'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36',
      'Samsung Internet on Android',
    ],
    [
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:130.0) Gecko/20100101 Firefox/130.0',
      'Firefox on Mac',
    ],
    [
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 OPR/113.0.0.0',
      'Opera on Linux',
    ],
    ['curl/8.4.0', 'curl'],
    ['', 'Unknown device'],
  ];

  it.each(cases)('names %s', (ua, expected) => {
    expect(describeDevice(ua)).toBe(expected);
  });
});

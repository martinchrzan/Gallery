import { useEffect, useMemo, useState } from 'react';
import { api, type ActivityReport } from '../api/client';
import {
  formatCount,
  formatDateTime,
  formatDay,
  formatRelative,
  formatShortDate,
} from '../lib/format';
import {
  ACTIVITY_RANGES,
  activityLevel,
  describeDevice,
  LEVEL_LABELS,
  localDays,
  summarize,
  type PersonActivity,
} from './activity';

/** Past this many, the device list folds behind a "show all". */
const DEVICES_SHOWN = 8;

interface ActivityPanelProps {
  onError: (message: string) => void;
}

/** A report together with the days it was asked for, so the two never disagree. */
interface Loaded {
  report: ActivityReport;
  days: number[];
}

export function ActivityPanel({ onError }: ActivityPanelProps): React.ReactElement {
  const [range, setRange] = useState<number>(30);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const controller = new AbortController();
    const days = localDays(range);
    setLoading(true);
    api
      .activity(days[0]!, controller.signal)
      .then((report) => {
        if (controller.signal.aborted) return;
        setLoaded({ report, days });
        setLoading(false);
      })
      .catch((err: Error) => {
        if (controller.signal.aborted) return;
        onError(err.message);
        setLoading(false);
      });
    return () => controller.abort();
  }, [range, onError]);

  const summary = useMemo(() => (loaded ? summarize(loaded.report, loaded.days) : null), [loaded]);

  return (
    <section className="card">
      <div className="card-head">
        <div>
          <h2>Activity</h2>
          <p className="hint">
            Who has opened the gallery, on which devices, from which addresses and when. Kept for{' '}
            {loaded?.report.retentionDays ?? 90} days.
          </p>
        </div>
        <select
          aria-label="Period"
          value={range}
          onChange={(event) => setRange(Number(event.target.value))}
        >
          {ACTIVITY_RANGES.map((days) => (
            <option key={days} value={days}>
              Last {days} days
            </option>
          ))}
        </select>
      </div>

      {!loaded || !summary ? (
        <div className="pill">
          <div className="spinner" />
          Loading activity…
        </div>
      ) : (
        // The previous period stays on screen, dimmed, while the next one loads —
        // no spinner, and nothing jumps.
        <div className={`activity${loading ? ' is-refreshing' : ''}`}>
          <div className="stat-grid">
            <div className="stat">
              <div className="value">{formatCount(summary.activeToday)}</div>
              <div className="label">Active today</div>
            </div>
            <div className="stat">
              <div className="value">
                {formatCount(summary.activePeople)}
                <span className="stat-of">/ {formatCount(summary.people.length)}</span>
              </div>
              <div className="label">People active</div>
            </div>
            <div className="stat">
              <div className="value">{formatCount(summary.devices)}</div>
              <div className="label">Devices</div>
            </div>
            <div className="stat">
              <div className="value">{formatCount(summary.addresses)}</div>
              <div className="label">IP addresses</div>
            </div>
          </div>

          {/* Keyed by the period, so a day picked in one never carries its
              column over to a different date in the next. */}
          <Heatmap key={loaded.days.length} people={summary.people} days={loaded.days} />

          {summary.loopbackOnly && (
            <p className="activity-note">
              Every visit so far came from the server’s own machine. If people reach the gallery
              through a tunnel or a reverse proxy, set <code>trustProxy</code> to{' '}
              <code>true</code> so their real addresses are recorded.
            </p>
          )}

          <DeviceList
            devices={loaded.report.devices}
            labels={new Map(loaded.report.people.map((person) => [person.id, person.label]))}
          />
        </div>
      )}
    </section>
  );
}

/* --------------------------------------------------------------- heatmap -- */

interface Cell {
  row: number;
  col: number;
}

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

const ARROWS: Record<string, [number, number]> = {
  ArrowUp: [-1, 0],
  ArrowDown: [1, 0],
  ArrowLeft: [0, -1],
  ArrowRight: [0, 1],
};

/**
 * One row per person, one cell per day, darker for more hours of use. The
 * readout under it names the day under the pointer — or under the arrow keys,
 * so it can be read without a mouse.
 */
function Heatmap({ people, days }: { people: PersonActivity[]; days: number[] }): React.ReactElement {
  const [focus, setFocus] = useState<Cell | null>(null);
  const last = days.length - 1;

  // The whole strip is the hit target, gaps included: at 90 days a cell is a
  // few pixels wide, and nobody should have to land on one exactly.
  const pick = (row: number, event: React.PointerEvent<HTMLDivElement>): void => {
    const box = event.currentTarget.getBoundingClientRect();
    const col = Math.floor(((event.clientX - box.left) / box.width) * days.length);
    setFocus({ row, col: clamp(col, 0, last) });
  };

  const onKeyDown = (event: React.KeyboardEvent): void => {
    const move = ARROWS[event.key];
    if (!move) return;
    event.preventDefault();
    const at = focus ?? { row: 0, col: last };
    setFocus({
      row: clamp(at.row + move[0], 0, people.length - 1),
      col: clamp(at.col + move[1], 0, last),
    });
  };

  const person = focus ? people[focus.row] : undefined;
  const hours = focus && person ? (person.hoursByDay[focus.col] ?? 0) : 0;

  return (
    <div className="heatmap">
      <div
        className="heatmap-grid"
        tabIndex={0}
        role="group"
        aria-label="Days each person used the gallery. Use the arrow keys to read a day."
        onKeyDown={onKeyDown}
        onFocus={() => setFocus((at) => at ?? { row: 0, col: last })}
        onBlur={() => setFocus(null)}
        // A touch lifts the pointer as soon as it lands, so only a mouse
        // leaving clears the readout; a tapped day stays read out.
        onPointerLeave={(event) => event.pointerType === 'mouse' && setFocus(null)}
      >
        {people.map((row, index) => (
          <div key={row.id} className="heatmap-row">
            <div className="heatmap-name" title={row.label}>
              {row.label}
            </div>
            <div
              className={`heatmap-cells${days.length > 45 ? ' dense' : ''}`}
              style={{ gridTemplateColumns: `repeat(${days.length}, minmax(0, 1fr))` }}
              onPointerMove={(event) => pick(index, event)}
              onPointerDown={(event) => pick(index, event)}
            >
              {row.hoursByDay.map((dayHours, col) => (
                <span
                  key={days[col]}
                  className={`heat-cell heat-${activityLevel(dayHours)}${
                    focus?.row === index && focus.col === col ? ' focused' : ''
                  }`}
                />
              ))}
            </div>
            <div className="heatmap-total">
              {row.activeDays > 0
                ? `${formatCount(row.activeDays)} day${row.activeDays === 1 ? '' : 's'}`
                : row.lastAt
                  ? `last ${formatShortDate(row.lastAt)}`
                  : 'never'}
            </div>
          </div>
        ))}

        <div className="heatmap-row heatmap-axis" aria-hidden="true">
          <div className="heatmap-name" />
          <div className="heatmap-axis-labels">
            <span>{formatShortDate(days[0]!)}</span>
            <span>Today</span>
          </div>
          <div className="heatmap-total" />
        </div>
      </div>

      <div className="heatmap-foot">
        <div className="heatmap-readout" aria-live="polite">
          {focus && person ? (
            <>
              <strong>{hours > 0 ? `${hours} h` : 'Not active'}</strong>
              {person.label} · {formatDay(days[focus.col]!)}
            </>
          ) : (
            'Point at a day to read it'
          )}
        </div>
        <div className="heatmap-legend" aria-hidden="true">
          {LEVEL_LABELS.map((label, index) => (
            <span key={label} className="legend-item">
              <span className={`heat-cell heat-${index + 1}`} />
              {label}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- devices -- */

function DeviceList({
  devices,
  labels,
}: {
  devices: ActivityReport['devices'];
  labels: Map<number, string>;
}): React.ReactElement {
  const [all, setAll] = useState(false);
  const shown = all ? devices : devices.slice(0, DEVICES_SHOWN);

  return (
    <div className="activity-devices">
      <h3>Devices</h3>
      <p className="activity-sub">
        Each browser someone signed in on. Signing in again starts a new one; to cut a device
        off, give its owner a new code.
      </p>

      <div className="user-list">
        {shown.map((device) => {
          const others = device.ipCount - 1;
          return (
            <div key={device.id} className="user-row">
              <div className="user-main">
                <div className="user-name">
                  {describeDevice(device.userAgent)}
                  {device.current && <span className="chip">This device</span>}
                  {!device.signedIn && <span className="chip chip-quiet">Signed out</span>}
                </div>
                <div className="user-meta" title={device.userAgent}>
                  {labels.get(device.userId) ?? '—'} · {device.ip}
                  {others > 0 && ` and ${others} other address${others === 1 ? '' : 'es'}`}
                  {' · '}
                  {formatCount(device.activeHours)} h in this period
                </div>
              </div>
              <div className="device-when" title={formatDateTime(device.lastAt)}>
                {formatRelative(device.lastAt)}
              </div>
            </div>
          );
        })}
      </div>

      {devices.length > DEVICES_SHOWN && (
        <button className="btn btn-ghost" onClick={() => setAll(!all)}>
          {all ? 'Show fewer' : `Show all ${formatCount(devices.length)}`}
        </button>
      )}
    </div>
  );
}

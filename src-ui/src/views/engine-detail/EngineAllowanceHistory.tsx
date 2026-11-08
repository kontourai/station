import type { EngineAccountUsageHistory } from '@kontourai/station-contracts/engine-accounts';
import { useState } from 'react';
import { Button } from '../../components/Button';
import { remainingPercentText } from '../../components/resource-hub/Meter';
import { Empty } from '../../components/state';
import '../EngineAccountOverview.css';

const percentFormatter = new Intl.NumberFormat(undefined, {
  maximumFractionDigits: 1,
});
function historyWindowKey(
  window: EngineAccountUsageHistory['observations'][number]['windows'][number],
): string {
  return JSON.stringify([
    window.id,
    window.label,
    window.durationSeconds ?? null,
  ]);
}
function historyDuration(seconds: number | undefined): string {
  if (seconds === undefined) return 'duration unknown';
  const [value, unit]: [number, string] =
    seconds >= 86400
      ? [seconds / 86400, 'd']
      : seconds >= 3600
        ? [seconds / 3600, 'h']
        : seconds >= 60
          ? [seconds / 60, 'm']
          : [seconds, 's'];
  return `${percentFormatter.format(value)}${unit}`;
}
/**
 * An account's allowance over the period, from the hourly observations the
 * host keeps. A gap is an unreported observation, never 0% left.
 */
export function EngineAllowanceHistory({
  history,
  days,
  now,
}: {
  history: EngineAccountUsageHistory;
  days: 7 | 30;
  now: number;
}) {
  const [selected, setSelected] = useState('');
  const [tableOpen, setTableOpen] = useState(false);
  const [visibleCount, setVisibleCount] = useState(50);
  const points = history.observations.filter(
    (point) => Date.parse(point.fetchedAt) >= now - days * 86400000,
  );
  const windows = new Map(
    [...points]
      .reverse()
      .flatMap((point) =>
        point.windows.map(
          (window) => [historyWindowKey(window), window] as const,
        ),
      ),
  );
  const labelCounts = new Map<string, number>();
  for (const window of windows.values())
    labelCounts.set(window.label, (labelCounts.get(window.label) ?? 0) + 1);
  const labels = new Map(
    [...windows].map(
      ([key, window]) =>
        [
          key,
          (labelCounts.get(window.label) ?? 0) > 1
            ? `${window.label} · ${historyDuration(window.durationSeconds)}`
            : window.label,
        ] as const,
    ),
  );
  const optionCounts = new Map<string, number>();
  for (const label of labels.values())
    optionCounts.set(label, (optionCounts.get(label) ?? 0) + 1);
  for (const [index, [key, label]] of [...labels].entries())
    if ((optionCounts.get(label) ?? 0) > 1)
      labels.set(key, `${label} · series ${index + 1}`);
  const id = windows.has(selected) ? selected : windows.keys().next().value;
  const observations = points.map((point) => ({
    fetchedAt: point.fetchedAt,
    window:
      point.status === 'ok'
        ? point.windows.find((window) => historyWindowKey(window) === id)
        : undefined,
  }));
  return (
    <section
      className="engine-account-overview__activity"
      aria-label="Allowance history"
    >
      <div className="engine-account-overview__activity-heading">
        <h3>Allowance history</h3>
        {windows.size > 0 && (
          <label>
            Limit
            <select
              value={id}
              onChange={(event) => setSelected(event.target.value)}
            >
              {[...labels].map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      {history.status === 'unavailable' ? (
        <p role="status">
          History could not be saved. Current limits are still available.
        </p>
      ) : !observations.length ? (
        <Empty
          variant="compact"
          label="History starts here"
          description="Refresh this account to capture allowance observations."
        />
      ) : (
        <>
          <figure>
            <figcaption>
              {labels.get(id ?? '') ?? 'Allowance'} · remaining at each
              observation · {days} days
            </figcaption>
            <svg
              className="engine-account-overview__history-chart"
              viewBox={`0 0 ${Math.max(1, observations.length)} 100`}
              preserveAspectRatio="none"
              role="img"
              aria-label={`${labels.get(id ?? '') ?? 'Allowance'} remaining history, ${observations.length} hourly observations`}
            >
              {observations.map((point, index) => {
                const remaining = point.window
                  ? 100 - point.window.usedPercent
                  : 0;
                return (
                  <rect
                    key={point.fetchedAt}
                    x={index}
                    y={100 - Math.max(2, remaining)}
                    width={0.8}
                    height={Math.max(2, remaining)}
                    data-unreported={!point.window || undefined}
                  >
                    <title>{`${new Date(point.fetchedAt).toLocaleString()}: ${point.window ? `${remainingPercentText(point.window.usedPercent)}% remaining` : 'Not reported'}`}</title>
                  </rect>
                );
              })}
            </svg>
            <div className="engine-account-overview__axis">
              <span>
                {new Date(observations[0]!.fetchedAt).toLocaleDateString()}
              </span>
              <span>
                {new Date(observations.at(-1)!.fetchedAt).toLocaleDateString()}
              </span>
            </div>
          </figure>
          <details onToggle={(event) => setTableOpen(event.currentTarget.open)}>
            <summary>View observations</summary>
            {tableOpen && (
              <div className="engine-account-overview__history-table">
                <table>
                  <caption>
                    Last {history.retentionDays} days at capture. Gaps are
                    unreported; closed profiles are not automatically purged.
                  </caption>
                  <thead>
                    <tr>
                      <th>Observed</th>
                      <th>Remaining</th>
                      <th>Reset</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...observations]
                      .reverse()
                      .slice(0, visibleCount)
                      .map((point) => (
                        <tr key={point.fetchedAt}>
                          <td>{new Date(point.fetchedAt).toLocaleString()}</td>
                          <td>
                            {point.window
                              ? `${remainingPercentText(point.window.usedPercent)}%`
                              : 'Not reported'}
                          </td>
                          <td>
                            {point.window?.resetsAt
                              ? new Date(point.window.resetsAt).toLocaleString()
                              : 'Not reported'}
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
                {visibleCount < observations.length && (
                  <Button
                    onClick={() => setVisibleCount((count) => count + 50)}
                  >
                    Show older observations
                  </Button>
                )}
              </div>
            )}
          </details>
        </>
      )}
      <small>Hourly snapshots · captured on page refresh</small>
    </section>
  );
}

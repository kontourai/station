import { MS_PER_DAY } from '@kontourai/station-contracts/time';
import { useActivityUsageQuery } from '@kontourai/station-sdk';
import { useState } from 'react';
import './ActivityTimeline.css';
import { describeReadFailure, ErrorState, SkeletonBlock } from './state';

const AGENT_COLORS = [
  'var(--accent-primary)',
  '#a78bfa',
  '#f59e0b',
  '#22c55e',
  '#06b6d4',
  '#f472b6',
  '#fb923c',
];

function fmt(d: Date) {
  return d.toISOString().split('T')[0];
}
function shortAgent(a: string) {
  return a.startsWith('kiro-') ? a.slice(5) : a.split(':').pop() || a;
}

export function ActivityTimeline() {
  const [fromDate, setFromDate] = useState(() =>
    fmt(new Date(Date.now() - 13 * MS_PER_DAY)),
  );
  const [toDate, setToDate] = useState(() => fmt(new Date()));
  const [hoverDate, setHoverDate] = useState<string | null>(null);

  const {
    data,
    isLoading: loading,
    isError,
    error,
    refetch,
  } = useActivityUsageQuery(fromDate, toDate);

  // station#771: this used to fall straight through to `!data?.byDate` on a
  // settled error, so a failed read vanished — no chart, no message, no
  // console trace. Cached data from a prior successful load still renders
  // (never blank a working page on a refetch failure).
  if (loading && !data)
    return <SkeletonBlock count={1} label="Loading activity" />;
  if (isError && !data) {
    return (
      <ErrorState
        title="Could not load activity"
        description={describeReadFailure(error)}
        action={
          <button type="button" onClick={() => refetch()}>
            Retry
          </button>
        }
      />
    );
  }
  if (!data?.byDate) return null;

  const dates: string[] = [];
  const d = new Date(fromDate);
  const end = new Date(toDate);
  while (d <= end) {
    dates.push(fmt(d));
    d.setDate(d.getDate() + 1);
  }

  const agentSet = new Set<string>();
  for (const day of Object.values(data.byDate) as Array<{
    byAgent: Record<string, number>;
  }>) {
    for (const a of Object.keys(day.byAgent)) agentSet.add(a);
  }
  const agents = Array.from(agentSet);
  const agentColorMap: Record<string, string> = {};
  agents.forEach((a, i) => {
    agentColorMap[a] = AGENT_COLORS[i % AGENT_COLORS.length];
  });

  const maxMessages = Math.max(
    1,
    ...dates.map((d) => data.byDate[d]?.messages || 0),
  );
  const hoverDay = hoverDate ? data.byDate[hoverDate] : null;

  return (
    <div>
      {/* Date range picker */}
      <div className="timeline-date-picker">
        <label className="timeline-label" htmlFor="timeline-from-date">
          From:
        </label>
        <input
          id="timeline-from-date"
          type="date"
          value={fromDate}
          onChange={(e) => setFromDate(e.target.value)}
          className="timeline-date-input"
        />
        <label className="timeline-label" htmlFor="timeline-to-date">
          To:
        </label>
        <input
          id="timeline-to-date"
          type="date"
          value={toDate}
          onChange={(e) => setToDate(e.target.value)}
          className="timeline-date-input"
        />
      </div>

      {/* Summary bar */}
      {(() => {
        const rs = data.rangeSummary;
        const streak = data.lifetime?.streak ?? 0;
        return (
          <div className="timeline-summary">
            <span>
              Current Streak: <strong>{streak} days</strong>
            </span>
            <span>
              Days Active:{' '}
              <strong>
                {rs?.activeDays ?? 0}/{rs?.totalDays ?? dates.length}
              </strong>
            </span>
            <span>
              Total:{' '}
              <strong>{(rs?.totalMessages ?? 0).toLocaleString()} msgs</strong>
            </span>
            <span>
              Avg/Day: <strong>{(rs?.avgPerDay ?? 0).toFixed(1)} msgs</strong>
            </span>
            {(rs?.totalCost ?? 0) > 0 && (
              <span>
                Cost: <strong>${rs.totalCost.toFixed(2)}</strong>
              </span>
            )}
          </div>
        );
      })()}

      {/* Chart + hover detail */}
      <div className="timeline-chart-wrap">
        {/* Hover tooltip */}
        {hoverDate && hoverDay && (
          <div data-testid="chart-tooltip" className="timeline-tooltip">
            <div className="timeline-tooltip-date">
              {new Date(`${hoverDate}T12:00:00`).toLocaleDateString(undefined, {
                weekday: 'short',
                month: 'short',
                day: 'numeric',
              })}
            </div>
            <div className="timeline-tooltip-stats">
              ({hoverDay.messages} messages · ${(hoverDay.cost ?? 0).toFixed(2)}
              )
            </div>
            {Object.entries(hoverDay.byAgent)
              .sort(([, a], [, b]) => (b as number) - (a as number))
              .map(([agent, count]: [string, unknown]) => (
                <div key={agent} className="timeline-tooltip-agent">
                  <span
                    className="timeline-agent-dot"
                    style={{ background: agentColorMap[agent] }}
                  />
                  <span className="timeline-tooltip-agent-name">
                    {shortAgent(agent)}
                  </span>
                  <span className="timeline-tooltip-agent-count">
                    {count as number}
                  </span>
                </div>
              ))}
          </div>
        )}

        {/* Stacked bar chart */}
        <div className="timeline-bars-container">
          {/* Y-axis labels */}
          <div className="timeline-y-axis">
            <span>{maxMessages}</span>
            <span>{Math.round(maxMessages / 2)}</span>
            <span>0</span>
          </div>
          {/* Bars */}
          <div className="timeline-bars">
            {dates.map((date) => {
              const day = data.byDate[date];
              const isHovered = date === hoverDate;
              const totalH =
                day && day.messages > 0
                  ? (day.messages / maxMessages) * 100
                  : 0;
              return (
                <div
                  key={date}
                  data-testid={`chart-col-${date}`}
                  className="timeline-bar-col"
                >
                  <div
                    data-testid={`chart-hover-${date}`}
                    onPointerEnter={() => setHoverDate(date)}
                    onPointerLeave={() => setHoverDate(null)}
                    className="timeline-bar-hover-target"
                  />
                  <div
                    className="timeline-bar-visual"
                    style={{
                      height: totalH > 0 ? `${totalH}%` : '2px',
                      opacity: hoverDate && !isHovered ? 0.4 : 1,
                    }}
                  >
                    {totalH > 0 ? (
                      <div className="timeline-bar-stack">
                        {agents.map((agent) => {
                          const count = day!.byAgent[agent] || 0;
                          if (!count) return null;
                          const pct = (count / day!.messages) * 100;
                          return (
                            <div
                              key={agent}
                              style={{
                                height: `${pct}%`,
                                minHeight: 2,
                                background: agentColorMap[agent],
                              }}
                            />
                          );
                        })}
                      </div>
                    ) : (
                      <div className="timeline-bar-empty" />
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* X-axis labels */}
      <div className="timeline-x-axis">
        {dates.map((date, i) => (
          <div key={date} className="timeline-x-label">
            {i % Math.max(1, Math.floor(dates.length / 7)) === 0
              ? date.slice(5)
              : ''}
          </div>
        ))}
      </div>

      {/* Legend */}
      <div className="timeline-legend">
        {agents.map((agent) => (
          <span key={agent} className="timeline-legend-item">
            <span
              className="timeline-legend-swatch"
              style={{ background: agentColorMap[agent] }}
            />
            {shortAgent(agent)}
          </span>
        ))}
      </div>
    </div>
  );
}

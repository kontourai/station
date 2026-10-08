import { K, OP, SPAN } from '@shared/monitoring-keys';
import { useState } from 'react';
import { Button } from '../../components/Button';
import { Empty, ErrorState } from '../../components/state';
import type { MonitoringEvent } from '../../contexts/MonitoringContext';

function percentile(values: number[], percentile: number) {
  return values[Math.max(0, Math.ceil(values.length * percentile) - 1)];
}

export function ToolLatencyPanel({
  events,
  isLoading,
  readError,
  truncated,
  onRetry,
}: {
  events: MonitoringEvent[];
  isLoading: boolean;
  readError: unknown;
  truncated?: boolean;
  onRetry: () => void;
}) {
  const [sort, setSort] = useState<'p95' | 'count'>('p95');
  const groups = new Map<
    string,
    {
      tool: string;
      durations: number[];
      results: number;
      errors: number;
      unreported: number;
    }
  >();
  for (const event of events) {
    if (event[K.OP_NAME] !== OP.EXECUTE_TOOL || event[K.SPAN_KIND] !== SPAN.END)
      continue;
    const reportedTool = event[K.TOOL_NAME];
    const tool =
      typeof reportedTool === 'string' ? reportedTool : 'Unnamed tool';
    const group = groups.get(tool) ?? {
      tool,
      durations: [],
      results: 0,
      errors: 0,
      unreported: 0,
    };
    group.results += 1;
    const duration = event[K.TOOL_DURATION_MS];
    if (
      typeof duration === 'number' &&
      Number.isFinite(duration) &&
      duration >= 0
    )
      group.durations.push(duration);
    if (event[K.TOOL_CALL_OUTCOME] === 'error') group.errors += 1;
    if (event[K.TOOL_CALL_OUTCOME] === undefined) group.unreported += 1;
    groups.set(tool, group);
  }
  const rows = [...groups.values()]
    .map((row) => {
      row.durations.sort((a, b) => a - b);
      return {
        ...row,
        p50: percentile(row.durations, 0.5),
        p95: percentile(row.durations, 0.95),
      };
    })
    .sort((a, b) =>
      sort === 'count' ? b.results - a.results : (b.p95 ?? -1) - (a.p95 ?? -1),
    );
  const ms = (value: number | undefined) =>
    value === undefined ? 'Not reported' : `${value.toLocaleString()} ms`;
  return (
    <section className="monitoring-page__scroll" aria-label="Tool latency">
      <div className="developer-tab__header-row">
        <h2>Tool latency</h2>
        <label>
          Sort by
          <select
            className="editor-select"
            value={sort}
            onChange={(event) =>
              setSort(event.target.value === 'count' ? 'count' : 'p95')
            }
          >
            <option value="p95">Slowest p95</option>
            <option value="count">Most results</option>
          </select>
        </label>
      </div>
      <p className="developer-tab__hint">
        Measured tool results in the loaded event window, using the current
        search and filters. p50 and p95 describe reported durations only.
      </p>
      {(truncated || !!readError) && (
        <p role="status">
          Partial event history. These figures do not cover all work in the
          selected period.
        </p>
      )}
      {!!readError && (
        <ErrorState
          variant="compact"
          title="Event history could not be read"
          action={
            <Button size="sm" onClick={onRetry}>
              Retry
            </Button>
          }
        />
      )}
      {!rows.length ? (
        <Empty
          variant="compact"
          label={
            isLoading
              ? 'Reading tool results…'
              : 'No tool results in the loaded window'
          }
        />
      ) : (
        <div className="diagnostic-table-scroll">
          <table className="diagnostic-table">
            <thead>
              <tr>
                <th>Tool</th>
                <th>Results</th>
                <th>Timed</th>
                <th>p50</th>
                <th>p95</th>
                <th>Reported errors</th>
                <th>Outcome unreported</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.tool}>
                  <th scope="row">{row.tool}</th>
                  <td>{row.results}</td>
                  <td>{row.durations.length}</td>
                  <td>{ms(row.p50)}</td>
                  <td>{ms(row.p95)}</td>
                  <td>{row.errors}</td>
                  <td>{row.unreported}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

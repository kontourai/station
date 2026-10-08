import { useResourcePostureForApiBaseQuery } from '@kontourai/station-sdk/resource-posture';
import { useEffect, useState } from 'react';
import { Button } from '../../components/Button';
import { Empty, ErrorState } from '../../components/state';

type Sample = { at: number; cpu?: number; memory?: number };

function bytes(value: number | undefined) {
  return value === undefined
    ? 'Not reported'
    : `${(value / 1024 ** 2).toLocaleString(undefined, { maximumFractionDigits: 0 })} MiB`;
}

export function SystemPerformance({ apiBase }: { apiBase: string }) {
  const query = useResourcePostureForApiBaseQuery(apiBase, {
    refetchInterval: 5_000,
  });
  const [resource, setResource] = useState<'cpu' | 'memory'>('cpu');
  const [history, setHistory] = useState<Sample[]>([]);
  const data = query.data;
  useEffect(() => {
    if (!data || query.isError) return;
    const at = data.resources?.sampledAt ?? data.sampledAt;
    if (at === null || at === undefined) return;
    const memory = data.resources?.memory;
    setHistory((previous) => {
      if (previous.at(-1)?.at === at) return previous;
      return [
        ...previous,
        {
          at,
          cpu: data.busyPercent,
          memory:
            memory && memory.totalBytes > 0
              ? (100 * (memory.totalBytes - memory.freeBytes)) /
                memory.totalBytes
              : undefined,
        },
      ].slice(-60);
    });
  }, [data, query.isError]);
  const samples = history.filter((sample) => sample[resource] !== undefined);
  const points = samples
    .map(
      (sample, index) =>
        `${samples.length > 1 ? (index * 600) / (samples.length - 1) : 0},${120 - Math.min(100, Math.max(0, sample[resource] ?? 0)) * 1.2}`,
    )
    .join(' ');
  return (
    <section className="system-tab__card" aria-label="Host performance">
      <h2>Host performance</h2>
      <p className="system-tab__muted">
        Samples from the connected Station host. This chart retains up to 60
        samples during this visit.
      </p>
      {query.isError && (
        <ErrorState
          variant="compact"
          title="Resource refresh failed"
          description="Previously received samples remain visible."
          action={
            <Button size="sm" onClick={() => void query.refetch()}>
              Retry
            </Button>
          }
        />
      )}
      <div className="developer-tab__controls">
        <label>
          Resource
          <select
            className="editor-select"
            value={resource}
            onChange={(event) =>
              setResource(event.target.value === 'memory' ? 'memory' : 'cpu')
            }
          >
            <option value="cpu">CPU busy</option>
            <option value="memory">Host memory used</option>
          </select>
        </label>
      </div>
      {samples.length > 1 ? (
        <svg
          className="system-performance__chart"
          viewBox="0 0 600 120"
          role="img"
          aria-label={`${resource === 'cpu' ? 'CPU busy' : 'Host memory used'} percentage across ${samples.length} received samples`}
        >
          <title>Percentage · full scale 100%</title>
          <polyline
            points={points}
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          />
        </svg>
      ) : (
        <Empty
          variant="compact"
          label={
            query.isLoading ? 'Reading resources…' : 'Waiting for chart samples'
          }
          description="Unreported measurements are not drawn as zero."
        />
      )}
      <dl className="system-tab__facts">
        <div>
          <dt>CPU busy</dt>
          <dd>
            {data?.busyPercent === undefined
              ? 'Not reported'
              : `${data.busyPercent}%`}
          </dd>
        </div>
        <div>
          <dt>Logical CPUs</dt>
          <dd>{data?.cpuCount ?? 'Not reported'}</dd>
        </div>
        <div>
          <dt>Host memory total</dt>
          <dd>{bytes(data?.resources?.memory.totalBytes)}</dd>
        </div>
        <div>
          <dt>Host memory free</dt>
          <dd>{bytes(data?.resources?.memory.freeBytes)}</dd>
        </div>
        <div>
          <dt>Station process memory (RSS)</dt>
          <dd>{bytes(data?.resources?.process.rssBytes)}</dd>
        </div>
        <div>
          <dt>JavaScript heap used</dt>
          <dd>{bytes(data?.resources?.process.heapUsedBytes)}</dd>
        </div>
        <div>
          <dt>Process ID</dt>
          <dd>{data?.resources?.process.pid ?? 'Not reported'}</dd>
        </div>
        <div>
          <dt>Last resource observation</dt>
          <dd>
            {data?.resources
              ? new Date(data.resources.sampledAt).toLocaleTimeString()
              : 'Not reported'}
          </dd>
        </div>
      </dl>
    </section>
  );
}

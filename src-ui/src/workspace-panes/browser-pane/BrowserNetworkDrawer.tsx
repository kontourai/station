import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Button } from '../../components/Button';
import { Empty, ErrorState, SkeletonBlock } from '../../components/state';
import { BrowserApiError, type BrowserPaneApi } from './browserPaneApi';

export function BrowserNetworkDrawer({
  api,
  apiBase,
  browserSessionId,
}: {
  api: BrowserPaneApi;
  apiBase: string;
  browserSessionId: string;
}) {
  const [filter, setFilter] = useState<'all' | 'failed' | 'xhr'>('all');
  const read = useQuery({
    queryKey: ['browser-network', apiBase, browserSessionId],
    queryFn: async ({ signal }) => {
      let after = 0;
      let generation: number | undefined;
      const entries = [];
      let dropped = 0;
      for (let page = 0; page < 5; page++) {
        const next = await api.network(browserSessionId, after, signal);
        if (generation !== undefined && generation !== next.generation)
          throw new Error('The browser changed while loading diagnostics.');
        generation = next.generation;
        dropped = next.dropped;
        entries.push(...next.entries);
        if (next.entries.length < 100) break;
        after = next.entries[next.entries.length - 1]!.seq;
      }
      return { entries, dropped };
    },
    refetchInterval: 1000,
    retry: false,
  });
  const shown = (read.data?.entries ?? []).filter(
    (entry) =>
      filter === 'all' ||
      (filter === 'failed'
        ? entry.failed || (entry.status ?? 0) >= 400
        : entry.type === 'XHR' || entry.type === 'Fetch'),
  );
  return (
    <section className="browser-pane__console" aria-label="Network diagnostics">
      <label>
        Requests{' '}
        <select
          value={filter}
          onChange={(event) => setFilter(event.target.value as typeof filter)}
        >
          <option value="all">All</option>
          <option value="failed">Failed</option>
          <option value="xhr">XHR / Fetch</option>
        </select>
      </label>
      {read.isPending ? (
        <SkeletonBlock label="Loading network requests" />
      ) : read.isError ? (
        <ErrorState
          title="Network diagnostics unavailable"
          description={
            read.error instanceof BrowserApiError && read.error.status === 404
              ? 'This Station may need an update to support network diagnostics.'
              : undefined
          }
          action={<Button onClick={() => void read.refetch()}>Retry</Button>}
        />
      ) : shown.length === 0 ? (
        <Empty label="No matching requests" />
      ) : (
        <ol>
          {shown.map((entry) => (
            <li key={entry.seq}>
              {entry.method} {entry.url} ·{' '}
              {entry.failed ? 'Failed' : (entry.status ?? 'Pending')} ·{' '}
              {entry.type}
              {entry.bytes !== undefined ? ` · ${entry.bytes} B` : ''}
              {entry.durationMs !== undefined
                ? ` · ${Math.round(entry.durationMs)} ms`
                : ''}
            </li>
          ))}
        </ol>
      )}
      {read.data?.dropped ? (
        <p>{read.data.dropped} older requests discarded.</p>
      ) : null}
    </section>
  );
}

import type { BrowserNetworkEntryView } from '@kontourai/station-contracts/workspace-browser-pane';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Button } from '../../components/Button';
import { Empty, ErrorState, SkeletonBlock } from '../../components/state';
import { BrowserApiError, type BrowserPaneApi } from './browserPaneApi';

export function BrowserNetworkDrawer({
  api,
  apiBase,
  browserSessionId,
  generation,
  live,
}: {
  api: BrowserPaneApi;
  apiBase: string;
  browserSessionId: string;
  generation: number;
  live: boolean;
}) {
  const [filter, setFilter] = useState<'all' | 'failed' | 'xhr'>('all');
  const queryClient = useQueryClient();
  const queryKey = [
    'browser-network',
    apiBase,
    browserSessionId,
    generation,
  ] as const;
  const read = useQuery({
    queryKey,
    queryFn: async ({ signal }) => {
      const previous = queryClient.getQueryData<{
        entries: BrowserNetworkEntryView[];
        dropped: number;
        cursor: number;
      }>(queryKey);
      let after = previous?.cursor ?? 0;
      const entries = new Map(
        (previous?.entries ?? []).map((entry) => [
          entry.requestSeq ?? entry.seq,
          entry,
        ]),
      );
      let dropped = previous?.dropped ?? 0;
      for (let page = 0; page < 5; page++) {
        const next = await api.network(browserSessionId, after, signal);
        if (generation !== next.generation)
          throw new Error('The browser changed while loading diagnostics.');
        dropped = next.dropped;
        for (const entry of next.entries)
          entries.set(entry.requestSeq ?? entry.seq, entry);
        if (next.entries.length < 100) {
          after = next.latestSeq;
          break;
        }
        after = next.entries[next.entries.length - 1]!.seq;
      }
      return {
        entries: [...entries.values()]
          .sort((a, b) => a.seq - b.seq)
          .slice(-500),
        dropped,
        cursor: after,
      };
    },
    enabled: live,
    gcTime: 0,
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
      {!live ? (
        <Empty label="Browser is not running" />
      ) : read.isPending ? (
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
        <Empty label="Nothing to show" />
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
      {live && read.data?.dropped ? (
        <p>{read.data.dropped} older requests discarded.</p>
      ) : null}
    </section>
  );
}

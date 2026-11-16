import type { OrchestrationSequencedEvent } from '@kontourai/station-contracts/orchestration';
import {
  fetchRemoteSessionHistory,
  readRemoteSessionHistoryCapability,
} from '@kontourai/station-sdk';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useMemo, useSyncExternalStore } from 'react';
import { useApiBase } from '../../contexts/ApiBaseContext';
import {
  type RemoteSessionReaderRequest,
  remoteSessionReaderStore,
} from '../../contexts/remote-session-reader-store';
import { displayProvider } from '../../utils/sessionDisplay';
import { ConversationBody } from '../conversation/ConversationBody';
import { Dialog } from '../Dialog';

const REMOTE_HISTORY_TURNS = 10;

/** The read-only continuation reason, stated for every remote session. */
export function remoteContinuationReason(environmentLabel: string): string {
  return `This session runs on ${environmentLabel}. Open Station on ${environmentLabel} to continue it.`;
}

/** Pages arrive newest first; the reader wants one oldest-first stream. */
export function remoteHistoryEvents(
  pages: readonly {
    window: { events: readonly OrchestrationSequencedEvent[] };
  }[],
) {
  const bySequence = new Map<number, OrchestrationSequencedEvent>();
  for (const page of pages)
    for (const entry of page.window.events)
      bySequence.set(entry.sequence, entry);
  return [...bySequence.values()]
    .sort((left, right) => left.sequence - right.sequence)
    .map((entry) => entry.event);
}

function RemoteSessionReader({
  request,
}: {
  request: RemoteSessionReaderRequest;
}) {
  const { apiBase } = useApiBase();
  const close = () => remoteSessionReaderStore.close(request);
  const capability = useQuery({
    queryKey: ['remote-session-history-capability', apiBase],
    queryFn: () => readRemoteSessionHistoryCapability(apiBase),
    staleTime: 5 * 60_000,
    retry: false,
  });
  const supported = capability.data === true;
  const history = useInfiniteQuery({
    queryKey: [
      'ssh-environments',
      'remote-session-history',
      request.environmentId,
      request.threadId,
    ],
    enabled: supported,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      fetchRemoteSessionHistory(request.environmentId, request.threadId, {
        ...(pageParam !== undefined ? { cursor: pageParam } : {}),
        turnLimit: REMOTE_HISTORY_TURNS,
      }),
    getNextPageParam: (page) =>
      page.window.hasMore ? page.window.nextCursor : undefined,
    retry: false,
  });
  const pages = history.data?.pages ?? [];
  const events = useMemo(() => remoteHistoryEvents(pages), [pages]);
  const session = pages[0]?.window.session;
  const reason = remoteContinuationReason(request.environmentLabel);

  let body: React.ReactNode;
  if (capability.isPending) {
    body = <p role="status">Checking this Station…</p>;
  } else if (!supported) {
    body = (
      <p role="status" data-testid="remote-session-unsupported">
        This Station can't show sessions from other computers. Update Station
        here, or open Station on {request.environmentLabel} to read it.
      </p>
    );
  } else if (history.isError && !session) {
    body = (
      <p role="alert" data-testid="remote-session-error">
        {history.error instanceof Error
          ? history.error.message
          : 'Could not read this session from the other computer.'}
      </p>
    );
  } else if (!session) {
    body = (
      <p role="status">Loading history from {request.environmentLabel}…</p>
    );
  } else {
    body = (
      <ConversationBody
        density="record"
        connection={{ apiBase }}
        session={session}
        readOnly
        reader={{
          agentLabel: displayProvider(session),
          isStreaming: false,
        }}
        source={{
          events,
          settled: !history.isFetching,
          hasMore: history.hasNextPage,
          loadOlder: async () => {
            await history.fetchNextPage();
          },
          ...(history.error instanceof Error ? { error: history.error } : {}),
        }}
        composer={{
          input: '',
          onInputChange: () => {},
          disabled: true,
          reason,
        }}
      />
    );
  }

  return (
    <Dialog
      title={request.title}
      subtitle={`On ${request.environmentLabel} · Read only`}
      closeLabel="Close remote session"
      size="lg"
      onClose={close}
    >
      <div
        className="remote-session-reader"
        data-testid="remote-session-reader"
        data-environment-id={request.environmentId}
      >
        {body}
      </div>
    </Dialog>
  );
}

/** Mounted once with the app overlays; renders nothing until a row asks. */
export function RemoteSessionReaderHost() {
  const request = useSyncExternalStore(
    remoteSessionReaderStore.subscribe,
    remoteSessionReaderStore.getSnapshot,
  );
  return request ? (
    <RemoteSessionReader key={request.epoch} request={request} />
  ) : null;
}

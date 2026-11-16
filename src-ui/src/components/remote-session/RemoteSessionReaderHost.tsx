import type {
  OrchestrationSequencedEvent,
  OrchestrationSessionEventWindow,
} from '@kontourai/station-contracts/orchestration';
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
import { notePartialTurnStarts } from '../../hooks/orchestration/useSessionEventWindow';
import {
  elidedHistoryNoticeText,
  summarizeElidedReasons,
} from '../../utils/elidedHistory';
import { displayProvider } from '../../utils/sessionDisplay';
import { ConversationBody } from '../conversation/ConversationBody';
import { Dialog } from '../Dialog';

const REMOTE_HISTORY_TURNS = 10;

/** The read-only continuation reason, stated for every remote session. */
export function remoteContinuationReason(environmentLabel: string): string {
  return `This session runs on ${environmentLabel}. Open Station on ${environmentLabel} to continue it.`;
}

type RemoteHistoryPage = {
  window: Pick<OrchestrationSessionEventWindow, 'events' | 'turnStartDetached'>;
};

/**
 * Pages arrive newest first (each older page from the previous one's
 * cursor); the reader wants one oldest-first stream. A page's own reports of
 * what it left out survive the merge: which turn starts are detached from
 * their turns (`turnStartDetached`, decided as the local window reader does)
 * and how many events the remote's budget withheld (`elided`).
 */
export function remoteHistoryEvents(pages: readonly RemoteHistoryPage[]) {
  const bySequence = new Map<number, OrchestrationSequencedEvent>();
  const partial = new Set<string>();
  const closed = new Set<string>();
  for (const page of pages) {
    for (const entry of page.window.events)
      bySequence.set(entry.sequence, entry);
    notePartialTurnStarts(page.window, partial, closed);
  }
  const ordered = [...bySequence.values()].sort(
    (left, right) => left.sequence - right.sequence,
  );
  return {
    events: ordered.map((entry) => entry.event),
    partialTurnStartEventIds: partial as ReadonlySet<string>,
    // Same filter as the local reader (ConversationBody): tool-detail
    // reductions are not a banner over an otherwise complete conversation.
    elidedNotice: elidedHistoryNoticeText(
      summarizeElidedReasons(
        ordered
          .filter(
            (entry) =>
              entry.event.method !== 'tool.progress' &&
              entry.event.method !== 'tool.started' &&
              entry.event.method !== 'tool.completed' &&
              entry.event.method !== 'token-usage.updated',
          )
          .map((entry) => entry.elided),
      ),
    ),
  };
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
  const merged = useMemo(() => remoteHistoryEvents(pages), [pages]);
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
        beforeTranscript={
          merged.elidedNotice ? (
            <details
              className="history-elided chat-dock__history-elided"
              data-testid="remote-session-history-elided"
            >
              <summary>Some recorded details are omitted</summary>
              {merged.elidedNotice}
            </details>
          ) : undefined
        }
        source={{
          events: merged.events,
          partialTurnStartEventIds: merged.partialTurnStartEventIds,
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

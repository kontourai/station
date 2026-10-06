import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import type { OrchestrationSessionSummary } from '@kontourai/station-sdk';
import { useQueryClient } from '@tanstack/react-query';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { stitchWindowWithLiveEvents } from './conversationTranscriptParts';
import { ensureOrchestrationEventStream } from './ensureOrchestrationEventStream';
import {
  readSequencedLiveEvents,
  readSequencedLiveTruncation,
  subscribeSequencedLiveEvents,
} from './sequencedLiveEvents';
import { useSessionEventWindow } from './useSessionEventWindow';

/**
 * The event source for a session detail's read-only conversation — the chat
 * dock's source, not the per-session live feed.
 *
 * `useSessionEventStream` keeps at most `MAX_FEED_EVENTS` live frames, which
 * is right for its own consumers (request state, the event log) and wrong for
 * a transcript: a long streamed answer lost its first words, a tool call early
 * in a long turn vanished, and earlier turns fell out while the detail stayed
 * open. This reads what chat reads instead:
 *
 * - completed turns from the durable conversation window, re-read when the
 *   session comes to rest so a finished turn is served from the record;
 * - the open turn from the document-wide sequenced live store, stitched past
 *   the window's watermark. That store is bounded per Station and records a
 *   truncation watermark; when it truncates past this window, the window is
 *   re-read (the server has the frames), exactly as the chat dock does.
 */
export function useSessionTranscriptEvents(
  apiBase: string,
  session: Pick<OrchestrationSessionSummary, 'threadId' | 'conversationId'>,
  isStreaming: boolean,
) {
  // The live half of this transcript is the app-wide stream. The chat dock
  // and the Agents pane start it, but the detail must not depend on either
  // being mounted: ensure it here (deduplicated per apiBase; the returned
  // release drops only this registration).
  const queryClient = useQueryClient();
  useEffect(
    () => ensureOrchestrationEventStream(apiBase, queryClient),
    [apiBase, queryClient],
  );

  const [revision, setRevision] = useState(0);
  const wasStreaming = useRef(isStreaming);
  useEffect(() => {
    if (wasStreaming.current && !isStreaming) setRevision((next) => next + 1);
    wasStreaming.current = isStreaming;
  }, [isStreaming]);

  const window = useSessionEventWindow(
    apiBase,
    session.conversationId ?? session.threadId,
    revision,
    session.threadId,
  );
  const subscribeLive = useCallback(
    (listener: () => void) => subscribeSequencedLiveEvents(apiBase, listener),
    [apiBase],
  );
  const readLive = useCallback(
    () => readSequencedLiveEvents(apiBase),
    [apiBase],
  );
  const liveEvents = useSyncExternalStore(subscribeLive, readLive, readLive);

  const liveGap = window.watermark < readSequencedLiveTruncation(apiBase);
  const gapReloadKey = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!liveGap || !window.settled || window.loading || window.error) return;
    const key = `${apiBase}\0${session.threadId}\0${window.watermark}`;
    if (gapReloadKey.current === key) return;
    gapReloadKey.current = key;
    void window.reload();
  }, [
    apiBase,
    session.threadId,
    liveGap,
    window.settled,
    window.loading,
    window.error,
    window.watermark,
    window.reload,
  ]);

  const events = useMemo(
    () =>
      stitchWindowWithLiveEvents({
        windowEvents: window.events,
        watermark: window.watermark,
        liveEvents,
        threadIds: new Set([
          session.threadId,
          window.currentSessionId,
          ...(window.sessionLineage ?? []).map((entry) => entry.sessionId),
        ]),
      })
        .map((item) => item.event)
        .filter((event): event is CanonicalRuntimeEvent =>
          Boolean(event.eventId),
        ),
    [
      window.events,
      window.watermark,
      window.currentSessionId,
      window.sessionLineage,
      liveEvents,
      session.threadId,
    ],
  );

  return {
    events,
    hasMore: window.hasMore,
    loadOlder: window.loadOlder,
    settled: window.settled,
    error: window.error,
    upgradeRequired: window.upgradeRequired,
    retry: window.reload,
    loading: window.loading,
  };
}

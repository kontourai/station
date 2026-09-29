import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import type { OrchestrationSessionSummary } from '@kontourai/station-sdk';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { stitchWindowWithLiveEvents } from './conversationTranscriptParts';
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
function coveredThrough(events: ReadonlyArray<{ sequence: number }>): number {
  let newest = 0;
  for (const item of events) newest = Math.max(newest, item.sequence);
  return newest;
}

export function useSessionTranscriptEvents(
  apiBase: string,
  session: Pick<OrchestrationSessionSummary, 'threadId' | 'conversationId'>,
  isStreaming: boolean,
) {
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
        // The newest frame the window actually RETURNED, not the log head it
        // reports. A long turn is served in pages (the read budget stops
        // partway through it and hands back a cursor), so frames between the
        // page's end and the head are not in `events`; admitting live frames
        // only past the head dropped the back half of a just-finished answer
        // the moment the turn ended and the window was re-read (seen live:
        // w1–w238 of 450).
        watermark: coveredThrough(window.events),
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
  };
}

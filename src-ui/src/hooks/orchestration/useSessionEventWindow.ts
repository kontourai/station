import type { ConversationContextBoundaryTranscriptMarker } from '@kontourai/station-contracts/conversation-context-boundary';
import type {
  ConversationHandoffProjection,
  OrchestrationConversationEventWindow,
  OrchestrationSequencedEvent,
} from '@kontourai/station-contracts/orchestration';
import {
  claimSessionEventWindowCapabilityRecovery,
  fetchOrchestrationConversationEventWindow,
  fetchOrchestrationSessionEventWindow,
  fetchSessionEventWindowCapability,
  resetSessionEventWindowCapabilityRecovery,
  SESSION_EVENT_WINDOW_CAPABILITY_RETRY_MS,
  SESSION_EVENT_WINDOW_UNSUPPORTED_RETRY_MS,
} from '@kontourai/station-sdk';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuthorityPersistence } from '../../contexts/AuthorityPersistenceContext';
import { activeChatsStore } from '../../contexts/active-chats-store';
import { useWorkObservation } from '../../contexts/work-observation';
import { saveOfflineReading } from '../../lib/offlineReading';
import {
  publishHistoryForCapture,
  removeHistoryForCapture,
} from './replay/capture-tap';

function eventKey(item: OrchestrationSequencedEvent): string {
  return item.event.eventId || `sequence:${item.sequence}`;
}

function mergePages(
  older: readonly OrchestrationSequencedEvent[],
  newer: readonly OrchestrationSequencedEvent[],
): OrchestrationSequencedEvent[] {
  const events = new Map<string, OrchestrationSequencedEvent>();
  for (const item of [...older, ...newer]) events.set(eventKey(item), item);
  return [...events.values()].sort(
    (left, right) => left.sequence - right.sequence,
  );
}

interface SessionEventWindowReader {
  events: OrchestrationSequencedEvent[];
  /** Stable event-log head captured by the window read. */
  watermark: number;
  /** Present for conversation reads when the newest lineage child is known. */
  currentSessionId?: string;
  /** Per-execution-Session Agent identity for historical transcript rows. */
  sessionLineage?: NonNullable<
    OrchestrationConversationEventWindow['sessionLineage']
  >;
  handoffs: ConversationHandoffProjection[];
  contextBoundaries: ConversationContextBoundaryTranscriptMarker[];
  hasMore: boolean;
  loadOlder: () => Promise<void>;
  reload: () => Promise<void>;
  upgradeRequired: boolean;
  loading: boolean;
  /**
   * Has this reader produced a reading yet?
   *
   * `loading` cannot answer that: it is `false` both before the first request
   * starts and after it finishes, so a caller reading `events.length === 0 &&
   * !loading` cannot tell "this conversation is empty" from "nobody has looked
   * yet" — and the chat dock rendered the empty "Start a conversation"
   * placeholder over a conversation with turns in it for ~1.7s on every reload
   * because of exactly that (#1582 E3/B6). `settled` becomes true when the
   * first read attempt finishes, success or failure, and resets when the
   * reader is pointed at a different thread.
   */
  settled: boolean;
  catchingUp: boolean;
  error?: Error;
}

async function fetchConversationWindow(
  conversationId: string,
  apiBase: string,
  input: { cursor?: string; turnLimit?: number },
  options: { signal: AbortSignal },
  legacySessionId?: string,
) {
  try {
    return await fetchOrchestrationConversationEventWindow(
      conversationId,
      apiBase,
      { ...input, direction: 'newest' },
      options,
    );
  } catch (error) {
    // An older channel server does not advertise the additive conversation
    // route. It can truthfully serve only a one-session conversation; never
    // silently drop known child-session transcript data on that fallback.
    const status =
      typeof error === 'object' && error !== null
        ? (error as { status?: unknown }).status
        : undefined;
    if (status !== 404 || legacySessionId !== conversationId) throw error;
    const legacy = await fetchOrchestrationSessionEventWindow(
      legacySessionId,
      apiBase,
      { ...input, direction: 'newest' },
      options,
    );
    return {
      ...legacy,
      conversationId,
      currentSessionId: legacySessionId,
      handoffs: [],
      contextBoundaries: [],
    };
  }
}

// JSON history reads expose no progress callback. Allow slow remote reads well
// beyond 30 seconds, but never hold a recovery control indefinitely.
const HISTORY_READ_DEADLINE_MS = 120_000;

async function readConversationWindow(
  ...args: Parameters<typeof fetchConversationWindow>
) {
  const parentSignal = args[3].signal;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancel: () => void = () => {};
  const cancelled = new Promise<never>((_resolve, reject) => {
    cancel = () => {
      controller.abort(parentSignal.reason);
      reject(parentSignal.reason);
    };
    parentSignal.addEventListener('abort', cancel, { once: true });
    timer = setTimeout(() => {
      const error = new Error(
        'Session history read timed out after 120 seconds. Try Resync again.',
      );
      controller.abort(error);
      reject(error);
    }, HISTORY_READ_DEADLINE_MS);
  });
  try {
    parentSignal.throwIfAborted();
    return await Promise.race([
      fetchConversationWindow(
        args[0],
        args[1],
        args[2],
        { signal: controller.signal },
        args[4],
      ),
      cancelled,
    ]);
  } finally {
    clearTimeout(timer);
    parentSignal.removeEventListener('abort', cancel);
  }
}

/** Pages one reload's fill may read before Load older takes over. */
const MAX_FILL_PAGES = 12;

/**
 * The lowest sequence from which a page runs unbroken to its newest event. A
 * detached page's oldest event is its oldest turn's `turn.started`, re-added
 * across rows the page left out, so the unbroken run starts after it.
 */
function contiguousFrom(
  page: Pick<
    OrchestrationConversationEventWindow,
    'events' | 'turnStartDetached'
  >,
): number {
  return (
    page.events[page.turnStartDetached ? 1 : 0]?.sequence ??
    Number.POSITIVE_INFINITY
  );
}

/** The newest turn's `turn.started` sequence, when the page holds it. */
function newestTurnStart(
  events: readonly OrchestrationSequencedEvent[],
): number | undefined {
  const turnId = events.at(-1)?.event.turnId;
  if (!turnId) return undefined;
  return events.find(
    (item) =>
      item.event.method === 'turn.started' && item.event.turnId === turnId,
  )?.sequence;
}

/** REST-only bounded session history. Live content remains app-wide SSE state. */
export function useSessionEventWindow(
  apiBase: string,
  threadId: string | null,
  reconcileRevision = 0,
  legacySessionId?: string,
): SessionEventWindowReader {
  const observation = useWorkObservation(threadId);
  const { namespace } = useAuthorityPersistence();
  const readingNamespace = useRef(namespace);
  readingNamespace.current = namespace;
  const readerKey = threadId
    ? JSON.stringify([apiBase, threadId, legacySessionId])
    : undefined;
  const [events, setEvents] = useState<OrchestrationSequencedEvent[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState<string>();
  const [sessionLineage, setSessionLineage] =
    useState<
      NonNullable<OrchestrationConversationEventWindow['sessionLineage']>
    >();
  const [handoffs, setHandoffs] = useState<ConversationHandoffProjection[]>([]);
  const [contextBoundaries, setContextBoundaries] = useState<
    ConversationContextBoundaryTranscriptMarker[]
  >([]);
  const [cursor, setCursor] = useState<string | undefined>();
  const [watermark, setWatermark] = useState(0);
  const [loading, setLoading] = useState(false);
  const [settled, setSettled] = useState(false);
  const [settledRevision, setSettledRevision] = useState<number | undefined>();
  const [upgradeRequired, setUpgradeRequired] = useState(false);
  const [error, setError] = useState<Error>();
  const generation = useRef(0);
  const readerKeyRef = useRef<string | undefined>(undefined);
  const cursorRef = useRef<string | undefined>(undefined);
  const watermarkRef = useRef(0);
  const olderLoadedRef = useRef(false);
  const requestSerialRef = useRef(0);
  const reconcileRevisionRef = useRef(reconcileRevision);
  const requestControllerRef = useRef<AbortController | undefined>(undefined);
  const fillRef = useRef<(cursor: string, floor: number) => Promise<void>>(
    async () => {},
  );
  const recoveryTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  cursorRef.current = cursor;
  const eventsRef = useRef(events);
  eventsRef.current = events;
  watermarkRef.current = watermark;
  reconcileRevisionRef.current = reconcileRevision;

  const reload = useCallback(async () => {
    if (!threadId) return;
    const revisionAtStart = reconcileRevisionRef.current;
    if (recoveryTimerRef.current !== undefined) {
      clearTimeout(recoveryTimerRef.current);
      recoveryTimerRef.current = undefined;
    }
    const requestGeneration = generation.current;
    const requestSerial = ++requestSerialRef.current;
    const read = observation?.read(
      threadId,
      'history',
      () =>
        requestGeneration === generation.current &&
        requestSerial === requestSerialRef.current,
      activeChatsStore.getChatForExecutionSession(threadId)
        ?.conversationActivity?.asOfSequence,
    );

    requestControllerRef.current?.abort();
    const controller = new AbortController();
    requestControllerRef.current = controller;
    setLoading(true);
    setSettled(false);
    let fill: { cursor: string; floor: number } | undefined;
    try {
      const capability = await fetchSessionEventWindowCapability(apiBase);
      if (
        requestGeneration !== generation.current ||
        requestSerial !== requestSerialRef.current ||
        controller.signal.aborted
      )
        return;
      if (capability !== true) {
        if (requestGeneration !== generation.current) return;
        read?.failed();
        const upgradeRequired = capability === false;
        setUpgradeRequired(upgradeRequired);
        setError(
          new Error(
            upgradeRequired
              ? 'Session history requires a Station upgrade'
              : 'Session history transport failed.',
          ),
        );
        if (claimSessionEventWindowCapabilityRecovery(apiBase, threadId)) {
          const delay =
            capability === false
              ? SESSION_EVENT_WINDOW_UNSUPPORTED_RETRY_MS
              : SESSION_EVENT_WINDOW_CAPABILITY_RETRY_MS;
          recoveryTimerRef.current = setTimeout(() => {
            recoveryTimerRef.current = undefined;
            void reload();
          }, delay);
        }
        return;
      }
      resetSessionEventWindowCapabilityRecovery(apiBase, threadId);
      const page = await readConversationWindow(
        threadId,
        apiBase,
        { turnLimit: 10 },
        { signal: controller.signal },
        legacySessionId,
      );
      if (
        requestGeneration !== generation.current ||
        requestSerial !== requestSerialRef.current
      )
        return;
      if (read?.current() === false) return;
      read?.observed(page.watermark);
      setUpgradeRequired(false);
      // #2309: the window read carries its conversation's activity too.
      activeChatsStore.applyConversationActivity(
        page.session?.conversationActivity,
      );
      setCurrentSessionId(page.currentSessionId);
      setSessionLineage(page.sessionLineage);
      setHandoffs(page.handoffs ?? []);
      setContextBoundaries(page.contextBoundaries ?? []);
      const next = page.events;
      if (namespace) {
        void saveOfflineReading(
          namespace,
          threadId,
          next,
          () =>
            readingNamespace.current === namespace &&
            requestGeneration === generation.current,
        ).catch(() => {});
      }
      // The newest page is capped: a long turn can read back as its
      // `turn.started` plus its tail, and a reload after a long silence can
      // land above what this reader holds. The page must run unbroken down to
      // what is held once older pages are loaded, or else to its newest turn's
      // start, so that turn reads whole. Its cursor reads the gap first.
      const floor = olderLoadedRef.current
        ? eventsRef.current.at(-1)?.sequence
        : newestTurnStart(next);
      if (
        page.nextCursor &&
        floor !== undefined &&
        contiguousFrom(page) > floor
      )
        fill = { cursor: page.nextCursor, floor };
      // Once older pages are loaded, the events already held are kept: stored
      // events never change, and the new page wins where the two overlap.
      setEvents((current) =>
        mergePages(olderLoadedRef.current ? current : [], next),
      );
      if (!olderLoadedRef.current) setCursor(page.nextCursor);
      setWatermark(page.watermark);
      watermarkRef.current = page.watermark;
      setError(undefined);
    } catch (cause) {
      if (controller.signal.aborted) return;
      if (
        requestGeneration !== generation.current ||
        requestSerial !== requestSerialRef.current
      )
        return;
      read?.failed();
      const failure = cause instanceof Error ? cause : new Error(String(cause));
      setError(failure);
      setUpgradeRequired(false);
    } finally {
      if (
        requestGeneration === generation.current &&
        requestSerial === requestSerialRef.current
      ) {
        setLoading(false);
        // A failed or upgrade-refused read is still a reading: the caller now
        // knows something, and `error`/`upgradeRequired` say what. Only a read
        // superseded by a newer one leaves the question open.
        setSettled(true);
        setSettledRevision(revisionAtStart);
      }
    }
    if (fill) void fillRef.current(fill.cursor, fill.floor);
  }, [apiBase, legacySessionId, observation, threadId, namespace]);

  /**
   * Read one older page at `pageCursor` and merge it. `adoptCursor` moves the
   * reader's own paging cursor to the page's next one; `olderLoaded` marks
   * history past the newest page as held, so later reloads keep it. Resolves
   * with the page once applied, or undefined when superseded or failed.
   */
  const readOlder = useCallback(
    async (
      pageCursor: string,
      options: { adoptCursor: boolean; olderLoaded: boolean },
    ): Promise<OrchestrationConversationEventWindow | undefined> => {
      if (!threadId) return undefined;
      const requestGeneration = generation.current;
      const requestSerial = ++requestSerialRef.current;
      const read = observation?.read(
        threadId,
        'older-history',
        () =>
          requestGeneration === generation.current &&
          requestSerial === requestSerialRef.current,
        activeChatsStore.getChatForExecutionSession(threadId)
          ?.conversationActivity?.asOfSequence,
      );

      requestControllerRef.current?.abort();
      const controller = new AbortController();
      requestControllerRef.current = controller;
      setLoading(true);
      try {
        const page = await readConversationWindow(
          threadId,
          apiBase,
          { cursor: pageCursor, turnLimit: 20 },
          { signal: controller.signal },
          legacySessionId,
        );
        if (
          requestGeneration !== generation.current ||
          requestSerial !== requestSerialRef.current
        )
          return undefined;
        if (read?.current() === false) return undefined;
        activeChatsStore.applyConversationActivity(
          page.session?.conversationActivity,
        );
        setCurrentSessionId(page.currentSessionId);
        setSessionLineage(page.sessionLineage);
        setHandoffs(page.handoffs ?? []);
        setContextBoundaries(page.contextBoundaries ?? []);
        read?.observed(page.watermark);
        setError(undefined);
        // A cursor pins the head it was minted at, which a later reload may
        // have passed. The events it pages lie below that head and never
        // change, so its page merges whatever the reader's head is now.
        setEvents((current) => mergePages(page.events, current));
        if (options.olderLoaded) olderLoadedRef.current = true;
        if (options.adoptCursor) setCursor(page.nextCursor);
        return page;
      } catch (cause) {
        if (controller.signal.aborted) return undefined;
        if (requestGeneration !== generation.current) return undefined;
        read?.failed();
        setError(cause instanceof Error ? cause : new Error(String(cause)));
        return undefined;
      } finally {
        if (
          requestGeneration === generation.current &&
          requestSerial === requestSerialRef.current
        )
          setLoading(false);
      }
    },
    [apiBase, legacySessionId, observation, threadId],
  );

  const loadOlder = useCallback(async () => {
    const pageCursor = cursorRef.current;
    if (pageCursor)
      await readOlder(pageCursor, { adoptCursor: true, olderLoaded: true });
  }, [readOlder]);

  // Page down from a reload's newest page until it runs unbroken to `floor`.
  // Older pages already loaded keep their own cursor, which sits past what is
  // held; otherwise the reader's cursor follows the fill, so Load older
  // resumes where it stopped. Bounded: past that, Load older reads on.
  const fillToFloor = useCallback(
    async (cursor: string, floor: number) => {
      const adoptCursor = !olderLoadedRef.current;
      let pageCursor: string | undefined = cursor;
      for (let pages = 0; pageCursor && pages < MAX_FILL_PAGES; pages += 1) {
        const page = await readOlder(pageCursor, {
          adoptCursor,
          olderLoaded: false,
        });
        if (!page || contiguousFrom(page) <= floor) return;
        pageCursor = page.nextCursor;
      }
      if (!adoptCursor && pageCursor) setCursor(pageCursor);
    },
    [readOlder],
  );
  fillRef.current = fillToFloor;

  useEffect(() => {
    if (readerKeyRef.current === readerKey) return;
    readerKeyRef.current = readerKey;
    generation.current += 1;
    requestSerialRef.current += 1;
    requestControllerRef.current?.abort();
    olderLoadedRef.current = false;
    if (recoveryTimerRef.current !== undefined) {
      clearTimeout(recoveryTimerRef.current);
      recoveryTimerRef.current = undefined;
    }
    setEvents([]);
    setCurrentSessionId(undefined);
    setSessionLineage(undefined);
    setHandoffs([]);
    setContextBoundaries([]);
    setCursor(undefined);
    setWatermark(0);
    setError(undefined);
    setUpgradeRequired(false);
    // A new thread has not been read yet, whatever the previous one reported.
    setSettled(false);
    setSettledRevision(undefined);
    if (threadId) void reload();
    return () => {
      generation.current += 1;
      requestControllerRef.current?.abort();
      if (recoveryTimerRef.current !== undefined) {
        clearTimeout(recoveryTimerRef.current);
        recoveryTimerRef.current = undefined;
      }
      readerKeyRef.current = undefined;
    };
  }, [readerKey, reload, threadId]);

  const previousRevision = useRef(reconcileRevision);
  useEffect(() => {
    if (previousRevision.current === reconcileRevision) return;
    previousRevision.current = reconcileRevision;
    if (threadId) void reload();
  }, [reconcileRevision, reload, threadId]);

  // Effects reset the request after commit. Do not expose the prior reader's
  // authority or transcript during the first render of a different identity.
  const currentReader = Boolean(threadId) && readerKeyRef.current === readerKey;
  useEffect(() => {
    if (!threadId || !currentReader) return;
    publishHistoryForCapture(apiBase, threadId, {
      events,
      currentSessionId,
      sessionLineage,
      handoffs,
      contextBoundaries,
      hasMore: Boolean(cursor),
      loading,
      settled,
      upgradeRequired,
      errorMessage: error?.message,
    });
  }, [
    apiBase,
    threadId,
    currentReader,
    events,
    currentSessionId,
    sessionLineage,
    handoffs,
    contextBoundaries,
    cursor,
    loading,
    settled,
    upgradeRequired,
    error,
  ]);
  useEffect(
    () => () => {
      if (threadId) removeHistoryForCapture(apiBase, threadId);
    },
    [apiBase, threadId],
  );
  return {
    events: currentReader ? events : [],
    watermark: currentReader ? watermark : 0,
    ...(currentReader && currentSessionId ? { currentSessionId } : {}),
    ...(currentReader && sessionLineage ? { sessionLineage } : {}),
    handoffs: currentReader ? handoffs : [],
    contextBoundaries: currentReader ? contextBoundaries : [],
    hasMore: currentReader && Boolean(cursor),
    loadOlder,
    reload,
    upgradeRequired: currentReader && upgradeRequired,
    loading: currentReader ? loading : Boolean(threadId),
    settled: currentReader && settled,
    // station#2530 review 2: catching up means a NEWER revision's fetch is
    // genuinely outstanding — `settledRevision`/`settled` have not caught up
    // to this render's `reconcileRevision` yet. `error` alone is
    // deliberately NOT part of this: a FAILED background refetch settles
    // `settledRevision` to match regardless (see the `finally` above), so
    // catching-up ends the instant that fetch resolves either way, instead
    // of pinning an already-loaded transcript behind a permanent "catching
    // up" state for as long as retries keep failing. `error` is still
    // surfaced on its own field for a retry affordance.
    catchingUp: Boolean(
      threadId &&
        reconcileRevision > 0 &&
        (settledRevision !== reconcileRevision || !settled),
    ),
    error: currentReader ? error : undefined,
  };
}

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
import type { ApiRequestScope } from '@kontourai/station-sdk/client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useOptionalConversationConnection } from '../../components/conversation/ConversationConnectionContext';
import { useAuthorityPersistence } from '../../contexts/AuthorityPersistenceContext';
import { activeChatsStore } from '../../contexts/active-chats-store';
import { useWorkObservation } from '../../contexts/work-observation';
import { saveOfflineReading } from '../../lib/offlineReading';
import {
  awayTrimSequence,
  type ReaderPlace,
  reloadKeepsHeld,
} from './readerPlace';
import {
  publishHistoryForCapture,
  removeHistoryForCapture,
} from './replay/capture-tap';
import {
  evictTranscriptWindow,
  readTranscriptWindow,
  type TranscriptWindowSnapshot,
  transcriptWindowCacheGeneration,
  transcriptWindowCacheKey,
  writeTranscriptWindow,
} from './transcriptWindowCache';

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

/**
 * Whether the held events cannot belong to the log a newest page was read
 * from: one of them lies past the page's head (a log's head never moves back),
 * or an event the two share sits at another sequence. The window read carries
 * no store identity, so these are what tell a replaced log apart.
 */
function heldFromAnotherLog(
  held: readonly OrchestrationSequencedEvent[],
  page: Pick<OrchestrationConversationEventWindow, 'events' | 'watermark'>,
): boolean {
  const newestHeld = held.at(-1)?.sequence;
  if (newestHeld !== undefined && newestHeld > page.watermark) return true;
  if (!held.length) return false;
  const heldSequences = new Map(
    held.map((item) => [eventKey(item), item.sequence]),
  );
  return page.events.some((item) => {
    const sequence = heldSequences.get(eventKey(item));
    return sequence !== undefined && sequence !== item.sequence;
  });
}

interface SessionEventWindowReader {
  events: OrchestrationSequencedEvent[];
  /**
   * #4266: event ids of `turn.started` events held without the events after
   * them: a `turnStartDetached` page re-added the start, and no read has
   * reached it in range yet (the fill is pending, cut short, or left to Load
   * older). The projection adopts no terminal `outputText` for those turns.
   */
  partialTurnStartEventIds: ReadonlySet<string>;
  /** Stable event-log head captured by the window read. */
  watermark: number;
  memoryContinuation?: OrchestrationConversationEventWindow['memoryContinuation'];
  /** Present for conversation reads when the newest lineage child is known. */
  currentSessionId?: string;
  /** A materialized child named by a fresh head read and the binding it read from. */
  executionRead?: { sessionId: string; priorSessionId: string | undefined };
  /** Per-execution-Session Agent identity for historical transcript rows. */
  sessionLineage?: NonNullable<
    OrchestrationConversationEventWindow['sessionLineage']
  >;
  handoffs: ConversationHandoffProjection[];
  contextBoundaries: ConversationContextBoundaryTranscriptMarker[];
  hasMore: boolean;
  loadOlder: () => Promise<void>;
  loadTurn: (turnId: string, signal?: AbortSignal) => Promise<boolean>;
  reload: () => Promise<void>;
  /**
   * The transcript reports where its reader is: while they are away from the
   * end, a reload keeps what is held instead of replacing it.
   */
  setReaderPlace: (place: ReaderPlace) => void;
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
  /**
   * The rows on screen were painted from this client's recent copy of the
   * window and a read for the current one is still in flight. `settled` is
   * already true: there is a reading, it may just be a little old.
   */
  revalidating: boolean;
  catchingUp: boolean;
  error?: Error;
}

async function fetchConversationWindow(
  conversationId: string,
  apiBase: string,
  input: { cursor?: string; turnLimit?: number },
  options: { signal: AbortSignal; requestScope?: ApiRequestScope },
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
        { ...args[3], signal: controller.signal },
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

/**
 * Where the page's newest turn starts: its first `turn.started`. The newest
 * event cannot name that turn (a finished turn is followed by a turnless
 * `session.state-changed`), and a steer re-announces the turn later on.
 */
function newestTurnStart(
  events: readonly OrchestrationSequencedEvent[],
): number | undefined {
  const newest = [...events]
    .reverse()
    .find((item) => item.event.method === 'turn.started')?.event;
  if (!newest) return undefined;
  return events.find(
    (item) =>
      item.event.method === 'turn.started' &&
      item.event.threadId === newest.threadId &&
      item.event.turnId === newest.turnId,
  )?.sequence;
}

const NO_PARTIAL_TURNS: ReadonlySet<string> = new Set();

/**
 * Updates which held turn starts are detached from the rest of their turn
 * after reading `page`. A start the page reads in range closes its turn: the
 * reads that reach it page down contiguously from the events above. A start
 * a detached page re-added is partial unless a read already closed it.
 */
export function notePartialTurnStarts(
  page: Pick<
    OrchestrationConversationEventWindow,
    'events' | 'turnStartDetached'
  >,
  partial: Set<string>,
  closed: Set<string>,
): void {
  const inRange = page.turnStartDetached ? page.events.slice(1) : page.events;
  for (const { event } of inRange) {
    if (event.method !== 'turn.started' || !event.eventId) continue;
    closed.add(event.eventId);
    partial.delete(event.eventId);
  }
  const anchor = page.turnStartDetached
    ? page.events[0]?.event.eventId
    : undefined;
  if (anchor && !closed.has(anchor)) partial.add(anchor);
}

function lowest(...values: (number | undefined)[]): number | undefined {
  const defined = values.filter((value) => value !== undefined);
  return defined.length ? Math.min(...defined) : undefined;
}

/** The cacheable state of one newest-page read, as `reload` would hold it. */
function snapshotOfNewestPage(
  page: OrchestrationConversationEventWindow,
): TranscriptWindowSnapshot {
  const partial = new Set<string>();
  notePartialTurnStarts(page, partial, new Set());
  return {
    events: page.events,
    ...(page.nextCursor ? { cursor: page.nextCursor } : {}),
    watermark: page.watermark,
    ...(page.sessionLineage ? { sessionLineage: page.sessionLineage } : {}),
    handoffs: page.handoffs ?? [],
    contextBoundaries: page.contextBoundaries ?? [],
    ...(page.memoryContinuation
      ? { memoryContinuation: page.memoryContinuation }
      : {}),
    partialTurnStartEventIds: [...partial],
  };
}

/**
 * Read one conversation's newest window into the reopen cache, the same read
 * a reader's first `reload` makes. For the host Station's own conversations
 * only: the key carries no remote Station namespace.
 */
export async function prefetchTranscriptWindow(input: {
  cacheKey: string;
  apiBase: string;
  conversationId: string;
  requestScope?: ApiRequestScope;
  signal: AbortSignal;
}): Promise<boolean> {
  const capability = input.requestScope
    ? true
    : await fetchSessionEventWindowCapability(input.apiBase);
  if (capability !== true || input.signal.aborted) return false;
  const readGeneration = transcriptWindowCacheGeneration();
  const page = await readConversationWindow(
    input.conversationId,
    input.apiBase,
    { turnLimit: 10 },
    {
      signal: input.signal,
      ...(input.requestScope ? { requestScope: input.requestScope } : {}),
    },
  );
  if (input.signal.aborted) return false;
  return writeTranscriptWindow(
    input.cacheKey,
    snapshotOfNewestPage(page),
    readGeneration,
  );
}

/** REST-only bounded session history. Live content remains app-wide SSE state. */
export function useSessionEventWindow(
  apiBase: string,
  threadId: string | null,
  reconcileRevision = 0,
  legacySessionId?: string,
  explicitTarget?: ReturnType<typeof useOptionalConversationConnection>,
): SessionEventWindowReader {
  const contextTarget = useOptionalConversationConnection();
  const target = explicitTarget ?? contextTarget;
  apiBase = target?.apiBase ?? apiBase;
  // Delivery controls may change without changing the history reader.
  const bound = target != null;
  const station = target?.station;
  const requestScope = target?.requestScope;
  const observationTarget =
    station ??
    (target?.requestScope
      ? {
          targetApiBase: target.apiBase,
          requestScope: target.requestScope,
          runtimeKey: JSON.stringify([
            target.apiBase,
            target.requestScope.authorityKey,
          ]),
        }
      : undefined);
  const observation = useWorkObservation(threadId, observationTarget);
  const { namespace } = useAuthorityPersistence();
  const readingNamespace = useRef(namespace);
  readingNamespace.current = namespace;
  // Only the 404 fallback to an older server reads this, at request time. It
  // is not reader identity: `/open` naming the current child mid-read must not
  // wipe and restart the window it is reading.
  const legacySessionIdRef = useRef(legacySessionId);
  legacySessionIdRef.current = legacySessionId;
  // Set when the newest read failed 404 while the fallback could not apply.
  const legacyFallbackOwedRef = useRef(false);
  const readerKey = threadId
    ? JSON.stringify([
        apiBase,
        threadId,
        requestScope?.authorityKey,
        station?.runtimeKey,
      ])
    : undefined;
  const cacheKey = threadId
    ? transcriptWindowCacheKey({
        namespace,
        ...(station ? { stationNamespace: station.authorityNamespace } : {}),
        apiBase,
        ...(requestScope?.authorityKey
          ? { authorityKey: requestScope.authorityKey }
          : {}),
        conversationId: threadId,
      })
    : undefined;
  const cacheKeyRef = useRef(cacheKey);
  cacheKeyRef.current = cacheKey;
  // The cache key and cache generation the held window was read under. The
  // reopen copy is written only under that same key: a window read before
  // the authority changed must never be stored as the new authority's.
  const windowStampRef = useRef<
    { key: string | undefined; generation: number } | undefined
  >(undefined);
  const [events, setEvents] = useState<OrchestrationSequencedEvent[]>([]);
  const [childObservation, setChildObservation] = useState<{
    sessionId: string;
    priorSessionId: string | undefined;
    materialized: boolean;
  }>();
  // The rows can keep painting when a foreground receipt or /open changes
  // the child. A head read started under a different child cannot undo it.
  const currentSessionId =
    childObservation &&
    (childObservation.priorSessionId === legacySessionId ||
      childObservation.sessionId === legacySessionId)
      ? childObservation.sessionId
      : undefined;
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
  const [memoryContinuation, setMemoryContinuation] =
    useState<OrchestrationConversationEventWindow['memoryContinuation']>();
  const [loading, setLoading] = useState(false);
  const [settled, setSettled] = useState(false);
  const [revalidating, setRevalidating] = useState(false);
  const revalidatingRef = useRef(false);
  const [settledRevision, setSettledRevision] = useState<number | undefined>();
  const [upgradeRequired, setUpgradeRequired] = useState(false);
  const [error, setError] = useState<Error>();
  const generation = useRef(0);
  const readerKeyRef = useRef<string | undefined>(undefined);
  const cursorRef = useRef<string | undefined>(undefined);
  const watermarkRef = useRef(0);
  const olderLoadedRef = useRef(false);
  // Where the reader is, as the transcript reports it: away from the end
  // (scrolled up, or holding a row with the end out of view) and the turn of
  // the first row they see.
  const readerPlaceRef = useRef<ReaderPlace>({ away: false });
  // The last reload kept what was held because the reader was away.
  const keptAwayRef = useRef(false);
  const setReaderPlace = useCallback((place: ReaderPlace) => {
    readerPlaceRef.current = place;
  }, []);
  const requestSerialRef = useRef(0);
  const reconcileRevisionRef = useRef(reconcileRevision);
  const requestControllerRef = useRef<AbortController | undefined>(undefined);
  // Older-page reads share the request slot with `reload`, so one of them
  // retires a `reload` that is still in flight, and a retired `reload` never
  // settles. `unsettledReloadRef` holds that reload's serial; `reloadOwedRef`
  // says an older-page read retired it, and whoever asked for the older pages
  // runs it again when they are done.
  const unsettledReloadRef = useRef<number | undefined>(undefined);
  const reloadOwedRef = useRef(false);
  const fillRef = useRef<(cursor: string, floor: number) => Promise<void>>(
    async () => {},
  );
  const recoveryTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  cursorRef.current = cursor;
  const eventsRef = useRef(events);
  const pendingFloorRef = useRef<number | undefined>(undefined);
  const partialRef = useRef(new Set<string>());
  // Each cursor owes a continuous read down to its floor. Coalescing the
  // oldest gaps at the bound retains every anchor and the lowest floor.
  const heldGapsRef = useRef<
    Array<{ floor: number; cursor: string; anchors: Set<string> }>
  >([]);
  const closedRef = useRef(new Set<string>());
  const [partialTurnStartEventIds, setPartialTurnStartEventIds] =
    useState<ReadonlySet<string>>(NO_PARTIAL_TURNS);
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
    const stamp = {
      key: cacheKeyRef.current,
      generation: transcriptWindowCacheGeneration(),
    };
    unsettledReloadRef.current = requestSerial;
    reloadOwedRef.current = false;
    const read = observation?.read(
      threadId,
      'history',
      () =>
        requestGeneration === generation.current &&
        requestSerial === requestSerialRef.current &&
        (!station || station.isCurrent()),
      activeChatsStore.getChatForExecutionSession(threadId, station)
        ?.conversationActivity?.asOfSequence,
    );

    requestControllerRef.current?.abort();
    const controller = new AbortController();
    requestControllerRef.current = controller;
    setLoading(true);
    // A cached paint is already a reading; the read replaces it in place.
    const revalidatingCachedPaint = revalidatingRef.current;
    if (!revalidatingCachedPaint) setSettled(false);
    setMemoryContinuation(undefined);
    let fill: { cursor: string; floor: number } | undefined;
    let failed = false;
    // The fallback decision is the request's: the id it was sent with.
    const legacyAtSend = legacySessionIdRef.current;
    let retryWithFallback = false;
    try {
      const capability = requestScope
        ? true
        : await fetchSessionEventWindowCapability(apiBase);
      if (
        requestGeneration !== generation.current ||
        requestSerial !== requestSerialRef.current ||
        controller.signal.aborted
      )
        return;
      if (capability !== true) {
        if (requestGeneration !== generation.current) return;
        failed = true;
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
        { signal: controller.signal, requestScope },
        legacyAtSend,
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
      if (!bound || station)
        activeChatsStore.applyConversationActivity(
          page.session?.conversationActivity,
          station,
        );
      setChildObservation(
        page.currentSessionId
          ? {
              sessionId: page.currentSessionId,
              priorSessionId: legacyAtSend,
              materialized: page.session?.threadId === page.currentSessionId,
            }
          : undefined,
      );
      setSessionLineage(page.sessionLineage);
      setHandoffs(page.handoffs ?? []);
      setContextBoundaries(page.contextBoundaries ?? []);
      setMemoryContinuation(page.memoryContinuation);
      // Held pages merge with the new one, so a key change since leaves a
      // mixed window that belongs under neither key.
      // A reader away from the end keeps what is held as well: replacing it
      // drops the oldest turns from the front, and with them the rows they
      // are reading. Back at the end, the next reload replaces again.
      // A page from another store (Station's event log replaced since the
      // held events were read) never merges with them: what is held is not
      // in it any more, and its sequences number a different log.
      const anotherLog = heldFromAnotherLog(eventsRef.current, page);
      if (anotherLog) {
        olderLoadedRef.current = false;
        keptAwayRef.current = false;
        pendingFloorRef.current = undefined;
      }
      const keep =
        !anotherLog &&
        reloadKeepsHeld({
          olderLoaded: olderLoadedRef.current,
          readerAway: readerPlaceRef.current.away,
          holding: eventsRef.current.length > 0,
        });
      const awayKeep = keep && !olderLoadedRef.current;
      keptAwayRef.current = awayKeep;
      windowStampRef.current =
        keep && windowStampRef.current?.key !== stamp.key ? undefined : stamp;
      const next = page.events;
      if (namespace && (!bound || station?.binding.affinity.kind === 'host')) {
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
      // A fill a later read cut short still owes its gap, so its floor holds
      // until some fill reaches it.
      const floor = keep
        ? lowest(
            eventsRef.current.at(-1)?.sequence,
            pendingFloorRef.current,
            ...heldGapsRef.current.map((gap) => gap.floor),
          )
        : newestTurnStart(next);
      if (
        page.nextCursor &&
        floor !== undefined &&
        contiguousFrom(page) > floor
      )
        fill = { cursor: page.nextCursor, floor };
      // Once older pages are loaded, the events already held are kept: stored
      // events never change, and the new page wins where the two overlap.
      // Kept while away, the window is bounded by turns, trimmed only above
      // the turn the reader is reading.
      const cut = awayKeep
        ? awayTrimSequence(
            mergePages(eventsRef.current, next),
            readerPlaceRef.current.turnId,
          )
        : undefined;
      setEvents((current) => {
        const merged = mergePages(keep ? current : [], next);
        return cut === undefined
          ? merged
          : merged.filter((item) => item.sequence >= cut);
      });
      // A page that replaces what is held starts the record over.
      if (!keep) {
        partialRef.current = new Set();
        closedRef.current = new Set();
        heldGapsRef.current = [];
      }
      notePartialTurnStarts(page, partialRef.current, closedRef.current);
      // A reload whose detached start was closed by an earlier fill can land
      // above what is held again: the gap between is owed anew, and the fill
      // may stop short of it (its page bound, a newer read).
      const anchor = page.turnStartDetached
        ? next[0]?.event.eventId
        : undefined;
      if (fill && keep) {
        const anchors = new Set(anchor ? [anchor] : []);
        heldGapsRef.current.push({ ...fill, anchors });
        if (heldGapsRef.current.length > 128) {
          const oldest = heldGapsRef.current.shift()!;
          const next = heldGapsRef.current[0]!;
          next.floor = Math.min(oldest.floor, next.floor);
          for (const id of oldest.anchors) next.anchors.add(id);
        }
      } else if (!fill) {
        heldGapsRef.current = heldGapsRef.current.filter((gap) => {
          if (contiguousFrom(page) > gap.floor) return true;
          for (const id of gap.anchors) partialRef.current.delete(id);
          return false;
        });
      }
      for (const gap of heldGapsRef.current)
        for (const id of gap.anchors) partialRef.current.add(id);
      setPartialTurnStartEventIds(new Set(partialRef.current));
      // A cursor reads below the oldest event held; trimmed, that is gone
      // until the reader is back at the end and a reload replaces the window.
      if (!keep) setCursor(page.nextCursor);
      else if (cut !== undefined) setCursor(undefined);
      setWatermark(page.watermark);
      watermarkRef.current = page.watermark;
      setError(undefined);
      legacyFallbackOwedRef.current = false;
    } catch (cause) {
      if (controller.signal.aborted) return;
      if (
        requestGeneration !== generation.current ||
        requestSerial !== requestSerialRef.current
      )
        return;
      failed = true;
      read?.failed();
      const failure = cause instanceof Error ? cause : new Error(String(cause));
      // A 404 the older-server fallback could not take (the reader then named
      // a child, not the conversation) is retried if it later can.
      const fallbackOwed =
        typeof cause === 'object' &&
        cause !== null &&
        (cause as { status?: unknown }).status === 404 &&
        legacyAtSend !== threadId;
      // Named the conversation itself while this read was in flight: the
      // change that would have retried it has already passed, so retry now.
      retryWithFallback =
        fallbackOwed && legacySessionIdRef.current === threadId;
      legacyFallbackOwedRef.current = fallbackOwed && !retryWithFallback;
      setError(failure);
      setUpgradeRequired(false);
    } finally {
      if (
        requestGeneration === generation.current &&
        requestSerial === requestSerialRef.current
      ) {
        unsettledReloadRef.current = undefined;
        revalidatingRef.current = false;
        setRevalidating(false);
        // A cached paint the server would not confirm is not shown as if it
        // were current: drop it so the failure (and its Retry) shows, and
        // forget the copy so it does not paint again.
        if (failed && revalidatingCachedPaint) {
          evictTranscriptWindow(stamp.key);
          windowStampRef.current = undefined;
          setEvents([]);
          setSessionLineage(undefined);
          setHandoffs([]);
          setContextBoundaries([]);
          setCursor(undefined);
          setWatermark(0);
          watermarkRef.current = 0;
          partialRef.current = new Set();
          setPartialTurnStartEventIds(NO_PARTIAL_TURNS);
        }
        setLoading(false);
        // A failed or upgrade-refused read is still a reading: the caller now
        // knows something, and `error`/`upgradeRequired` say what. Only a read
        // superseded by a newer one leaves the question open.
        setSettled(true);
        setSettledRevision(revisionAtStart);
      }
    }
    if (fill) void fillRef.current(fill.cursor, fill.floor);
    if (
      retryWithFallback &&
      requestGeneration === generation.current &&
      requestSerial === requestSerialRef.current
    )
      void reload();
  }, [apiBase, observation, threadId, namespace, requestScope, station, bound]);

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
      if (unsettledReloadRef.current !== undefined) {
        unsettledReloadRef.current = undefined;
        reloadOwedRef.current = true;
      }
      const read = observation?.read(
        threadId,
        'older-history',
        () =>
          requestGeneration === generation.current &&
          requestSerial === requestSerialRef.current &&
          (!station || station.isCurrent()),
        activeChatsStore.getChatForExecutionSession(threadId, station)
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
          { signal: controller.signal, requestScope },
          legacySessionIdRef.current,
        );
        if (
          requestGeneration !== generation.current ||
          requestSerial !== requestSerialRef.current
        )
          return undefined;
        if (read?.current() === false) return undefined;
        if (!bound || station)
          activeChatsStore.applyConversationActivity(
            page.session?.conversationActivity,
            station,
          );
        setSessionLineage(page.sessionLineage);
        setHandoffs(page.handoffs ?? []);
        setContextBoundaries(page.contextBoundaries ?? []);
        if (windowStampRef.current?.key !== cacheKeyRef.current)
          windowStampRef.current = undefined;
        read?.observed(page.watermark);
        setError(undefined);
        // A cursor pins the head it was minted at, which a later reload may
        // have passed. The events it pages lie below that head and never
        // change, so its page merges whatever the reader's head is now.
        setEvents((current) => mergePages(page.events, current));
        notePartialTurnStarts(page, partialRef.current, closedRef.current);
        const activeGap = heldGapsRef.current.find(
          (gap) => gap.cursor === pageCursor,
        );
        if (activeGap) {
          heldGapsRef.current = heldGapsRef.current.filter((gap) => {
            if (contiguousFrom(page) > gap.floor) return true;
            for (const id of gap.anchors) partialRef.current.delete(id);
            return false;
          });
          if (heldGapsRef.current.includes(activeGap) && page.nextCursor)
            activeGap.cursor = page.nextCursor;
        }
        for (const gap of heldGapsRef.current)
          for (const id of gap.anchors) partialRef.current.add(id);
        setPartialTurnStartEventIds(new Set(partialRef.current));
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
    [apiBase, observation, threadId, requestScope, station, bound],
  );

  // After a requested older read: run the `reload` it retired, if any. Not
  // after each page, where the next page would only retire it again.
  const runOwedReload = useCallback(() => {
    if (!reloadOwedRef.current) return;
    reloadOwedRef.current = false;
    void reload();
  }, [reload]);

  const loadOlder = useCallback(async () => {
    try {
      const heldGap = heldGapsRef.current.at(-1);
      if (heldGap) {
        await fillRef.current(heldGap.cursor, heldGap.floor);
        return;
      }
      const pageCursor = cursorRef.current;
      if (pageCursor)
        await readOlder(pageCursor, { adoptCursor: true, olderLoaded: true });
    } finally {
      runOwedReload();
    }
  }, [readOlder, runOwedReload]);

  const loadTurn = useCallback(
    async (turnId: string, signal?: AbortSignal) => {
      const requestGeneration = generation.current;
      const containsWholeTurn = (
        events: readonly OrchestrationSequencedEvent[],
      ) =>
        events.some(
          ({ event }) =>
            event.method === 'turn.started' &&
            event.turnId === turnId &&
            !!event.eventId &&
            !partialRef.current.has(event.eventId),
        );
      if (containsWholeTurn(eventsRef.current)) return true;
      let pageCursor = heldGapsRef.current.at(-1)?.cursor ?? cursorRef.current;
      try {
        // Bound each user-requested jump. A retry continues from the retained cursor.
        for (let pages = 0; pageCursor && pages < 64; pages += 1) {
          if (signal?.aborted || requestGeneration !== generation.current)
            return false;
          const page = await readOlder(pageCursor, {
            adoptCursor: true,
            olderLoaded: true,
          });
          if (
            !page ||
            signal?.aborted ||
            requestGeneration !== generation.current
          )
            return false;
          if (containsWholeTurn(page.events)) return true;
          pageCursor = page.nextCursor;
        }
        return false;
      } finally {
        runOwedReload();
      }
    },
    [readOlder, runOwedReload],
  );

  // Page down from a reload's newest page until it runs unbroken to `floor`.
  // Older pages already loaded keep their own cursor, which sits past what is
  // held; otherwise the reader's cursor follows the fill, so Load older
  // resumes where it stopped. Bounded: past that, Load older reads on.
  const fillToFloor = useCallback(
    async (cursor: string, floor: number) => {
      const adoptCursor = !olderLoadedRef.current && !keptAwayRef.current;
      // Only held history can owe a gap: without older pages, the next reload
      // replaces this page and finds its own floor.
      pendingFloorRef.current = adoptCursor ? undefined : floor;
      let pageCursor: string | undefined = cursor;
      for (let pages = 0; pageCursor && pages < MAX_FILL_PAGES; pages += 1) {
        const page = await readOlder(pageCursor, {
          adoptCursor,
          olderLoaded: false,
        });
        // Superseded or failed: the floor stays owed to the next reload.
        if (!page) return;
        if (contiguousFrom(page) <= floor) {
          pendingFloorRef.current = undefined;
          return;
        }
        pageCursor = page.nextCursor;
      }
      // Bounded or out of pages: Load older owns the rest of the gap.
      pendingFloorRef.current = undefined;
      if (!adoptCursor && pageCursor && !heldGapsRef.current.length)
        setCursor(pageCursor);
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
    unsettledReloadRef.current = undefined;
    reloadOwedRef.current = false;
    olderLoadedRef.current = false;
    keptAwayRef.current = false;
    // The place belonged to the last conversation's list; this one's list
    // reports its own.
    readerPlaceRef.current = { away: false };
    pendingFloorRef.current = undefined;
    partialRef.current = new Set();
    closedRef.current = new Set();
    heldGapsRef.current = [];
    setPartialTurnStartEventIds(NO_PARTIAL_TURNS);
    if (recoveryTimerRef.current !== undefined) {
      clearTimeout(recoveryTimerRef.current);
      recoveryTimerRef.current = undefined;
    }
    setEvents([]);
    setChildObservation(undefined);
    setSessionLineage(undefined);
    setHandoffs([]);
    setContextBoundaries([]);
    setCursor(undefined);
    setWatermark(0);
    setMemoryContinuation(undefined);
    setError(undefined);
    setUpgradeRequired(false);
    // A new thread has not been read yet, whatever the previous one reported.
    setSettled(false);
    setSettledRevision(undefined);
    revalidatingRef.current = false;
    setRevalidating(false);
    windowStampRef.current = undefined;
    legacyFallbackOwedRef.current = false;
    // A window this client read recently paints at once, as a settled
    // reading; the read below revalidates and replaces it in place.
    const cached = readTranscriptWindow(cacheKeyRef.current);
    if (threadId && cached) {
      setEvents([...cached.events]);
      // Never the cached child: which Session is current is the server's
      // answer now, not the one this window last saw (`/open` may already
      // have bound a newer child, which an adopted stale id would undo).
      setSessionLineage(cached.sessionLineage);
      setHandoffs([...cached.handoffs]);
      setContextBoundaries([...cached.contextBoundaries]);
      setCursor(cached.cursor);
      setWatermark(cached.watermark);
      watermarkRef.current = cached.watermark;
      setMemoryContinuation(cached.memoryContinuation);
      partialRef.current = new Set(cached.partialTurnStartEventIds);
      setPartialTurnStartEventIds(new Set(cached.partialTurnStartEventIds));
      setSettled(true);
      setSettledRevision(reconcileRevisionRef.current);
      revalidatingRef.current = true;
      setRevalidating(true);
    }
    if (threadId) void reload();
    return () => {
      generation.current += 1;
      requestControllerRef.current?.abort();
      // A jump still unwinding must not start a read for a reader that is gone.
      unsettledReloadRef.current = undefined;
      reloadOwedRef.current = false;
      if (recoveryTimerRef.current !== undefined) {
        clearTimeout(recoveryTimerRef.current);
        recoveryTimerRef.current = undefined;
      }
      readerKeyRef.current = undefined;
    };
  }, [readerKey, reload, threadId]);

  // The fallback reads only a conversation that is its own Session, so it
  // waits for the reader to name the conversation itself (the child id was
  // cleared); then the failed read is owed once more.
  useEffect(() => {
    if (
      !threadId ||
      legacySessionId !== threadId ||
      !legacyFallbackOwedRef.current
    )
      return;
    legacyFallbackOwedRef.current = false;
    void reload();
  }, [legacySessionId, threadId, reload]);

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
    if (
      !threadId ||
      !currentReader ||
      (bound && station?.binding.affinity.kind !== 'host')
    )
      return;
    publishHistoryForCapture(apiBase, threadId, {
      events,
      currentSessionId,
      sessionLineage,
      handoffs,
      contextBoundaries,
      hasMore: Boolean(cursor || heldGapsRef.current.length),
      loading,
      settled,
      upgradeRequired,
      errorMessage: error?.message,
    });
  }, [
    apiBase,
    threadId,
    currentReader,
    bound,
    station,
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
      if (threadId && (!bound || station?.binding.affinity.kind === 'host'))
        removeHistoryForCapture(apiBase, threadId);
    },
    [apiBase, threadId, bound, station],
  );
  // Keep the reopen copy at what a settled, current read holds. A reader
  // still owing a gap fill holds a window the cache could not reproduce.
  useEffect(() => {
    if (
      !currentReader ||
      !settled ||
      loading ||
      revalidating ||
      error ||
      upgradeRequired ||
      events.length === 0 ||
      heldGapsRef.current.length > 0
    )
      return;
    const stamp = windowStampRef.current;
    if (!stamp || stamp.key !== cacheKey) return;
    writeTranscriptWindow(
      cacheKey,
      {
        events,
        ...(cursor ? { cursor } : {}),
        watermark,
        ...(sessionLineage ? { sessionLineage } : {}),
        handoffs,
        contextBoundaries,
        ...(memoryContinuation ? { memoryContinuation } : {}),
        partialTurnStartEventIds: [...partialTurnStartEventIds],
      },
      stamp.generation,
    );
  }, [
    cacheKey,
    currentReader,
    settled,
    loading,
    revalidating,
    error,
    upgradeRequired,
    events,
    cursor,
    watermark,
    sessionLineage,
    handoffs,
    contextBoundaries,
    memoryContinuation,
    partialTurnStartEventIds,
  ]);
  return {
    events: currentReader ? events : [],
    partialTurnStartEventIds: currentReader
      ? partialTurnStartEventIds
      : NO_PARTIAL_TURNS,
    watermark: currentReader ? watermark : 0,
    memoryContinuation: currentReader ? memoryContinuation : undefined,
    ...(currentReader && currentSessionId ? { currentSessionId } : {}),
    ...(currentReader && currentSessionId && childObservation?.materialized
      ? { executionRead: childObservation }
      : {}),
    ...(currentReader && sessionLineage ? { sessionLineage } : {}),
    handoffs: currentReader ? handoffs : [],
    contextBoundaries: currentReader ? contextBoundaries : [],
    hasMore: currentReader && Boolean(cursor || heldGapsRef.current.length),
    loadOlder,
    loadTurn,
    reload,
    setReaderPlace,
    upgradeRequired: currentReader && upgradeRequired,
    loading: currentReader ? loading : Boolean(threadId),
    settled: currentReader && settled,
    revalidating: currentReader && revalidating,
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

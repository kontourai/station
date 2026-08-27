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

export interface SessionEventWindowReader {
  events: OrchestrationSequencedEvent[];
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
  error?: Error;
}

async function readConversationWindow(
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
      input,
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
      input,
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

/** REST-only bounded session history. Live content remains app-wide SSE state. */
export function useSessionEventWindow(
  apiBase: string,
  threadId: string | null,
  reconcileRevision = 0,
  legacySessionId?: string,
): SessionEventWindowReader {
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
  const [upgradeRequired, setUpgradeRequired] = useState(false);
  const [error, setError] = useState<Error>();
  const generation = useRef(0);
  const readerKeyRef = useRef<string | undefined>(undefined);
  const cursorRef = useRef<string | undefined>(undefined);
  const watermarkRef = useRef(0);
  const olderLoadedRef = useRef(false);
  const requestSerialRef = useRef(0);
  const requestControllerRef = useRef<AbortController | undefined>(undefined);
  const recoveryTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  cursorRef.current = cursor;
  watermarkRef.current = watermark;

  const reload = useCallback(async () => {
    if (!threadId) return;
    if (recoveryTimerRef.current !== undefined) {
      clearTimeout(recoveryTimerRef.current);
      recoveryTimerRef.current = undefined;
    }
    const requestGeneration = generation.current;
    const requestSerial = ++requestSerialRef.current;
    requestControllerRef.current?.abort();
    const controller = new AbortController();
    requestControllerRef.current = controller;
    setLoading(true);
    setError(undefined);
    try {
      const capability = await fetchSessionEventWindowCapability(apiBase);
      if (capability !== true) {
        if (requestGeneration !== generation.current) return;
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
      setUpgradeRequired(false);
      setCurrentSessionId(page.currentSessionId);
      setSessionLineage(page.sessionLineage);
      setHandoffs(page.handoffs ?? []);
      setContextBoundaries(page.contextBoundaries ?? []);
      const next = page.events;
      const replacementBoundary = next.reduce(
        (minimum, item) => Math.min(minimum, item.sequence),
        Number.POSITIVE_INFINITY,
      );
      setEvents((current) =>
        olderLoadedRef.current
          ? mergePages(
              current.filter((item) => item.sequence < replacementBoundary),
              next,
            )
          : mergePages([], next),
      );
      if (!olderLoadedRef.current) setCursor(page.nextCursor);
      setWatermark(page.watermark);
    } catch (cause) {
      if (controller.signal.aborted) return;
      if (
        requestGeneration !== generation.current ||
        requestSerial !== requestSerialRef.current
      )
        return;
      const failure = cause instanceof Error ? cause : new Error(String(cause));
      setError(failure);
      setUpgradeRequired(false);
    } finally {
      if (
        requestGeneration === generation.current &&
        requestSerial === requestSerialRef.current
      )
        setLoading(false);
    }
  }, [apiBase, legacySessionId, threadId]);

  const loadOlder = useCallback(async () => {
    const pageCursor = cursorRef.current;
    if (!threadId || !pageCursor) return;
    const requestGeneration = generation.current;
    const requestSerial = ++requestSerialRef.current;
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
        return;
      setCurrentSessionId(page.currentSessionId);
      setSessionLineage(page.sessionLineage);
      setHandoffs(page.handoffs ?? []);
      setContextBoundaries(page.contextBoundaries ?? []);
      if (page.watermark !== watermarkRef.current) {
        await reload();
        return;
      }
      setEvents((current) => mergePages(page.events, current));
      olderLoadedRef.current = true;
      setCursor(page.nextCursor);
    } catch (cause) {
      if (controller.signal.aborted) return;
      if (requestGeneration !== generation.current) return;
      setError(cause instanceof Error ? cause : new Error(String(cause)));
    } finally {
      if (
        requestGeneration === generation.current &&
        requestSerial === requestSerialRef.current
      )
        setLoading(false);
    }
  }, [apiBase, legacySessionId, reload, threadId]);

  useEffect(() => {
    const readerKey = threadId ? `${apiBase}\u0000${threadId}` : undefined;
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
    if (threadId) void reload();
    return () => {
      requestControllerRef.current?.abort();
      if (recoveryTimerRef.current !== undefined) {
        clearTimeout(recoveryTimerRef.current);
        recoveryTimerRef.current = undefined;
      }
      readerKeyRef.current = undefined;
    };
  }, [apiBase, reload, threadId]);

  const previousRevision = useRef(reconcileRevision);
  useEffect(() => {
    if (previousRevision.current === reconcileRevision) return;
    previousRevision.current = reconcileRevision;
    if (threadId) void reload();
  }, [reconcileRevision, reload, threadId]);

  return {
    events,
    ...(currentSessionId ? { currentSessionId } : {}),
    ...(sessionLineage ? { sessionLineage } : {}),
    handoffs,
    contextBoundaries,
    hasMore: Boolean(cursor),
    loadOlder,
    reload,
    upgradeRequired,
    loading,
    error,
  };
}

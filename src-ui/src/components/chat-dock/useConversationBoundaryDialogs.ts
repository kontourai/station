import { useConversationContextBoundaryStatusQuery } from '@kontourai/station-sdk';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AgentData } from '../../contexts/AgentsContext';
import { useOutboundQueueSnapshot } from '../../hooks/useOutboundQueueSnapshot';
import type { ChatSession } from '../../types';
import {
  type EffectiveModelSource,
  isSessionExecutionActive,
} from '../../utils/execution';
import { agentRunnability } from '../agent-runnability';
import {
  readConversationContextBoundaryUiState,
  writeConversationContextBoundaryUiState,
} from './conversationContextBoundaryUiState';

/**
 * The three conversation-boundary overlays the dock owns — Agent handoff,
 * fork-from-turn, and context reset — as one state object.
 *
 * They are one cluster because they answer one question: whether this
 * conversation may be re-anchored right now, and onto what. The handoff
 * blocked-reason, the persisted context-boundary projection and its polling,
 * and the fork attempt's abort/generation bookkeeping all read the same
 * active session.
 *
 * `ConversationBoundaryDialogs` renders the handoff and context-reset
 * dialogs from this object; the fork members are consumed by the dock's
 * `ChatDockModalStack` and its transcript fork affordance.
 */
export function useConversationBoundaryDialogs({
  agents,
  apiBase,
  activeSession,
  allSessions,
}: {
  agents: AgentData[];
  apiBase: string;
  activeSession: ChatSession | null;
  allSessions: ChatSession[];
}) {
  const handoffReturnFocusRef = useRef<HTMLButtonElement | null>(null);
  const [handoffSource, setHandoffSource] = useState<{
    id: string;
    agentSlug: string;
  } | null>(null);
  const [forkSource, setForkSource] = useState<{
    id: string;
    agentSlug: string;
    turnId: string;
    projectSlug?: string;
    projectName?: string;
    model?: string;
    modelSource?: EffectiveModelSource;
    defaultModel?: string;
    defaultModelSource?: EffectiveModelSource;
    providerOptions?: Record<string, unknown>;
    providerId?: string;
    providerType?: string;
    sourceSessionId?: string;
    idempotencyKey: string;
  } | null>(null);
  const [forkOperation, setForkOperation] = useState<{
    pending: boolean;
    error: string | null;
  }>({ pending: false, error: null });
  const forkAbortRef = useRef<AbortController | null>(null);
  const forkGenerationRef = useRef(0);
  const cancelFork = useCallback(() => {
    forkGenerationRef.current += 1;
    forkAbortRef.current?.abort();
    forkAbortRef.current = null;
    setForkOperation({ pending: false, error: null });
    setForkSource(null);
  }, []);
  const forkEligibleAgents = useMemo(() => {
    if (!forkSource) return agents;
    return agents
      .filter((agent) => agentRunnability(agent).runnable)
      .sort((left, right) => {
        if (left.slug === forkSource.agentSlug) return -1;
        if (right.slug === forkSource.agentSlug) return 1;
        return 0;
      });
  }, [agents, forkSource]);
  const [contextResetSource, setContextResetSource] = useState<{
    id: string;
  } | null>(null);

  const activeConversationId = activeSession?.conversationId ?? '';
  const [contextBoundaryStored, setContextBoundaryStored] = useState(() =>
    activeConversationId
      ? readConversationContextBoundaryUiState(activeConversationId)
      : null,
  );
  useEffect(() => {
    setContextBoundaryStored(
      activeConversationId
        ? readConversationContextBoundaryUiState(activeConversationId)
        : null,
    );
    const onStorage = () =>
      setContextBoundaryStored(
        activeConversationId
          ? readConversationContextBoundaryUiState(activeConversationId)
          : null,
      );
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [activeConversationId]);
  // The SDK owns this read (`useConversationContextBoundaryStatusQuery`), and
  // `ConversationContextResetDialog` — the dock's own overlay for the same
  // conversation — already calls it. This used to be a second, hand-rolled
  // query against the same endpoint under a different key, so a dock with the
  // dialog open ran two caches and two two-second timers over one status.
  // Same call shape as the dialog's, so both observe one cache entry.
  const contextBoundaryStatusQuery = useConversationContextBoundaryStatusQuery(
    activeConversationId,
    contextBoundaryStored?.idempotencyKey ?? '',
    apiBase,
    { enabled: Boolean(contextBoundaryStored), refetchInterval: 2_000 },
  );
  useEffect(() => {
    if (!contextBoundaryStored || !contextBoundaryStatusQuery.data) return;
    if (
      contextBoundaryStored.status === contextBoundaryStatusQuery.data.status &&
      contextBoundaryStored.boundaryId ===
        contextBoundaryStatusQuery.data.boundaryId &&
      contextBoundaryStored.policy === contextBoundaryStatusQuery.data.policy
    )
      return;
    setContextBoundaryStored(
      writeConversationContextBoundaryUiState(
        contextBoundaryStored.idempotencyKey,
        contextBoundaryStatusQuery.data,
      ),
    );
  }, [contextBoundaryStatusQuery.data, contextBoundaryStored]);

  // The queue publishes every durable transition through its own
  // subscription, so this reads a cached projection and is told when it
  // changed. It used to re-read IndexedDB once a second for a value that only
  // moves when the user queues, sends, or discards a message.
  const durableHandoffQueue = useOutboundQueueSnapshot(
    Boolean(activeSession?.conversationId),
  );
  const durableHandoffQueueCount = durableHandoffQueue.turns.filter(
    (turn) =>
      turn.conversationId === activeSession?.conversationId ||
      turn.sessionId === activeSession?.id,
  ).length;
  const contextBoundaryStatus =
    contextBoundaryStatusQuery.data?.status ?? contextBoundaryStored?.status;
  const contextBoundaryLabel =
    contextBoundaryStatus === 'reserved'
      ? `Next engine start: ${(contextBoundaryStatusQuery.data?.policy ?? contextBoundaryStored?.policy) === 'empty-next-cold-start' ? 'Empty' : 'Re-anchor'}`
      : contextBoundaryStatus === 'claimed'
        ? 'Engine start reconciling'
        : contextBoundaryStatus === 'indeterminate'
          ? 'Engine start needs inspection'
          : contextBoundaryStatus === 'failed'
            ? 'Start failed; retry available'
            : undefined;
  const hasLocalDeferredMessages = Boolean(
    activeSession?.queuedMessages?.length ||
      activeSession?.queuedMessageFailure ||
      activeSession?.unsentMessages?.length,
  );
  const contextBoundarySessionId =
    activeSession?.currentSessionId ?? activeSession?.id;
  const handoffDisabledReason = !activeSession?.conversationId
    ? 'Send a message before changing Agent.'
    : isSessionExecutionActive(activeSession)
      ? 'Wait for the current turn to finish before changing Agent.'
      : hasLocalDeferredMessages
        ? 'Resolve queued or offline messages before changing Agent.'
        : durableHandoffQueue.status === 'pending'
          ? 'Checking queued messages before changing Agent.'
          : durableHandoffQueue.status === 'error'
            ? 'Queued message state is unavailable. Try again.'
            : durableHandoffQueueCount > 0
              ? 'Resolve queued or offline messages before changing Agent.'
              : undefined;

  const openConversationHandoff = useCallback(
    (returnFocusTarget: HTMLButtonElement | null) => {
      if (!activeSession?.conversationId) return;
      handoffReturnFocusRef.current = returnFocusTarget;
      setHandoffSource({
        id: activeSession.conversationId,
        agentSlug: activeSession.agentSlug,
      });
    },
    [activeSession],
  );

  const handoffSession = handoffSource
    ? allSessions.find(
        (session) =>
          session.conversationId === handoffSource.id ||
          session.id === handoffSource.id,
      )
    : undefined;

  return {
    handoffReturnFocusRef,
    handoffSource,
    setHandoffSource,
    handoffSession,
    handoffDisabledReason,
    openConversationHandoff,
    forkSource,
    setForkSource,
    forkOperation,
    setForkOperation,
    forkAbortRef,
    forkGenerationRef,
    cancelFork,
    forkEligibleAgents,
    contextResetSource,
    setContextResetSource,
    setContextBoundaryStored,
    contextBoundaryLabel,
    contextBoundarySessionId,
    hasLocalDeferredMessages,
  };
}

export type ConversationBoundaryDialogsState = ReturnType<
  typeof useConversationBoundaryDialogs
>;

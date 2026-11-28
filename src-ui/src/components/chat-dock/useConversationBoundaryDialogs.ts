import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { chatBelongsToStation } from '../../connections/station-state';
import { activeChatsStore } from '../../contexts/active-chats-store';
import { useOutboundQueueSnapshot } from '../../hooks/useOutboundQueueSnapshot';
import type { ChatSession, FileAttachment } from '../../types';
import {
  type EffectiveModelSource,
  isSessionExecutionActive,
} from '../../utils/execution';
import type { SelectableModel } from '../../utils/modelCapabilities';
import {
  type ContextBoundaryAuthority,
  observeContextBoundary,
  useContextBoundaryRecovery,
} from './conversationContextBoundaryUiState';

interface ForkSourceView {
  id: string;
  conversationId?: string;
}

export interface ForkFollowUp {
  mode: 'regenerate' | 'edit';
  text: string;
  attachments: FileAttachment[];
}

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
 * `ConversationBoundaryDialogs` renders the handoff, fork and context-reset
 * dialogs from this object; the dock's `runFork` drives the fork members.
 */
export function useConversationBoundaryDialogs({
  apiBase,
  activeSession,
  allSessions,
  contextBoundaryAuthority,
  forkScope,
  forkViewId,
}: {
  apiBase: string;
  activeSession: ChatSession | null;
  allSessions: ChatSession[];
  contextBoundaryAuthority?: ContextBoundaryAuthority;
  forkScope?: string;
  forkViewId?: string;
}) {
  const handoffReturnFocusRef = useRef<
    HTMLButtonElement | HTMLTextAreaElement | null
  >(null);
  const [handoffSource, setHandoffSource] = useState<{
    id: string;
    agentSlug: string;
    executionPreset?: { executionAgentId?: string; modelId?: string };
    /**
     * Each open is a new dialog: the dialog is keyed by this, so one chat's
     * request state can never carry into another's picker.
     */
    nonce: number;
  } | null>(null);
  const nextNonce = useRef(0);
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
    /**
     * #4406: what the fork does once open — Regenerate sends the message
     * again, Edit and resend puts it in the composer.
     */
    followUp?: ForkFollowUp;
    /**
     * Regenerate / Edit and resend with a runnable Agent: the fork runs
     * without the dialog, which appears only if it fails.
     */
    quiet?: boolean;
  } | null>(null);
  const [forkOperation, setForkOperation] = useState<{
    pending: boolean;
    error: string | null;
  }>({ pending: false, error: null });
  const forkAbortRef = useRef<AbortController | null>(null);
  const forkGenerationRef = useRef(0);
  const forkIntentRef = useRef<{
    view: ForkSourceView;
    scope: string | undefined;
    isAuthorityCurrent: () => boolean;
    selectingDestination: boolean;
    unsubscribe: () => void;
  } | null>(null);
  const retireFork = useCallback(() => {
    forkGenerationRef.current += 1;
    forkIntentRef.current?.unsubscribe();
    forkIntentRef.current = null;
    forkAbortRef.current?.abort();
    forkAbortRef.current = null;
  }, []);
  useLayoutEffect(() => retireFork, [retireFork]);
  const cancelFork = useCallback(() => {
    retireFork();
    setForkOperation({ pending: false, error: null });
    setForkSource(null);
  }, [retireFork]);
  const isForkIntentCurrent = useCallback(() => {
    const intent = forkIntentRef.current;
    if (!intent?.isAuthorityCurrent()) return false;
    const chat = activeChatsStore.getSnapshot()[intent.view.id];
    return Boolean(
      chat &&
        chatBelongsToStation(chat) &&
        chat.conversationId === intent.view.conversationId,
    );
  }, []);
  useLayoutEffect(() => {
    const intent = forkIntentRef.current;
    if (
      intent &&
      (!isForkIntentCurrent() ||
        (!intent.selectingDestination &&
          (intent.scope !== forkScope ||
            (forkViewId && forkViewId !== intent.view.id))))
    ) {
      cancelFork();
    }
  }, [cancelFork, forkScope, forkViewId, isForkIntentCurrent]);
  const beginForkIntent = (
    view: ForkSourceView,
    isAuthorityCurrent: () => boolean,
  ) => {
    cancelFork();
    forkIntentRef.current = {
      view,
      scope: forkScope,
      isAuthorityCurrent,
      selectingDestination: false,
      // Observe removal before a close/reopen can reuse the same local ID.
      unsubscribe: activeChatsStore.subscribe(() => {
        if (!isForkIntentCurrent()) cancelFork();
      }),
    };
    return forkGenerationRef.current;
  };
  const moveForkIntentToLiveView = (view: ForkSourceView) => {
    if (forkIntentRef.current) forkIntentRef.current.view = view;
  };
  const selectForkDestination = () => {
    if (forkIntentRef.current)
      forkIntentRef.current.selectingDestination = true;
  };
  const [contextResetSource, setContextResetSource] = useState<{
    id: string;
  } | null>(null);

  const activeConversationId = activeSession?.conversationId ?? '';
  const open = activeSession?.conversationOpenState;
  const contextBoundarySessionId =
    open?.status === 'fresh-context-ready' &&
    open.conversation.id === activeConversationId
      ? open.predecessorSessionId
      : (activeSession?.currentSessionId ?? activeSession?.id);
  const scope =
    contextBoundaryAuthority && activeConversationId && contextBoundarySessionId
      ? {
          ...contextBoundaryAuthority,
          conversationId: activeConversationId,
          sessionId: contextBoundarySessionId,
        }
      : undefined;
  const { candidate: contextBoundaryCandidate, boundary: contextBoundary } =
    useContextBoundaryRecovery(scope, apiBase);
  useEffect(() => {
    if (scope && contextBoundaryCandidate && contextBoundary)
      observeContextBoundary(scope, contextBoundaryCandidate, contextBoundary);
  }, [scope, contextBoundaryCandidate, contextBoundary]);

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
  const contextBoundaryStatus = contextBoundary?.status;
  const contextBoundaryLabel =
    contextBoundaryCandidate &&
    !contextBoundaryCandidate.legacy &&
    !contextBoundaryStatus
      ? 'Check reset status'
      : contextBoundaryStatus === undefined &&
          !activeSession?.orchestrationSessionStarted &&
          !activeSession?.conversationOpenPending &&
          !activeSession?.conversationOpenFailed &&
          open?.status === 'fresh-context-ready' &&
          open.conversation.id === activeSession?.conversationId &&
          open.canContinue &&
          open.callerAccess?.continue !== false
        ? 'Next message starts fresh'
        : contextBoundaryStatus === 'reserved'
          ? `Next message: ${contextBoundary?.policy === 'empty-next-cold-start' ? 'starts fresh' : 'continues'}`
          : contextBoundaryStatus === 'claimed'
            ? 'Reset in progress'
            : contextBoundaryStatus === 'indeterminate'
              ? 'Reset unconfirmed, check the chat'
              : contextBoundaryStatus === 'failed'
                ? 'Reset failed, retry available'
                : undefined;
  const hasLocalDeferredMessages = Boolean(
    activeSession?.queuedMessages?.length ||
      activeSession?.queuedMessageFailure ||
      activeSession?.unsentMessages?.length,
  );
  // One reason gates every boundary action this hook owns: continuing with
  // another Agent, switching engines, and replacing engine context. The words
  // therefore name no single action; each surface supplies its own subject.
  const handoffDisabledReason = !activeSession?.conversationId
    ? 'Send a message first.'
    : isSessionExecutionActive(activeSession)
      ? 'Wait for the current turn to finish.'
      : hasLocalDeferredMessages
        ? 'Send or discard queued messages first.'
        : durableHandoffQueue.status === 'pending'
          ? 'Checking queued messages…'
          : durableHandoffQueue.status === 'error'
            ? 'Queued message state is unavailable. Try again.'
            : durableHandoffQueueCount > 0
              ? 'Send or discard queued messages first.'
              : undefined;

  const openConversationHandoff = useCallback(
    (returnFocusTarget: HTMLButtonElement | HTMLTextAreaElement | null) => {
      if (!activeSession?.conversationId) return;
      handoffReturnFocusRef.current = returnFocusTarget;
      setHandoffSource({
        id: activeSession.conversationId,
        agentSlug: activeSession.agentSlug,
        nonce: ++nextNonce.current,
      });
    },
    [activeSession],
  );

  const openExecutionHandoff = useCallback(
    (
      model?: SelectableModel,
      returnFocusTarget?: HTMLTextAreaElement | null,
    ) => {
      if (!activeSession?.conversationId) return;
      // The engine picker owns no button to return to; the dialog returns
      // focus to the composer instead.
      handoffReturnFocusRef.current = returnFocusTarget ?? null;
      setHandoffSource({
        id: activeSession.conversationId,
        agentSlug: activeSession.agentSlug,
        nonce: ++nextNonce.current,
        executionPreset: {
          executionAgentId: model?.executionAgentId,
          modelId: model?.id,
        },
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
  // The source chat was deleted or closed: its dialog has nothing to render
  // into, so the held source is dropped.
  const sourceGone = Boolean(handoffSource && !handoffSession);
  useEffect(() => {
    if (sourceGone) setHandoffSource(null);
  }, [sourceGone]);

  return {
    handoffReturnFocusRef,
    handoffSource,
    setHandoffSource,
    handoffSession,
    handoffDisabledReason,
    openConversationHandoff,
    openExecutionHandoff,
    forkSource,
    setForkSource,
    forkOperation,
    setForkOperation,
    forkAbortRef,
    forkGenerationRef,
    cancelFork,
    beginForkIntent,
    isForkIntentCurrent,
    moveForkIntentToLiveView,
    selectForkDestination,
    contextResetSource,
    setContextResetSource,
    contextBoundaryAuthority,
    contextBoundaryLabel,
    contextBoundarySessionId,
    hasLocalDeferredMessages,
  };
}

export type ConversationBoundaryDialogsState = ReturnType<
  typeof useConversationBoundaryDialogs
>;

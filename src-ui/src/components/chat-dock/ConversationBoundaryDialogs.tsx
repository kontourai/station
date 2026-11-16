import {
  conversationQueries,
  type OrchestrationSessionSummary,
  orchestrationQueries,
  useInvalidateQuery,
  useOrchestrationSessionsQuery,
} from '@kontourai/station-sdk';
import type { RefObject } from 'react';
import {
  activeChatsStore,
  useActiveChatActions,
} from '../../contexts/ActiveChatsContext';
import type { AgentData } from '../../contexts/AgentsContext';
import { chatDraftsStore } from '../../contexts/chat-drafts-store';
import type { ProjectMetadata } from '../../contexts/ProjectsContext';
import type { useToast } from '../../contexts/ToastContext';
import type { useChatInput } from '../../hooks/useChatInput';
import type { ChatSession } from '../../types';
import { ConversationContextResetDialog } from './ConversationContextResetDialog';
import { ConversationHandoffDialog } from './ConversationHandoffDialog';
import { writeConversationContextBoundaryUiState } from './conversationContextBoundaryUiState';
import {
  acceptConversationHandoffUiState,
  beginConversationHandoffUiState,
  refuseConversationHandoffUiState,
} from './conversationHandoffUiState';
import type { ConversationBoundaryDialogsState } from './useConversationBoundaryDialogs';

/**
 * The dock's Agent-handoff and context-reset overlays.
 *
 * Both are driven entirely by `useConversationBoundaryDialogs`; everything
 * else this takes is the ambient dock context the two dialogs report back
 * into (the composer's draft, the active-chat store, the query cache and the
 * toast surface). Splitting them out of `ChatWorkspacePane` keeps that
 * reporting-back visible as a prop list instead of closure capture.
 *
 * This module IS the dock's boundary-dialog chunk: `ChatWorkspacePane` mounts
 * it through `LazyBoundary` only once a boundary source is set, and it imports
 * both dialogs statically. So opening either one costs a single dynamic import
 * that carries both, rather than a nested pair. Nothing here is fetched at
 * dock mount.
 */
export function ConversationBoundaryDialogs({
  dialogs,
  apiBase,
  agents,
  projects,
  activeSession,
  activeOrchestrationSession,
  activeOrchestrationSessionRead,
  chatInput,
  composerMenuTriggerRef,
  updateChat,
  focusSessionInPane,
  invalidate,
  showToast,
  refetchOrchestrationSessions,
}: {
  dialogs: ConversationBoundaryDialogsState;
  apiBase: string;
  agents: AgentData[];
  projects: ProjectMetadata[];
  activeSession: ChatSession | null;
  activeOrchestrationSession: OrchestrationSessionSummary | null;
  activeOrchestrationSessionRead: 'pending' | 'error' | 'present' | 'absent';
  chatInput: Pick<
    ReturnType<typeof useChatInput>,
    | 'input'
    | 'attachments'
    | 'quotes'
    | 'textareaRef'
    | 'prepareOutgoingText'
    | 'handleClearInput'
    | 'handleClearAttachments'
  >;
  composerMenuTriggerRef: RefObject<HTMLButtonElement | null>;
  updateChat: ReturnType<typeof useActiveChatActions>['updateChat'];
  focusSessionInPane: (sessionId: string) => void;
  invalidate: ReturnType<typeof useInvalidateQuery>;
  showToast: ReturnType<typeof useToast>['showToast'];
  refetchOrchestrationSessions: ReturnType<
    typeof useOrchestrationSessionsQuery
  >['refetch'];
}) {
  const {
    handoffSource,
    setHandoffSource,
    handoffSession,
    handoffDisabledReason,
    handoffReturnFocusRef,
    setArmedHandoff,
    setArmedHandoffPhase,
    contextResetSource,
    setContextResetSource,
    contextBoundarySessionId,
    setContextBoundaryStored,
    hasLocalDeferredMessages,
  } = dialogs;
  const { clearInput, clearDraft } = useActiveChatActions();
  const handoffIsActive = handoffSession?.id === activeSession?.id;
  return (
    <>
      {handoffSource && handoffSession?.conversationId && (
        <ConversationHandoffDialog
          // A new dialog per open: request state never crosses chats.
          key={`${handoffSource.id}\0${handoffSource.nonce}`}
          apiBase={apiBase}
          conversationId={handoffSession.conversationId}
          sessionId={handoffSession.id}
          currentAgentId={handoffSession.agentSlug}
          executionPreset={handoffSource.executionPreset}
          autoSubmit={handoffSource.autoSubmit}
          // An armed send keeps running when the person opens another chat;
          // anything it needs them for waits until they return to its own.
          suspended={Boolean(handoffSource.autoSubmit) && !handoffIsActive}
          prepareDraft={
            handoffIsActive ? chatInput.prepareOutgoingText : undefined
          }
          draftQuotes={handoffIsActive ? chatInput.quotes : undefined}
          onPhaseChange={setArmedHandoffPhase}
          onArm={(armed) => {
            setArmedHandoff(armed);
            setHandoffSource(null);
            // The next step is typing the message the choice applies to.
            requestAnimationFrame(() => chatInput.textareaRef.current?.focus());
          }}
          projectSlug={handoffSession.projectSlug}
          agents={agents}
          projects={projects}
          initialMessage={
            handoffSession.id === activeSession?.id ? chatInput.input : ''
          }
          attachments={
            handoffSession.id === activeSession?.id ? chatInput.attachments : []
          }
          blockedReason={
            handoffSession.id === activeSession?.id
              ? handoffDisabledReason
              : undefined
          }
          onDispatchStarted={({ message, clientTurnId }) => {
            const state = activeChatsStore.getSnapshot()[handoffSession.id];
            updateChat(
              handoffSession.id,
              beginConversationHandoffUiState(state, {
                message,
                clientTurnId,
                now: Date.now(),
              }),
            );
          }}
          onDefiniteFailure={(clientTurnId) => {
            const state = activeChatsStore.getSnapshot()[handoffSession.id];
            updateChat(
              handoffSession.id,
              refuseConversationHandoffUiState(state, clientTurnId),
            );
          }}
          onClose={() => {
            setHandoffSource(null);
            // The engine picker has no trigger to return to: the composer.
            requestAnimationFrame(() =>
              (
                handoffReturnFocusRef.current ?? chatInput.textareaRef.current
              )?.focus(),
            );
          }}
          onAccepted={({
            receipt,
            target,
            targetId,
            clearsComposer,
            sentQuotes,
          }) => {
            const state = activeChatsStore.getSnapshot()[handoffSession.id];
            updateChat(
              handoffSession.id,
              acceptConversationHandoffUiState(
                state,
                target,
                receipt,
                agents.find(
                  (agent) => agent.slug === receipt.target.executionAgentId,
                ),
              ),
            );
            setArmedHandoff(null, handoffSession.conversationId);
            const armedDraft = handoffSource.armedDraft;
            if (armedDraft) {
              // The armed send came from its own chat's composer: clear that
              // chat's draft (it was sent), wherever the person is now, and
              // leave the screen where they put it.
              if (clearsComposer) {
                const now =
                  activeChatsStore.getSnapshot()[armedDraft.sessionId];
                if ((now?.input ?? '') === armedDraft.draft) {
                  clearInput(armedDraft.sessionId);
                  clearDraft(armedDraft.sessionId);
                }
                chatDraftsStore.consumeQuotes(
                  armedDraft.sessionId,
                  armedDraft.quotes,
                );
              }
            } else if (handoffIsActive) {
              if (clearsComposer) {
                chatInput.handleClearInput();
                chatInput.handleClearAttachments();
                chatDraftsStore.consumeQuotes(handoffSession.id, sentQuotes);
              }
            } else {
              focusSessionInPane(handoffSession.id);
            }
            invalidate(orchestrationQueries.sessions().queryKey);
            invalidate(conversationQueries.inventory().queryKey);
            setHandoffSource(null);
            if (!armedDraft)
              requestAnimationFrame(() =>
                handoffReturnFocusRef.current?.focus(),
              );
            showToast(
              `Continuing with ${target?.name ?? `deleted Agent “${targetId}”`}`,
              'success',
            );
          }}
        />
      )}
      {contextResetSource &&
        activeSession?.conversationId === contextResetSource.id && (
          <ConversationContextResetDialog
            apiBase={apiBase}
            conversationId={activeSession.conversationId}
            sessionId={contextBoundarySessionId ?? activeSession.id}
            session={activeSession}
            sessionRead={activeOrchestrationSessionRead}
            orchestrationSession={activeOrchestrationSession}
            hasLocalDeferredMessages={hasLocalDeferredMessages}
            onStoppedSessionRefreshed={async () => {
              const refreshed = await refetchOrchestrationSessions();
              return (
                refreshed.data?.find(
                  (session) =>
                    session.threadId ===
                    (contextBoundarySessionId ?? activeSession.id),
                ) ?? null
              );
            }}
            onClose={() => {
              setContextResetSource(null);
              requestAnimationFrame(() =>
                composerMenuTriggerRef.current?.focus(),
              );
            }}
            onReserved={(boundary, idempotencyKey) => {
              setContextBoundaryStored(
                writeConversationContextBoundaryUiState(
                  idempotencyKey,
                  boundary,
                ),
              );
              invalidate(orchestrationQueries.sessions().queryKey);
              if (boundary.status === 'reserved')
                showToast('Agent context reset is ready', 'success');
            }}
          />
        )}
    </>
  );
}

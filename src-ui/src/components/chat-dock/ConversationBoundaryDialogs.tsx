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
  type useActiveChatActions,
  useActiveChatSelector,
} from '../../contexts/ActiveChatsContext';
import type { AgentData } from '../../contexts/AgentsContext';
import { chatDraftsStore } from '../../contexts/chat-drafts-store';
import type { ProjectMetadata } from '../../contexts/ProjectsContext';
import type { useToast } from '../../contexts/ToastContext';
import type { useChatInput } from '../../hooks/useChatInput';
import type { ChatSession } from '../../types';
import { ConversationContextResetDialog } from './ConversationContextResetDialog';
import { ConversationHandoffDialog } from './ConversationHandoffDialog';
import type { ContinuedOnStation } from './ConversationStationHandoff';
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
  continueOnStation,
  onStageAgentChange,
  handoffAvailable = true,
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
  >;
  composerMenuTriggerRef: RefObject<HTMLButtonElement | null>;
  updateChat: ReturnType<typeof useActiveChatActions>['updateChat'];
  focusSessionInPane: (sessionId: string) => void;
  invalidate: ReturnType<typeof useInvalidateQuery>;
  showToast: ReturnType<typeof useToast>['showToast'];
  refetchOrchestrationSessions: ReturnType<
    typeof useOrchestrationSessionsQuery
  >['refetch'];
  handoffAvailable?: boolean;
  onStageAgentChange?: React.ComponentProps<
    typeof ConversationHandoffDialog
  >['onStage'];
  /** Opens the paired Station's new chat and sends its first turn there. */
  continueOnStation?: (
    result: ContinuedOnStation,
    sourceTitle?: string,
  ) => void;
}) {
  const {
    handoffSource,
    setHandoffSource,
    handoffSession,
    handoffDisabledReason,
    handoffReturnFocusRef,
    contextResetSource,
    setContextResetSource,
    contextBoundarySessionId,
    contextBoundaryAuthority,
    hasLocalDeferredMessages,
  } = dialogs;
  const handoffIsActive = handoffSession?.id === activeSession?.id;
  // The client turn this chat is busy with (the handoff's own dispatch marks
  // it `handoff:<key>`), read live from the chat store.
  const handoffBusyTurnId = useActiveChatSelector(
    handoffSession?.id ?? '',
    (chat) => chat?.pendingClientTurnId,
  );
  return (
    <>
      {handoffAvailable && handoffSource && handoffSession?.conversationId && (
        <ConversationHandoffDialog
          // A new dialog per open: request state never crosses chats.
          key={`${handoffSource.id}\0${handoffSource.nonce}`}
          apiBase={apiBase}
          conversationId={handoffSession.conversationId}
          sessionId={handoffSession.id}
          currentAgentId={handoffSession.agentSlug}
          onStage={handoffIsActive ? onStageAgentChange : undefined}
          executionPreset={handoffSource.executionPreset}
          prepareDraft={
            handoffIsActive ? chatInput.prepareOutgoingText : undefined
          }
          draftQuotes={handoffIsActive ? chatInput.quotes : undefined}
          busyTurnId={handoffBusyTurnId}
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
            requestAnimationFrame(() => {
              // The trigger can be gone (Run setup closed on a phone, or the
              // engine picker has none): fall back to the composer.
              const trigger = handoffReturnFocusRef.current;
              (trigger?.isConnected
                ? trigger
                : chatInput.textareaRef.current
              )?.focus();
            });
          }}
          // Only a chat this Station owns can be carried to a paired one.
          {...(continueOnStation &&
          (!handoffSession.stationBinding ||
            handoffSession.stationBinding.affinity.kind === 'host')
            ? {
                onContinuedOnStation: (result: ContinuedOnStation) => {
                  // As for an Agent handoff: a draft that became the first
                  // message leaves the composer with its quotes.
                  if (handoffIsActive && result.clearsComposer) {
                    chatInput.handleClearInput();
                    chatDraftsStore.consumeQuotes(
                      handoffSession.id,
                      result.sentQuotes,
                    );
                  }
                  setHandoffSource(null);
                  continueOnStation(result, handoffSession.title);
                  showToast(
                    `Continuing on ${result.connection.stationName}`,
                    'success',
                  );
                },
              }
            : {})}
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
            if (handoffIsActive) {
              // A handoff never carries attachments, so they (and any still
              // uploading) stay in the composer.
              if (clearsComposer) {
                chatInput.handleClearInput();
                chatDraftsStore.consumeQuotes(handoffSession.id, sentQuotes);
              }
            } else {
              focusSessionInPane(handoffSession.id);
            }
            invalidate(orchestrationQueries.sessions().queryKey);
            invalidate(conversationQueries.inventory().queryKey);
            setHandoffSource(null);
            requestAnimationFrame(() => {
              // The trigger can be gone (Run setup closed on a phone, or the
              // engine picker has none): fall back to the composer.
              const trigger = handoffReturnFocusRef.current;
              (trigger?.isConnected
                ? trigger
                : chatInput.textareaRef.current
              )?.focus();
            });
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
            key={JSON.stringify([
              contextBoundaryAuthority?.namespace,
              activeSession.conversationId,
              contextBoundarySessionId,
            ])}
            authority={contextBoundaryAuthority}
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
            onReserved={(boundary) => {
              invalidate(orchestrationQueries.sessions().queryKey);
              if (boundary.status === 'reserved')
                showToast('Agent context reset is ready', 'success');
            }}
          />
        )}
    </>
  );
}

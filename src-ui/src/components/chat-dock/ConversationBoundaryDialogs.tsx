import {
  conversationQueries,
  type OrchestrationSessionSummary,
  orchestrationQueries,
  useInvalidateQuery,
  useOrchestrationSessionsQuery,
} from '@kontourai/station-sdk';
import type { RefObject } from 'react';
import type { useActiveChatActions } from '../../contexts/ActiveChatsContext';
import { activeChatsStore } from '../../contexts/ActiveChatsContext';
import type { AgentData } from '../../contexts/AgentsContext';
import type { ProjectMetadata } from '../../contexts/ProjectsContext';
import type { useToast } from '../../contexts/ToastContext';
import type { useChatInput } from '../../hooks/useChatInput';
import type { ChatSession } from '../../types';
import { LazyBoundary } from '../LazyBoundary';
import { writeConversationContextBoundaryUiState } from './conversationContextBoundaryUiState';
import {
  acceptConversationHandoffUiState,
  beginConversationHandoffUiState,
  refuseConversationHandoffUiState,
} from './conversationHandoffUiState';
import type { ConversationBoundaryDialogsState } from './useConversationBoundaryDialogs';

const loadConversationHandoffDialog = () =>
  import('./ConversationHandoffDialog').then((module) => ({
    default: module.ConversationHandoffDialog,
  }));
const loadConversationContextResetDialog = () =>
  import('./ConversationContextResetDialog').then((module) => ({
    default: module.ConversationContextResetDialog,
  }));

/**
 * The dock's Agent-handoff and context-reset overlays.
 *
 * Both are driven entirely by `useConversationBoundaryDialogs`; everything
 * else this takes is the ambient dock context the two dialogs report back
 * into (the composer's draft, the active-chat store, the query cache and the
 * toast surface). Splitting them out of `ChatWorkspacePane` keeps that
 * reporting-back visible as a prop list instead of closure capture.
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
    'input' | 'attachments' | 'handleClearInput' | 'handleClearAttachments'
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
    contextResetSource,
    setContextResetSource,
    contextBoundarySessionId,
    setContextBoundaryStored,
    hasLocalDeferredMessages,
  } = dialogs;
  return (
    <>
      {handoffSource && handoffSession?.conversationId && (
        <LazyBoundary
          load={loadConversationHandoffDialog}
          componentProps={{
            apiBase,
            conversationId: handoffSession.conversationId,
            sessionId: handoffSession.id,
            currentAgentId: handoffSession.agentSlug,
            projectSlug: handoffSession.projectSlug,
            agents,
            projects,
            initialMessage:
              handoffSession.id === activeSession?.id ? chatInput.input : '',
            attachments:
              handoffSession.id === activeSession?.id
                ? chatInput.attachments
                : [],
            blockedReason:
              handoffSession.id === activeSession?.id
                ? handoffDisabledReason
                : undefined,
            onDispatchStarted: ({ message, clientTurnId }) => {
              const state = activeChatsStore.getSnapshot()[handoffSession.id];
              updateChat(
                handoffSession.id,
                beginConversationHandoffUiState(state, {
                  message,
                  clientTurnId,
                  now: Date.now(),
                }),
              );
            },
            onDefiniteFailure: (clientTurnId) => {
              const state = activeChatsStore.getSnapshot()[handoffSession.id];
              updateChat(
                handoffSession.id,
                refuseConversationHandoffUiState(state, clientTurnId),
              );
            },
            onClose: () => {
              setHandoffSource(null);
              requestAnimationFrame(() =>
                handoffReturnFocusRef.current?.focus(),
              );
            },
            onAccepted: ({ receipt, target, targetId }) => {
              const state = activeChatsStore.getSnapshot()[handoffSession.id];
              updateChat(
                handoffSession.id,
                acceptConversationHandoffUiState(state, target, receipt),
              );
              if (handoffSession.id === activeSession?.id) {
                chatInput.handleClearInput();
                chatInput.handleClearAttachments();
              } else {
                focusSessionInPane(handoffSession.id);
              }
              invalidate(orchestrationQueries.sessions().queryKey);
              invalidate(conversationQueries.inventory().queryKey);
              setHandoffSource(null);
              requestAnimationFrame(() =>
                handoffReturnFocusRef.current?.focus(),
              );
              showToast(
                `Continuing with ${target?.name ?? `deleted Agent “${targetId}”`}`,
                'success',
              );
            },
          }}
          pending={null}
        />
      )}
      {contextResetSource &&
        activeSession?.conversationId === contextResetSource.id && (
          <LazyBoundary
            load={loadConversationContextResetDialog}
            componentProps={{
              apiBase,
              conversationId: activeSession.conversationId,
              sessionId: contextBoundarySessionId ?? activeSession.id,
              session: activeSession,
              sessionRead: activeOrchestrationSessionRead,
              orchestrationSession: activeOrchestrationSession,
              hasLocalDeferredMessages,
              onStoppedSessionRefreshed: async () => {
                const refreshed = await refetchOrchestrationSessions();
                return (
                  refreshed.data?.find(
                    (session) =>
                      session.threadId ===
                      (contextBoundarySessionId ?? activeSession.id),
                  ) ?? null
                );
              },
              onClose: () => {
                setContextResetSource(null);
                requestAnimationFrame(() =>
                  composerMenuTriggerRef.current?.focus(),
                );
              },
              onReserved: (boundary, idempotencyKey) => {
                setContextBoundaryStored(
                  writeConversationContextBoundaryUiState(
                    idempotencyKey,
                    boundary,
                  ),
                );
                invalidate(orchestrationQueries.sessions().queryKey);
                if (boundary.status === 'reserved')
                  showToast('Next engine context reserved', 'success');
              },
            }}
            pending={null}
          />
        )}
    </>
  );
}

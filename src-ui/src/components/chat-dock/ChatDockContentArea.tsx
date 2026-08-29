import type { OrchestrationSessionSummary } from '@kontourai/station-sdk';
import { type ComponentProps, memo } from 'react';
import type { AgentData } from '../../contexts/AgentsContext';
import type { ChatSession, FileAttachment } from '../../types';
import type { ForkTurnSource } from '../chat/fork-turn-source';
import { LazyBoundary } from '../LazyBoundary';
import { Empty, SkeletonList } from '../state';
import { ChatDockBody } from './ChatDockBody';
import type { ComposerActionsMenuProps } from './ComposerActionsMenu';

// Stable module-scope loader: LazyBoundary rebuilds its lazy component when
// the load identity changes, so an inline loader re-suspends on every parent
// render (station#2605).
const loadConversationHistory = () =>
  import('../chat/ConversationHistory').then(({ ConversationHistory }) => ({
    default: ConversationHistory,
  }));

interface ChatDockContentAreaProps {
  activeSession: ChatSession | null;
  /**
   * station#3213: the serving Station's own record of this chat, correlated
   * once in `useChatDockViewModel`. `null` when the dock is showing a chat the
   * server has no session for (a chat before its first send, or the direct
   * `/chat` path) — a state with no failure to report, not a failure hidden.
   */
  activeOrchestrationSession: OrchestrationSessionSummary | null;
  /** UX audit T5: see `useChatDockViewModel`'s `activeOrchestrationSessionRead`. */
  activeOrchestrationSessionRead: 'pending' | 'error' | 'present' | 'absent';
  onRetryOrchestrationSessions: () => void;
  activeSessionId: string | null;
  sessions: ChatSession[];
  agents: AgentData[];
  projects: Array<{ slug: string; name: string }>;
  projectScope?: { slug: string; name: string } | null;
  chatFontSize: number;
  dockHeight: number;
  showStatsPanel: boolean;
  showReasoning: boolean;
  showToolDetails: boolean;
  modelSupportsAttachments: boolean;
  fileAttachmentsSupported: boolean;
  modelProviderLabel?: string;
  modelProviders: ComponentProps<typeof ChatDockBody>['modelProviders'];
  agentDefaultModelId: string | null;
  connectionApprovalModeDefault?: unknown;
  toolPolicyDelivery?: ComponentProps<
    typeof ChatDockBody
  >['toolPolicyDelivery'];
  availableModels: ComponentProps<typeof ChatDockBody>['availableModels'];
  modelsLoading?: ComponentProps<typeof ChatDockBody>['modelsLoading'];
  chatInput: ComponentProps<typeof ChatDockBody>['chatInput'];
  secondaryActions?: ComposerActionsMenuProps;
  onOpenAgentHandoff?: ComponentProps<
    typeof ChatDockBody
  >['onOpenAgentHandoff'];
  agentHandoffTriggerRef?: ComponentProps<
    typeof ChatDockBody
  >['agentHandoffTriggerRef'];
  isHistoryOpen: boolean;
  onCloseHistory: () => void;
  onToggleStatsPanel: (show: boolean) => void;
  onTitleUpdate: (sessionId: string, title: string) => void;
  onDeleteSession: (sessionId: string) => void;
  onFocusSession: (sessionId: string) => void;
  onOpenConversation: (
    conversationId: string,
    agentSlug: string,
    projectSlug?: string,
    projectName?: string,
    model?: string,
  ) => void;
  onForkFromTurn?: (source: ForkTurnSource) => void;
  /** Starts a new chat from the empty state (#800). */
  onNewChat: (
    initialMessage?: string,
    attachments?: FileAttachment[],
    migratedTurnId?: string,
  ) => void | Promise<void>;
  onRetryConversationOpen?: () => void | Promise<void>;
  /** station#1301 slice 1: opens the Background tasks sheet. */
  onOpenBackgroundTasks?: () => void;
}

function ChatDockContentAreaImpl({
  activeSession,
  activeOrchestrationSession,
  activeOrchestrationSessionRead,
  onRetryOrchestrationSessions,
  activeSessionId,
  sessions,
  agents,
  projects,
  projectScope,
  chatFontSize,
  dockHeight,
  showStatsPanel,
  showReasoning,
  showToolDetails,
  modelSupportsAttachments,
  fileAttachmentsSupported,
  modelProviderLabel,
  modelProviders,
  agentDefaultModelId,
  connectionApprovalModeDefault,
  toolPolicyDelivery,
  availableModels,
  modelsLoading,
  chatInput,
  secondaryActions,
  onOpenAgentHandoff,
  agentHandoffTriggerRef,
  isHistoryOpen,
  onCloseHistory,
  onToggleStatsPanel,
  onTitleUpdate,
  onDeleteSession,
  onFocusSession,
  onOpenConversation,
  onForkFromTurn,
  onNewChat,
  onRetryConversationOpen,
  onOpenBackgroundTasks,
}: ChatDockContentAreaProps) {
  return (
    <div className="chat-dock__content-area">
      {isHistoryOpen && (
        <>
          <button
            type="button"
            className="conversation-history__backdrop"
            aria-label="Close conversation history"
            tabIndex={-1}
            onClick={onCloseHistory}
          />
          <LazyBoundary
            load={loadConversationHistory}
            pending={
              <div className="conversation-history">
                <div className="conversation-history__header">
                  <span className="conversation-history__title">History</span>
                </div>
                <div className="conversation-history__list">
                  <SkeletonList label="Loading conversation history" />
                </div>
              </div>
            }
            unavailable={(onRetry) => (
              <div className="conversation-history">
                <div className="conversation-history__header">
                  <span className="conversation-history__title">History</span>
                  <div className="conversation-history__actions">
                    <button
                      type="button"
                      className="conversation-history__close-btn"
                      onClick={onCloseHistory}
                    >
                      ×
                    </button>
                  </div>
                </div>
                <div className="conversation-history__list">
                  <div className="lazy-boundary__error" role="alert">
                    <span>Unable to load this part of Station.</span>
                    <button type="button" onClick={onRetry}>
                      Retry
                    </button>
                    <button
                      type="button"
                      onClick={() => window.location.reload()}
                    >
                      Reload
                    </button>
                  </div>
                </div>
              </div>
            )}
            componentProps={{
              sessions: sessions
                .filter((s) => s.conversationId)
                .map((s) => ({
                  id: s.id,
                  conversationId: s.conversationId as string,
                  agentSlug: s.agentSlug,
                  agentName: s.agentName,
                  title: s.title,
                })),
              activeSessionId,
              agents,
              projects,
              projectScope,
              onTitleUpdate,
              onDelete: onDeleteSession,
              onSelect: onFocusSession,
              onOpenConversation,
              onClose: onCloseHistory,
            }}
          />
        </>
      )}
      <div className="chat-dock__body">
        {activeSession ? (
          <ChatDockBody
            activeSession={activeSession}
            activeOrchestrationSession={activeOrchestrationSession}
            activeOrchestrationSessionRead={activeOrchestrationSessionRead}
            onRetryOrchestrationSessions={onRetryOrchestrationSessions}
            chatFontSize={chatFontSize}
            dockHeight={dockHeight}
            showStatsPanel={showStatsPanel}
            showReasoning={showReasoning}
            showToolDetails={showToolDetails}
            modelSupportsAttachments={modelSupportsAttachments}
            fileAttachmentsSupported={fileAttachmentsSupported}
            modelProviderLabel={modelProviderLabel}
            modelProviders={modelProviders}
            agentDefaultModelId={agentDefaultModelId ?? undefined}
            connectionApprovalModeDefault={connectionApprovalModeDefault}
            toolPolicyDelivery={toolPolicyDelivery}
            availableModels={availableModels}
            modelsLoading={modelsLoading}
            chatInput={chatInput}
            secondaryActions={secondaryActions}
            onOpenAgentHandoff={onOpenAgentHandoff}
            agentHandoffTriggerRef={agentHandoffTriggerRef}
            setShowStatsPanel={onToggleStatsPanel}
            onOpenBackgroundTasks={onOpenBackgroundTasks}
            onNewChat={onNewChat}
            onRetryConversationOpen={onRetryConversationOpen}
            onForkFromTurn={onForkFromTurn}
          />
        ) : (
          // #800: this instructed the user to click "New", which renders as a
          // bare + icon on phone — naming a control the eye cannot find. The
          // empty state carries the action itself now.
          <Empty
            variant="prominent"
            label="No active session"
            action={
              <button
                type="button"
                className="button button--primary"
                onClick={() => onNewChat()}
              >
                Start a chat
              </button>
            }
          />
        )}
      </div>
    </div>
  );
}

/**
 * Memoized: the surrounding dock re-renders every animation frame while the
 * bottom/side resize handle is dragged (`liveDragHeight`/width state), and
 * this subtree does not depend on either — skip its render work per frame.
 */
export const ChatDockContentArea = memo(ChatDockContentAreaImpl);

import { useConnections } from '@kontourai/station-connect';
import { agentId } from '@kontourai/station-contracts/agent-identity';
import {
  ENGINE_CAPABILITY_MATRICES,
  resolveComposerImageSupport,
  resolveEngineCapabilityMatrix,
} from '@kontourai/station-contracts/engine-capability-matrix';
import type { AgentConnectionView } from '@kontourai/station-contracts/tool';
import { useAgentConnectionsQuery } from '@kontourai/station-sdk';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { verifiedBuildLabel } from '../../build-info';
import {
  type ChatUIState,
  useActiveChatActions,
  useActiveChatSelector,
  useActiveChatState,
} from '../../contexts/ActiveChatsContext';
import { useAgents } from '../../contexts/AgentsContext';
import { useApiBase } from '../../contexts/ApiBaseContext';
import { useAuth } from '../../contexts/AuthContext';
import { isTurnInFlight } from '../../contexts/active-chats-state';
import { useCreateChatSession } from '../../hooks/useActiveChatSessions';
import { useChatInput } from '../../hooks/useChatInput';
import { useMobileVisualViewport } from '../../hooks/useMobileVisualViewport';
import type { ChatMessage, ChatSession, FileAttachment } from '../../types';
import {
  accountableHumanFromUser,
  ownerAttributionFromStation,
} from '../../utils/ownerAttribution';
import { ChatInputArea } from '../chat/ChatInputArea';
import { ChatMessageList } from '../chat/ChatMessageList';
import { shouldBindPanelProjectContext } from './project-context-binding';

interface ACPChatPanelProps {
  projectSlug: string;
  projectName?: string;
  agentSlug: string;
/** Stable tab ID — used to persist the session across re-renders */
  tabId: string;
/**
* archive#1294: whether this tab is the active one.
* `CodingTerminalPanel` keeps every tab's panel mounted (`display: none`
* on inactive tabs, mirroring `TerminalPanel`'s own `isActive` prop)
* rather than unmounting it, so a send failure in a background tab must
* not have its toast suppressed on the assumption the transcript notice
* is visible — it isn't. Defaults to `true` so any other, single-tab
* caller keeps today's behavior.
*/
  isActive?: boolean;
}

export function acpViewportBoundaryStyle(
  viewportStyle: React.CSSProperties,
): React.CSSProperties {
// CodingTerminalPanel owns the nested surface's top placement. ACP consumes
// the shared available height only; applying offsetTop here would double it.
  return {
    ...viewportStyle,
    maxHeight: 'var(--chat-visual-viewport-height)',
  };
}

// Stable, never-mutated fallbacks for ChatSession fields the transcript
// (ChatMessageList/MessageBubble/StreamingMessage) never reads. Using
// constants here — rather than the live composer values — keeps the
// selected transcript session referentially stable while the user types
// (see buildTranscriptSession below).
const EMPTY_MESSAGES: ChatMessage[] = [];
const EMPTY_ATTACHMENTS: FileAttachment[] = [];
const EMPTY_STRING_LIST: string[] = [];

/**
 * Builds the ChatSession shape ChatMessageList/MessageBubble expect from the
 * store's ChatUIState, fixing the `id` hole: ChatUIState has no `id` field,
 * so passing it through `as any` (the old code) left every message key
 * namespaced under the literal "undefined". Only the fields the transcript
 * actually reads (id, agentSlug, agentName, conversationId, messages,
 * status/orchestrationStatus, isProcessingStep, pendingApprovals) come from
 * live state; everything else the type requires but the transcript ignores
 * is a stable constant so an unrelated composer update (e.g. `input`) can't
 * change this object's shallow-equality outcome.
 */
export function buildTranscriptSession(
  sessionId: string,
  fallbackAgentSlug: string,
  state: ChatUIState,
): ChatSession {
  return {
    id: sessionId,
    conversationId: state.conversationId,
    agentSlug: agentId(state.agentSlug || fallbackAgentSlug),
    agentName: state.agentName || fallbackAgentSlug,
    title: '',
    source: 'manual',
    messages: state.messages || EMPTY_MESSAGES,
    input: '',
    attachments: EMPTY_ATTACHMENTS,
    queuedMessages: EMPTY_STRING_LIST,
    inputHistory: EMPTY_STRING_LIST,
    status: state.status || 'idle',
    isThinking: state.status === 'sending' && !state.isProcessingStep,
    error: state.error ?? null,
    createdAt: 0,
    updatedAt: 0,
    hasUnread: false,
    orchestrationStatus: state.orchestrationStatus,
    pendingApprovals: state.pendingApprovals,
    isProcessingStep: state.isProcessingStep,
  };
}

/**
 * Compact chat UI for terminal tabs. Uses the same ActiveChatsStore and
 * /chat endpoint as ChatDock — conversations are resumable from either place.
 */
export function ACPChatPanel({
  projectSlug,
  projectName,
  agentSlug,
  tabId,
  isActive = true,
}: ACPChatPanelProps) {
  const { apiBase } = useApiBase();
  const visualViewport = useMobileVisualViewport();
  const agents = useAgents();
  const createSession = useCreateChatSession();
  const { updateChat } = useActiveChatActions();
  const { user } = useAuth();
  const { activeConnection } = useConnections();
  const owner = useMemo(
    () =>
      ownerAttributionFromStation(
        activeConnection,
        verifiedBuildLabel ? `Station ${verifiedBuildLabel}` : null,
      ),
    [activeConnection],
  );
  const accountableHuman = useMemo(
    () => accountableHumanFromUser(user),
    [user],
  );

// Resolve session ID: restore from sessionStorage or create new
  const [sessionId] = useState<string>(() => {
    const stored = sessionStorage.getItem(`acp-tab-session:${tabId}`);
    if (stored) return stored;
    const agent = agents.find((a) => a.slug === agentSlug);
    const sid = createSession(
      agentSlug,
      agent?.name || agentSlug,
      undefined,
      projectSlug,
      projectName,
    );
    sessionStorage.setItem(`acp-tab-session:${tabId}`, sid);
    return sid;
  });

  const activeSession = useActiveChatState(sessionId);
 // Agent app connection default for the approval-mode chip (archive#727
 //) — mirrors useChatDockViewModel.ts's connectionApprovalModeDefault.
  const { data: agentConnections = [] } = useAgentConnectionsQuery() as {
    data?: AgentConnectionView[];
  };
  const runtimeConnection = agentConnections.find(
    (connection) => connection.id === activeSession?.agentConnectionId,
  );
  const connectionApprovalModeDefault =
    typeof runtimeConnection?.config.approvalMode === 'string'
      ? runtimeConnection.config.approvalMode
      : undefined;

// A panel's Project is a default for its fresh tab only. A restored or
// already-dispatched conversation has an immutable workspace identity from
// its first turn, so navigation must not rewrite it to this panel's Project.
  useEffect(() => {
    if (shouldBindPanelProjectContext(activeSession, projectSlug)) {
      updateChat(sessionId, { projectSlug, projectName });
    }
  }, [activeSession, projectSlug, projectName, sessionId, updateChat]);

// archive#3344: this used to read `agent.supportsAttachments`, a wire field
// no server code has ever written — so it was `undefined ?? false` on every
// render and this panel refused every image, while `acp-adapter.ts` declares
// `image-input` and builds real ACP image content blocks. The engine's own
// declared cell answers it now, the same way the tool-policy chip below
// resolves.
  const composerImageSupport = resolveComposerImageSupport(
    ENGINE_CAPABILITY_MATRICES.acp,
    runtimeConnection
      ? {
          connectionCapabilities: runtimeConnection.capabilities,
          ...(typeof runtimeConnection.capabilityInventory?.sessionSurfaces
            ?.promptImage === 'boolean'
            ? {
                observedImagePrompt:
                  runtimeConnection.capabilityInventory.sessionSurfaces
                    .promptImage,
              }
            : {}),
          connectionLabel: runtimeConnection.name,
        }
      : {},
  );
  const attachmentCapabilities = useMemo(
    () => ({
      images: composerImageSupport.attachable,
      files: false,
      imageRefusal: composerImageSupport.refusal,
    }),
    [composerImageSupport.attachable, composerImageSupport.refusal],
  );
  const chatInput = useChatInput({
    apiBase,
    sessionId,
    agentSlug,
    conversationId: activeSession?.conversationId,
    availableModels: [],
    attachmentCapabilities,
// archive#1294: suppress the generic error toast
// only while this tab is the one actually on screen.
    isChatVisible: isActive,
  });

// Narrow, selector-granular subscription for the transcript: only
// re-renders (i.e. only returns a new object) when a field the transcript
// actually reads changes. This is what stops composer keystrokes —
// updateChat(sessionId, { input }) — from re-rendering/re-parsing the
// memoized ChatMessageList tree below.
  const transcriptSession = useActiveChatSelector(
    sessionId,
    useCallback(
      (state: ChatUIState | null): ChatSession | null =>
        state ? buildTranscriptSession(sessionId, agentSlug, state) : null,
      [sessionId, agentSlug],
    ),
  );

  if (!activeSession || !transcriptSession) {
    return (
      <div className="acp-chat-panel acp-chat-panel--loading">
        Initializing...
      </div>
    );
  }

// ACP is nested in CodingTerminalPanel rather than fixed to the window. Its
// ancestor owns top placement; consuming offsetTop here would double it.
  return (
    <div
      className="acp-chat-panel"
      data-visual-viewport-boundary="shared"
      style={acpViewportBoundaryStyle(visualViewport.style)}
    >
      <ChatMessageList
        activeSession={transcriptSession}
        fontSize={13}
        showReasoning={true}
        showToolDetails={true}
        owner={owner}
        accountableHuman={accountableHuman}
      />
      <ChatInputArea
        sessionId={sessionId}
        input={chatInput.input}
        attachments={chatInput.attachments}
        textareaRef={chatInput.textareaRef}
        disabled={false}
        isSending={activeSession.status === 'sending'}
        turnInFlight={isTurnInFlight(activeSession)}
        modelSupportsAttachments={composerImageSupport.attachable}
        fileAttachmentsSupported={false}
        fontSize={13}
        dockHeight={400}
        canModelSelect={chatInput.canModelSelect}
        currentModel={chatInput.currentModel}
        availableModels={[]}
        modelQuery={chatInput.modelQuery}
        agentConnectionId={activeSession.agentConnectionId}
        modelRuntimeOptions={activeSession.providerOptions}
        executionMode={activeSession.executionMode}
        approvalModeConnectionDefault={connectionApprovalModeDefault}
        toolPolicyDelivery={
          runtimeConnection
            ? resolveEngineCapabilityMatrix(
                activeSession.agentConnectionId,
                runtimeConnection,
              ).toolPolicy
            : undefined
        }
        lastAppliedApprovalMode={activeSession.lastAppliedApprovalMode}
        commandQuery={chatInput.commandQuery}
        slashCommands={chatInput.slashCommands}
        onInputChange={chatInput.handleInputChange}
        onSend={chatInput.handleSend}
        onCancel={chatInput.handleCancel}
        onClearInput={chatInput.handleClearInput}
        selectAttachmentFiles={chatInput.selectAttachmentFiles}
        attachmentError={chatInput.attachmentError}
        attachmentStages={chatInput.attachmentStages}
        sendBlockedReason={chatInput.sendBlockedReason}
        onRetryAttachmentStage={chatInput.retryAttachmentStage}
        onCancelAttachmentStage={chatInput.cancelAttachmentStage}
        onReplaceAttachmentFile={chatInput.replaceAttachmentFile}
        onRemoveAttachment={chatInput.handleRemoveAttachment}
        onClearAttachments={chatInput.handleClearAttachments}
        onModelSelect={chatInput.handleModelSelect}
        onModelReset={chatInput.handleModelReset}
        onModelClose={chatInput.handleModelClose}
        onModelOpen={chatInput.handleModelOpen}
        onModelRuntimeOptionChange={chatInput.handleModelRuntimeOptionChange}
        onApprovalModeChange={chatInput.handleApprovalModeChange}
        onCommandSelect={chatInput.handleCommandSelect}
        onCommandClose={chatInput.handleCommandClose}
        onHistoryUp={chatInput.handleHistoryUp}
        onHistoryDown={chatInput.handleHistoryDown}
        updateFromInput={chatInput.updateFromInput}
        closeAll={chatInput.closeAll}
      />
    </div>
  );
}

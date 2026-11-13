import { useConnections } from '@kontourai/station-connect';
import {
  agentId,
  engineConnectionId,
} from '@kontourai/station-contracts/agent-identity';
import {
  ENGINE_CAPABILITY_MATRICES,
  resolveComposerImageSupport,
  resolveEngineCapabilityMatrix,
} from '@kontourai/station-contracts/engine-capability-matrix';
import type { AgentConnectionView } from '@kontourai/station-contracts/tool';
import { useEngineConnectionsQuery } from '@kontourai/station-sdk';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { verifiedBuildLabel } from '../../build-info';
import {
  type ChatUIState,
  useActiveChatActions,
  useActiveChatSelector,
  useActiveChatState,
} from '../../contexts/ActiveChatsContext';
import { useAgents } from '../../contexts/AgentsContext';
import {
  useApiBase,
  useHostRequestAuthorityScope,
} from '../../contexts/ApiBaseContext';
import { useConfig } from '../../contexts/ConfigContext';
import { useProject } from '../../contexts/ProjectsContext';
import { useCreateChatSession } from '../../hooks/useActiveChatSessions';
import { useActiveStationName } from '../../hooks/useActiveStationName';
import { useChatInput } from '../../hooks/useChatInput';
import { useMobileVisualViewport } from '../../hooks/useMobileVisualViewport';
import type { ChatMessage, ChatSession, FileAttachment } from '../../types';
import { ownerAttributionFromStation } from '../../utils/ownerAttribution';
import { durableMentionAuthority } from '../chat/composer-mentions';
import { ConversationBody } from '../conversation/ConversationBody';
import { ConversationConnectionProvider } from '../conversation/ConversationConnectionContext';
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
 * status/orchestrationStatus, isProcessingStep, pendingApprovals, answeredApprovals, and the
 * #2309 activity record with its send/stop window, and the older-server
 * open-turn start for the working clock) come from
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
    orchestrationStatus: state.orchestrationStatus,
    pendingApprovals: state.pendingApprovals,
    // Answered here, still open on the server: the transcript subtracts these
    // from `pendingApprovals` (utils/waiting-approvals), so it must see both.
    answeredApprovals: state.answeredApprovals,
    isProcessingStep: state.isProcessingStep,
    // #2309: the server's record drives this panel's liveness and working
    // clock exactly as it drives the dock's, so a reload mid-turn shows the
    // turn's real duration here too (the panel has no window seed of its own).
    conversationActivity: state.conversationActivity,
    sendAwaitingTurnStart: state.sendAwaitingTurnStart,
    stopSettledTurnId: state.stopSettledTurnId,
    // #2304: without a record (an older server) the clock falls back to the
    // start `turn.started` stamped; ACP has no window seed, so after a reload
    // on such a server the row states no duration.
    openTurnStartedAt: state.openTurnStartedAt,
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
  const mentionRequestScope = useHostRequestAuthorityScope();
  const visualViewport = useMobileVisualViewport();
  const agents = useAgents();
  const createSession = useCreateChatSession();
  const { updateChat } = useActiveChatActions();
  const { activeConnection, captureCredentialEvidence } = useConnections();
  const mentionCredentialEvidence = captureCredentialEvidence();
  const mentionAuthority = mentionCredentialEvidence
    ? durableMentionAuthority({
        apiBase: mentionCredentialEvidence.origin,
        connectionId: mentionCredentialEvidence.connectionId,
        authorityGeneration: mentionCredentialEvidence.authorityGeneration,
        credentialState: mentionCredentialEvidence.credentialState,
      })
    : null;

  // #4402: "via <machine>" for the seeded "Default" connection.
  const activeStationName = useActiveStationName();
  const owner = useMemo(
    () =>
      ownerAttributionFromStation(
        activeConnection && activeStationName
          ? { ...activeConnection, name: activeStationName }
          : activeConnection,
        verifiedBuildLabel ? `Station ${verifiedBuildLabel}` : null,
      ),
    [activeConnection, activeStationName],
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
  const { project: sessionProject } = useProject(
    activeSession?.projectSlug ?? projectSlug ?? '',
  );
  const { data: agentConnections = [] } = useEngineConnectionsQuery() as {
    data?: AgentConnectionView[];
  };
  const runtimeConnection = agentConnections.find(
    (connection) => connection.id === activeSession?.agentConnectionId,
  );
  // The session's Agent's own default posture for the approval-mode chip
  // (#2436) — mirrors useChatDockViewModel.ts's agentApprovalModeDefault.
  const agentApprovalModeDefault = agents.find(
    (agent) => agent.slug === activeSession?.agentSlug,
  )?.execution?.approvalMode;
  // #2144 slice 6: the Station-scope layer below that Agent default.
  const stationApprovalModeDefault = useConfig()?.defaultApprovalMode;
  // A panel's Project is a default for its fresh tab only. A restored or
  // already-dispatched conversation has an immutable workspace identity from
  // its first turn, so navigation must not rewrite it to this panel's Project.
  useEffect(() => {
    if (shouldBindPanelProjectContext(activeSession, projectSlug)) {
      updateChat(sessionId, { projectSlug, projectName });
    }
  }, [activeSession, projectSlug, projectName, sessionId, updateChat]);

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
      imageCaveat: composerImageSupport.caveat,
    }),
    [
      composerImageSupport.attachable,
      composerImageSupport.caveat,
      composerImageSupport.refusal,
    ],
  );
  const chatInput = useChatInput({
    apiBase,
    sessionId,
    agentSlug,
    conversationId: activeSession?.conversationId,
    availableModels: [],
    attachmentCapabilities,
    workingDirectory: sessionProject?.workingDirectory,
    mentionRequestScope,
    mentionAuthority,
    // archive#1294: suppress the generic error toast
    // only while this tab is the one actually on screen.
    isChatVisible: isActive,
  });

  // Normalize the transcript identity while the shared body receives the
  // complete runtime and control state from this host conversation.
  const transcriptSession = useActiveChatSelector(
    sessionId,
    useCallback(
      (state: ChatUIState | null): ChatSession | null =>
        state ? buildTranscriptSession(sessionId, agentSlug, state) : null,
      [sessionId, agentSlug],
    ),
  );

  // `transcriptSession` fills the ChatSession fields the transcript ignores
  // with placeholders, and it is spread last so its normalized identity wins.
  // The body, unlike the transcript, reads three of those fields — the queued
  // follow-ups, the last sent input and the title — so they are restored from
  // the live chat after the spread.
  const bodySession = useMemo<ChatSession | null>(
    () =>
      activeSession && transcriptSession
        ? {
            ...activeSession,
            ...transcriptSession,
            title: activeSession.title ?? transcriptSession.title,
            queuedMessages:
              activeSession.queuedMessages ?? transcriptSession.queuedMessages,
            inputHistory:
              activeSession.inputHistory ?? transcriptSession.inputHistory,
            agentConnectionId: activeSession.agentConnectionId
              ? engineConnectionId(activeSession.agentConnectionId)
              : undefined,
          }
        : null,
    [activeSession, transcriptSession],
  );

  if (!activeSession || !bodySession) {
    return (
      <div className="acp-chat-panel acp-chat-panel--loading">
        Initializing…
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
      <ConversationConnectionProvider
        value={{ apiBase, requestScope: mentionRequestScope }}
      >
        <ConversationBody
          activeSession={bodySession}
          owner={owner}
          workingDirectory={sessionProject?.workingDirectory}
          chatInput={chatInput}
          chatFontSize={13}
          dockHeight={400}
          showStatsPanel={false}
          showReasoning
          showToolDetails
          modelSupportsAttachments={composerImageSupport.attachable}
          fileAttachmentsSupported={false}
          availableModels={[]}
          agentApprovalModeDefault={agentApprovalModeDefault}
          stationApprovalModeDefault={stationApprovalModeDefault}
          toolPolicyDelivery={
            runtimeConnection
              ? resolveEngineCapabilityMatrix(
                  activeSession.agentConnectionId,
                  runtimeConnection,
                ).toolPolicy
              : undefined
          }
          setShowStatsPanel={() => {}}
        />
      </ConversationConnectionProvider>
    </div>
  );
}

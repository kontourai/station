import { useConnections } from '@kontourai/station-connect';
import type { ToolPolicyDelivery } from '@kontourai/station-contracts/engine-capability-matrix';
import { engineDisplayLabel } from '@kontourai/station-contracts/engine-display';
import {
  ENGINE_MEMORY_EXHAUSTED_CODE,
  ENGINE_SIGN_IN_REQUIRED_CODE,
  isAcpFamilyEngine,
  isSteerConflictCode,
} from '@kontourai/station-contracts/provider';
import { MCP_SIGN_IN_REQUIRED_CODE } from '@kontourai/station-contracts/provider-failure';
import { isFirstSendFailure } from '@kontourai/station-contracts/session-attention';
import { stationControlToolName } from '@kontourai/station-contracts/station-control-refusal';
import {
  continueAfterMemoryExhaustion,
  inspectOrchestrationSteerInput,
  MemoryContinuationUnsupportedError,
  type OrchestrationSessionSummary,
  steerOrchestrationTurn,
  useAgentsQuery,
} from '@kontourai/station-sdk';
import { listConversationInbox } from '@kontourai/station-sdk/client';
import {
  turnInterruptedContinueClientTurnId,
  turnInterruptedContinuePrompt,
} from '@kontourai/station-shared/runtime-event-projection';
import { StatusBadge } from '@kontourai/ui/react';
import React, {
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { conversationAccessFor } from '../../connections/station-connection';
import { outboundStationIdentity } from '../../connections/station-state';
import { useActiveChatActions } from '../../contexts/ActiveChatsContext';
import { useAgents } from '../../contexts/AgentsContext';
import { useAuth } from '../../contexts/AuthContext';
import { isTurnInFlight } from '../../contexts/active-chats-state';
import { activeChatsStore } from '../../contexts/active-chats-store';
import { chatDraftsStore } from '../../contexts/chat-drafts-store';
import { conversationOpenPhase } from '../../contexts/conversation-open-policy';
import { useMessageContextContext } from '../../contexts/MessageContextContext';
import { useNavigationActions } from '../../contexts/NavigationContext';
import { useScopedProjectChatDefaultsQuery } from '../../contexts/ProjectsContext';
import { useWorkObservation } from '../../contexts/work-observation';
import { BoundBrowserActivityProvider } from '../../float-over-chat/BoundBrowserActivityProvider';
import { useEngineStartWait } from '../../hooks/orchestration/engineStartWaits';
import { resyncOrchestrationEventStream } from '../../hooks/orchestration/ensureOrchestrationEventStream';
import { useStreamCatchingUp } from '../../hooks/orchestration/heldDuringCatchUp';
import { unansweredApprovalRequests } from '../../hooks/orchestration/pendingRequestRows';
import {
  drainQueuedMessageOnTurnCompleted,
  sendPendingMessageNow,
} from '../../hooks/orchestration/queueDrain';
import { isReplayThread } from '../../hooks/orchestration/replay/replay-registry';
import { useACPConnections } from '../../hooks/useACPConnections';
import type { useChatInput } from '../../hooks/useChatInput';
import { useFeatureSettings } from '../../hooks/useFeatureSettings';
import { useFollowUpAttachmentsSupport } from '../../hooks/useFollowUpAttachmentsSupport';
import { useShareReceiver } from '../../hooks/useShareReceiver';
import { useSTT } from '../../hooks/useSTT';
import { useSurfaceVisibilityFlags } from '../../hooks/useSurfaceVisibilityFlags';
import { useTTS } from '../../hooks/useTTS';
import { openConnectionsModal } from '../../lib/connectionModalEvents';
import { requestTroubleshoot } from '../../lib/troubleshootEvents';
import { isWorkspaceRefusedTurn } from '../../lib/workspaceRefusal';
import type { ChatMessage, ChatSession, FileAttachment } from '../../types';
import { advertisedAcpSessionModesFromConnection } from '../../utils/acpSessionMode';
import type { SavedAnswerQuote } from '../../utils/answer-quotes';
import {
  acpApprovalFor,
  sessionApprovalOverride,
} from '../../utils/approvalMode';
import { ambientContextForSend } from '../../utils/chatAmbientContext';
import {
  currentChatError,
  formatChatErrorDisplay,
  MEMORY_EXHAUSTION_CONTINUE_TEXT,
  MEMORY_EXHAUSTION_CONTINUING_DISPLAY,
  SESSION_START_INDETERMINATE_CODE,
  translateChatError,
} from '../../utils/chatErrorTranslation';
import {
  elidedHistoryNoticeText,
  summarizeElidedReasons,
} from '../../utils/elidedHistory';
import {
  chatEngineIdentity,
  chatExecutionBinding,
  chatNextTurnStartsSession,
} from '../../utils/engine';
import {
  isSessionExecutionActive,
  isTurnStreamLive,
  sessionAdapterSupportsSteering,
  sessionSteeringPlacement,
} from '../../utils/execution';
import type {
  ModelProviderOption,
  SelectableModel,
} from '../../utils/modelCapabilities';
import type { OwnerAttribution } from '../../utils/ownerAttribution';
import { accountableHumanFromUser } from '../../utils/ownerAttribution';
import {
  sessionFailureNote,
  sessionFailureText,
  transcriptCarriesFailureText,
  transcriptShowsFailureSurface,
} from '../../utils/sessionFailure';
import { describeStationFailure } from '../../utils/stationFailure';
import { steerRefusalMessage } from '../../utils/steerTurn';
import { turnToolsRunning } from '../../utils/turn-tools-running';
import { requestsWaitingOnUser } from '../../utils/waiting-approvals';
import { Button } from '../Button';
import { ChatEmptyState } from '../chat/ChatEmptyState';
import { durableMentionAuthority } from '../chat/composer-mentions';
import { EphemeralMessage } from '../chat/EphemeralMessage';
import type {
  ForkTurnSource,
  MessageResendRequest,
} from '../chat/fork-turn-source';
import { preloadMarkdownRenderer } from '../chat/LazyMarkdown';
import { interruptionNoticeReason } from '../chat/message-bubble/visibleContent';
import { outboxNeedsReview } from '../chat/pendingMessages';
import type { OutboxRows } from '../chat/QueuedMessages';
import { SessionRewindProvider } from '../chat/SessionRewind';
import { SystemEventMessage } from '../chat/SystemEventMessage';
import { StationSessionTitlesProvider } from '../chat/station-session-titles';
import { preloadToolCallBatch } from '../chat/ToolCallBatchBoundary';
import { hasActiveToolCall } from '../chat/tool-call-labels';
import { markTranscriptPhase } from '../chat/transcriptLayoutTrace';
import { AgentScheduleNotes } from '../chat-dock/AgentScheduleNotes';
import type { ComposerActionsMenuProps } from '../chat-dock/ComposerActionsMenu';
import { CoordinatorToolsNotice } from '../chat-dock/CoordinatorToolsNotice';
import {
  CONTINUE_INTERRUPTED_TURN_PREVIEW_ID,
  continuableInterruptedBoundary,
} from '../chat-dock/interruptedTurnContinue';
import {
  type RetryAttachment,
  resolveRetryAttachments,
  retryAttachmentsFromParts,
} from '../chat-dock/retry-attachments';
import {
  TerminalRunNotes,
  terminalRunRefreshKey,
} from '../chat-dock/TerminalRunNotes';
import { UsageLimitBanner } from '../chat-dock/UsageLimitBanner';
import { useChatStatusPill } from '../chat-dock/useChatStatusPill';
import {
  ContextPercentage,
  ConversationStats,
} from '../conversation-stats/ConversationStats';
import ProgressSilenceObservation from '../home/ProgressSilenceObservation';
import { AgentIcon } from '../icons/AgentIcon';
import { LazyBoundary } from '../LazyBoundary';
import { resolveNewChatAgentEnable } from '../modals/new-chat-agent-enable';
import { SessionFailureAlert } from '../session-failure/SessionFailureAlert';
import { ErrorState, SkeletonList } from '../state';
import { ConversationComposer } from './ConversationComposer';
import { useConversationConnection } from './ConversationConnectionContext';
import {
  ConversationLoadingStage,
  type ConversationLoadingStep,
  conversationLoadingLongText,
  conversationLoadingStepText,
} from './ConversationLoadingStage';
import { ConversationStopControl } from './ConversationStopControl';
import {
  RecordConversationBody,
  type RecordConversationBodyProps,
} from './RecordConversationBody';
import {
  SETTLED_COMPOSER_NOTICE,
  SettledConversationFooter,
  useSettledConversation,
} from './SettledConversationNotes';
import { useConversationController } from './useConversationController';

/** The station-control tools that change what a chat has scheduled. */
const SCHEDULE_TOOLS = new Set([
  'schedule_wake_up',
  'cancel_wake_up',
  'propose_job',
]);

interface SchedulePart {
  type?: string;
  toolName?: string;
  state?: string;
  args?: unknown;
  input?: unknown;
}

/** Whether a tool call's text names a scheduling tool, by the call object. */
const callNamesScheduleTool = new WeakMap<object, boolean>();

/**
 * Whether a call is a scheduling tool, or a script that ran one. A script
 * tool runs Station Control tools inside a single call, so the stream never
 * shows the scheduling tool as a call of its own; the script's arguments
 * name it. The arguments are read once per call: a part that was not
 * updated keeps its object across stream updates.
 */
function mayHaveScheduled(part: SchedulePart): boolean {
  if (SCHEDULE_TOOLS.has(stationControlToolName(part.toolName) ?? ''))
    return true;
  let named = callNamesScheduleTool.get(part);
  if (named === undefined) {
    const call = JSON.stringify(part.args ?? part.input ?? '');
    named = [...SCHEDULE_TOOLS].some((tool) => call.includes(tool));
    callNamesScheduleTool.set(part, named);
  }
  return named;
}

/**
 * When the chat's schedule may have changed: a turn started or ended (a
 * check-back sent, a stop), or the running turn finished a call that
 * scheduled something. Not every streamed event: the summary's event count
 * moves on every delta, and each move re-read the schedule.
 */
export function agentScheduleRefreshKey(
  openTurnId: string | undefined,
  parts: readonly SchedulePart[] | undefined,
): string {
  const scheduled = (parts ?? []).filter(
    (part) =>
      part.type === 'tool-invocation' &&
      part.state !== 'call' &&
      part.state !== 'running' &&
      part.state !== 'partial-call' &&
      mayHaveScheduled(part),
  ).length;
  return `${openTurnId ?? 'idle'}:${scheduled}`;
}

const loadChatMessageList = () =>
  import('../chat/ChatMessageList').then(({ ChatMessageList }) => ({
    default: ChatMessageList,
  }));

/*
 * The list chunk's pending state takes the transcript's flex fill, exactly
 * like the empty-transcript filler below. A bare skeleton list here left the
 * dock with no filler for the frames between the filler unmounting and the
 * list chunk resolving, and the composer jumped up under the header and back
 * (recorded as a layout shift on `.chat-input` by
 * tests/transcript-load-stability.spec.ts).
 */
const CHAT_MESSAGE_LIST_PENDING = (
  <div
    className="chat-messages chat-messages--empty"
    role="status"
    aria-label="Loading chat"
  >
    <ConversationLoadingStage step="rendering" />
  </div>
);

const loadOutboundQueuedMessages = () =>
  import('../chat/OutboundQueuedMessages').then(
    ({ OutboundQueuedMessages }) => ({
      default: OutboundQueuedMessages,
    }),
  );

const loadConversationInboxMessages = () =>
  import('../chat/ConversationInboxMessages').then(
    ({ ConversationInboxMessages }) => ({
      default: ConversationInboxMessages,
    }),
  );

const loadConversationOpenRecoveryNotice = () =>
  import('../chat-dock/ConversationOpenRecoveryNotice').then((module) => ({
    default: module.ConversationOpenRecoveryNotice,
  }));

const loadReplayTransport = () =>
  import('../chat/ReplayTransport').then(({ ReplayTransport }) => ({
    default: ReplayTransport,
  }));

const loadConversationTimeline = () =>
  import('../chat/ConversationTimeline').then(({ ConversationTimeline }) => ({
    default: ConversationTimeline,
  }));

const loadSourceQuoteDrafts = () =>
  import('../chat/SourceQuoteDrafts').then((module) => ({
    default: module.SourceQuoteDrafts,
  }));

// #90 D9: a live Browser session an agent in this conversation drives
// floats over the transcript. Its own chunk, loaded only for a Project chat.
const loadFloatOverChat = () => import('../../float-over-chat/FloatOverChat');

// station#3706: lazy because most sessions
// never hold a refused follow-up, so the chunk loads only when one exists.
const loadUnsentMessages = () =>
  import('../chat/UnsentMessages').then(({ UnsentMessages }) => ({
    default: UnsentMessages,
  }));

/**
 * The unavailable-agent banner's inline link-button appearance, unchanged and
 * shared by both of its branches so neither can drift from the other. Lifted
 * out of the JSX verbatim; nothing about the banner's layout or styling moved.
 */
const BANNER_LINK_BUTTON_STYLE: React.CSSProperties = {
  background: 'none',
  border: 'none',
  color: 'var(--accent-primary, inherit)',
  cursor: 'pointer',
  textDecoration: 'underline',
  fontSize: 'inherit',
  padding: 0,
};

/** D3: see `ChatDockBodyProps.loadingEscapeDelayMs`. */
const LOADING_ESCAPE_DELAY_MS = 6_000;
/**
 * The composer's reason when the open read refused this caller a send. Says
 * "you", not "this device": the server answers per credential, and the caller
 * may be a relay member rather than a paired device.
 */
const CALLER_CANNOT_SEND_REASON =
  "You can read this chat but can't send to it.";
/**
 * A refused workspace (the server refused this conversation's queued turn
 * here) for a caller the server also refused a new chat: both halves of why
 * nothing can be sent from this composer.
 */
const WORKSPACE_REFUSED_WITHOUT_NEW_CHAT_REASON =
  "This chat can only continue in its original workspace, and you can't start a new chat here.";

export interface ConversationTranscriptSnapshot {
  chatId: string;
  conversationId?: string;
  messages: readonly ChatMessage[];
  requestScope: NonNullable<
    ReturnType<typeof useConversationConnection>['requestScope']
  >;
}

export interface ConversationBodyProps {
  transcriptSnapshotRef?: RefObject<ConversationTranscriptSnapshot | null>;
  owner?: OwnerAttribution | null;
  activeSession: ChatSession;
  workingDirectory?: string | null;
  /**
   * station#3213: the serving Station's record of this chat, correlated in
   * `useChatDockViewModel`. The dock's own `ChatSession` is local tab state
   * and carries no lifecycle fold, which is why this pane could not say a
   * session had failed. `null` for a chat the server has no session for.
   */
  activeOrchestrationSession?: OrchestrationSessionSummary | null;
  /** UX audit T5: see `useChatDockViewModel`'s `activeOrchestrationSessionRead`. */
  activeOrchestrationSessionRead?: 'pending' | 'error' | 'present' | 'absent';
  onRetryOrchestrationSessions?: () => void;
  chatFontSize: number;
  dockHeight: number;
  showStatsPanel: boolean;
  /** Whether the composer shows this chat's context meter. */
  showContextMeter?: boolean;
  showReasoning: boolean;
  showToolDetails: boolean;
  modelSupportsAttachments: boolean;
  fileAttachmentsSupported: boolean;
  modelProviderLabel?: string;
  modelProviders?: ModelProviderOption[];
  agentDefaultModelId?: string;
  agentApprovalModeDefault?: unknown;
  /** This Station's `AppConfig.defaultApprovalMode` (#2144 slice 6). */
  stationApprovalModeDefault?: unknown;
  toolPolicyDelivery?: ToolPolicyDelivery;
  availableModels: SelectableModel[];
  stagedAgentChange?: Pick<
    ReturnType<
      typeof import('../chat-dock/useStagedAgentChange').useStagedAgentChange
    >,
    | 'pending'
    | 'canRetry'
    | 'canWithdraw'
    | 'withdraw'
    | 'changeModel'
    | 'changeOption'
    | 'send'
    | 'undo'
  > & {
    selection?: NonNullable<
      ReturnType<
        typeof import('../chat-dock/useStagedAgentChange').useStagedAgentChange
      >['selected']
    >;
    models: SelectableModel[];
  };
  executionModels?: SelectableModel[];
  onExecutionModelSelect?: (model?: SelectableModel) => void;
  modelsLoading?: boolean;
  secondaryActions?: ComposerActionsMenuProps;
  onOpenAgentHandoff?: () => void;
  agentHandoffTriggerRef?: React.RefObject<HTMLButtonElement | null>;
  onOpenBackgroundTasks?: () => void;
  /**
   * station#1827: opens the new-chat flow — wired to the terminal-session
   * failure marker's "Start new chat" action (a dead engine binding cannot
   * be resumed by resending into the same thread). Optional so existing
   * callers/tests that don't wire it degrade to no action rather than a
   * required-prop break.
   */
  onNewChat?: (
    initialMessage?: string,
    attachments?: FileAttachment[],
    migratedTurnId?: string,
  ) => void | Promise<void>;
  /** Re-resolves the exact durable conversation identity, never an Agent guess. */
  onRetryConversationOpen?: () => void | Promise<void>;
  /**
   * #3239: how long a load runs before the loading stage adds its quieter
   * "Taking longer than usual" line. A load that lands in the ordinary second
   * or two shows only its step. (The name predates the stage: it once
   * timed a "Start new chat" escape, which a slow load no longer offers.)
   * Tests set it to 0.
   */
  loadingEscapeDelayMs?: number;
  onForkFromTurn?: (source: ForkTurnSource) => void;
  /** #4406: Regenerate and Edit and resend, gated with the fork. */
  onResendFromMessage?: (request: MessageResendRequest) => void;
  onComposerEnabledChange?: (element: HTMLTextAreaElement | null) => void;
  /** The host sends this draft once its uploads finish (Start's first message). */
  sendQueuedForUploads?: boolean;
  chatInput: ReturnType<typeof useChatInput>;
  setShowStatsPanel: (show: boolean) => void;
}

/**
 * The user turn a failed-turn marker belongs to — the nearest real user
 * message before it, skipping the `[SYSTEM_EVENT]` markers that are themselves
 * stored with a user role (#797).
 *
 * When the marker and that message both name a turn, they must name the same
 * one. A failed turn with no prompt of its own (one the engine or an
 * automation opened) has nothing to send again, and the message before it
 * belongs to an earlier turn.
 *
 * Returns the attachments alongside the text: the server now persists the
 * turn's `file` parts, so a resend that carried only the text would silently
 * drop an image the user had attached — a recovery affordance that quietly
 * recovers less than it claims (#797 review).
 */
export function findPrecedingUserTurn(
  messages: ChatMessage[],
  markerIndex: number,
): { text: string; attachments: RetryAttachment[] } | null {
  for (let idx = markerIndex - 1; idx >= 0; idx--) {
    const message = messages[idx];
    if (message?.role !== 'user' || message.ephemeral) {
      continue;
    }
    const parts = (message.contentParts ?? []) as Array<Record<string, any>>;
    const text =
      parts
        .filter((part) => part.type === 'text')
        .map((part) => part.content)
        .join('\n') ||
      message.content ||
      '';
    if (text.startsWith('[SYSTEM_EVENT]')) {
      continue;
    }
    const markerTurnId = messages[markerIndex]?.turnId;
    if (markerTurnId && message.turnId && message.turnId !== markerTurnId)
      return null;
    // Every file part, whether or not this read carried its bytes. Filtering
    // to inline ones here is what made a retry silently text-only once
    // byte-budgeted reads became the steady state (station#3385); resolving
    // the references is the caller's job, and failing that is visible.
    const attachments = retryAttachmentsFromParts(parts, `retry-${idx}`);
    return { text, attachments };
  }
  return null;
}

/**
 * The newest SEND-FAILURE notice as one plain line (its bold title row), for the
 * composer to repeat while a short dock hides the transcript.
 *
 * Only a notice that says why a send did not go counts (`sendFailure`): the
 * transcript's other ephemeral lines — slash-command output, model or mode
 * changes, stop and status notes — are not what the composer is asking about,
 * and showing one there reads as a failure that did not happen. A failure is
 * also stale once a LATER message was accepted: the newest non-ephemeral user
 * message after it (the transcript is timestamp-ordered, and a refused send's
 * optimistic bubble is rolled back, so one that follows is a send that took)
 * clears it.
 */
export function latestSendFailureLine(
  messages: readonly {
    role: string;
    content: string;
    ephemeral?: boolean;
    sendFailure?: boolean;
  }[],
) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.ephemeral) {
      if (!message.sendFailure) continue;
      return noticeLine(message.content);
    }
    if (message.role === 'user') return undefined;
  }
  return undefined;
}

/**
 * Send-failure notices whose action is stale (#4400): a LATER message was
 * accepted after them, by the same rule `latestSendFailureLine` uses. A Retry
 * there would send again a message the user has since sent and had answered,
 * so such a card keeps its text but loses its action. A Station check-back or
 * memory continuation is not the user's send and does not retire a failure.
 * Terminal-session notices own their own "New chat" action and are left alone.
 */
export function staleSendFailureIds(
  messages: readonly {
    role: string;
    ephemeral?: boolean;
    sendFailure?: boolean;
    terminalSession?: boolean;
    stationCheckBack?: boolean;
    stationMemoryContinuation?: boolean;
    stationRestartContinuation?: boolean;
    id?: string;
  }[],
): ReadonlySet<string> {
  const stale = new Set<string>();
  let failures: string[] = [];
  for (const message of messages) {
    if (message.ephemeral) {
      if (message.sendFailure && !message.terminalSession && message.id)
        failures.push(message.id);
      continue;
    }
    if (
      message.role === 'user' &&
      !message.stationCheckBack &&
      !message.stationMemoryContinuation &&
      !message.stationRestartContinuation
    ) {
      for (const id of failures) stale.add(id);
      failures = [];
    }
  }
  return stale;
}

/**
 * The newest "queued to retry" notice, for the composer to carry while a short
 * dock hides the transcript that holds it. It is a queued send, not a failure,
 * so `latestSendFailureLine` never repeats it; its action (Discard) is what the
 * composer must keep reachable. Like a failure it is stale once a LATER message
 * was accepted; `queued` (the chat still waits on its retry) ends it too, since
 * the notice itself is left in the transcript after the retry settles.
 */
export function latestQueuedRetryNotice<
  Message extends {
    role: string;
    content: string;
    ephemeral?: boolean;
    queuedRetry?: boolean;
    action?: {
      label: string;
      handler: () => void;
      /** Ask first with the shared unconfirmed-message discard. */
      confirm?: 'unconfirmed-discard';
    };
  },
>(messages: readonly Message[], queued: boolean) {
  if (!queued) return undefined;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.ephemeral) {
      if (!message.queuedRetry || !message.action) continue;
      const line = noticeLine(message.content);
      return line ? { line, action: message.action } : undefined;
    }
    if (message.role === 'user') return undefined;
  }
  return undefined;
}

/**
 * The chat's ephemeral messages once the queue panel's "x" has discarded a
 * queued turn: only the queued-retry notices go, and only when no queued turn
 * is left for them to explain. Undefined when nothing changes, so a send
 * failure or a command's output survives the discard.
 */
export function ephemeralAfterQueueDiscard<Message extends object>(
  ephemeral: readonly Message[],
  remaining: number,
) {
  if (remaining > 0) return undefined;
  const kept = ephemeral.filter(
    (message) => !(message as { queuedRetry?: boolean }).queuedRetry,
  );
  return kept.length === ephemeral.length ? undefined : kept;
}

function noticeLine(content: string) {
  if (!content) return undefined;
  const line = content
    .replace(/^\[SYSTEM_EVENT\]\s*/, '')
    .split('\n', 1)[0]
    ?.replace(/\*\*/g, '')
    .trim();
  return line || undefined;
}

export function ConversationBody(
  props: ConversationBodyProps | RecordConversationBodyProps,
) {
  // #3418: only the live body reads Session titles for Station tool rows.
  return 'density' in props && props.density === 'record' ? (
    <RecordConversationBody {...props} />
  ) : (
    <StationSessionTitlesProvider>
      <LiveConversationBody {...(props as ConversationBodyProps)} />
    </StationSessionTitlesProvider>
  );
}

function LiveConversationBody({
  activeSession,
  transcriptSnapshotRef,
  workingDirectory,
  activeOrchestrationSession,
  activeOrchestrationSessionRead = 'present',
  onRetryOrchestrationSessions,
  chatFontSize,
  dockHeight,
  showStatsPanel,
  showContextMeter = false,
  showReasoning,
  showToolDetails,
  modelSupportsAttachments,
  fileAttachmentsSupported,
  modelProviderLabel,
  modelProviders,
  agentDefaultModelId,
  agentApprovalModeDefault,
  stationApprovalModeDefault,
  toolPolicyDelivery,
  availableModels,
  stagedAgentChange,
  executionModels,
  onExecutionModelSelect,
  modelsLoading = false,
  chatInput,
  onComposerEnabledChange,
  sendQueuedForUploads = false,
  owner,
  secondaryActions: dockSecondaryActions,
  onOpenAgentHandoff,
  agentHandoffTriggerRef,
  onOpenBackgroundTasks,
  onNewChat: onNewChatProp,
  onRetryConversationOpen,
  loadingEscapeDelayMs = LOADING_ESCAPE_DELAY_MS,
  onForkFromTurn,
  onResendFromMessage,
  setShowStatsPanel,
}: ConversationBodyProps) {
  const [scrollControlsTarget, setScrollControlsTarget] =
    useState<HTMLDivElement | null>(null);
  const hostAgents = useAgents();
  const {
    apiBase,
    requestScope: mentionRequestScope,
    station,
    record: connectionRecord,
  } = useConversationConnection();
  const visibilityFlags = useSurfaceVisibilityFlags();
  const { transport, transcript, streamStatus, turnInFlight } =
    useConversationController(activeSession);
  const currentTranscriptMessages = transcript.enabled
    ? transcript.settled &&
      !transcript.revalidating &&
      !transcript.catchingUp &&
      !transcript.error &&
      !transcript.upgradeRequired
      ? transcript.messages
      : undefined
    : activeSession.orchestrationSessionStarted
      ? undefined
      : activeSession.messages;
  useLayoutEffect(() => {
    if (
      !transcriptSnapshotRef ||
      !mentionRequestScope ||
      !currentTranscriptMessages
    )
      return;
    const snapshot = {
      chatId: activeSession.id,
      conversationId: activeSession.conversationId,
      messages: currentTranscriptMessages,
      requestScope: mentionRequestScope,
    };
    transcriptSnapshotRef.current = snapshot;
    return () => {
      if (transcriptSnapshotRef.current === snapshot)
        transcriptSnapshotRef.current = null;
    };
  }, [
    activeSession.id,
    activeSession.conversationId,
    currentTranscriptMessages,
    mentionRequestScope,
    transcriptSnapshotRef,
  ]);
  // Open and Settled inbox: this host's own record for this person. A replay
  // or another Station's conversation has none here.
  const settledConversationId =
    activeSession.conversationId &&
    !activeSession.replay &&
    (!station || station.routeKind === 'host')
      ? activeSession.conversationId
      : undefined;
  const settled = useSettledConversation(settledConversationId, turnInFlight);
  const secondaryActions =
    station && station.routeKind !== 'host' ? undefined : dockSecondaryActions;
  // Read only when it decides something: a turn is running and the draft
  // holds files. Every other render sends nothing.
  const queueTakesFiles = useFollowUpAttachmentsSupport(
    apiBase,
    !station || station.routeKind === 'host',
    turnInFlight &&
      (chatInput.attachments.length > 0 ||
        (chatInput.attachmentStages?.length ?? 0) > 0),
  );
  const targetAgents = useAgentsQuery({
    enabled: Boolean(station),
    readTarget: station,
  });
  const agents = station ? (targetAgents.data ?? []) : hostAgents;
  const { updateChat, clearEphemeralMessages, addEphemeralMessage } =
    useActiveChatActions();
  const { navigate } = useNavigationActions();
  const { user } = useAuth();
  const { captureCredentialEvidence } = useConnections();
  const approvalModeIsNewSession =
    !activeSession?.orchestrationSessionStarted &&
    !activeSession?.conversationId;
  // A new chat in a Project starts in that Project's approval layer
  // (`project-chat-defaults.ts`). Read only while the chat has not started:
  // a started session reports what its engine applied. The cached answer is
  // also what the first send consults before queuing a personal default.
  // `null`: this Station applies no Project layer here; `undefined`: no
  // answer yet (loading or failed).
  const { data: projectChatDefaultsAnswer } = useScopedProjectChatDefaultsQuery(
    approvalModeIsNewSession ? activeSession?.projectSlug : undefined,
  );
  const projectChatDefaults = projectChatDefaultsAnswer ?? undefined;
  const mentionCredentialEvidence = captureCredentialEvidence();
  const mentionAuthority =
    (!station || station.capabilities.mentions.state === 'allowed') &&
    mentionCredentialEvidence
      ? durableMentionAuthority({
          apiBase: mentionCredentialEvidence.origin,
          connectionId: mentionCredentialEvidence.connectionId,
          authorityGeneration: mentionCredentialEvidence.authorityGeneration,
          credentialState: mentionCredentialEvidence.credentialState,
        })
      : null;
  const { data: acpConnections = [], isSuccess: acpConnectionsVerified } =
    useACPConnections(!station || station.routeKind === 'host');
  const activeAcpConnection = useMemo(
    () =>
      acpConnections.find(
        (connection) => connection.id === activeSession.agentConnectionId,
      ),
    [acpConnections, activeSession.agentConnectionId],
  );
  const advertisedAcpSession = useMemo(
    () => advertisedAcpSessionModesFromConnection(activeAcpConnection),
    [activeAcpConnection],
  );
  // #3290: who decides which of this ACP engine's actions ask.
  const acpApproval = useMemo(
    () => acpApprovalFor(activeAcpConnection),
    [activeAcpConnection],
  );
  const accountableHuman = useMemo(
    () =>
      station?.routeKind === 'relay' ? null : accountableHumanFromUser(user),
    [user, station],
  );

  const { settings } = useFeatureSettings();
  const stt = useSTT();
  const tts = useTTS();
  const { getComposedContext } = useMessageContextContext();
  // A reopened conversation retains the admission decision that opened this
  // tab. Provider/model availability today cannot convert a recovery view
  // into a writable continuation of a different child session.
  const openPhase = conversationOpenPhase(activeSession);
  // Split deliberately. `resolvingOpen` blocks the same writes `recoveryOpen`
  // does — you cannot send into a conversation whose continuation is unproven —
  // but it is the only one of the two that may not claim anything is wrong
  // (#1582 E3/B6).
  // #2424: `unverified` refuses writes and shows the same recovery notice, but
  // is a failed check rather than a verdict — only `read-only` may say so.
  const unverifiedOpen = openPhase === 'unverified';
  const removedEngine =
    (!station || station.routeKind === 'host') &&
    acpConnectionsVerified &&
    isAcpFamilyEngine(activeOrchestrationSession?.provider) &&
    Boolean(activeSession.agentConnectionId) &&
    !activeAcpConnection &&
    !turnInFlight;
  const recoveryOpen =
    openPhase === 'read-only' || unverifiedOpen || removedEngine;
  const busyOpen = openPhase === 'busy';
  // A chat reopened mid-turn resolves `busy`: it cannot start a continuation,
  // but its open turn still takes Steer or Queue, as it does in the tab that
  // started it. Only a busy wait this tab sees no turn for (a missed
  // terminal) stays draft-only behind its Check again notice.
  const busyWaitBlocksSend = busyOpen && !turnInFlight;
  const resolvingOpen = openPhase === 'resolving';
  // Whether THIS caller may send into this conversation or start a chat, as
  // the server's own boundary answered it on the open read (`callerAccess`).
  // A refused send disables the composer with its reason and drops the send
  // invitations; a refused new chat drops every new-chat offer, because each
  // one ends in `POST /api/orchestration/chat`. Absent (an older server, a
  // request with no authenticated principal, or no successful open read yet)
  // means unknown, and unknown shows. The answer is as of the last open read:
  // a scope changed mid-session shows on the next one, and until then the
  // server's own refusal still stands.
  const callerAccess = conversationAccessFor(activeSession, station);
  const callerMayContinue = callerAccess?.continue !== false;
  const callerMayStartChat = callerAccess?.startChat !== false;
  const onNewChat = callerMayStartChat ? onNewChatProp : undefined;
  const windowRequests = useMemo(
    () =>
      unansweredApprovalRequests(
        [],
        transcript.events.map((item) => item.event),
      ).flatMap((request) =>
        request.approvalId
          ? [
              {
                requestId: request.approvalId,
                requestKind: request.requestKind,
                threadId: request.approvalThreadId,
              },
            ]
          : [],
      ),
    [transcript.events],
  );
  // A history or continuation read failed: what the session record last said
  // (Running, background work) is no longer current proof.
  const workObservation = useWorkObservation(
    activeSession.conversationId ?? activeSession.id,
    station,
  );
  useEffect(() => {
    if (
      unverifiedOpen &&
      !activeSession.replay &&
      workObservation?.unavailable(
        activeSession.conversationId ?? activeSession.id,
      ) === undefined
    ) {
      workObservation?.failed(activeSession.conversationId ?? activeSession.id);
    }
  }, [
    workObservation,
    unverifiedOpen,
    activeSession.conversationId,
    activeSession.id,
    activeSession.replay,
  ]);
  const observationUnavailable =
    unverifiedOpen ||
    Boolean(
      transcript.enabled && (transcript.error || transcript.upgradeRequired),
    );
  const transcriptReadFailed = Boolean(transcript.enabled && transcript.error);
  const reloadTranscript = transcript.reload;
  const pendingResyncs = useRef(new Set<string>());
  const [resyncs, setResyncs] = useState<ReadonlySet<string>>(new Set());
  const resyncKey = JSON.stringify([apiBase, activeSession.id]);
  const resyncPending = resyncs.has(resyncKey);
  // One replacement per conversation, including same-tick activations and
  // switching away and back while its reads are still pending.
  const resyncConversation = useCallback(async () => {
    if (pendingResyncs.current.has(resyncKey)) return;
    pendingResyncs.current.add(resyncKey);
    setResyncs(new Set(pendingResyncs.current));
    try {
      resyncOrchestrationEventStream(apiBase);
      await Promise.allSettled([
        ...(transcriptReadFailed ? [reloadTranscript()] : []),
        ...(activeOrchestrationSessionRead === 'error'
          ? [onRetryOrchestrationSessions?.()]
          : []),
        ...(unverifiedOpen ? [onRetryConversationOpen?.()] : []),
      ]);
    } finally {
      pendingResyncs.current.delete(resyncKey);
      setResyncs(new Set(pendingResyncs.current));
    }
  }, [
    apiBase,
    resyncKey,
    transcriptReadFailed,
    reloadTranscript,
    activeOrchestrationSessionRead,
    onRetryOrchestrationSessions,
    unverifiedOpen,
    onRetryConversationOpen,
  ]);
  const focusRecoveredComposer = useCallback(() => {
    const textarea = chatInput.textareaRef.current;
    const target = textarea?.disabled ? textarea.closest('fieldset') : textarea;
    target?.focus();
    return Boolean(target && document.activeElement === target);
  }, [chatInput.textareaRef]);
  const streamCatchingUp = useStreamCatchingUp(apiBase);
  // Live chat status shares the composer rail; replay keeps its recorded rows.
  const {
    pill: statusPill,
    statusInPill,
    stopInPill,
  } = useChatStatusPill({
    activeSession,
    sessionSummary:
      activeOrchestrationSessionRead === 'error'
        ? null
        : activeOrchestrationSession,
    streamStatus,
    turnLive: isTurnStreamLive(activeSession),
    enabled: !activeSession.replay,
    stopControl: turnInFlight && (
      <ConversationStopControl
        onCancel={chatInput.handleCancel}
        stopPending={!!activeSession.stopPending}
      />
    ),
    windowRequests,
    observationUnavailable: observationUnavailable || resyncPending,
    resyncPending,
    onResync: resyncConversation,
    onRecoveryFocus: focusRecoveredComposer,
    catchingUp: streamCatchingUp,
    apiBase,
  });
  /*
   * One transitional state for the whole conversation, from the two things
   * that are actually still in flight after a reload: the conversation-open
   * point-read (`resolvingOpen`, seeded by `hydrateActiveChats` for every
   * persisted chat with a conversation id) and the transcript's first read
   * (`settled`). Before #1582 E3/B6 these produced a red "is read-only" alert,
   * an empty "Start a chat" placeholder and a second red line under
   * the composer — three contradictory claims about a healthy conversation.
   */
  const transcriptPending =
    transcript.catchingUp || (transcript.enabled && !transcript.settled);
  /*
   * station#2530 review 2: `transcript.catchingUp` legitimately blanks
   * `transcript.messages` for BACKGROUND refetches too — a revision bump
   * whose reload has not settled yet, success or failure alike — and that
   * hook contract is correct and pinned elsewhere
   * (useActiveChatTranscript.test.tsx's "a fallback revision hides stale
   * transcript" case). What is wrong is unmounting the already-loaded
   * transcript/queue components over that BLIP: `ChatMessageList` lives
   * behind a `LazyBoundary`, and toggling its mount (empty → non-empty)
   * forces a fresh `lazy()` Suspense cycle even when the chunk is cached, so
   * a reload that resolves (successfully OR with an error) still shows one
   * more pending skeleton frame after the data is already back. Retain the
   * last non-empty read for THIS session and keep rendering it through a
   * catching-up blip; a genuinely empty transcript (never loaded, or a
   * session with no turns) still renders the empty state.
   */
  const stickyTranscriptRef = useRef<{ id: string; messages: ChatMessage[] }>({
    id: activeSession.id,
    messages: [],
  });
  if (stickyTranscriptRef.current.id !== activeSession.id) {
    stickyTranscriptRef.current = { id: activeSession.id, messages: [] };
  }
  if (transcript.messages.length > 0) {
    stickyTranscriptRef.current.messages = transcript.messages;
  } else if (transcript.settled && transcript.error && !transcript.catchingUp) {
    // A read that settled failed with no rows and is not catching up (a
    // cached paint whose re-read failed drops its rows so the failure shows)
    // leaves nothing to keep: a later Retry must not bring the dropped rows
    // back while it reads. A rejected revision reload is still catching up,
    // so its retained rows stay (station#2530).
    stickyTranscriptRef.current.messages = [];
  }
  const displayedTranscriptMessages =
    transcript.messages.length > 0
      ? transcript.messages
      : transcriptPending
        ? stickyTranscriptRef.current.messages
        : transcript.messages;
  /*
   * Loading is the FIRST read of this session's transcript, not every refetch
   * after it. A turn ending bumps the history revision (and can re-key the
   * window when the conversation id lands), and that refetch is a background
   * refresh of a transcript already on screen: counting it flashed a
   * "Loading chat" skeleton and a "Start new chat" escape under the
   * finished answer on every turn. Once this session has shown messages, a
   * pending refetch keeps showing them and claims nothing is loading.
   */
  const transcriptLoaded = stickyTranscriptRef.current.messages.length > 0;
  const conversationLoading =
    resolvingOpen || (transcriptPending && !transcriptLoaded);
  const transcriptDisplayed = displayedTranscriptMessages.length > 0;
  // Fetch the Markdown renderer alongside the transcript read rather than
  // after the rows render: rows painted from their source and then grew when
  // the renderer arrived.
  const hasConversation = Boolean(activeSession.conversationId);
  useEffect(() => {
    if (!hasConversation) return;
    preloadMarkdownRenderer();
    void preloadToolCallBatch().catch(() => undefined);
    // The list chunk too: rows that land before it would otherwise swap the
    // filler's stage for the pending one, replaying its entrance.
    void loadChatMessageList().catch(() => undefined);
  }, [hasConversation]);
  // Loading-phase boundaries for the opt-in transcript layout tracer.
  useEffect(() => {
    markTranscriptPhase('dock-loading', {
      resolvingOpen,
      transcriptPending,
      catchingUp: transcript.catchingUp,
      conversationLoading,
      transcriptDisplayed,
    });
  }, [
    resolvingOpen,
    transcriptPending,
    transcript.catchingUp,
    conversationLoading,
    transcriptDisplayed,
  ]);
  // D3: the long-wait line joins the stage only once a load has run long; a load
  // that lands in the ordinary second or two shows only its step.
  const [loadingLong, setLoadingLong] = useState(false);
  useEffect(() => {
    if (!conversationLoading) {
      setLoadingLong(false);
      return;
    }
    if (loadingEscapeDelayMs <= 0) {
      setLoadingLong(true);
      return;
    }
    const timer = setTimeout(() => setLoadingLong(true), loadingEscapeDelayMs);
    return () => clearTimeout(timer);
  }, [conversationLoading, loadingEscapeDelayMs]);
  /*
   * The wait is BOUNDED but not short: both reads go through the SDK client,
   * whose `DEFAULT_CLIENT_REQUEST_TIMEOUT_MS` is 30_000, so a resolution that
   * never lands settles into the read-only verdict in at most ~30s rather than
   * hanging. Through that window the draft stays editable (Send waits) and
   * the inbox and new-chat controls stay reachable; a slow load offers no
   * "Start new chat" of its own (owner decision, 2026-11; it replaced #1607's
   * row). Retry deliberately does not appear: retrying a read that is still
   * in flight is what the resolver is already doing.
   */
  const forkableTranscript =
    !activeSession.replay || activeSession.replay.mode === 'timeline';
  const forkFromTurn = forkableTranscript ? onForkFromTurn : undefined;
  const resendFromMessage = forkableTranscript
    ? onResendFromMessage
    : undefined;
  const renderedSession = useMemo(
    () =>
      transcript.enabled
        ? { ...activeSession, messages: displayedTranscriptMessages }
        : activeSession,
    [activeSession, transcript.enabled, displayedTranscriptMessages],
  );
  /**
   * station#3213. The dock's only failure rendering was `turnHandlers.ts`'s
   * append of a LIVE `runtime.error` into the streaming bubble, so arriving
   * cold at an already-failed session — a project deep link, a tab switch, the
   * project page's live-work section — showed nothing at all. This reads the
   * SAME fold the session detail renders (`utils/sessionFailure`), off the
   * server's own session record, so the two surfaces cannot describe one
   * failure two ways.
   *
   * The events come from the bounded window this pane already loads, mapped
   * out of their sequence envelopes: with them the banner quotes the exact
   * `runtime.error` the detail quotes; without them (window not yet resolved,
   * or a session that never started one) the shared fold falls back to the
   * server's `blockedReason` mirror and then to the one recorded sentence for
   * an unrecorded cause.
   */
  const failureEvents = useMemo(
    () => transcript.events.map((sequenced) => sequenced.event),
    [transcript.events],
  );
  const failureText = sessionFailureText(
    activeOrchestrationSession,
    failureEvents,
  );
  // A local chat can only claim a server-backed session after the foreground
  // dispatch recorded that one started. If that established record is absent
  // from the shared projection, do not silently fall back to an ordinary
  // empty/direct chat: the dock must preserve the last turn it still knows
  // about and name the missing record for the operator.
  //
  // UX audit T5 (live): this used to read `activeOrchestrationSession === null`,
  // which is also what a query that has not resolved yet — or has failed —
  // looks like. `orchestrationSessionStarted` IS rehydrated from storage on
  // reload, so on EVERY reload a perfectly healthy session rendered
  // "Session record missing" for about a second before the read landed. Only
  // an established absence (`absent`: the read succeeded and this thread is
  // not in it) may claim that; the read's own pending and failed states are
  // rendered as themselves below.
  const claimsServerSession =
    activeSession.orchestrationSessionStarted === true &&
    !isReplayThread(activeSession.id);
  // The inventory can omit an unloaded child. An authorized point-read of
  // this exact child is stronger evidence than absence from that list.
  const openResolution = activeSession.conversationOpenState;
  const currentChildKnown =
    openResolution?.status === 'resolved' &&
    openResolution.currentSessionId ===
      (activeSession.currentSessionId ??
        activeSession.conversationId ??
        activeSession.id);
  const sessionRecordMissing =
    claimsServerSession &&
    activeOrchestrationSessionRead === 'absent' &&
    !activeSession.conversationOpenPending &&
    !currentChildKnown;
  const sessionRecordPending =
    claimsServerSession && activeOrchestrationSessionRead === 'pending';
  const sessionRecordUnreadable =
    claimsServerSession && activeOrchestrationSessionRead === 'error';
  const lastKnownTurn = [...renderedSession.messages]
    .reverse()
    .find((message) => message.role === 'user' || message.role === 'assistant');
  // The transcript is empty on a cold reload — which is exactly when the
  // missing-record state can be reached — so the durable composer history is
  // the last-known turn that actually survives. Labelled for what it is: the
  // last message this client SENT, not a server-confirmed turn.
  const lastSentInput = activeSession.inputHistory?.at(-1);
  /**
   * station#3299: one failure, one surface. The transcript's turn-adjacent
   * surfaces (the `[CHAT_ERROR]` marker card, the ephemeral failure notice,
   * the projected error row) own a failure they already carry — they sit
   * with the turn it belongs to and hold its retry/new-chat affordances.
   * The banner renders only when the transcript says nothing about it,
   * which is exactly the cold arrival station#3213 built it for. Matched
   * against both the raw recorded cause and its translated body, because
   * the marker/projection embed the former and the ephemeral notice (and
   * the banner itself) print the latter.
   */
  const bannerFailureText =
    failureText !== null &&
    (transcriptCarriesFailureText(renderedSession.messages, [
      failureText,
      translateChatError({ message: failureText }).body,
    ]) ||
      // A session whose sends never took has no turns; any visible failure
      // card in its transcript is that refusal, in its own words.
      (activeOrchestrationSession !== null &&
        activeOrchestrationSession !== undefined &&
        isFirstSendFailure(activeOrchestrationSession) &&
        transcriptShowsFailureSurface(renderedSession.messages)))
      ? null
      : failureText;
  const historyFailure =
    transcript.enabled && (transcript.upgradeRequired || transcript.error);
  /**
   * station#3386. The bounded window read has two per-event budgets, and both
   * used to be silent: a payload over the serialized ceiling comes back as
   * identity fields alone, and a tool result comes back shortened. From here a
   * `turn.started` with its prompt and attachment removed by the budget was
   * indistinguishable from a turn that never carried them — and from a blob
   * retention had reclaimed. `elided` is the read's own report of which
   * budget fired, so this counts events the read actually withheld rather
   * than inferring anything from what is missing. Tool-detail reductions stay
   * in session diagnostics; they must not add a banner above an otherwise
   * complete conversation.
   */
  const elidedHistoryText = useMemo(
    () =>
      elidedHistoryNoticeText(
        summarizeElidedReasons(
          transcript.events
            .filter(
              (item) =>
                item.event.method !== 'tool.progress' &&
                item.event.method !== 'tool.started' &&
                item.event.method !== 'tool.completed' &&
                item.event.method !== 'token-usage.updated',
            )
            .map((sequenced) => sequenced.elided),
        ),
      ),
    [transcript.events],
  );
  const historyElisionNotice = elidedHistoryText ? (
    <details
      className="history-elided chat-dock__history-elided"
      data-testid="chat-dock-history-elided"
    >
      <summary>Some recorded details are omitted</summary>
      {elidedHistoryText}
    </details>
  ) : undefined;
  const historyFailureNotice = historyFailure ? (
    <div className="session-history-error" role="alert">
      <strong>Session history is unavailable.</strong>
      <span className="session-history-error__detail">
        {transcript.upgradeRequired
          ? ' Update Station to use bounded managed-session history.'
          : ` ${describeStationFailure(transcript.error, station).body}`}
      </span>
      <button
        type="button"
        className="button button--secondary session-history-error__retry"
        onClick={() => void transcript.reload()}
      >
        Retry
      </button>
    </div>
  ) : undefined;
  // The empty filler's loading wait (the filler names the wait itself).
  const showLoadingSkeleton = conversationLoading && !historyFailureNotice;
  const loadingLabel = transcript.catchingUp ? 'Catching up' : 'Loading chat';
  // The step the stage names: only the read that is actually in flight.
  const loadingStep: ConversationLoadingStep = resolvingOpen
    ? 'opening'
    : transcript.catchingUp
      ? 'catching-up'
      : 'reading';
  const loadingLongMessage = conversationLoadingLongText(station?.stationName);
  /*
   * What assistive tech hears about the wait. Screen readers announce a CHANGE
   * to a live region that already exists; a region inserted together with its
   * words, or one that names the wait only through `aria-label`, is mostly
   * not read. So one region lives for the dock body's whole life, starts
   * empty, and receives the words in an effect after it has been committed.
   * It goes quiet when the load ends: the rows arriving are the news, and
   * "loaded" is not a convention this app announces anywhere else. React
   * writes the text only when it changes, so re-renders announce nothing.
   *
   * The long-wait sentence uses the stage's own long-wait condition, so the
   * two cannot disagree. A history failure replaces the stage and is spoken
   * by its own alert, so it is never announced as a long wait.
   */
  const showLoadingLongRow =
    conversationLoading &&
    loadingLong &&
    !recoveryOpen &&
    !historyFailureNotice;
  const loadingAnnouncement = showLoadingLongRow
    ? loadingLongMessage
    : showLoadingSkeleton
      ? conversationLoadingStepText(loadingStep)
      : '';
  const [announcedLoading, setAnnouncedLoading] = useState('');
  useEffect(() => {
    setAnnouncedLoading(loadingAnnouncement);
  }, [loadingAnnouncement]);

  // Wire STT transcript into chat input
  const inputRef = useRef(chatInput.input);
  inputRef.current = chatInput.input;

  useEffect(() => {
    if (stt.state === 'idle' && stt.transcript) {
      const cur = inputRef.current;
      chatInput.handleInputChange(
        cur ? `${cur} ${stt.transcript}` : stt.transcript,
      );
    }
  }, [stt.state, stt.transcript, chatInput.handleInputChange]);

  useShareReceiver({
    enabled: true,
    onShare: useCallback(
      (text: string) => chatInput.handleInputChange(text),
      [chatInput],
    ),
  });

  const stagedSelection = stagedAgentChange?.selection;
  const handleSendWithContext = useCallback(
    (intent?: 'steer'): Promise<void> => {
      // Ambient context travels OUT-OF-BAND (#685): the server composes it into
      // the model-facing input only, so the transcript keeps the typed text.
      // `ambientContextForSend` keeps the `[`-prefix and slash-command
      // short-circuits (slash commands must reach `useSendMessage` unmodified
      // so `content.startsWith('/')` still routes them to the slash handler).
      const ambientContext = ambientContextForSend(
        getComposedContext(),
        chatInput.input,
      );
      if (stagedAgentChange) return stagedAgentChange.send(ambientContext);
      return chatInput.handleSend(undefined, undefined, {
        ambientContext,
        ...(intent === 'steer'
          ? { requireSteer: true }
          : { queueOnBusy: true, queueFilesOnBusy: queueTakesFiles }),
      });
    },
    [getComposedContext, chatInput, queueTakesFiles, stagedAgentChange],
  );
  const steerPlacement = sessionSteeringPlacement(
    activeSession.orchestrationDurability,
  );
  const nativeSteering = steerPlacement.state === 'native';
  const [queueToolbar, setQueueToolbar] = useState<HTMLDivElement | null>(null);
  const [queueEditTarget, setQueueEditTarget] = useState<HTMLDivElement | null>(
    null,
  );
  const [queueDraft, setQueueDraft] = useState<{
    sessionId: string;
    text: string;
    saving?: boolean;
  } | null>(null);
  const queueEdit =
    queueDraft?.sessionId === activeSession?.id ? queueDraft : null;
  const queueEditing = queueEdit !== null;
  const queueSessionId = activeSession?.id;
  useEffect(() => {
    setQueueDraft((draft) =>
      draft?.sessionId === queueSessionId ? draft : null,
    );
  }, [queueSessionId]);
  useEffect(() => {
    if (!queueEditing) return;
    const frame = requestAnimationFrame(() =>
      chatInput.textareaRef.current?.focus(),
    );
    return () => cancelAnimationFrame(frame);
  }, [queueEditing, chatInput.textareaRef]);
  const [pendingSteerTarget, setPendingSteerTarget] =
    useState<HTMLDivElement | null>(null);
  const steerEffect = nativeSteering
    ? 'Adds to the running turn'
    : steerPlacement.state === 'emulated' &&
        steerPlacement.boundary === 'engine-defined'
      ? 'Stops the step and continues'
      : 'Sends at the next safe boundary';
  const steeringUnavailableReason = activeSession.orchestrationDurability
    ? undefined
    : activeOrchestrationSessionRead === 'pending'
      ? 'Loading steering support…'
      : 'Steering unavailable: the host did not report a durability profile.';
  const busyFollowUp =
    turnInFlight &&
    !stagedAgentChange &&
    activeSession.conversationActivity?.openTurn?.trigger !== 'provider' &&
    chatInput.attachments.length === 0 &&
    sessionAdapterSupportsSteering(activeSession.orchestrationDurability)
      ? 'steer'
      : 'queue';
  const isExecutionActive = isSessionExecutionActive(activeSession);
  // #2309: the conversation's record carries the watchdog's silence for its
  // open turn, whichever lineage child runs it. Without a record, the current
  // session's own projection (the pre-#2309 source) is read instead.
  const turnProgressSilence = activeSession.conversationActivity
    ? activeSession.conversationActivity.progressSilence
    : activeOrchestrationSession?.turnProgress?.progressSilence;

  // #4568: Station's record that this chat's engine start is queued behind
  // another engine start: the Session's summary, or, for a brand-new chat
  // whose first start has no Session yet, the stream's wait frame for the id
  // it was sent under. Only while a send is in flight, so a stale read after
  // the send settled claims nothing; the composer's Stop cancels it.
  const streamedEngineStartWait = useEngineStartWait(apiBase, [
    activeSession.currentSessionId,
    activeSession.conversationId,
    activeSession.id,
  ]);
  const engineStartWait = isTurnInFlight(activeSession)
    ? (activeOrchestrationSession?.engineStartWait ?? streamedEngineStartWait)
    : undefined;

  // TTS readback when streaming ends
  const prevStatusRef = useRef(isExecutionActive);
  useEffect(() => {
    const wasStreaming = prevStatusRef.current;
    prevStatusRef.current = isExecutionActive;
    if (!wasStreaming || isExecutionActive) return;
    if (!settings.ttsReadbackEnabled) return;
    const lastMsg = [...activeSession.messages]
      .reverse()
      .find((m) => m.role === 'assistant');
    if (!lastMsg) return;
    const text =
      lastMsg.contentParts
        ?.filter((p) => p.type === 'text')
        .map((p) => p.content)
        .join(' ') ??
      lastMsg.content ??
      '';
    if (text.trim()) tts.speak(text.slice(0, 800));
  }, [
    isExecutionActive,
    activeSession.messages,
    settings.ttsReadbackEnabled,
    tts.speak,
  ]);

  const [removingMessages, setRemovingMessages] = useState<Set<string>>(
    new Set(),
  );
  const ephemeralMessages = activeSession.messages.filter((m) => m.ephemeral);
  const sendFailureNotice = latestSendFailureLine(
    activeSession.messages.filter((message) => !message.deliveryNotice),
  );
  const staleSendFailures = staleSendFailureIds(activeSession.messages);
  const queuedRetry = latestQueuedRetryNotice(
    activeSession.messages,
    activeSession.status === 'queued',
  );
  const queuedRetryNotice = queuedRetry
    ? {
        text: queuedRetry.line,
        confirm: queuedRetry.action.confirm === 'unconfirmed-discard',
        // What the transcript's own action does: run it, then drop the notice.
        onDiscard: () => {
          queuedRetry.action.handler();
          clearEphemeralMessages(activeSession.id);
        },
      }
    : undefined;

  // Every "New chat" affordance funnels rejections here: a typed
  // NewChatUnavailableError (the chat never started) surfaces bare, anything
  // else keeps its own context. Silent rejections are the dead-button class
  // this exists to prevent.
  const surfaceRecoveryFailure = useCallback(
    (error: unknown) => {
      // The established message surface owns error presentation — a bare
      // session-status error has no renderer here and a global alert would
      // double-render failures that already have their own surfaces
      // (station#2600 review).
      addEphemeralMessage(activeSession.id, {
        role: 'system',
        content: `[SYSTEM_EVENT] ${describeStationFailure(error).body}`,
      });
    },
    [activeSession.id, addEphemeralMessage],
  );

  const quoteMessage = useCallback(
    (quote: SavedAnswerQuote) => {
      chatDraftsStore.addQuote(activeSession.id, quote);
    },
    [activeSession.id],
  );
  const newChatFromMessage = useCallback(
    (text: string) => {
      if (onNewChat)
        void Promise.resolve(onNewChat(text)).catch(surfaceRecoveryFailure);
    },
    [onNewChat, surfaceRecoveryFailure],
  );

  /**
   * Resolve a recovered turn's attachments, then run the recovery. A turn
   * whose attachment bytes can no longer be fetched is REFUSED with a visible
   * message rather than re-sent without them (station#3385) — the same rule
   * the server applies to its own replays.
   */
  const runRecoveredTurn = useCallback(
    async (
      turn: { text: string; attachments: RetryAttachment[] },
      run: (text: string, attachments: FileAttachment[]) => unknown,
    ) => {
      try {
        const attachments = await resolveRetryAttachments(
          turn.attachments,
          apiBase,
          mentionRequestScope,
        );
        await run(turn.text, attachments);
      } catch (error) {
        surfaceRecoveryFailure(error);
      }
    },
    [apiBase, mentionRequestScope, surfaceRecoveryFailure],
  );

  // Continue after a memory kill goes through Station, which sends the
  // continuation once per dead turn whoever asks first (this device, another
  // one, or Station's own automatic continuation). An older Station has no
  // such route: then the short continuation is sent as an ordinary message.
  const continueAfterMemoryKill = useCallback(async () => {
    try {
      if (station && station.routeKind !== 'host')
        throw new MemoryContinuationUnsupportedError();
      await continueAfterMemoryExhaustion(
        activeSession.conversationId ?? activeSession.id,
        apiBase,
      );
    } catch (error) {
      if (error instanceof MemoryContinuationUnsupportedError) {
        await runRecoveredTurn(
          { text: MEMORY_EXHAUSTION_CONTINUE_TEXT, attachments: [] },
          (text, attachments) => sendRef.current(text, attachments),
        );
        return;
      }
      surfaceRecoveryFailure(error);
    }
  }, [
    activeSession.conversationId,
    activeSession.id,
    apiBase,
    station,
    runRecoveredTurn,
    surfaceRecoveryFailure,
  ]);

  // Continue after a restart cut a turn off: an ordinary send of a fixed
  // prompt, keyed on the interruption so a repeat (a double tap, another
  // device) names the same turn and the server admits it once. It leaves the
  // composer alone. The local set only covers the tap before the send's own
  // row renders.
  const continueInterruptedEnabled = visibilityFlags.has(
    CONTINUE_INTERRUPTED_TURN_PREVIEW_ID,
  );
  const sendComposedRef = useRef(chatInput.sendComposedMessage);
  sendComposedRef.current = chatInput.sendComposedMessage;
  const continuingInterruptedRef = useRef(new Set<string>());
  const continueInterruptedTurn = useCallback(
    async (boundaryId: string, prompt: string) => {
      const continuing = continuingInterruptedRef.current;
      if (continuing.has(boundaryId)) return;
      continuing.add(boundaryId);
      try {
        await sendComposedRef.current(
          prompt,
          turnInterruptedContinueClientTurnId(boundaryId),
        );
      } catch (error) {
        surfaceRecoveryFailure(error);
      } finally {
        continuing.delete(boundaryId);
      }
    },
    [surfaceRecoveryFailure],
  );
  // Only on a transcript that has caught up: while it catches up the dock
  // keeps showing the last one it read, whose latest row may be stale.
  const continueInterruptedAction = useCallback(
    (msg: ChatMessage) => {
      if (!continueInterruptedEnabled) return undefined;
      const boundaryId = continuableInterruptedBoundary(
        renderedSession.messages,
        msg,
        {
          replay: Boolean(activeSession.replay),
          current:
            !transcriptPending &&
            !observationUnavailable &&
            openPhase === 'writable',
          turnInFlight: turnInFlight,
          pendingSends:
            (activeSession.outboundQueuedTurns?.length ?? 0) +
            (activeSession.queuedMessages?.length ?? 0),
        },
      );
      return boundaryId
        ? {
            label: 'Continue',
            // The prompt follows the notice's reason: an engine that ended
            // under a running Station is not a restart.
            onClick: () =>
              void continueInterruptedTurn(
                boundaryId,
                turnInterruptedContinuePrompt(
                  interruptionNoticeReason(msg.content),
                ),
              ),
          }
        : undefined;
    },
    [
      continueInterruptedEnabled,
      turnInFlight,
      renderedSession.messages,
      activeSession,
      transcriptPending,
      observationUnavailable,
      openPhase,
      continueInterruptedTurn,
    ],
  );

  const handleDismissEphemeral = useCallback(
    (messageId: string) => {
      setRemovingMessages((prev) => new Set(prev).add(messageId));
      setTimeout(() => {
        const updated = ephemeralMessages.filter(
          (m, i) => (m.id || `ephemeral-${i}`) !== messageId,
        );
        if (updated.length === 0) {
          clearEphemeralMessages(activeSession.id);
        } else {
          updateChat(activeSession.id, { ephemeralMessages: updated });
        }
        setRemovingMessages((prev) => {
          const next = new Set(prev);
          next.delete(messageId);
          return next;
        });
      }, 300);
    },
    [ephemeralMessages, activeSession.id, clearEphemeralMessages, updateChat],
  );

  const agent = agents.find((a) => a.slug === activeSession.agentSlug);
  const hasExecutionAlternatives = Boolean(
    onExecutionModelSelect &&
      activeSession.conversationId &&
      executionModels?.some(
        (model) =>
          model.executionAgentId !== activeSession.executionAgentId &&
          model.available !== false,
      ),
  );
  // Another engine is offered only when this caller can switch to it: the
  // dock passes no `onExecutionModelSelect` when the server's open resolution
  // denies changes to this conversation, and an engine this client cannot
  // start (not ready, incompatible) is left out rather than listed. While a
  // turn or queued message blocks the switch, the engines stay listed but
  // disabled with that reason, and so is the reset that would return an
  // engine override to the Agent's defaults: both open the same dialog, so
  // neither opens it only for its submit to refuse a blocked switch. Pending
  // attachments are not known here; the dialog disables its submit for them.
  // An engine override with no engine change offered (the conversation is
  // read-only, unverified, busy or still resolving) refuses its reset too:
  // the model-only reset would leave the override in place while reading as
  // "Use Agent defaults".
  const engineChangeBlockedReason = secondaryActions?.handoffDisabledReason;
  const engineResetBlockedReason = activeSession.executionAgentId
    ? onExecutionModelSelect
      ? engineChangeBlockedReason
      : 'This conversation can’t change its engine right now.'
    : undefined;
  const pickerModels = executionModels
    ?.filter(
      (model) =>
        model.executionAgentId === activeSession.executionAgentId ||
        (onExecutionModelSelect && model.available !== false),
    )
    .map((model) =>
      model.executionAgentId === activeSession.executionAgentId
        ? chatInput.canModelSelect
          ? model
          : {
              ...model,
              available: false,
              unavailableReason:
                chatInput.modelSelectionReason ??
                'This engine cannot change its model in this conversation.',
            }
        : engineChangeBlockedReason
          ? {
              ...model,
              available: false,
              unavailableReason: engineChangeBlockedReason,
            }
          : model,
    );
  // `chatExecutionBinding` and `chatEngineIdentity` (utils/engine.ts) own
  // which Agent runs this chat and which engine it names; the dock header
  // reads the same two rules.
  const executionBinding = chatExecutionBinding(activeSession, agents);
  const engineIdentity = chatEngineIdentity({
    orchestrationProvider: activeSession.orchestrationProvider,
    currentSessionId:
      activeSession.currentSessionId ?? activeSession.conversationId,
    sessionConnectionId: activeSession.agentConnectionId,
    connectionObservedFor: activeSession.agentConnectionObservedFor,
    binding: executionBinding,
    acpConnections,
  });
  const configuredEngineLabel =
    executionBinding?.engineDisplayName ??
    engineDisplayLabel(activeSession.provider ?? '') ??
    modelProviderLabel;
  // Undefined while the Session's engine cannot be named: the chip then reads
  // its neutral "Engine & model" rather than a guess.
  const executionEngineLabel = engineIdentity.configurationNamesEngine
    ? (configuredEngineLabel ?? engineIdentity.sessionEngine)
    : engineIdentity.sessionEngine;
  // Set only once a Session exists: the engine that Session runs on.
  const sessionEngineLabel =
    engineIdentity.relation === 'no-session' ? undefined : executionEngineLabel;
  // The Agent now points somewhere else. While the Session can still take a
  // turn it keeps its engine, so that is said as a fact about the Agent. Once
  // the next turn starts a successor Session on the Agent's engine
  // (`chatNextTurnStartsSession`), that is the one case worth saying outright.
  const agentEngineMove =
    engineIdentity.relation === 'moved' &&
    executionBinding?.engineDisplayName &&
    executionBinding.engineDisplayName !== executionEngineLabel
      ? {
          to: executionBinding.engineDisplayName,
          nextTurn: chatNextTurnStartsSession(activeSession),
        }
      : undefined;

  const workspaceRefused =
    activeSession.outboundQueuedTurns?.some(isWorkspaceRefusedTurn) ?? false;
  // A refused workspace turns Send into "Start new chat". A caller who may not
  // start one gets neither: the composer is disabled and says why.
  const workspaceRefusedWithoutNewChat =
    workspaceRefused && !callerMayStartChat;

  // `handleSend`'s identity changes on every keystroke (its deps include the
  // composer `input`). Reading it through a ref keeps `renderOverride` stable,
  // so `ChatMessageList`'s memoization isn't defeated while typing (#797
  // review) — same pattern as `inputRef` above.
  const sendRef = useRef(chatInput.handleSend);
  sendRef.current = chatInput.handleSend;

  // Dock-specific message overrides: ephemeral messages and system events
  const renderOverride = useCallback(
    (msg: ChatMessage, idx: number): React.ReactNode | null => {
      if (msg.ephemeral) {
        const messageId = msg.id || `ephemeral-${idx}`;
        if (staleSendFailures.has(messageId) && 'action' in msg && msg.action) {
          // The message stays readable; only its Retry goes (#4400).
          const settled = { ...msg, action: undefined };
          return (
            <EphemeralMessage
              key={messageId}
              idx={idx}
              fontSize={chatFontSize}
              isRemoving={removingMessages.has(messageId)}
              onDismiss={() => handleDismissEphemeral(messageId)}
              msg={settled}
            />
          );
        }
        return (
          <EphemeralMessage
            key={messageId}
            idx={idx}
            fontSize={chatFontSize}
            isRemoving={removingMessages.has(messageId)}
            onDismiss={() => handleDismissEphemeral(messageId)}
            msg={
              msg.terminalSession && chatInput.input.trim() && onNewChat
                ? {
                    ...msg,
                    action: {
                      label: 'New chat',
                      handler: () =>
                        void Promise.resolve(onNewChat(chatInput.input)).catch(
                          surfaceRecoveryFailure,
                        ),
                    },
                  }
                : msg
            }
            onAction={
              (msg.terminalSession && chatInput.input.trim() && onNewChat) ||
              msg.action
                ? () => {
                    if (msg.terminalSession && onNewChat) {
                      void Promise.resolve(onNewChat(chatInput.input))
                        .then(() => clearEphemeralMessages(activeSession.id))
                        .catch(surfaceRecoveryFailure);
                    } else {
                      msg.action?.handler();
                      clearEphemeralMessages(activeSession.id);
                    }
                  }
                : undefined
            }
          />
        );
      }

      const textContent =
        msg.contentParts
          ?.filter((p: any) => p.type === 'text')
          .map((p: any) => p.content)
          .join('\n') ||
        msg.content ||
        '';
      const isSystemEvent =
        msg.role === 'user' && textContent.startsWith('[SYSTEM_EVENT]');
      if (isSystemEvent) {
        const eventBody = textContent.replace(/^\[SYSTEM_EVENT\]\s*/, '');
        // #191 R2 persistence-gap fix: a `[CHAT_ERROR]` sub-marker (written
        // by `chat-lifecycle.ts`'s failed-turn persistence) is a raw,
        // untranslated failure message — run it through the same
        // `translateChatError` table the live SSE/pre-stream paths use, so
        // a reload shows the same copy the user saw live instead of the
        // raw underlying message. station#1827: the sub-marker optionally
        // carries the originating `RuntimeErrorEvent.code` as
        // `[CHAT_ERROR:code]` (written by `turnHandlers.ts`'s
        // `handleRuntimeErrorEvent`) — the capture is optional so an older
        // marker without a code still parses exactly as before.
        const chatErrorMatch = eventBody.match(
          /^\[CHAT_ERROR(?::([\w-]+))?\]\s*([\s\S]*)$/,
        );
        // A failure stored in an older vocabulary reads as today's (#4266).
        const chatError =
          chatErrorMatch?.[2] !== undefined
            ? currentChatError({
                code: chatErrorMatch[1],
                message: chatErrorMatch[2],
              })
            : undefined;
        const chatErrorCode = chatError?.code;
        const chatErrorText = chatError?.message;
        const translation =
          chatErrorText !== undefined
            ? translateChatError({
                message: chatErrorText,
                code: chatErrorCode,
              })
            : undefined;
        // station#4080 slice 1: the boot-time interrupted-turn banner is a
        // plain, already-human-readable notice — nothing to translate, just
        // the same bracket-stripping `[CHAT_ERROR]` gets above so the raw
        // `[TURN_INTERRUPTED]` tag never reaches the user.
        const turnInterruptedMatch = eventBody.match(
          /^\[TURN_INTERRUPTED\]\s*([\s\S]*)$/,
        );
        // Station already continued after this memory kill (its own
        // continuation turn follows): say so, and offer Stop while it runs.
        const memoryContinued =
          chatErrorCode === ENGINE_MEMORY_EXHAUSTED_CODE &&
          renderedSession.messages
            .slice(idx + 1)
            .some((message) => message.stationMemoryContinuation === true);
        const displayContent = memoryContinued
          ? MEMORY_EXHAUSTION_CONTINUING_DISPLAY
          : translation
            ? formatChatErrorDisplay(translation, callerAccess)
            : (turnInterruptedMatch?.[1] ?? eventBody);
        // #797: the failed turn's own user message now survives the failure,
        // so the marker can offer to send it again — text and attachments
        // both — rather than leaving the user to retype it. station#1827
        // reserved "New chat" for `terminalSession` failures whose binding
        // could never resume; #765 A1 removed that flag from the
        // dead-engine-binding class specifically because the server's
        // continuation seam now recovers it (fresh child session, transcript
        // carried forward), so a resend into the same conversation is a
        // truthful affordance again. Translations that still claim
        // `terminalSession` keep the New-chat-only treatment. Auth/login
        // failures set `retryable: false` — Send again would hit the same
        // expired session.
        // #3112: `idx` indexes the list `ChatMessageList` renders — the
        // transcript projection when it is enabled — so the user turn is read
        // from that same list. The stored `activeSession.messages` is a
        // different list; the same index there landed on a Station agent's
        // stored copy of the model-facing input (ambient context prefix and
        // all), which Send again then resent as if typed.
        const retryTurn = chatErrorMatch
          ? findPrecedingUserTurn(renderedSession.messages, idx)
          : null;
        // A start Station could not confirm may have created the session;
        // a resend then collides with it ("thread … already has an active
        // writer"). No blind Send again — the hint says to check first.
        // Nor for a session that cannot take another message
        // (`terminalSession`: its contract is "retrying cannot help; offer a
        // fresh chat") — with New chat withheld from a caller the server
        // refused one, the chain below used to fall through to Send again.
        // Nor for a caller the server said may not send at all.
        const canRetry =
          chatErrorCode !== SESSION_START_INDETERMINATE_CODE &&
          translation?.retryable !== false &&
          !translation?.terminalSession &&
          callerMayContinue &&
          !!retryTurn &&
          (!!retryTurn.text.trim() || retryTurn.attachments.length > 0);
        return (
          <SystemEventMessage
            key={`${activeSession.id}-msg-${idx}`}
            messageKey={`${activeSession.id}-msg-${idx}`}
            content={displayContent}
            details={translation?.disclosureRaw ? chatErrorText : undefined}
            troubleshoot={
              // #4470: a failed turn (a `[CHAT_ERROR]` marker) offers
              // troubleshooting; the interrupted-turn notice and replays do
              // not. It starts a new chat, so a caller refused one is not
              // offered it. The raw error, not the translated copy, is what
              // the assistant can diagnose; the start flow redacts it.
              chatErrorMatch && !activeSession.replay && callerMayStartChat
                ? {
                    code: chatErrorCode ?? 'chat-error',
                    message: chatErrorText,
                    conversationId: activeSession.conversationId,
                    turnId: msg.turnId,
                  }
                : undefined
            }
            action={
              activeSession.replay
                ? undefined
                : turnInterruptedMatch
                  ? continueInterruptedAction(msg)
                  : chatErrorCode === MCP_SIGN_IN_REQUIRED_CODE
                    ? {
                        label: 'Sign in to tool',
                        onClick: () => navigate('/connections/tools'),
                      }
                    : chatErrorCode === ENGINE_SIGN_IN_REQUIRED_CODE &&
                        activeSession.agentConnectionId
                      ? {
                          label: 'Sign in',
                          onClick: () =>
                            navigate(
                              `/connections/engines/${encodeURIComponent(activeSession.agentConnectionId ?? '')}`,
                            ),
                        }
                      : chatErrorCode === ENGINE_MEMORY_EXHAUSTED_CODE
                        ? memoryContinued
                          ? turnInFlight
                            ? {
                                label: 'Stop',
                                onClick: () => void chatInput.handleCancel(),
                              }
                            : undefined
                          : callerMayContinue
                            ? {
                                // Not a resend: Station's continuation, whose
                                // model input carries the recovery note.
                                label: 'Continue',
                                onClick: () => void continueAfterMemoryKill(),
                              }
                            : undefined
                        : translation?.retryable === false &&
                            chatErrorCode !==
                              SESSION_START_INDETERMINATE_CODE &&
                            onNewChat
                          ? {
                              label: 'Switch agent',
                              onClick: () =>
                                void Promise.resolve(onNewChat()).catch(
                                  surfaceRecoveryFailure,
                                ),
                            }
                          : translation?.terminalSession &&
                              onNewChat &&
                              retryTurn
                            ? {
                                label: 'New chat',
                                onClick: () =>
                                  void runRecoveredTurn(retryTurn, onNewChat),
                              }
                            : canRetry && retryTurn
                              ? {
                                  label: 'Send again',
                                  onClick: () =>
                                    void runRecoveredTurn(
                                      retryTurn,
                                      (text, attachments) =>
                                        sendRef.current(text, attachments),
                                    ),
                                }
                              : undefined
            }
          />
        );
      }

      return null; // Use default MessageBubble rendering
    },
    [
      chatFontSize,
      removingMessages,
      staleSendFailures,
      activeSession.id,
      activeSession.replay,
      activeSession.agentConnectionId,
      navigate,
      renderedSession.messages,
      chatInput.input,
      clearEphemeralMessages,
      handleDismissEphemeral,
      onNewChat,
      runRecoveredTurn,
      surfaceRecoveryFailure,
      continueAfterMemoryKill,
      continueInterruptedAction,
      activeSession,
      chatInput.handleCancel,
      callerAccess,
      callerMayContinue,
      callerMayStartChat,
      turnInFlight,
    ],
  );

  // The stopped row that says "Station restarted mid-turn" in place of the
  // restart notice offers the notice's Continue under it.
  const renderAfterMessage = useCallback(
    (msg: ChatMessage): React.ReactNode | null => {
      if (msg.role !== 'assistant') return null;
      const action = continueInterruptedAction(msg);
      return action ? (
        <div className="interrupted-turn-continue">
          <Button size="sm" onClick={action.onClick}>
            {action.label}
          </Button>
        </div>
      ) : null;
    },
    [continueInterruptedAction],
  );

  // This browser's outbox: rows in the one pending-message list above the
  // composer, not a list of its own.
  const outboundTurns = activeSession.outboundQueuedTurns ?? [];
  const sendHeldCopy = async (turn: { clientTurnId: string }) => {
    const { outboundDispatch } = await import('../../lib/outboundQueue');
    await outboundDispatch.sendHeld(
      turn.clientTurnId,
      station ? outboundStationIdentity(station) : undefined,
      activeSession.conversationId,
    );
  };
  const outboxRows: OutboxRows | undefined = outboundTurns.length
    ? {
        count: outboundTurns.length,
        needsReview: outboundTurns.some(outboxNeedsReview),
        notSent: outboundTurns.some((turn) => turn.status === 'failed'),
        node: (
          <LazyBoundary
            load={loadOutboundQueuedMessages}
            pending={
              <SkeletonList
                count={1}
                withIcon={false}
                label="Loading offline messages"
              />
            }
            componentProps={{
              sessionId: activeSession.id,
              turns: outboundTurns,
              onSendHeld: sendHeldCopy,
              messages: renderedSession.messages,
              onError: (error: string) => surfaceRecoveryFailure(error),
              // The "x" discards the same queued turn as the notice's Discard;
              // once none is left, the notice has nothing to explain.
              onDiscarded: (remaining: number) => {
                const kept = ephemeralAfterQueueDiscard(
                  ephemeralMessages,
                  remaining,
                );
                if (!kept) return;
                if (kept.length === 0) clearEphemeralMessages(activeSession.id);
                else updateChat(activeSession.id, { ephemeralMessages: kept });
              },
              onRetry: async (clientTurnId: string) => {
                try {
                  const { outboundDispatch } = await import(
                    '../../lib/outboundQueue'
                  );
                  await outboundDispatch.retry(
                    clientTurnId,
                    station ? outboundStationIdentity(station) : undefined,
                    activeSession.conversationId,
                  );
                } catch (error) {
                  surfaceRecoveryFailure(
                    `Could not retry the durable offline turn: ${describeStationFailure(error).body}`,
                  );
                }
              },
              // No offer at all when the server refused this caller a new
              // chat; the fallback below is for a view without the handler.
              onStartNewChat: !callerMayStartChat
                ? undefined
                : (onNewChat ??
                  (() => {
                    updateChat(activeSession.id, {
                      status: 'error',
                      error:
                        'New chat is unavailable in this view — open the conversation from the dock and try again.',
                    });
                  })),
            }}
          />
        ),
      }
    : undefined;
  return (
    <SessionRewindProvider
      executionThreadId={
        activeSession.replay || connectionRecord?.readOnly
          ? undefined
          : (activeSession.currentSessionId ?? activeSession.id)
      }
      openTurnId={activeSession.conversationActivity?.openTurn?.turnId}
    >
      {!activeSession.replay && (
        <CoordinatorToolsNotice
          conversationId={activeSession.conversationId ?? activeSession.id}
        />
      )}
      {showStatsPanel && (
        <ConversationStats
          agentSlug={activeSession.agentSlug}
          conversationId={activeSession.conversationId || ''}
          apiBase={apiBase}
          isVisible={showStatsPanel}
          onToggle={() => setShowStatsPanel(!showStatsPanel)}
          messageCount={activeSession.messages.length}
          engineMcpServers={activeSession.engineMcpServers}
          engineMcpReconnect={activeSession.engineMcpReconnect === true}
          engineMcpComplete={activeSession.engineMcpComplete === true}
          engineName={activeAcpConnection?.name}
          executionThreadId={
            activeSession.replay || connectionRecord?.readOnly
              ? undefined
              : (activeSession.currentSessionId ?? activeSession.id)
          }
          key={`${activeSession.conversationId || activeSession.agentSlug}-${activeSession.orchestrationStatus || activeSession.status}`}
        />
      )}
      {historyFailure &&
        displayedTranscriptMessages.length > 0 &&
        historyFailureNotice}
      {sessionRecordPending && (
        <SkeletonList count={1} label="Reading this chat's record" />
      )}
      {sessionRecordUnreadable && (
        <ErrorState
          variant="compact"
          title="Could not read this Station's chat records"
          description="Showing the chat this browser still holds."
          action={
            onRetryOrchestrationSessions ? (
              <button
                type="button"
                className="button button--secondary"
                onClick={onRetryOrchestrationSessions}
              >
                Retry
              </button>
            ) : undefined
          }
        />
      )}
      {sessionRecordMissing && (
        <div
          className="session-history-error"
          role="alert"
          data-testid="chat-dock-session-record-missing"
        >
          <strong>Session record missing.</strong>
          <span className="session-history-error__detail">
            {lastKnownTurn
              ? ` Last known turn: ${lastKnownTurn.content}`
              : lastSentInput
                ? ` Last message you sent: ${lastSentInput}`
                : ' Station recorded that this session started, but no turn record is available.'}
          </span>
        </div>
      )}
      {displayedTranscriptMessages.length === 0 && (
        /*
         * The transcript owns the flex fill that pins the composer to the
         * bottom; without this filler an empty chat stacks the composer
         * directly under the header (#2467 gated the heavy list on content
         * and left no substitute).
         *
         * station#3764: what goes IN the filler is `ChatEmptyState` — the same
         * component `ChatMessageList` renders for an empty transcript, so an
         * empty chat says the same thing whether or not the list chunk is
         * mounted. #2467's split left the list as the only route to it, and
         * the follow-up filled this slot with a generic `Empty`; the effect
         * was that a Station with no model connection lost its whole guided
         * rescue ("Connect a model to start chatting" → Connections → Models)
         * and read "No messages yet" instead — a true sentence that is not
         * the reason nothing can be sent.
         */
        <div
          className="chat-messages chat-messages--empty"
          // One status region for the filler's whole life: it exists before
          // the empty state or notice it later announces (a region created
          // together with its text is often not read), and while loading it
          // carries the wait itself, so the skeleton inside is not a second,
          // nested region.
          role="status"
          aria-busy={showLoadingSkeleton || undefined}
          aria-label={showLoadingSkeleton ? loadingLabel : undefined}
        >
          {historyElisionNotice}
          {historyFailureNotice ??
            (showLoadingSkeleton ? (
              /*
               * "Start a chat" is a CLAIM that this chat has none, and
               * a transcript read that has not landed has established nothing.
               * It rendered here for ~1.7s on every reload of a conversation
               * that had turns in it (#1582 E3/B6). The skeleton keeps the flex
               * fill this slot exists for while saying only what is known.
               */
              <ConversationLoadingStage
                step={loadingStep}
                long={showLoadingLongRow}
                stationName={station?.stationName}
              />
            ) : (
              <ChatEmptyState
                agentSlug={renderedSession.agentSlug}
                agentName={renderedSession.agentName}
                canSend={callerMayContinue}
              />
            ))}
        </div>
      )}
      {displayedTranscriptMessages.length > 0 && (
        <BoundBrowserActivityProvider
          enabled={visibilityFlags.has('inline-browser-activity')}
          apiBase={apiBase}
          requestScope={mentionRequestScope}
          routeKind={station?.routeKind}
          readOnly={Boolean(activeSession.replay || connectionRecord?.readOnly)}
          session={activeSession}
        >
          <LazyBoundary
            load={loadChatMessageList}
            pending={CHAT_MESSAGE_LIST_PENDING}
            componentProps={{
              activeSession: renderedSession,
              recordAgents: agents,
              suppressStreamingRow: transcript.openTurnProjected,
              fontSize: chatFontSize,
              layoutHeight: dockHeight,
              scrollControlsTarget,
              pendingSteerRef: setPendingSteerTarget,
              showReasoning,
              showToolDetails,
              renderOverride,
              renderAfterMessage,
              emptyState: historyFailureNotice,
              historyNotice: historyElisionNotice,
              transcriptFooter: settled ? (
                <SettledConversationFooter
                  conversationId={settledConversationId}
                />
              ) : undefined,
              hasOlderMessages: transcript.enabled && transcript.hasMore,
              // #2316: the pending-approvals strip derives from the window's
              // events inside the lazily loaded list.
              approvalEvents: transcript.enabled
                ? transcript.events
                : undefined,
              approvalEventsSettled: transcript.settled,
              // A cached paint offers no answer until its re-read lands.
              approvalsHeld: transcript.revalidating === true,
              historyLoading: transcript.loading,
              // The status pill owns turn activity for a live chat.
              suppressActivity: statusInPill || Boolean(streamStatus),
              statusShownElsewhere: statusInPill,
              // #2309: the stall notice below presents the silence (with its
              // Stop action); the streaming row does not repeat it.
              progressSilenceShownElsewhere: Boolean(
                turnProgressSilence && turnInFlight,
              ),
              onLoadOlder: transcript.loadOlder,
              onLoadTurn: transcript.loadTurn,
              onReaderPlaceChange: transcript.enabled
                ? transcript.setReaderPlace
                : undefined,
              onOpenBackgroundTasks,
              liveStatusUnavailable: activeSession.replay
                ? observationUnavailable
                : (workObservation?.unavailable(
                    activeSession.conversationId ?? activeSession.id,
                  ) ?? observationUnavailable),
              accountableHuman,
              owner,
              onQuote: quoteMessage,
              onForkFromTurn: forkFromTurn,
              onNewChatFromMessage: onNewChat ? newChatFromMessage : undefined,
              onResendFromMessage: resendFromMessage,
              // The dock's header gear opens ChatSettingsPanel, which carries the
              // Summarize entry point (#3310).
              hasSettingsEntryPoint: true,
            }}
          />
        </BoundBrowserActivityProvider>
      )}
      {streamStatus && !statusInPill && streamStatus.kind !== 'restored' && (
        <div
          className="chat-stream-status"
          role="status"
          data-chat-stream-status={activeSession.id}
          title="Live updates are paused; the remote request may still be running."
        >
          <span>{streamStatus.label}</span>
          {streamStatus.blocked && (
            <button
              type="button"
              className="button button--secondary"
              disabled={Boolean(activeSession.replay)}
              onClick={() => openConnectionsModal({ mode: 'request-access' })}
            >
              Repair connection
            </button>
          )}
        </div>
      )}
      {(activeSession.unacknowledgedDecisions?.length ?? 0) > 0 && (
        // #2880: a decision Station recorded that the engine has not
        // acknowledged. Shown beside the transcript, not in the streaming
        // row: a turn stuck after an approval often has no streaming row.
        // "Not yet": a late acknowledgement removes it, and it never claims
        // the reply failed or that the engine applied it. A refused reply
        // (`invalid-reply`) was never sent, so it gets its own statement.
        <div
          className="chat-stream-status"
          role="status"
          data-chat-decision-delivery={activeSession.id}
        >
          {activeSession.unacknowledgedDecisions?.some(
            (decision) => decision.reason === 'invalid-reply',
          ) && (
            <span>
              Your decision is recorded, but Station did not send it because the
              engine would not accept that reply. The engine still needs an
              answer.
            </span>
          )}
          {activeSession.unacknowledgedDecisions?.some(
            (decision) => decision.reason === 'no-acknowledgement',
          ) && (
            <span>
              Your decision is recorded, but the engine has not acknowledged it
              yet. Station has not re-sent it.
            </span>
          )}
        </div>
      )}
      {activeSession.unsentMessages?.length ? (
        <LazyBoundary
          load={loadUnsentMessages}
          pending={null}
          componentProps={{
            sessionId: activeSession.id,
            messages: activeSession.unsentMessages,
          }}
        />
      ) : null}
      {/* One pending-message list: this browser's queue, its outbox and what
          Station holds for the conversation (#3868). It renders nothing while
          all are empty, and stays mounted so its rows can animate in and out. */}
      {activeSession.queuedMessages.length ||
      outboxRows ||
      !activeSession.replay ? (
        <LazyBoundary
          // The chat's own id: a new chat gaining its conversation id is the
          // same list, not a new one to mount (and replay its rows' entry).
          key={activeSession.id}
          load={loadConversationInboxMessages}
          pending={null}
          componentProps={{
            conversationId: activeSession.replay
              ? undefined
              : activeSession.conversationId,
            conversationActive: isExecutionActive,
            onResend: (message: string) => {
              const latest = activeChatsStore.getSnapshot()[activeSession.id];
              if (!latest || latest.input.trim()) return false;
              updateChat(activeSession.id, { input: message });
              return true;
            },
            sessionId: activeSession.id,
            messages: activeSession.queuedMessages,
            metadata: activeSession.queuedMessageMetadata,
            nextFirst: true,
            queueToolbar,
            composerEdit: {
              target: queueEditTarget,
              text: queueEdit?.text,
              start: (text: string) =>
                setQueueDraft({ sessionId: activeSession.id, text }),
              finish: () =>
                setQueueDraft((draft) =>
                  draft?.sessionId === activeSession.id ? null : draft,
                ),
              setSaving: (saving: boolean) =>
                setQueueDraft((draft) =>
                  draft?.sessionId === activeSession.id
                    ? { ...draft, saving }
                    : draft,
                ),
            },
            pendingSteerTarget,
            outbox: outboxRows,
            // The pill's fact when the server's turn record is here (it
            // survives a reload; the live parts do not), unless the user
            // owes an approval, which the turn waits on instead. The live
            // parts only without that record.
            waitingForTools: activeSession.conversationActivity
              ? turnToolsRunning(activeSession.conversationActivity) &&
                requestsWaitingOnUser({
                  pendingApprovals: activeSession.pendingApprovals ?? [],
                  answeredApprovals: activeSession.answeredApprovals,
                }).length === 0
              : hasActiveToolCall(activeSession.streamingMessage?.contentParts),
            sendNowPending:
              activeSession.queueSendNowPending ||
              activeSession.queueDrainSettling,
            onReviewOrigin: (messageId: string) => {
              const latest = activeChatsStore.getSnapshot()[activeSession.id];
              const index =
                latest?.queuedMessageMetadata?.findIndex(
                  (entry) => entry.id === messageId,
                ) ?? -1;
              if (
                !latest ||
                latest.input.trim() ||
                index < 0 ||
                !latest.queuedMessageMetadata?.[index]?.originUnverified
              )
                return;
              updateChat(activeSession.id, {
                input: latest.queuedMessages[index],
                queuedMessages: latest.queuedMessages.filter(
                  (_, position) => position !== index,
                ),
                queuedMessageMetadata: latest.queuedMessageMetadata.filter(
                  (_, position) => position !== index,
                ),
              });
            },
            onSendMessageNow: (messageId: string) =>
              sendPendingMessageNow(
                apiBase,
                activeSession.id,
                messageId,
                station,
              ),
            failure: activeSession.queuedMessageFailure,
            heldByUsageLimit: activeSession.usageLimitStopped === true,
            // UX audit T3: the automatic drain only fires on a later
            // `turn.completed`/`runtime.error`. A follow-up refused for a
            // reason the user has since fixed (a workspace binding, a paused
            // engine) otherwise sits there with no way to send it — the same
            // drain, on demand.
            onRetry: () =>
              drainQueuedMessageOnTurnCompleted(
                apiBase,
                activeSession.id,
                true,
                // #2309: an explicit request; not held back by the record.
                true,
                station,
              ),
            steeringUnavailableReason,
            canSteer:
              activeSession.conversationActivity?.openTurn?.trigger !==
                'provider' &&
              Boolean(
                isExecutionActive ||
                  activeSession.queuedMessageMetadata?.some(
                    (entry) => !!entry.delivery,
                  ),
              ) &&
              sessionAdapterSupportsSteering(
                activeSession.orchestrationDurability,
              ),
            onPendingSettled: () => {
              const latest = activeChatsStore.getSnapshot()[activeSession.id];
              if (
                latest &&
                latest.orchestrationStatus !== 'aborted' &&
                !isTurnInFlight(latest)
              )
                drainQueuedMessageOnTurnCompleted(
                  apiBase,
                  activeSession.id,
                  false,
                  false,
                  station,
                );
            },
            onSteer: async (message: string, clientInputId?: string) => {
              const latest = activeChatsStore.getSnapshot()[activeSession.id];
              if (
                !latest ||
                latest.queueSendNowPending ||
                latest.queueDrainSettling
              )
                return false;
              if (!clientInputId) {
                addEphemeralMessage(activeSession.id, {
                  role: 'system',
                  content:
                    'This pending message has no delivery identity. Keep it queued or reopen the conversation before steering.',
                });
                return false;
              }
              const metadataIndex =
                latest.queuedMessageMetadata?.findIndex(
                  (entry) => entry.id === clientInputId,
                ) ?? -1;
              const metadata = latest.queuedMessageMetadata?.[metadataIndex];
              if (
                !metadata ||
                metadata.originUnverified ||
                latest.queuedMessages[metadataIndex] !== message
              ) {
                addEphemeralMessage(activeSession.id, {
                  role: 'system',
                  content:
                    'This pending message changed. Review the current queue before steering it.',
                });
                return false;
              }
              activeChatsStore.updateChat(activeSession.id, {
                queueSendNowPending: true,
              });
              const retireConfirmedById = () => {
                const current =
                  activeChatsStore.getSnapshot()[activeSession.id];
                const index =
                  current?.queuedMessageMetadata?.findIndex(
                    (entry) => entry.id === clientInputId,
                  ) ?? -1;
                if (!current || index < 0) return;
                activeChatsStore.updateChat(activeSession.id, {
                  queuedMessages: current.queuedMessages.filter(
                    (_, position) => position !== index,
                  ),
                  queuedMessageMetadata: current.queuedMessageMetadata?.filter(
                    (_, position) => position !== index,
                  ),
                });
              };
              try {
                if (metadata.inboxSteerConversationId) {
                  if (!mentionRequestScope?.isCurrent())
                    throw new Error('Station authority changed.');
                  const entries = await listConversationInbox(
                    apiBase,
                    metadata.inboxSteerConversationId,
                    { requestScope: mentionRequestScope },
                  );
                  if (!mentionRequestScope.isCurrent())
                    throw new Error('Station authority changed.');
                  if (
                    entries.some(
                      (entry) =>
                        metadata.inboxSteerHead !== undefined &&
                        entry.kind === 'steer' &&
                        entry.ownedByCaller === true &&
                        entry.clientTurnId === clientInputId &&
                        entry.message === message &&
                        entry.expectedHead === metadata.inboxSteerHead,
                    )
                  ) {
                    retireConfirmedById();
                    return true;
                  }
                  addEphemeralMessage(activeSession.id, {
                    role: 'system',
                    content:
                      'Station has not confirmed this steer. It remains held for review.',
                  });
                  return false;
                }
                const steeringInput = {
                  // Steering is a command on the live execution Session. The
                  // tab id remains the durable conversation identity after a
                  // continuation child becomes current.
                  //
                  // #2309: the server's open turn names the exact lineage
                  // child and turn; the local stamp is the older-server path.
                  threadId:
                    (metadata?.delivery ? metadata.steerThreadId : undefined) ??
                    activeSession.conversationActivity?.openTurn?.threadId ??
                    activeSession.currentSessionId ??
                    activeSession.id,
                  text: message,
                  requestScope: mentionRequestScope,
                  clientInputId,
                  turnId:
                    metadata?.delivery && metadata.steerThreadId !== undefined
                      ? metadata.steerTurnId
                      : (activeSession.conversationActivity?.openTurn?.turnId ??
                        activeSession.openTurnId),
                  apiBase,
                };
                if (metadata?.delivery) {
                  const inspection = await inspectOrchestrationSteerInput({
                    ...steeringInput,
                    clientInputId,
                  });
                  if (inspection.outcome === 'steered') {
                    retireConfirmedById();
                    addEphemeralMessage(activeSession.id, {
                      role: 'system',
                      content: 'Steering sent.',
                    });
                    return true;
                  }
                  if (inspection.outcome !== 'not-received') {
                    const held =
                      activeChatsStore.getSnapshot()[activeSession.id];
                    activeChatsStore.updateChat(activeSession.id, {
                      queuedMessageMetadata: held?.queuedMessageMetadata?.map(
                        (entry) =>
                          entry.id === clientInputId
                            ? { ...entry, delivery: 'indeterminate' }
                            : entry,
                      ),
                    });
                    addEphemeralMessage(activeSession.id, {
                      role: 'system',
                      content:
                        'Steering delivery is still unconfirmed. Your message remains held.',
                    });
                    return false;
                  }
                }
                const prepared =
                  activeChatsStore.getSnapshot()[activeSession.id];
                const preparedIndex =
                  prepared?.queuedMessageMetadata?.findIndex(
                    (entry) => entry.id === clientInputId,
                  ) ?? -1;
                if (
                  !prepared ||
                  preparedIndex < 0 ||
                  prepared.queuedMessages[preparedIndex] !== message
                )
                  return false;
                activeChatsStore.updateChat(activeSession.id, {
                  ...(prepared.queuedMessageFailure?.code ===
                  'steering-save-failed'
                    ? { queuedMessageFailure: undefined }
                    : {}),
                  queuedMessageMetadata: prepared.queuedMessageMetadata?.map(
                    (entry) =>
                      entry.id === clientInputId
                        ? {
                            ...entry,
                            delivery: 'steering',
                            mode: 'steer',
                            steerThreadId: steeringInput.threadId,
                            steerTurnId: steeringInput.turnId,
                          }
                        : entry,
                  ),
                });
                if (!activeChatsStore.flushPendingSave()) {
                  const held = activeChatsStore.getSnapshot()[activeSession.id];
                  activeChatsStore.updateChat(activeSession.id, {
                    queuedMessageMetadata: held?.queuedMessageMetadata?.map(
                      (entry) =>
                        entry.id === clientInputId
                          ? { ...entry, delivery: 'indeterminate' }
                          : entry,
                    ),
                    queuedMessageFailure: {
                      code: 'steering-save-failed',
                      message:
                        'Could not save pending steering. It was not sent; your message remains held.',
                      at: Date.now(),
                    },
                  });
                  return false;
                }
                const result = await (transport
                  ? transport.steer(steeringInput)
                  : steerOrchestrationTurn(steeringInput));
                if (result.outcome === 'steered') {
                  retireConfirmedById();
                  addEphemeralMessage(activeSession.id, {
                    role: 'system',
                    content: 'Steering sent.',
                  });
                  return true;
                }
                if (result.outcome === 'indeterminate') {
                  const held = activeChatsStore.getSnapshot()[activeSession.id];
                  activeChatsStore.updateChat(activeSession.id, {
                    queuedMessageMetadata: held?.queuedMessageMetadata?.map(
                      (entry) =>
                        entry.id === clientInputId
                          ? { ...entry, delivery: 'indeterminate' }
                          : entry,
                    ),
                  });
                  return false;
                }
                const refused =
                  activeChatsStore.getSnapshot()[activeSession.id];
                activeChatsStore.updateChat(activeSession.id, {
                  queuedMessageMetadata: refused?.queuedMessageMetadata?.map(
                    (entry) =>
                      entry.id === clientInputId
                        ? {
                            ...entry,
                            delivery: undefined,
                            steerThreadId: undefined,
                            steerTurnId: undefined,
                          }
                        : entry,
                  ),
                });
                addEphemeralMessage(activeSession.id, {
                  role: 'system',
                  sendFailure: true,
                  content: steerRefusalMessage(result),
                });
              } catch (error) {
                const conflict =
                  (error as { stationEnvelope?: unknown })?.stationEnvelope ===
                    true &&
                  isSteerConflictCode((error as { code?: unknown })?.code);
                const held = activeChatsStore.getSnapshot()[activeSession.id];
                activeChatsStore.updateChat(activeSession.id, {
                  queuedMessageMetadata: held?.queuedMessageMetadata?.map(
                    (entry) =>
                      entry.id === clientInputId
                        ? { ...entry, delivery: 'indeterminate' }
                        : entry,
                  ),
                });
                addEphemeralMessage(activeSession.id, {
                  role: 'system',
                  ...(conflict ? { sendFailure: true } : {}),
                  content: conflict
                    ? 'That steer key names different input. Review the held message before resending.'
                    : 'Station could not confirm steering delivery. Your message remains held.',
                });
              } finally {
                activeChatsStore.updateChat(activeSession.id, {
                  queueSendNowPending: false,
                });
              }
              return false;
            },
          }}
        />
      ) : null}
      {/*
        station#3213. The session detail's own failure banner, rendered here
        rather than respelled — same component, same fold, so one failure
        cannot read two ways on two surfaces.

        The note is DERIVED from the lifecycle contract, not assumed:
        `SESSION_LIFECYCLE_TRANSITIONS` declares `failed: ['queued',
        'running']` and the send path's only terminal gate rejects
        `completed` alone (`orchestration-service.ts`'s `sendTurn` case), so
        sending here really does try to resume this session. "Try" is the
        honest verb — whether the turn lands depends on the engine's own live
        session binding, and when that binding is gone the existing
        terminal-session marker says so and offers a new chat instead. It is
        also why the composer below stays enabled: disabling it would be a
        second untruth in the opposite direction.

        Every note invites a send, so it is withheld when the server's open
        read said this caller may not post one (`callerAccess.continue`); the
        banner then keeps only the recorded cause. While the open itself is
        unproven the banner does not render at all, so it cannot contradict
        the recovery notice's "Sending is paused".
      */}
      <SessionFailureAlert
        failureText={recoveryOpen || resolvingOpen ? null : bannerFailureText}
        className="chat-dock__session-failure"
        testId="chat-dock-session-failure"
        note={
          callerMayContinue
            ? sessionFailureNote(activeOrchestrationSession)
            : undefined
        }
      />
      {/* #3157: the limited conversation's own banner, from the server's
          recovery projection; it re-reads with each snapshot update. */}
      <UsageLimitBanner
        apiBase={apiBase}
        scope={mentionRequestScope}
        session={activeSession}
        summary={activeOrchestrationSession}
      />
      {/* Commands an agent asked to run here, each waiting for its own Run. */}
      {activeSession.conversationId &&
      !activeSession.replay &&
      (!station || station.routeKind === 'host') ? (
        <TerminalRunNotes
          conversationId={activeSession.conversationId}
          refreshKey={terminalRunRefreshKey(
            activeSession.conversationActivity?.openTurn?.turnId,
            activeSession.streamingMessage?.contentParts,
          )}
        />
      ) : null}
      {agent?.available === false &&
        !recoveryOpen &&
        !resolvingOpen &&
        activeSession.modelSource !== 'session override' && (
          <div
            style={{
              padding: '8px 12px',
              margin: '0 12px 8px',
              background: 'var(--bg-warning, var(--bg-secondary))',
              border: '1px solid var(--border-warning, var(--border-primary))',
              borderRadius: '6px',
              fontSize: '0.85em',
              color: 'var(--text-muted)',
            }}
          >
            {/*
              station#3136. The lead-in is DERIVED, not assumed. The old
              banner opened with "can't launch with its current model" for
              every unavailable agent and then interpolated the server's
              reason — which, for an engine-default alias, says the opposite
              (there is no authored Agent, and the row has no model concept at
              all). `resolveNewChatAgentEnable` is the same machine-readable
              signal the new-chat picker keys its "Not set up" chip and Enable
              action on (`enable` is attached by the server for exactly the
              no-authored-Agent refusal on a ready connection); it is reused
              here rather than re-derived, and `unavailableReason` is never
              parsed.

              The remedy differs from the picker's on purpose. The server's own
              reason is explicit that enabling the engine helps NEW chats and
              that "existing conversations stay readable" — so an in-banner
              Enable that created the Agent and left the user in this dead
              thread would overclaim. `onNewChat()` with no arguments opens the
              new-chat picker, which is where the real Enable affordance lives.
            */}
            {resolveNewChatAgentEnable(agent) ? (
              <>
                <strong>This agent isn't set up yet.</strong> No Agent has been
                created for this engine, so this conversation can't continue —
                it stays readable.
                {onNewChat ? (
                  <>
                    {' '}
                    <button
                      type="button"
                      onClick={() =>
                        void Promise.resolve(onNewChat()).catch(
                          surfaceRecoveryFailure,
                        )
                      }
                      style={BANNER_LINK_BUTTON_STYLE}
                    >
                      Enable it in a new chat
                    </button>
                    .
                  </>
                ) : null}
              </>
            ) : (
              <>
                <strong>This agent is unavailable.</strong>{' '}
                {agent.unavailableReason ? `${agent.unavailableReason} ` : ''}
                {agent.unavailableFix?.kind === 'cli-missing' ||
                agent.unavailableFix?.kind === 'connection-broken' ||
                agent.unavailableFix?.kind === 'engine-disabled' ? (
                  <button
                    type="button"
                    onClick={() =>
                      navigate(
                        agent.unavailableFix?.target
                          ? `/connections/engines/${encodeURIComponent(agent.unavailableFix.target)}`
                          : '/connections/engines',
                      )
                    }
                    style={BANNER_LINK_BUTTON_STYLE}
                  >
                    Open engine settings
                  </button>
                ) : (
                  <>
                    Select a model from the picker to start chatting, or{' '}
                    <button
                      type="button"
                      onClick={() =>
                        navigate(`/agents/${activeSession.agentSlug}`)
                      }
                      style={BANNER_LINK_BUTTON_STYLE}
                    >
                      edit the agent's model setting
                    </button>
                    .
                  </>
                )}
                {callerMayStartChat ? (
                  <>
                    {' '}
                    <button
                      type="button"
                      onClick={() =>
                        requestTroubleshoot({
                          code:
                            agent.unavailableFix?.kind ?? 'agent-unavailable',
                          message:
                            agent.unavailableReason ??
                            'This agent is unavailable.',
                          conversationId: activeSession.conversationId,
                        })
                      }
                      style={BANNER_LINK_BUTTON_STYLE}
                    >
                      Troubleshoot
                    </button>
                  </>
                ) : null}
              </>
            )}
          </div>
        )}
      {/*
        The transitional state. It replaces the red "is read-only" alert this
        phase used to paint: nothing has gone wrong — `hydrateActiveChats`
        seeds the pending phase on every reload of a chat with a conversation
        id, so this is the ordinary path (#1582 E3/B6).

        With messages on screen the wait is shown by the draft-only composer,
        whose placeholder (or, with a draft, its send-blocked reason) names it
        (`loadingConversation`); with
        an empty transcript the filler above shows it. Either way it is
        announced by this one persistent, visually hidden region (see
        `loadingAnnouncement`). An in-flow block under the newest message used
        to shrink the transcript while the open read was pending and hand the
        space back when it landed ("space appears below while the conversation
        loads").
      */}
      <div
        className="sr-only"
        role="status"
        aria-live="polite"
        aria-atomic="true"
        data-testid="chat-dock-loading-announcement"
      >
        {announcedLoading}
      </div>
      {/*
        A slow load offers no "Start new chat": the user opened THIS chat, the
        inbox and new-chat controls stay reachable throughout, and the draft
        stays editable (`allowDraftWhileDisabled`). The exits belong to a load
        that actually failed: the recovery notice below (Retry + Start new
        chat) and the history-failure notice (Retry).
      */}
      {recoveryOpen ? (
        <LazyBoundary
          load={loadConversationOpenRecoveryNotice}
          componentProps={{
            title:
              activeSession.conversationOpenState?.conversation.title ??
              activeSession.title,
            state: removedEngine
              ? 'engine-disconnected'
              : unverifiedOpen
                ? 'unverified'
                : activeSession.conversationOpenState?.status,
            onContinue:
              !unverifiedOpen &&
              !turnInFlight &&
              !busyOpen &&
              !secondaryActions?.handoffDisabled &&
              callerMayContinue &&
              (!station || station.routeKind === 'host')
                ? (onOpenAgentHandoff ?? secondaryActions?.onOpenHandoff)
                : undefined,
            // Retry re-reads the open (`GET /api/conversations/:id/open`),
            // the read this client already makes to see the chat. Start new
            // chat follows the server's `callerAccess.startChat` (`onNewChat`
            // is already withheld when it refused).
            onRetry: onRetryConversationOpen
              ? () => void onRetryConversationOpen()
              : undefined,
            // The draft typed while the chat was opening goes with it, so a
            // read-only verdict does not strand that text in a dead composer.
            onStartNew: onNewChat
              ? () =>
                  void Promise.resolve(
                    onNewChat(
                      chatInput.input.trim() ? chatInput.input : undefined,
                      chatInput.attachments.length > 0
                        ? chatInput.attachments
                        : undefined,
                    ),
                  ).catch(surfaceRecoveryFailure)
              : undefined,
          }}
          pending={
            <div className="session-history-error" role="status">
              Conversation recovery is loading. Sending is paused.
            </div>
          }
        />
      ) : null}
      {/*
        The way out of a stale wait. A `busy` resolution is an authoritative
        wait on the active turn, and only three things re-prove it: the
        terminal turn event (turnHandlers), a child change (snapshotHandlers),
        or a reload (hydrate seeds pending). Miss the terminal — a backgrounded
        phone across a long turn — and the composer sits draft-only with Send
        dead: `recoveryOpen` owns Retry + Start new, `resolvingOpen` keeps
        the draft open until the read answers, `busy` owned nothing. When this tab itself sees no turn in
        flight, the wait may be that stale one, so offer the same re-resolve
        the recovery notice owns. A genuine wait (turn in flight) keeps the
        current draft-only behavior below.
      */}
      {busyOpen && !turnInFlight ? (
        <div className="session-history-controls" role="status">
          <span>
            Waiting for the active turn to finish. If it already has, check
            again to send.
          </span>
          {onRetryConversationOpen ? (
            <button
              type="button"
              className="button button--secondary"
              onClick={() => void onRetryConversationOpen()}
            >
              Check again
            </button>
          ) : null}
        </div>
      ) : null}
      {/*
        #765 A2/A3: the turn-stall watchdog's projection, surfaced IN the
        chat it is about. The server has observed this silence for the
        agent's whole stall window (`turn-progress-tracker.ts`,
        observe-only by archive#2959 decision — Station terminates nothing),
        and until now the only surfaces showing it were Home rows and the
        Sessions list; the affected chat itself just said "Working…". The
        wording is derived from the observation, never a client-side
        re-sample, and the Stop affordance is the composer's existing
        interrupt path — this banner adds visibility, not a new mechanism.
        `isTurnInFlight` gates it so a stale projection read after the turn
        settled cannot claim a live stall.
      */}
      {engineStartWait && (
        <div
          role="status"
          data-testid="chat-dock-engine-start-wait"
          style={{
            display: 'flex',
            margin: '0 var(--k-space-3) var(--k-space-2)',
          }}
        >
          <StatusBadge
            status="Waiting for another engine to start"
            tone="caution"
          />
        </div>
      )}
      {turnProgressSilence &&
        turnInFlight &&
        activeSession.activityHint?.kind !== 'retrying' && (
          <div
            role="status"
            data-testid="chat-dock-turn-stall-notice"
            style={{
              padding: '8px 12px',
              margin: '0 12px 8px',
              background: 'var(--bg-warning, var(--bg-secondary))',
              border: '1px solid var(--border-warning, var(--border-primary))',
              borderRadius: '6px',
              fontSize: '0.85em',
              color: 'var(--text-muted)',
            }}
          >
            <ProgressSilenceObservation
              observation={turnProgressSilence}
              engineName={
                sessionEngineLabel ??
                agent?.engineDisplayName ??
                acpConnections.find(
                  (connection) =>
                    connection.id === activeSession.agentConnectionId,
                )?.name ??
                engineDisplayLabel(turnProgressSilence.provider) ??
                'the agent'
              }
            />
            {'. '}
            <ConversationStopControl
              onCancel={chatInput.handleCancel}
              stopPending={!!activeSession.stopPending}
            >
              Stop this turn
            </ConversationStopControl>
          </div>
        )}
      {activeSession.replay?.mode === 'timeline' ? (
        <LazyBoundary
          load={loadConversationTimeline}
          pending={<SkeletonList count={1} label="Loading timeline controls" />}
          componentProps={{
            sessionId: activeSession.id,
            onForkFromTurn: forkFromTurn,
          }}
        />
      ) : activeSession.replay ? (
        <LazyBoundary
          load={loadReplayTransport}
          pending={null}
          componentProps={{ sessionId: activeSession.id }}
        />
      ) : (
        <>
          {/*
            Mounted HERE, between the transcript and everything docked at the
            bottom (quotes, composer): the floater floats over its parent
            (this chat body, not the history sidebar beside it) and keeps
            clear of everything below its own position, which is exactly the
            composer stack. A seam this component owns, not a class name.
          */}
          {activeSession.projectSlug ? (
            <LazyBoundary
              load={loadFloatOverChat}
              componentProps={{ session: activeSession }}
              pending={null}
              unavailable={() => null}
            />
          ) : null}
          {chatInput.quotes.length > 0 && (
            <LazyBoundary
              load={loadSourceQuoteDrafts}
              componentProps={{
                origin: apiBase,
                quotes: chatInput.quotes,
                onRemove: chatInput.removeQuote,
              }}
              pending={
                <SkeletonList count={1} label="Loading quoted context" />
              }
            />
          )}
          <ConversationComposer
            activity={
              activeSession.conversationId &&
              !activeSession.replay &&
              (!station || station.routeKind === 'host') ? (
                <>
                  <AgentScheduleNotes
                    key={activeSession.conversationId}
                    conversationId={activeSession.conversationId}
                    refreshKey={agentScheduleRefreshKey(
                      activeSession.conversationActivity?.openTurn?.turnId,
                      activeSession.streamingMessage?.contentParts,
                    )}
                  >
                    {statusInPill ? statusPill : null}
                  </AgentScheduleNotes>
                  {!statusInPill && statusPill}
                </>
              ) : (
                statusPill
              )
            }
            contextMeter={
              showContextMeter && activeSession.conversationId ? (
                <ContextPercentage
                  agentSlug={activeSession.agentSlug}
                  conversationId={activeSession.conversationId}
                  apiBase={apiBase}
                  messageCount={activeSession.messages.length}
                  liveUsage={activeSession.liveUsage}
                  onClick={() => setShowStatsPanel(true)}
                />
              ) : undefined
            }
            activityRef={setScrollControlsTarget}
            hasQuotedContext={chatInput.quotes.length > 0}
            queueEditTargetRef={setQueueEditTarget}
            draftText={queueEdit?.text ?? chatInput.quotedDraftText}
            quoteContext={chatInput.quotes}
            sessionId={activeSession.id}
            sendFailureNotice={sendFailureNotice}
            composerNotice={settled ? SETTLED_COMPOSER_NOTICE : undefined}
            stagedAgentNotice={
              stagedAgentChange
                ? {
                    label: stagedAgentChange.pending
                      ? stagedAgentChange.pending.sending
                        ? 'Sending Agent change…'
                        : 'Agent change unconfirmed'
                      : `Next message: ${stagedSelection?.agent.name} · ${stagedSelection?.executionAgent?.engineDisplayName ?? stagedSelection?.agent.engineDisplayName ?? stagedSelection?.connectionId ?? 'Station'} · ${stagedSelection?.modelId ?? 'Agent default'}`,
                    onCheck:
                      stagedAgentChange.pending &&
                      !stagedAgentChange.pending.sending
                        ? () =>
                            void (stagedAgentChange.canWithdraw
                              ? stagedAgentChange.withdraw()
                              : stagedAgentChange.send())
                        : undefined,
                    checkLabel: stagedAgentChange.canWithdraw
                      ? 'Withdraw Send'
                      : stagedAgentChange.canRetry
                        ? 'Retry Send'
                        : 'Check status',
                    onUndo: stagedAgentChange.pending
                      ? undefined
                      : stagedAgentChange.undo,
                  }
                : undefined
            }
            queuedRetryNotice={queuedRetryNotice}
            activeConversationId={activeSession.conversationId}
            input={queueEdit?.text ?? chatInput.input}
            editingQueue={queueEditing}
            queueEditSaving={queueEdit?.saving}
            workingDirectory={workingDirectory}
            mentionProjectSlug={activeSession.projectSlug}
            mentionRequestScope={mentionRequestScope}
            mentionAuthority={mentionAuthority}
            attachments={queueEditing ? [] : chatInput.attachments}
            textareaRef={chatInput.textareaRef}
            onEnabledChange={onComposerEnabledChange}
            disabled={
              !agent ||
              recoveryOpen ||
              resolvingOpen ||
              busyWaitBlocksSend ||
              !callerMayContinue ||
              workspaceRefusedWithoutNewChat
            }
            // A busy wait, or an open read still in flight, keeps the draft
            // open for a later send; a caller the server refused a send has
            // no later send to draft for. Send itself stays disabled.
            allowDraftWhileDisabled={
              (busyWaitBlocksSend || resolvingOpen) &&
              !!agent &&
              callerMayContinue
            }
            sendRefused={!callerMayContinue || workspaceRefusedWithoutNewChat}
            turnInFlight={turnInFlight}
            stopInActivity={stopInPill}
            busyFollowUp={busyFollowUp}
            busyQueueTakesFiles={queueTakesFiles}
            busySteeringUnavailableReason={steeringUnavailableReason}
            queueToolbarRef={setQueueToolbar}
            followUpPresentation={{
              effect: steerEffect,
              showEffect: !nativeSteering,
            }}
            busySteeringKind={nativeSteering ? 'native' : 'safe-stop'}
            onQueueFollowUp={handleSendWithContext}
            stopPending={!!activeSession.stopPending}
            modelSupportsAttachments={modelSupportsAttachments}
            fileAttachmentsSupported={fileAttachmentsSupported}
            modelProviderLabel={
              stagedSelection
                ? (stagedSelection.executionAgent ?? stagedSelection.agent)
                    .engineDisplayName
                : modelProviderLabel
            }
            executionEngineLabel={executionEngineLabel}
            executionEngineId={
              engineIdentity.configurationNamesEngine
                ? executionBinding?.engineId
                : activeSession.orchestrationProvider
            }
            agentEngineMove={agentEngineMove}
            modelProviders={modelProviders}
            currentProviderId={
              stagedSelection
                ? stagedSelection.connectionId
                : activeSession.providerId
            }
            fontSize={chatFontSize}
            dockHeight={dockHeight}
            currentModel={
              stagedAgentChange
                ? stagedSelection?.modelId
                : chatInput.currentModel
            }
            currentModelSource={
              stagedSelection
                ? stagedSelection.modelId
                  ? 'session override'
                  : 'agent default'
                : activeSession.requestedModel === null
                  ? (activeSession.defaultModelSource ?? 'agent default')
                  : (activeSession.requestedModelSource ??
                    activeSession.modelSource)
            }
            canModelSelect={
              stagedAgentChange
                ? !stagedAgentChange.pending &&
                  stagedAgentChange.models.length > 0
                : chatInput.canModelSelect || hasExecutionAlternatives
            }
            modelSelectionReason={chatInput.modelSelectionReason}
            modelsStale={
              stagedAgentChange || hasExecutionAlternatives
                ? false
                : chatInput.modelsStale
            }
            modelsLoading={modelsLoading}
            agentDefaultModel={
              stagedAgentChange
                ? ((stagedSelection?.executionAgent ?? stagedSelection?.agent)
                    ?.execution?.modelId ?? undefined)
                : (agentDefaultModelId ?? undefined)
            }
            defaultModelSource={activeSession.defaultModelSource}
            availableModels={stagedAgentChange?.models ?? availableModels}
            pickerModels={stagedAgentChange?.models ?? pickerModels}
            currentExecutionAgentId={
              stagedAgentChange ? undefined : activeSession.executionAgentId
            }
            modelQuery={chatInput.modelQuery}
            agentConnectionId={
              stagedSelection
                ? stagedSelection.connectionId
                : activeSession.agentConnectionId
            }
            modelRuntimeOptions={
              stagedSelection?.options ??
              activeSession.requestedProviderOptions ??
              activeSession.providerOptions
            }
            secondaryActions={
              recoveryOpen || resolvingOpen || busyOpen
                ? undefined
                : secondaryActions
            }
            agentIcon={agent && <AgentIcon agent={agent} size="small" />}
            agentLabel={
              stagedSelection?.agent.name ??
              agent?.name ??
              activeSession.agentName ??
              activeSession.agentSlug
            }
            agentRoute={
              activeOrchestrationSession?.modelRoute
                ? activeOrchestrationSession.modelRoute.label
                : undefined
            }
            onOpenAgentHandoff={
              station && station.routeKind !== 'host'
                ? undefined
                : stagedAgentChange?.pending
                  ? undefined
                  : (onOpenAgentHandoff ?? secondaryActions?.onOpenHandoff)
            }
            agentHandoffTriggerRef={agentHandoffTriggerRef}
            agentHandoffDisabled={
              Boolean(stagedAgentChange?.pending) ||
              secondaryActions?.handoffDisabled
            }
            agentHandoffDisabledReason={secondaryActions?.handoffDisabledReason}
            executionMode={activeSession.executionMode}
            approvalModeIsNewSession={approvalModeIsNewSession}
            approvalModeAgentDefault={agentApprovalModeDefault}
            approvalModeProjectDefault={
              projectChatDefaults?.approvalMode.resolved
            }
            approvalModeProjectDefaultUnavailable={
              approvalModeIsNewSession &&
              !!activeSession?.projectSlug &&
              projectChatDefaultsAnswer === undefined
            }
            approvalModeStationDefault={stationApprovalModeDefault}
            toolPolicyDelivery={toolPolicyDelivery}
            lastAppliedApprovalMode={activeSession.lastAppliedApprovalMode}
            reportedApprovalReviewer={activeSession.reportedApprovalReviewer}
            approvalModeOverride={sessionApprovalOverride(activeSession)}
            acpSessionModes={advertisedAcpSession.modes}
            acpApproval={acpApproval}
            acpCurrentModeId={activeSession.currentModeId ?? undefined}
            acpRequestedModeId={
              typeof activeSession.requestedProviderOptions?.mode === 'string'
                ? activeSession.requestedProviderOptions.mode
                : undefined
            }
            commandQuery={chatInput.commandQuery}
            slashCommands={chatInput.slashCommands}
            onInputChange={
              queueEdit
                ? (text) =>
                    setQueueDraft({ sessionId: queueEdit.sessionId, text })
                : chatInput.handleInputChange
            }
            onSend={handleSendWithContext}
            onCancel={chatInput.handleCancel}
            onClearInput={
              queueEdit
                ? () =>
                    setQueueDraft({ sessionId: queueEdit.sessionId, text: '' })
                : chatInput.handleClearInput
            }
            selectAttachmentFiles={
              queueEditing ? undefined : chatInput.selectAttachmentFiles
            }
            attachmentError={chatInput.attachmentError}
            attachmentStages={queueEditing ? [] : chatInput.attachmentStages}
            attachmentNotice={chatInput.attachmentNotice}
            attachUnavailableReason={chatInput.attachUnavailableReason}
            onAttachUnavailable={chatInput.setAttachmentError}
            removalUnblocksSend={chatInput.removalUnblocksSend}
            sendBlockedReason={
              recoveryOpen && !unverifiedOpen
                ? callerMayStartChat
                  ? 'This conversation is available read-only. Retry resolution or start a new chat.'
                  : 'This conversation is available read-only. Retry resolution to check again.'
                : !callerMayContinue
                  ? // The server's open read refused this caller the send;
                    // say so instead of leaving Send to fail with a 403.
                    CALLER_CANNOT_SEND_REASON
                  : workspaceRefusedWithoutNewChat
                    ? WORKSPACE_REFUSED_WITHOUT_NEW_CHAT_REASON
                    : resolvingOpen &&
                        (chatInput.input.trim() ||
                          chatInput.attachments.length > 0)
                      ? // A draft hides the placeholder that named the wait,
                        // so Send says why it is not live yet.
                        'You can send once this chat opens.'
                      : recoveryOpen || resolvingOpen || busyWaitBlocksSend
                        ? // The banner above already says this; repeating the SENTENCE
                          // under the composer is what made one ordinary reload read as
                          // three separate problems. `undefined` leaves the composer
                          // quietly disabled. An `unverified` check (#2424) is the same:
                          // its notice says what failed and carries the Retry.
                          undefined
                        : chatInput.sendBlockedReason
            }
            sendQueuedForUploads={sendQueuedForUploads}
            onRetryAttachmentStage={chatInput.retryAttachmentStage}
            onCancelAttachmentStage={chatInput.cancelAttachmentStage}
            onReplaceAttachmentFile={chatInput.replaceAttachmentFile}
            onRemoveAttachment={chatInput.handleRemoveAttachment}
            onClearAttachments={chatInput.handleClearAttachments}
            onModelSelect={(model) => {
              if (stagedAgentChange) {
                stagedAgentChange.changeModel(model.id);
                return;
              }
              if (
                model.executionAgentId !== activeSession.executionAgentId &&
                onExecutionModelSelect
              ) {
                chatInput.handleModelClose();
                onExecutionModelSelect(model);
              } else if (chatInput.canModelSelect) {
                chatInput.handleModelSelect(model);
              }
            }}
            onModelReset={() => {
              if (stagedAgentChange) {
                stagedAgentChange.changeModel();
                return;
              }
              if (activeSession.executionAgentId) {
                if (engineResetBlockedReason || !onExecutionModelSelect) return;
                chatInput.handleModelClose();
                onExecutionModelSelect();
              } else {
                chatInput.handleModelReset();
              }
            }}
            modelResetDisabledReason={engineResetBlockedReason}
            // The server denied changes (no engine change offered): the
            // composer offers no reset. A turn or queue wait only disables it.
            modelResetOffered={
              !(activeSession.executionAgentId && !onExecutionModelSelect)
            }
            onModelClose={chatInput.handleModelClose}
            onModelOpen={
              stagedAgentChange || hasExecutionAlternatives
                ? chatInput.openModelForExecution
                : chatInput.handleModelOpen
            }
            onModelRuntimeOptionChange={
              stagedAgentChange?.changeOption ??
              chatInput.handleModelRuntimeOptionChange
            }
            onApprovalModeChange={chatInput.handleApprovalModeChange}
            onAcpSessionModeChange={chatInput.handleAcpSessionModeChange}
            onCommandSelect={chatInput.handleCommandSelect}
            onCommandClose={chatInput.handleCommandClose}
            onHistoryUp={chatInput.handleHistoryUp}
            onHistoryDown={chatInput.handleHistoryDown}
            onRestorePortableDraft={chatInput.handleRestorePortableDraft}
            updateFromInput={chatInput.updateFromInput}
            closeAll={chatInput.closeAll}
            voiceState={stt.state}
            voiceSupported={stt.supported}
            voiceUnsupportedReason={stt.unsupportedReason}
            voiceError={stt.errorMessage}
            onVoiceStart={() => stt.startListening()}
            onVoiceStop={() => stt.stopListening()}
            workspaceRefused={
              workspaceRefused && !workspaceRefusedWithoutNewChat
            }
            loadingConversation={resolvingOpen}
            onStartNewChat={onNewChat}
          />
        </>
      )}
    </SessionRewindProvider>
  );
}

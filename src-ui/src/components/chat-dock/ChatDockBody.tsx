import { useConnections } from '@kontourai/station-connect';
import type { ToolPolicyDelivery } from '@kontourai/station-contracts/engine-capability-matrix';
import { ENGINE_CAPABILITY_MATRICES } from '@kontourai/station-contracts/engine-capability-matrix';
import type { SteerTurnResult } from '@kontourai/station-contracts/orchestration';
import {
  type OrchestrationSessionSummary,
  steerOrchestrationTurn,
} from '@kontourai/station-sdk';
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { verifiedBuildLabel } from '../../build-info';
import { useActiveChatActions } from '../../contexts/ActiveChatsContext';
import { useAgents } from '../../contexts/AgentsContext';
import { useApiBase } from '../../contexts/ApiBaseContext';
import { useAuth } from '../../contexts/AuthContext';
import { isTurnInFlight } from '../../contexts/active-chats-state';
import { conversationOpenPhase } from '../../contexts/conversation-open-policy';
import { useNavigation } from '../../contexts/NavigationContext';
import { drainQueuedMessageOnTurnCompleted } from '../../hooks/orchestration/queueDrain';
import { useActiveChatTranscript } from '../../hooks/orchestration/useActiveChatTranscript';
import { useFeatureSettings } from '../../hooks/useFeatureSettings';
import { useMessageContext } from '../../hooks/useMessageContext';
import { useShareReceiver } from '../../hooks/useShareReceiver';
import type { SlashCommand } from '../../hooks/useSlashCommands';
import { useSTT } from '../../hooks/useSTT';
import { useTTS } from '../../hooks/useTTS';
import { isWorkspaceRefusedTurn } from '../../lib/workspaceRefusal';
import type { ChatMessage, ChatSession, FileAttachment } from '../../types';
import type { ApprovalMode } from '../../utils/approvalMode';
import { ambientContextForSend } from '../../utils/chatAmbientContext';
import {
  formatChatErrorDisplay,
  translateChatError,
} from '../../utils/chatErrorTranslation';
import {
  elidedHistoryNoticeText,
  summarizeElidedReasons,
} from '../../utils/elidedHistory';
import { isSessionExecutionActive } from '../../utils/execution';
import type {
  ModelProviderOption,
  SelectableModel,
} from '../../utils/modelCapabilities';
import {
  accountableHumanFromUser,
  ownerAttributionFromStation,
} from '../../utils/ownerAttribution';
import {
  sessionFailureText,
  transcriptCarriesFailureText,
} from '../../utils/sessionFailure';
import { ChatEmptyState } from '../chat/ChatEmptyState';
import { ChatInputArea } from '../chat/ChatInputArea';
import { EphemeralMessage } from '../chat/EphemeralMessage';
import type { ForkTurnSource } from '../chat/fork-turn-source';
import { SystemEventMessage } from '../chat/SystemEventMessage';
import { ConversationStats } from '../conversation-stats/ConversationStats';
import ProgressSilenceObservation from '../home/ProgressSilenceObservation';
import { LazyBoundary } from '../LazyBoundary';
import { resolveNewChatAgentEnable } from '../modals/new-chat-agent-enable';
import { SessionFailureAlert } from '../session-failure/SessionFailureAlert';
import { ErrorState, SkeletonBlock, SkeletonList } from '../state';
import type { ComposerActionsMenuProps } from './ComposerActionsMenu';
import {
  type RetryAttachment,
  resolveRetryAttachments,
  retryAttachmentsFromParts,
} from './retry-attachments';

const loadChatMessageList = () =>
  import('../chat/ChatMessageList').then(({ ChatMessageList }) => ({
    default: ChatMessageList,
  }));

const loadOutboundQueuedMessages = () =>
  import('../chat/OutboundQueuedMessages').then(
    ({ OutboundQueuedMessages }) => ({
      default: OutboundQueuedMessages,
    }),
  );

const loadConversationOpenRecoveryNotice = () =>
  import('./ConversationOpenRecoveryNotice').then((module) => ({
    default: module.ConversationOpenRecoveryNotice,
  }));

const loadQueuedMessages = () =>
  import('../chat/QueuedMessages').then(({ QueuedMessages }) => ({
    default: QueuedMessages,
  }));

// station#3706: lazy for the same reason as the queue above — most sessions
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

interface ChatDockBodyProps {
  activeSession: ChatSession;
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
  showReasoning: boolean;
  showToolDetails: boolean;
  modelSupportsAttachments: boolean;
  fileAttachmentsSupported: boolean;
  modelProviderLabel?: string;
  modelProviders?: ModelProviderOption[];
  agentDefaultModelId?: string;
  connectionApprovalModeDefault?: unknown;
  toolPolicyDelivery?: ToolPolicyDelivery;
  availableModels: SelectableModel[];
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
  onForkFromTurn?: (source: ForkTurnSource) => void;
  chatInput: {
    input: string;
    attachments: FileAttachment[];
    attachmentStages: import('../../types').ComposerAttachmentStageSnapshot[];
    sendBlockedReason?: string;
    textareaRef: React.RefObject<HTMLTextAreaElement | null>;
    currentModel: string | undefined;
    canModelSelect: boolean;
    modelSelectionReason?: string;
    modelsStale?: boolean;
    modelQuery: string | null;
    commandQuery: string | null;
    slashCommands: SlashCommand[];
    handleInputChange: (value: string) => void;
    handleSend: (
      overrideText?: string,
      overrideAttachments?: FileAttachment[],
      options?: { ambientContext?: string },
    ) => Promise<void>;
    handleCancel: () => void;
    handleClearInput: () => void;
    handleAddAttachments: (files: FileAttachment[]) => void;
    selectAttachmentFiles: (files: File[]) => Promise<void>;
    attachmentError: string | null;
    retryAttachmentStage: (id: string) => void | Promise<void>;
    cancelAttachmentStage: (id: string) => void | Promise<void>;
    replaceAttachmentFile: (id: string, files: File[]) => void | Promise<void>;
    handleRemoveAttachment: (id: string) => void;
    handleClearAttachments: () => void;
    handleModelSelect: (model: SelectableModel) => void;
    handleModelReset: () => void;
    handleModelClose: () => void;
    handleModelOpen: () => void;
    handleModelRuntimeOptionChange: (
      key: string,
      value: string | number | boolean | undefined,
    ) => void;
    handleApprovalModeChange: (mode: ApprovalMode) => void;
    handleCommandSelect: (command: SlashCommand) => Promise<void>;
    handleCommandClose: () => void;
    handleHistoryUp: () => void;
    handleHistoryDown: () => void;
    handleRestorePortableDraft: (
      text: string,
      attachments: FileAttachment[],
    ) => void;
    updateFromInput: (value: string) => void;
    closeAll: () => void;
  };
  setShowStatsPanel: (show: boolean) => void;
}

/**
 * The user turn a failed-turn marker belongs to — the nearest real user
 * message before it, skipping the `[SYSTEM_EVENT]` markers that are themselves
 * stored with a user role (#797).
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
 * The system-message copy for every `steerOrchestrationTurn` outcome OTHER
 * than `'steered'` (that one is a success — `onSteer` returns `true` for it
 * without ever calling this).
 *
 * station#4075 stage 2 review round 2: this used to be a two-way ternary
 * (`unsupported-engine` vs. a catch-all "the turn ended before the steer
 * could be sent") — the additive-enum trap. Adding `'concurrent-steer'` to
 * `SteerTurnResult` fell into that catch-all and told the user the turn had
 * ENDED, which is false: the turn is still live, another steer just won the
 * race. Exhaustive `switch` with NO `default` case that returns a value —
 * the `never`-check in the (genuinely unreachable) fallback is what makes a
 * FUTURE outcome addition a compile error here instead of silent wrong copy
 * (the same idiom as `views/settings/registry-row.tsx`).
 */
export function steerRefusalMessage(
  result: Exclude<SteerTurnResult, { outcome: 'steered' }>,
): string {
  switch (result.outcome) {
    case 'unsupported-engine':
      return `${result.engineName} does not support mid-turn steering.`;
    case 'no-active-turn':
      return 'The turn ended before the steer could be sent.';
    case 'concurrent-steer':
      return 'Another steer is in progress — try again in a moment.';
    default: {
      const exhaustive: never = result;
      return exhaustive;
    }
  }
}

export function ChatDockBody({
  activeSession,
  activeOrchestrationSession,
  activeOrchestrationSessionRead = 'present',
  onRetryOrchestrationSessions,
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
  modelsLoading = false,
  chatInput,
  secondaryActions,
  onOpenAgentHandoff,
  agentHandoffTriggerRef,
  onOpenBackgroundTasks,
  onNewChat,
  onRetryConversationOpen,
  onForkFromTurn,
  setShowStatsPanel,
}: ChatDockBodyProps) {
  const agents = useAgents();
  const { apiBase } = useApiBase();
  const { updateChat, clearEphemeralMessages, addEphemeralMessage } =
    useActiveChatActions();
  const { navigate } = useNavigation();
  const { user } = useAuth();
  const { activeConnection } = useConnections();
  // Stable across renders unless the saved Station or accountable display name
  // changes, preserving ChatMessageList's memoization.
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

  const { settings } = useFeatureSettings();
  const stt = useSTT();
  const tts = useTTS();
  const { getComposedContext } = useMessageContext();
  // A reopened conversation retains the admission decision that opened this
  // tab. Provider/model availability today cannot convert a recovery view
  // into a writable continuation of a different child session.
  const openPhase = conversationOpenPhase(activeSession);
  // Split deliberately. `resolvingOpen` blocks the same writes `readOnlyOpen`
  // does — you cannot send into a conversation whose continuation is unproven —
  // but it is the only one of the two that may not claim anything is wrong
  // (#1582 E3/B6).
  const readOnlyOpen = openPhase === 'read-only';
  const resolvingOpen = openPhase === 'resolving';
  const transcript = useActiveChatTranscript(apiBase, activeSession);
  /*
   * One transitional state for the whole conversation, from the two things
   * that are actually still in flight after a reload: the conversation-open
   * point-read (`resolvingOpen`, seeded by `hydrateActiveChats` for every
   * persisted chat with a conversation id) and the transcript's first read
   * (`settled`). Before #1582 E3/B6 these produced a red "is read-only" alert,
   * an empty "Start a conversation" placeholder and a second red line under
   * the composer — three contradictory claims about a healthy conversation.
   */
  const conversationLoading =
    resolvingOpen || (transcript.enabled && !transcript.settled);
  /*
   * The wait is BOUNDED but not short: both reads go through the SDK client,
   * whose `DEFAULT_CLIENT_REQUEST_TIMEOUT_MS` is 30_000, so a resolution that
   * never lands settles into the read-only verdict in at most ~30s rather than
   * hanging. That is long enough that the composer being disabled with no way
   * out would be its own defect, so the control row below keeps "Start new
   * chat" reachable for the whole window (review L1). Retry deliberately does
   * not appear: retrying a read that is still in flight is what the resolver is
   * already doing.
   *
   * The ROW is what scopes that control to the wait, so the button carries no
   * second copy of the condition. It had one, and an injection that made it
   * unconditional stayed green — a guard nothing can reach reads as a
   * guarantee and is not one.
   */
  const forkFromTurn = onForkFromTurn;
  const renderedSession = useMemo(
    () =>
      transcript.enabled
        ? { ...activeSession, messages: transcript.messages }
        : activeSession,
    [activeSession, transcript.enabled, transcript.messages],
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
    activeSession.orchestrationSessionStarted === true;
  const sessionRecordMissing =
    claimsServerSession && activeOrchestrationSessionRead === 'absent';
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
    transcriptCarriesFailureText(renderedSession.messages, [
      failureText,
      translateChatError({ message: failureText }).body,
    ])
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
   * than inferring anything from what is missing, and keeps the two reasons
   * apart in the copy.
   */
  const elidedHistoryText = useMemo(
    () =>
      elidedHistoryNoticeText(
        summarizeElidedReasons(
          transcript.events.map((sequenced) => sequenced.elided),
        ),
      ),
    [transcript.events],
  );
  const historyElisionNotice = elidedHistoryText ? (
    <div
      className="history-elided chat-dock__history-elided"
      role="status"
      data-testid="chat-dock-history-elided"
    >
      {elidedHistoryText}
    </div>
  ) : undefined;
  const historyFailureNotice = historyFailure ? (
    <div className="session-history-error" role="alert">
      <strong>Session history is unavailable.</strong>
      <span className="session-history-error__detail">
        {transcript.upgradeRequired
          ? ' Update Station to use bounded managed-session history.'
          : ` ${transcript.error?.message ?? 'Retry the history request.'}`}
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

  const handleSendWithContext = useCallback((): Promise<void> => {
    // Ambient context travels OUT-OF-BAND (#685): the server composes it into
    // the model-facing input only, so the transcript keeps the typed text.
    // `ambientContextForSend` keeps the `[`-prefix and slash-command
    // short-circuits (slash commands must reach `useSendMessage` unmodified
    // so `content.startsWith('/')` still routes them to the slash handler).
    const ambientContext = ambientContextForSend(
      getComposedContext(),
      chatInput.input,
    );
    return chatInput.handleSend(undefined, undefined, { ambientContext });
  }, [getComposedContext, chatInput]);
  const isExecutionActive = isSessionExecutionActive(activeSession);

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
  ]); // eslint-disable-line react-hooks/exhaustive-deps

  const [removingMessages, setRemovingMessages] = useState<Set<string>>(
    new Set(),
  );
  const ephemeralMessages = activeSession.messages.filter((m) => m.ephemeral);

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
        content: `[SYSTEM_EVENT] ${error instanceof Error ? error.message : String(error)}`,
      });
    },
    [activeSession.id, addEphemeralMessage],
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
        );
        await run(turn.text, attachments);
      } catch (error) {
        surfaceRecoveryFailure(error);
      }
    },
    [apiBase, surfaceRecoveryFailure],
  );

  const handleDismissEphemeral = useCallback(
    (messageId: string) => {
      setRemovingMessages((prev) => new Set(prev).add(messageId));
      setTimeout(() => {
        const updated = ephemeralMessages.filter(
          (m, i) => ((m as any).id || `ephemeral-${i}`) !== messageId,
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
  const workspaceRefused =
    activeSession.outboundQueuedTurns?.some(isWorkspaceRefusedTurn) ?? false;

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
        const messageId = (msg as any).id || `ephemeral-${idx}`;
        return (
          <EphemeralMessage
            key={messageId}
            idx={idx}
            fontSize={chatFontSize}
            isRemoving={removingMessages.has(messageId)}
            onDismiss={() => handleDismissEphemeral(messageId)}
            msg={
              (msg as any).terminalSession &&
              chatInput.input.trim() &&
              onNewChat
                ? {
                    ...(msg as any),
                    action: {
                      label: 'New chat',
                      handler: () =>
                        void Promise.resolve(onNewChat(chatInput.input)).catch(
                          surfaceRecoveryFailure,
                        ),
                    },
                  }
                : (msg as any)
            }
            onAction={
              ((msg as any).terminalSession &&
                chatInput.input.trim() &&
                onNewChat) ||
              (msg as any).action
                ? () => {
                    if ((msg as any).terminalSession && onNewChat) {
                      void Promise.resolve(onNewChat(chatInput.input))
                        .then(() => clearEphemeralMessages(activeSession.id))
                        .catch(surfaceRecoveryFailure);
                    } else {
                      (msg as any).action.handler();
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
        const chatErrorCode = chatErrorMatch?.[1];
        const chatErrorText = chatErrorMatch?.[2];
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
        const displayContent = translation
          ? formatChatErrorDisplay(translation, chatErrorText)
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
        // `terminalSession` keep the New-chat-only treatment.
        const retryTurn = chatErrorMatch
          ? findPrecedingUserTurn(activeSession.messages, idx)
          : null;
        const canRetry =
          !!retryTurn &&
          (!!retryTurn.text.trim() || retryTurn.attachments.length > 0);
        return (
          <SystemEventMessage
            key={`${activeSession.id}-msg-${idx}`}
            messageKey={`${activeSession.id}-msg-${idx}`}
            content={displayContent}
            action={
              translation?.terminalSession && onNewChat && retryTurn
                ? {
                    label: 'New chat',
                    onClick: () => void runRecoveredTurn(retryTurn, onNewChat),
                  }
                : canRetry && retryTurn
                  ? {
                      label: 'Send again',
                      onClick: () =>
                        void runRecoveredTurn(retryTurn, (text, attachments) =>
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
      activeSession.id,
      activeSession.messages,
      chatInput.input,
      clearEphemeralMessages,
      handleDismissEphemeral,
      onNewChat,
      runRecoveredTurn,
      surfaceRecoveryFailure,
    ],
  );

  return (
    <>
      {showStatsPanel && (
        <ConversationStats
          agentSlug={activeSession.agentSlug}
          conversationId={activeSession.conversationId || ''}
          apiBase={apiBase}
          isVisible={showStatsPanel}
          onToggle={() => setShowStatsPanel(!showStatsPanel)}
          messageCount={activeSession.messages.length}
          key={`${activeSession.conversationId || activeSession.agentSlug}-${activeSession.orchestrationStatus || activeSession.status}`}
        />
      )}
      {historyFailure && transcript.messages.length > 0 && historyFailureNotice}
      {historyElisionNotice}
      {sessionRecordPending && (
        <SkeletonList count={1} label="Reading this session's record" />
      )}
      {sessionRecordUnreadable && (
        <ErrorState
          title="Could not read this Station's session records"
          description="The chat below is what this browser still holds. Retry to find out whether the session is still there."
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
      {transcript.messages.length === 0 && (
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
        <div className="chat-messages chat-messages--empty" role="status">
          {historyFailureNotice ??
            (conversationLoading ? (
              /*
               * "Start a conversation" is a CLAIM that this chat has none, and
               * a transcript read that has not landed has established nothing.
               * It rendered here for ~1.7s on every reload of a conversation
               * that had turns in it (#1582 E3/B6). The skeleton keeps the flex
               * fill this slot exists for while saying only what is known.
               */
              <SkeletonList count={4} label="Loading conversation" />
            ) : (
              <ChatEmptyState
                agentSlug={renderedSession.agentSlug}
                agentName={renderedSession.agentName}
              />
            ))}
        </div>
      )}
      {transcript.messages.length > 0 && (
        <LazyBoundary
          load={loadChatMessageList}
          pending={<SkeletonList count={4} label="Loading conversation" />}
          componentProps={{
            activeSession: renderedSession,
            fontSize: chatFontSize,
            layoutHeight: dockHeight,
            showReasoning,
            showToolDetails,
            renderOverride,
            emptyState: historyFailureNotice,
            onOpenBackgroundTasks,
            owner,
            accountableHuman,
            onForkFromTurn: forkFromTurn,
            // The dock's header gear opens ChatSettingsPanel, which carries the
            // Summarize entry point (#3310).
            hasSettingsEntryPoint: true,
          }}
        />
      )}
      {transcript.enabled && transcript.hasMore && (
        <div className="session-history-controls">
          <button
            type="button"
            className="button button--secondary session-history-controls__more"
            onClick={() => void transcript.loadOlder()}
          >
            Load earlier events
          </button>
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
      {activeSession.queuedMessages.length ? (
        <LazyBoundary
          load={loadQueuedMessages}
          pending={null}
          componentProps={{
            sessionId: activeSession.id,
            messages: activeSession.queuedMessages,
            failure: activeSession.queuedMessageFailure,
            // UX audit T3: the automatic drain only fires on a later
            // `turn.completed`/`runtime.error`. A follow-up refused for a
            // reason the user has since fixed (a workspace binding, a paused
            // engine) otherwise sits there with no way to send it — the same
            // drain, on demand.
            onRetry: () =>
              drainQueuedMessageOnTurnCompleted(apiBase, activeSession.id),
            canSteer:
              isExecutionActive &&
              !!activeSession.orchestrationProvider &&
              ENGINE_CAPABILITY_MATRICES[activeSession.orchestrationProvider]
                ?.midTurnSteer === true,
            onSteer: async (message: string) => {
              try {
                const result = await steerOrchestrationTurn({
                  // Steering is a command on the live execution Session. The
                  // tab id remains the durable conversation identity after a
                  // continuation child becomes current.
                  threadId: activeSession.currentSessionId ?? activeSession.id,
                  text: message,
                  turnId: activeSession.openTurnId,
                  apiBase,
                });
                if (result.outcome === 'steered') return true;
                addEphemeralMessage(activeSession.id, {
                  role: 'system',
                  content: steerRefusalMessage(result),
                });
              } catch (error) {
                addEphemeralMessage(activeSession.id, {
                  role: 'system',
                  content: `Could not send steer: ${error instanceof Error ? error.message : String(error)}`,
                });
              }
              return false;
            },
          }}
        />
      ) : null}
      {activeSession.outboundQueuedTurns?.length ? (
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
            turns: activeSession.outboundQueuedTurns,
            messages: renderedSession.messages,
            onError: (error: string) => surfaceRecoveryFailure(error),
            onRetry: async (clientTurnId: string) => {
              try {
                const { outboundDispatch } = await import(
                  '../../lib/outboundQueue'
                );
                await outboundDispatch.retry(clientTurnId);
              } catch (error) {
                surfaceRecoveryFailure(
                  `Could not retry the durable offline turn: ${error instanceof Error ? error.message : String(error)}`,
                );
              }
            },
            onStartNewChat:
              onNewChat ??
              (() => {
                updateChat(activeSession.id, {
                  status: 'error',
                  error:
                    'New chat is unavailable in this view — open the conversation from the dock and try again.',
                });
              }),
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
      */}
      <SessionFailureAlert
        failureText={bannerFailureText}
        className="chat-dock__session-failure"
        testId="chat-dock-session-failure"
        note="You can send a message to try to continue this session."
      />
      {agent?.available === false &&
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
                <strong>This agent can't launch with its current model.</strong>{' '}
                {agent.unavailableReason ? `${agent.unavailableReason} ` : ''}
                Select a model from the picker to start chatting, or{' '}
                <button
                  type="button"
                  onClick={() => navigate(`/agents/${activeSession.agentSlug}`)}
                  style={BANNER_LINK_BUTTON_STYLE}
                >
                  edit the agent's model setting
                </button>
                .
              </>
            )}
          </div>
        )}
      {/*
        The transitional state, in the repo's one loading vocabulary
        (`state-primitives-ratchet`: name the wait in a skeleton's `label`,
        never a new sentence). It replaces the red "is read-only" alert this
        phase used to paint: nothing has gone wrong — `hydrateActiveChats`
        seeds the pending phase on every reload of a chat with a conversation
        id, so this is the ordinary path (#1582 E3/B6).

        It renders only when the transcript already has messages: with an empty
        transcript the filler above carries the same wait, and two skeletons
        for one wait is the multiplicity this change exists to remove.

        A SIBLING of the control row below, not a child of it. Inside
        `.session-history-controls` (`display: flex; justify-content: center`)
        the skeleton becomes a shrink-to-fit flex item, and `.skeleton--block`
        is `width: 100%` OF that item — it measured 2px wide in Chrome against
        600px here, and jsdom, which lays nothing out, called both green
        (delta-review M1).
      */}
      {conversationLoading && transcript.messages.length > 0 ? (
        <SkeletonBlock count={1} label="Loading conversation" />
      ) : null}
      {/*
        The one way out of the wait. `.session-history-controls` is this pane's
        existing control row (archive#3386 already widened it past "buttons
        only"), reused rather than given a class of its own — the entry
        stylesheet is at its budget ceiling to the byte.

        `!readOnlyOpen` because the read-only recovery notice below carries its
        own "Start new chat": a reload whose point-read lands `unavailable`
        BEFORE the transcript's first read satisfies both conditions at once,
        and rendered the control twice (delta-review L1).
      */}
      {conversationLoading && !readOnlyOpen ? (
        <div className="session-history-controls">
          {onNewChat ? (
            <button
              type="button"
              className="button button--secondary"
              onClick={() =>
                void Promise.resolve(onNewChat()).catch(surfaceRecoveryFailure)
              }
            >
              Start new chat
            </button>
          ) : null}
        </div>
      ) : null}
      {readOnlyOpen ? (
        <LazyBoundary
          load={loadConversationOpenRecoveryNotice}
          componentProps={{
            title:
              activeSession.conversationOpenState?.conversation.title ??
              activeSession.title,
            state:
              activeSession.conversationOpenState?.status === 'missing-session'
                ? 'missing-session'
                : 'unavailable',
            onRetry: onRetryConversationOpen
              ? () => void onRetryConversationOpen()
              : undefined,
            onStartNew: onNewChat
              ? () =>
                  void Promise.resolve(onNewChat()).catch(
                    surfaceRecoveryFailure,
                  )
              : undefined,
          }}
          pending={
            <div className="session-history-error" role="status">
              Conversation recovery is loading. This conversation remains
              read-only.
            </div>
          }
        />
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
      {activeOrchestrationSession?.turnProgress?.progressSilence &&
        isTurnInFlight(activeSession) && (
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
            <strong>The engine appears stalled.</strong>{' '}
            <ProgressSilenceObservation
              observation={
                activeOrchestrationSession.turnProgress.progressSilence
              }
            />
            {'. '}
            You can wait, or{' '}
            <button
              type="button"
              onClick={() => void chatInput.handleCancel()}
              disabled={!!activeSession.stopPending}
              style={BANNER_LINK_BUTTON_STYLE}
            >
              stop this turn
            </button>
            .
          </div>
        )}
      <ChatInputArea
        sessionId={activeSession.id}
        input={chatInput.input}
        attachments={chatInput.attachments}
        textareaRef={chatInput.textareaRef}
        disabled={!agent || readOnlyOpen || resolvingOpen}
        isSending={isExecutionActive}
        turnInFlight={isTurnInFlight(activeSession)}
        stopPending={!!activeSession.stopPending}
        modelSupportsAttachments={modelSupportsAttachments}
        fileAttachmentsSupported={fileAttachmentsSupported}
        modelProviderLabel={modelProviderLabel}
        modelProviders={modelProviders}
        currentProviderId={activeSession.providerId}
        fontSize={chatFontSize}
        dockHeight={dockHeight}
        currentModel={chatInput.currentModel}
        currentModelSource={
          activeSession.requestedModel === null
            ? (activeSession.defaultModelSource ?? 'agent default')
            : (activeSession.requestedModelSource ?? activeSession.modelSource)
        }
        canModelSelect={chatInput.canModelSelect}
        modelSelectionReason={chatInput.modelSelectionReason}
        modelsStale={chatInput.modelsStale}
        modelsLoading={modelsLoading}
        agentDefaultModel={agentDefaultModelId}
        defaultModelSource={activeSession.defaultModelSource}
        availableModels={availableModels}
        modelQuery={chatInput.modelQuery}
        agentConnectionId={activeSession.agentConnectionId}
        modelRuntimeOptions={
          activeSession.requestedProviderOptions ??
          activeSession.providerOptions
        }
        secondaryActions={
          readOnlyOpen || resolvingOpen ? undefined : secondaryActions
        }
        agentLabel={
          agent?.name ?? activeSession.agentName ?? activeSession.agentSlug
        }
        onOpenAgentHandoff={
          onOpenAgentHandoff ?? secondaryActions?.onOpenHandoff
        }
        agentHandoffTriggerRef={agentHandoffTriggerRef}
        agentHandoffDisabled={secondaryActions?.handoffDisabled}
        agentHandoffDisabledReason={secondaryActions?.handoffDisabledReason}
        executionMode={activeSession.executionMode}
        approvalModeConnectionDefault={connectionApprovalModeDefault}
        toolPolicyDelivery={toolPolicyDelivery}
        lastAppliedApprovalMode={activeSession.lastAppliedApprovalMode}
        commandQuery={chatInput.commandQuery}
        slashCommands={chatInput.slashCommands}
        onInputChange={chatInput.handleInputChange}
        onSend={handleSendWithContext}
        onCancel={chatInput.handleCancel}
        onClearInput={chatInput.handleClearInput}
        selectAttachmentFiles={chatInput.selectAttachmentFiles}
        attachmentError={chatInput.attachmentError}
        attachmentStages={chatInput.attachmentStages}
        sendBlockedReason={
          readOnlyOpen
            ? 'This conversation is available read-only. Retry resolution or start a new chat.'
            : resolvingOpen
              ? // The banner above already says this; repeating the SENTENCE
                // under the composer is what made one ordinary reload read as
                // three separate problems. `undefined` leaves the composer
                // quietly disabled.
                undefined
              : chatInput.sendBlockedReason
        }
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
        onRestorePortableDraft={chatInput.handleRestorePortableDraft}
        updateFromInput={chatInput.updateFromInput}
        closeAll={chatInput.closeAll}
        voiceState={stt.state}
        voiceSupported={stt.supported}
        voiceUnsupportedReason={stt.unsupportedReason}
        voiceError={stt.errorMessage}
        onVoiceStart={() => stt.startListening()}
        onVoiceStop={() => stt.stopListening()}
        workspaceRefused={workspaceRefused}
        onStartNewChat={onNewChat}
      />
    </>
  );
}

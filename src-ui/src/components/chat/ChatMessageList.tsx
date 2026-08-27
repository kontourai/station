import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useAgents } from '../../contexts/AgentsContext';
import { useApiBase } from '../../contexts/ApiBaseContext';
import type { ChatContentPart } from '../../contexts/active-chats-state';
import { useSendMessage } from '../../hooks/useActiveChatSessions';
import { useCopyToClipboardToast } from '../../hooks/useCopyToClipboardToast';
import { useToolApproval } from '../../hooks/useToolApproval';
import type { ChatMessage, ChatSession } from '../../types';
import { isTurnStreamLive } from '../../utils/execution';
import type { OwnerAttribution } from '../../utils/ownerAttribution';
import { AgentIcon } from '../icons/AgentIcon';
import { LoadingDots } from '../LoadingDots';
import { ChatEmptyState } from './ChatEmptyState';
import {
  type ChatScrollAnchor,
  captureChatScrollAnchor,
  createResizeReanchorGate,
  restoreChatScrollAnchor,
} from './chatScrollAnchor';
import type { ForkTurnSource } from './fork-turn-source';
import { formatFormSubmission } from './formSubmission';
import { MessageBubble } from './MessageBubble';
import { ReasoningSection } from './ReasoningSection';
import { ScrollToBottomButton } from './ScrollToBottomButton';
import { SessionSummaryCard } from './SessionSummaryCard';
import { StreamingMessage } from './StreamingMessage';
import { ToolCallDisplay } from './ToolCallDisplay';
import { TranscriptVirtualizer } from './TranscriptVirtualizer';
import {
  projectTranscriptMessages,
  type TranscriptRow,
} from './transcriptProjection';
import {
  UIBlockActionsContext,
  type UIBlockFormSubmission,
} from './UIBlockActionsContext';

interface ChatMessageListProps {
  activeSession: ChatSession;
  fontSize: number;
  /** Discrete dock/viewport height used to re-anchor before the resized frame paints. */
  layoutHeight?: number;
  showReasoning: boolean;
  showToolDetails: boolean;
  /** Override rendering for specific messages. Return a ReactNode to replace default, or null to use MessageBubble. */
  renderOverride?: (msg: ChatMessage, idx: number) => React.ReactNode | null;
  emptyState?: React.ReactNode;
  /**
   * station#1301 slice 1: when provided, the background-tasks banner below
   * becomes a real tap target opening the Background tasks sheet instead of
   * a passive status line. Omitted call sites (e.g. a test render with no
   * dock chrome around it) keep the original inert banner.
   */
  onOpenBackgroundTasks?: () => void;
  /**
   * "via <Station>" row attribution (station#2585) — threaded from a call
   * site that resolves the active saved Station.
   * Omitted call sites (including existing tests) simply render no owner
   * chip on message rows.
   */
  owner?: OwnerAttribution | null;
  /** Display-only human accountability, shown in completed-turn provenance. */
  accountableHuman?: string | null;
  /**
   * The host renders its own Summarize entry point (a gear opening
   * `ChatSettingsPanel`), so `SessionSummaryCard` may demote its inline button
   * (#3310). Defaults to false: a host that does not claim one keeps the
   * button rather than silently losing the affordance.
   */
  hasSettingsEntryPoint?: boolean;
  onForkFromTurn?: (source: ForkTurnSource) => void;
}

// Stable fallback so `agent || FALLBACK_AGENT` doesn't allocate a new object
// (and therefore a new <AgentIcon> element identity) on every render.
const FALLBACK_AGENT = { name: 'AI' };

// Stable empty style object — StreamingMessage is memoized, so a fresh `{}`
// literal here would defeat that memo on every ChatMessageList render.
const EMPTY_STYLE: React.CSSProperties = {};

function backgroundTasksLabel(
  tasks: NonNullable<ChatSession['backgroundTasks']>,
): string {
  const first = tasks[0];
  const description = first?.description || 'agent task';
  if (tasks.length === 1) {
    return `Background agent working — ${description}`;
  }
  return `${tasks.length} background agents working — ${description}, …`;
}

// A resize below this delta is treated as jitter (sub-pixel layout rounding,
// font-metric noise) rather than a genuine composer-height change, so it
// doesn't re-anchor the transcript scroll. Keeps composer auto-resize
// (which re-measures on every keystroke) from repeatedly snapping the
// scroll position even when nothing visually grew.
const RESIZE_REANCHOR_THRESHOLD_PX = 4;
const VIRTUALIZE_AFTER_MESSAGE_COUNT = 40;
const EMPTY_MESSAGES: ChatMessage[] = [];

function ChatMessageListComponent({
  activeSession,
  fontSize,
  layoutHeight,
  showReasoning,
  showToolDetails,
  renderOverride,
  emptyState,
  onOpenBackgroundTasks,
  owner,
  accountableHuman,
  hasSettingsEntryPoint,
  onForkFromTurn,
}: ChatMessageListProps) {
  const agents = useAgents();
  const { apiBase } = useApiBase();
  const handleCopy = useCopyToClipboardToast();
  const handleToolApproval = useToolApproval(apiBase);
  const sendMessage = useSendMessage(apiBase);

  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const visibleAnchorRef = useRef<ChatScrollAnchor | null>(null);
  const isUserScrolledUpRef = useRef(false);
  const userScrollIntentRef = useRef(false);
  const lastClientHeightRef = useRef<number | null>(null);
  const [isUserScrolledUp, setIsUserScrolledUp] = useState(false);
  const [scrollAnchorVersion, setScrollAnchorVersion] = useState(0);
  const [streamingContentRevision, setStreamingContentRevision] = useState(0);
  const [submittedBlockIds, setSubmittedBlockIds] = useState<Set<string>>(
    () => new Set(),
  );
  const previousTranscriptRows = useRef<readonly TranscriptRow[]>([]);

  // Dock snap changes are known synchronously by the parent. Handle that
  // discrete resize in a layout effect instead of relying solely on the
  // browser's later ResizeObserver delivery, which can arrive after a native
  // scroll event has already moved the transcript.
  useLayoutEffect(() => {
    const el = messagesContainerRef.current;
    if (!el || layoutHeight === undefined) return;
    if (isUserScrolledUpRef.current && visibleAnchorRef.current) {
      restoreChatScrollAnchor(el, visibleAnchorRef.current);
    } else {
      el.scrollTop = el.scrollHeight;
    }
    visibleAnchorRef.current = captureChatScrollAnchor(el);
    lastClientHeightRef.current = el.clientHeight;
  }, [layoutHeight]);

  const submitForm = useCallback(
    (submission: UIBlockFormSubmission) => {
      if (submittedBlockIds.has(submission.blockId)) return;
      setSubmittedBlockIds((prev) => new Set(prev).add(submission.blockId));
      void sendMessage(
        activeSession.id,
        activeSession.agentSlug,
        activeSession.conversationId,
        formatFormSubmission(submission),
      );
    },
    [
      sendMessage,
      activeSession.id,
      activeSession.agentSlug,
      activeSession.conversationId,
      submittedBlockIds,
    ],
  );

  const uiBlockActions = useMemo(
    () => ({ submitForm, submittedBlockIds }),
    [submitForm, submittedBlockIds],
  );

  const messages = activeSession.messages || EMPTY_MESSAGES;
  // station#3300: the turn fold, not the session flags — a settled turn must
  // not reconstruct its own streaming row after resume. See the doc comment
  // on `isTurnStreamLive` for why `isSessionExecutionActive` was the wrong
  // derivation for THIS row specifically.
  const isStreaming = isTurnStreamLive(activeSession);

  // The dock supplies the bounded event-window projection. This component
  // owns only that projection's one scroll surface, so it cannot create a
  // second event reader.
  const transcriptRows = useMemo(() => {
    const projected = projectTranscriptMessages(
      activeSession.id,
      messages,
      previousTranscriptRows.current,
    );
    previousTranscriptRows.current = projected;
    return projected;
  }, [activeSession.id, messages]);

  const [transcriptRevealHash, setTranscriptRevealHash] = useState(
    () => window.location.hash,
  );
  useEffect(() => {
    const onHashChange = () => setTranscriptRevealHash(window.location.hash);
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);
  const requestedMessageRowId = (() => {
    const encoded = transcriptRevealHash.match(/^#station-message=(.+)$/)?.[1];
    if (!encoded) return undefined;
    try {
      return `${activeSession.id}:message:${decodeURIComponent(encoded)}`;
    } catch {
      return undefined;
    }
  })();

  // A command-palette transcript result carries the stable runtime message id
  // in the location hash. Re-run when messages arrive, rather than trusting a
  // timer after opening an older session; the asynchronous bounded window may
  // not have committed on that timer tick.
  useLayoutEffect(() => {
    // The DOM target can only exist after the projected message count changes.
    void messages.length;
    if (!requestedMessageRowId) return;
    // Disable tail-follow before the child virtualizer receives the anchor.
    // Otherwise its normal new-message policy could undo the reveal.
    isUserScrolledUpRef.current = true;
    setIsUserScrolledUp(true);
    const target = Array.from(
      messagesContainerRef.current?.querySelectorAll<HTMLElement>(
        '[data-chat-message-key]',
      ) ?? [],
    ).find((node) => node.dataset.chatMessageKey === requestedMessageRowId);
    if (!target) return;
    target.scrollIntoView({ block: 'center' });
  }, [messages, requestedMessageRowId]);
  const agent = agents.find((a) => a.slug === activeSession.agentSlug);

  // Keep the view pinned to the bottom as content grows (new messages, live
  // streaming) unless the user has scrolled up. A layout effect writes scrollTop
  // before paint so there is no visible jump; rAF covers late layout (images,
  // markdown reflow) without fighting the browser via a 0ms timeout.
  const lastMessage = messages[messages.length - 1];
  const streamingTick = isStreaming
    ? (lastMessage?.contentParts?.length ?? 0)
    : 0;
  // messages.length / streamingTick / isStreaming are growth triggers — not read
  // in the body but they must re-pin the scroll as content streams in.
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional triggers
  useLayoutEffect(() => {
    const el = messagesContainerRef.current;
    if (!el || isUserScrolledUp) return;
    el.scrollTop = el.scrollHeight;
    const raf = requestAnimationFrame(() => {
      if (messagesContainerRef.current && !isUserScrolledUp) {
        messagesContainerRef.current.scrollTop =
          messagesContainerRef.current.scrollHeight;
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [
    isUserScrolledUp,
    messages.length,
    streamingContentRevision,
    streamingTick,
    isStreaming,
  ]);

  // A reader who requested earlier history keeps the same visible row when
  // the projection prepends it. Height correction follows the same anchor
  // contract through the ResizeObserver below; native anchoring is disabled
  // in CSS so there is exactly one owner for both adjustments.
  useLayoutEffect(() => {
    // This projection change is the prepend/row-growth trigger.
    void transcriptRows;
    // The virtualizer owns keyed row+offset preservation for long transcripts.
    // A DOM anchor here can point at a recycled node and fight that correction.
    if (messages.length > VIRTUALIZE_AFTER_MESSAGE_COUNT) return;
    const el = messagesContainerRef.current;
    if (!el || !isUserScrolledUpRef.current || !visibleAnchorRef.current) {
      return;
    }
    restoreChatScrollAnchor(el, visibleAnchorRef.current);
    visibleAnchorRef.current = captureChatScrollAnchor(el);
  }, [messages.length, transcriptRows]);

  // Container resize is the important keyboard/composer path. Keep a reader's
  // scrollTop stable; only an already-pinned conversation follows the bottom.
  // A composer auto-resize can fire on every keystroke even when its
  // rendered height doesn't actually change; only re-anchor once the size
  // delta clears a small threshold so pure jitter can't reintroduce the
  // scroll-yank this anchor logic exists to prevent.
  useLayoutEffect(() => {
    const el = messagesContainerRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    visibleAnchorRef.current = captureChatScrollAnchor(el);
    lastClientHeightRef.current = el.clientHeight;
    const reanchorGate = createResizeReanchorGate(
      el.clientHeight,
      RESIZE_REANCHOR_THRESHOLD_PX,
    );
    const observer = new ResizeObserver(() => {
      lastClientHeightRef.current = el.clientHeight;
      if (!reanchorGate.shouldReanchor(el.clientHeight)) return;
      if (isUserScrolledUpRef.current) {
        if (visibleAnchorRef.current) {
          restoreChatScrollAnchor(el, visibleAnchorRef.current);
        }
      } else {
        el.scrollTop = el.scrollHeight;
      }
      visibleAnchorRef.current = captureChatScrollAnchor(el);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const target = e.currentTarget;
    const previousClientHeight = lastClientHeightRef.current;
    const resized =
      previousClientHeight !== null &&
      Math.abs(target.clientHeight - previousClientHeight) >=
        RESIZE_REANCHOR_THRESHOLD_PX;
    lastClientHeightRef.current = target.clientHeight;
    // A dock/keyboard resize can dispatch `scroll` before ResizeObserver gets
    // its turn. Preserve the reader's prior intent during that event: an
    // already-pinned transcript stays pinned, while an intentionally scrolled
    // transcript is restored by the observer from its captured anchor.
    if (resized) {
      if (!isUserScrolledUpRef.current) {
        target.scrollTop = target.scrollHeight;
        visibleAnchorRef.current = null;
      }
      return;
    }
    // Programmatic positioning, measurement correction, and viewport resize
    // also produce trusted browser scroll events, so trust alone cannot mark
    // reader intent. Only wheel/touch/pointer input arms the next scroll.
    if (!userScrollIntentRef.current) return;
    userScrollIntentRef.current = false;
    setScrollAnchorVersion((version) => version + 1);
    // Resize animations can emit a scroll event between two ResizeObserver
    // frames. Treat a small transient gap as still pinned so a dock/keyboard
    // transition cannot be mistaken for deliberate reader navigation.
    const isAtBottom =
      target.scrollHeight - target.scrollTop - target.clientHeight <= 32;
    isUserScrolledUpRef.current = !isAtBottom;
    setIsUserScrolledUp(!isAtBottom);
    visibleAnchorRef.current = isAtBottom
      ? null
      : captureChatScrollAnchor(target);
  };

  const handleScrollToBottom = () => {
    if (messagesContainerRef.current) {
      messagesContainerRef.current.scrollTop =
        messagesContainerRef.current.scrollHeight;
      isUserScrolledUpRef.current = false;
      setIsUserScrolledUp(false);
    }
  };

  const handleStreamingContentChange = useCallback(() => {
    setStreamingContentRevision((revision) => revision + 1);
  }, []);

  // Derived sessions may re-materialize message objects when unrelated chat UI
  // state changes (for example, each composer keystroke). Object identity is
  // therefore not a message identity: using a WeakMap here caused every row to
  // remount and replay its entry animation while the user typed. Prefer an
  // upstream id when present, then use persisted fields plus the stable list
  // position as a collision-safe fallback.
  const messageAnchorKey = (msg: ChatMessage) => {
    const originSessionId = msg.sessionId ?? activeSession.id;
    const upstreamId = (msg as ChatMessage & { id?: string }).id;
    if (upstreamId) return `${originSessionId}:id:${upstreamId}`;
    if (msg.traceId) return `${originSessionId}:trace:${msg.traceId}`;
    if (msg.turnId) return `${originSessionId}:turn:${msg.turnId}:${msg.role}`;
    return `${originSessionId}:message:${msg.timestamp ?? 'untimed'}:${msg.role}:${msg.content}`;
  };

  const renderDefaultMessage = (msg: ChatMessage, idx: number) => (
    <MessageBubble
      key={`${activeSession.id}-msg-${messageAnchorKey(msg)}`}
      msg={msg as any}
      idx={idx}
      activeSession={activeSession as any}
      agents={agents as any}
      chatFontSize={fontSize}
      showReasoning={showReasoning}
      showToolDetails={showToolDetails}
      onCopy={handleCopy}
      onForkFromTurn={onForkFromTurn}
      onToolApproval={handleToolApproval as any}
      anchorKey={messageAnchorKey(msg)}
      owner={owner}
      accountableHuman={accountableHuman}
    />
  );

  const renderMessage = (msg: ChatMessage, idx: number) => {
    if (renderOverride) {
      const override = renderOverride(msg, idx);
      if (override !== null) return override;
    }
    return renderDefaultMessage(msg, idx);
  };

  // Work activities render inline, inside the message row, in reading order
  // (see `projectTranscriptMessages`'s doc comment) — there is no separate
  // fold/work row kind any more.
  const renderTranscriptRow = (row: TranscriptRow) => {
    const messageId = (row.message as ChatMessage & { id?: string }).id;
    return (
      <div
        className="chat-message-anchor"
        data-chat-message-key={row.id}
        {...(messageId
          ? { id: `transcript-message-${encodeURIComponent(messageId)}` }
          : {})}
      >
        {renderMessage(row.message, row.index)}
      </div>
    );
  };

  const agentIcon = useMemo(
    () => <AgentIcon agent={agent || FALLBACK_AGENT} size={20} />,
    [agent],
  );

  // station#1424 review fix (S3, then round 3 NEW-1): the streaming row's
  // identity/owner attribution is resolved from the CURRENT live agent
  // binding — honest while this turn is actually executing. The engine chip
  // is deliberately NOT threaded here: it briefly asserted an engine
  // identity while streaming and then retracted it the instant the row
  // converted to a persisted `MessageBubble`. No surface may assert an
  // engine identity it's going to take back.
  // station#1434 made the persisted row's chip real (it reads the turn's own
  // provenance envelope), and this row still shows none — deliberately. The
  // envelope is assembled from the turn's TERMINAL event, so while the turn
  // is still streaming there is no per-turn record to read; the only source
  // available here is the live binding this comment already rules out. The
  // resulting transition is additive (nothing claimed, then a fact once it
  // is observed), never a retraction — pinned by
  // `MessageAttribution.streamingParity.test.tsx`.
  // station#1424 review fix (round 3 NEW-6): falls back to the session's own
  // threaded `agentName` (never blank) when `agents.find` misses — e.g. the
  // agent was deleted after this session started — so the row still reads
  // as attributable instead of silently dropping the identity text.
  const streamingAttributionAgent = useMemo(() => {
    const name = agent?.name ?? activeSession.agentName;
    return name ? { name } : null;
  }, [agent, activeSession.agentName]);

  const renderReasoning = useCallback(
    (content: string, i: number) => (
      <ReasoningSection
        key={i}
        content={content}
        fontSize={fontSize}
        show={showReasoning}
      />
    ),
    [fontSize, showReasoning],
  );

  const renderToolCall = useCallback(
    (part: ChatContentPart, i: number) => (
      <ToolCallDisplay
        key={i}
        toolCall={part}
        showDetails={showToolDetails}
        onApprove={
          part.needsApproval && part.approvalId
            ? (action) =>
                handleToolApproval(
                  activeSession.id,
                  activeSession.agentSlug,
                  part.approvalId!,
                  part.toolName || part.name || '',
                  action,
                )
            : undefined
        }
      />
    ),
    [
      showToolDetails,
      handleToolApproval,
      activeSession.id,
      activeSession.agentSlug,
    ],
  );

  return (
    <UIBlockActionsContext.Provider value={uiBlockActions}>
      <SessionSummaryCard
        activeSession={activeSession}
        hasSettingsEntryPoint={hasSettingsEntryPoint}
      />
      <div
        className="chat-messages"
        ref={messagesContainerRef}
        role="log"
        aria-label="Conversation transcript"
        aria-live="polite"
        style={{ fontSize: `${fontSize}px` }}
        onScroll={handleScroll}
        onWheel={() => {
          userScrollIntentRef.current = true;
        }}
        onTouchMove={() => {
          userScrollIntentRef.current = true;
        }}
        onPointerDown={() => {
          userScrollIntentRef.current = true;
        }}
      >
        {messages.length === 0 && !isStreaming ? (
          (emptyState ?? (
            <ChatEmptyState
              agentSlug={activeSession.agentSlug}
              agentName={activeSession.agentName}
            />
          ))
        ) : (
          <>
            {messages.length > 0 &&
              (messages.length > VIRTUALIZE_AFTER_MESSAGE_COUNT ? (
                <TranscriptVirtualizer
                  rows={transcriptRows}
                  scrollElement={messagesContainerRef}
                  renderRow={renderTranscriptRow}
                  followTail={!isUserScrolledUp && !requestedMessageRowId}
                  anchorVersion={scrollAnchorVersion}
                  revealRowId={requestedMessageRowId}
                />
              ) : (
                transcriptRows.map((row) => (
                  <React.Fragment key={row.id}>
                    {renderTranscriptRow(row)}
                  </React.Fragment>
                ))
              ))}
            {isStreaming && (
              <div
                className="chat-message-anchor"
                data-chat-message-key={`${activeSession.id}:streaming`}
              >
                <StreamingMessage
                  sessionId={activeSession.id}
                  agentIcon={agentIcon}
                  agentIconStyle={EMPTY_STYLE}
                  fontSize={fontSize}
                  showReasoning={showReasoning}
                  renderReasoning={renderReasoning}
                  renderToolCall={renderToolCall}
                  activityHint={activeSession.activityHint}
                  attributionAgent={streamingAttributionAgent}
                  owner={owner}
                  onContentChange={handleStreamingContentChange}
                />
              </div>
            )}
            {/* Backgrounded provider tasks outlive the assistant turn: the
                session is honestly idle, but work continues. Keep a live
                affordance so the chat never looks done while it isn't. */}
            {!isStreaming &&
              (activeSession.backgroundTasks?.length ?? 0) > 0 &&
              (onOpenBackgroundTasks ? (
                // station#1301 slice 1 (review LOW fix): a `<button>` cannot
                // also carry `role="status"` (an interactive element and a
                // live region are mutually exclusive ARIA roles) — a visually
                // hidden sibling carries the exact live-region semantics the
                // plain `<div>` below has, so the wording still auto-announces
                // as it changes, while the button itself stays the one
                // accessible interactive element (name via `aria-label`).
                <>
                  <button
                    type="button"
                    className="background-tasks-banner"
                    onClick={onOpenBackgroundTasks}
                    aria-label={`${backgroundTasksLabel(activeSession.backgroundTasks!)} — open background tasks`}
                  >
                    <LoadingDots />
                    <span
                      className="background-tasks-banner__label"
                      aria-hidden="true"
                    >
                      {backgroundTasksLabel(activeSession.backgroundTasks!)}
                    </span>
                  </button>
                  <span
                    className="background-tasks-banner__sr-status"
                    role="status"
                  >
                    {backgroundTasksLabel(activeSession.backgroundTasks!)}
                  </span>
                </>
              ) : (
                <div className="background-tasks-banner" role="status">
                  <LoadingDots />
                  <span className="background-tasks-banner__label">
                    {backgroundTasksLabel(activeSession.backgroundTasks!)}
                  </span>
                </div>
              ))}
          </>
        )}
      </div>
      {isUserScrolledUp && (
        <ScrollToBottomButton onClick={handleScrollToBottom} />
      )}
    </UIBlockActionsContext.Provider>
  );
}

export const ChatMessageList = React.memo(ChatMessageListComponent);

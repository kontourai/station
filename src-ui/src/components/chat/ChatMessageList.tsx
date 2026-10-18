import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { useAgents } from '../../contexts/AgentsContext';
import { useApiBase } from '../../contexts/ApiBaseContext';
import type { ChatContentPart } from '../../contexts/active-chats-state';
import { activeChatsStore } from '../../contexts/active-chats-store';
import { chatFormDraftsStore } from '../../contexts/chat-form-drafts-store';
import { unansweredApprovalRequests } from '../../hooks/orchestration/pendingRequestRows';
import { useSendMessage } from '../../hooks/useActiveChatSessions';
import { useCopyToClipboardToast } from '../../hooks/useCopyToClipboardToast';
import { useToolApproval } from '../../hooks/useToolApproval';
import { deviceSettingsStore } from '../../lib/device-settings-store';
import type { ChatMessage, ChatSession } from '../../types';
import type { SavedAnswerQuote } from '../../utils/answer-quotes';
import { isTurnStreamLive } from '../../utils/execution';
import { isShallowEqual } from '../../utils/isShallowEqual';
import type { OwnerAttribution } from '../../utils/ownerAttribution';
import {
  chatWaitsOnUser,
  requestsWaitingOnUser,
} from '../../utils/waiting-approvals';
import { AgentIcon } from '../icons/AgentIcon';
import { LoadingDots } from '../LoadingDots';
import {
  REVEAL_APPROVAL_EVENT,
  type RevealApprovalDetail,
} from '../status/approvalReveal';
import { ApprovalSheetProvider } from './ApprovalSheetProvider';
import {
  animateScrollToBottom,
  type ScrollToBottomAnimation,
} from './animateScrollToBottom';
import { ChatEmptyState } from './ChatEmptyState';
import {
  CHAT_READER_RESTORE_EVENT,
  type ChatReaderRestoreRequest,
  type ChatScrollAnchor,
  captureChatScrollAnchor,
  createResizeReanchorGate,
  restoreChatScrollAnchor,
} from './chatScrollAnchor';
import { type ForkTurnSource, precedingForkSource } from './fork-turn-source';
import { formatFormSubmission } from './formSubmission';
import { MessageBubble, type MessageBubbleSession } from './MessageBubble';
import { PendingApprovalStrip } from './PendingApprovalStrip';
import { QuoteSelectionToolbar } from './QuoteSelectionToolbar';
import { ReasoningSection } from './ReasoningSection';
import { ScrollToBottomButton } from './ScrollToBottomButton';
import { SessionSummaryCard } from './SessionSummaryCard';
import { SmoothStreamingMessage } from './SmoothStreamingMessage';
import { StreamingMessage } from './StreamingMessage';
import { SubagentTranscriptCard } from './SubagentTranscriptCard';
import { ToolCallDisplay } from './ToolCallDisplay';
import { TranscriptVirtualizer } from './TranscriptVirtualizer';
import {
  type ChildTranscriptRow,
  foldTranscriptChildren,
  projectTranscriptChildRows,
  TranscriptChildrenContext,
  TranscriptTurnContext,
} from './transcript-child-work';
import {
  markTranscriptPhase,
  noteTranscriptProgrammaticScroll,
  traceKey,
} from './transcriptLayoutTrace';
import { useTranscriptLayoutTrace } from './transcriptLayoutTracer';
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
  scrollControlsTarget?: HTMLElement | null;
  /** The canonical window plus sequenced live events already renders this turn. */
  suppressStreamingRow?: boolean;
  fontSize: number;
  /** Discrete dock/viewport height used to re-anchor before the resized frame paints. */
  layoutHeight?: number;
  showReasoning: boolean;
  showToolDetails: boolean;
  /** Override rendering for specific messages. Return a ReactNode to replace default, or null to use MessageBubble. */
  renderOverride?: (msg: ChatMessage, idx: number) => React.ReactNode | null;
  emptyState?: React.ReactNode;
  historyNotice?: React.ReactNode;
  hasOlderMessages?: boolean;
  historyLoading?: boolean;
  suppressActivity?: boolean;
  /**
   * The host presents turn activity and pending approvals in its own status
   * surface (the chat pane's floating pill): rows do not repeat the typing
   * dots or the "Awaiting tool approval" line.
   */
  statusShownElsewhere?: boolean;
  /**
   * #2309: the host already presents the watchdog's silence for this turn
   * with an action attached (the dock's stall notice, which offers Stop), so
   * the streaming row's compact progress omits it rather than saying it twice.
   */
  progressSilenceShownElsewhere?: boolean;
  onLoadOlder?: () => Promise<void>;
  /**
   * archive#1301: when provided, the background-tasks banner below
   * becomes a real tap target opening the Background tasks sheet instead of
   * a passive status line. Omitted call sites (e.g. a test render with no
   * dock chrome around it) keep the original inert banner.
   */
  onOpenBackgroundTasks?: () => void;
  /**
   * The host could not read this conversation's status or history, so the
   * session record's background work is only the last thing Station said.
   * The banner then says so instead of animating as if it were current.
   */
  liveStatusUnavailable?: boolean;
  /**
   * "via <Station>" row attribution (archive#2585) — threaded from a call
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
   * (archive#3310). Defaults to false: a host that does not claim one keeps the
   * button rather than silently losing the affordance.
   */
  hasSettingsEntryPoint?: boolean;
  onForkFromTurn?: (source: ForkTurnSource) => void;
  onNewChatFromMessage?: (text: string) => void;
  onQuote?: (quote: SavedAnswerQuote) => void;
  /**
   * #2316: the transcript window's runtime events. Open approvals no rendered
   * row can answer are derived from them here and rendered as the
   * pending-approvals strip below the transcript (never as messages). The
   * subagent cards are folded from the same events
   * (`transcript-child-work.ts`), so a card and the transcript it sits in
   * read one record.
   */
  approvalEvents?: readonly { event: CanonicalRuntimeEvent }[];
  /** Whether `approvalEvents`' window has finished its first read (#2344). */
  approvalEventsSettled?: boolean;
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
// A programmatic scrollTop write dispatches its scroll event asynchronously,
// so the handler recognizes the write's echo by position for this long. The
// positional match alone is already safe (a write always targets the position
// the current reader state implies), and the window closes the one hole:
// the reader landing pixel-exact on a stale write minutes later.
const PROGRAMMATIC_SCROLL_ECHO_MS = 500;
const PROGRAMMATIC_SCROLL_ECHO_PX = 1;
// A scroll this close to the top loads earlier history (#2706).
const OLDER_AUTO_LOAD_BAND_PX = 96;
// Scroll-driven history loads stay suppressed after an "Earlier messages"
// request until the transcript's scrollTop and scrollHeight have held for this
// many consecutive frames.
const OLDER_RESTORE_STABLE_FRAMES = 4;
const VIRTUALIZE_AFTER_MESSAGE_COUNT = 40;
// A pinned transcript counts a scroll this close to its end as still pinned
// (a dock/keyboard transition can land it a little short).
const PINNED_TOLERANCE_PX = 32;
// Scrolls this soon after wheel/key input or a mouse/pen press are the
// reader's, as are scrolls while a finger is down.
const READER_INPUT_GRACE_MS = 400;
// A lifted finger leaves momentum that emits scrolls and no input events (iOS
// especially); each such scroll extends the window by READER_SCROLL_EXTEND_MS.
const TOUCH_MOMENTUM_GRACE_MS = 1_000;
const READER_SCROLL_EXTEND_MS = 200;
// Growth this soon after a press or key inside the transcript is the reader's
// own doing (a tool card or details they opened): it stays where it opened.
const READER_INTERACTION_GRACE_MS = 1_000;
const EMPTY_MESSAGES: ChatMessage[] = [];
const NO_PENDING_APPROVALS: ReturnType<typeof unansweredApprovalRequests> = [];
function ChatMessageListComponent({
  activeSession,
  scrollControlsTarget,
  suppressStreamingRow,
  fontSize,
  layoutHeight,
  showReasoning,
  showToolDetails,
  renderOverride,
  emptyState,
  historyNotice,
  hasOlderMessages,
  historyLoading,
  suppressActivity,
  statusShownElsewhere,
  progressSilenceShownElsewhere,
  onLoadOlder,
  onOpenBackgroundTasks,
  liveStatusUnavailable = false,
  owner,
  accountableHuman,
  hasSettingsEntryPoint,
  onForkFromTurn,
  onNewChatFromMessage,
  onQuote,
  approvalEvents,
  approvalEventsSettled,
}: ChatMessageListProps) {
  const agents = useAgents();
  const { apiBase } = useApiBase();
  const handleCopy = useCopyToClipboardToast();
  const handleToolApproval = useToolApproval(apiBase);
  const pendingApprovalRequests = useMemo(
    () =>
      approvalEvents && approvalEvents.length > 0 && !activeSession.replay
        ? unansweredApprovalRequests(
            activeSession.messages,
            approvalEvents
              .map((item) => item.event)
              .filter((event) => Boolean(event.eventId)),
            // Only the live streaming shell holds an open turn's row without
            // an answerable card. When the transcript window projects the
            // open turn instead (`suppressStreamingRow`), that row carries the
            // bound request and renders Allow/Deny itself — unexpanded, even
            // inside a batch — so the strip must not render a second one.
            activeSession.orchestrationTurnOpen && !suppressStreamingRow
              ? activeSession.openTurnId
              : undefined,
          )
        : NO_PENDING_APPROVALS,
    [
      activeSession.messages,
      activeSession.replay,
      activeSession.orchestrationTurnOpen,
      activeSession.openTurnId,
      suppressStreamingRow,
      approvalEvents,
    ],
  );
  const transcriptChildren = useMemo(
    () => foldTranscriptChildren(approvalEvents),
    [approvalEvents],
  );
  const sendMessage = useSendMessage(apiBase);
  const sheetRequests = useMemo(
    () =>
      activeSession.replay
        ? []
        : unansweredApprovalRequests(
            [],
            (approvalEvents ?? [])
              .map((item) => item.event)
              .filter((event) => Boolean(event.eventId)),
          ).filter((request) => !request.inputRequest),
    [activeSession.replay, approvalEvents],
  );
  // The store is already live at the shell; reading its scalar snapshot here
  // avoids adding a second subscription/allocation to every streaming row.
  // A mid-stream toggle is observed on the next existing 80 ms stream flush.
  const smoothReveal =
    deviceSettingsStore.get('featureSettings').smoothReveal ?? false;
  const ActiveStreamingMessage = smoothReveal
    ? SmoothStreamingMessage
    : StreamingMessage;

  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const visibleAnchorRef = useRef<ChatScrollAnchor | null>(null);
  const isUserScrolledUpRef = useRef(false);
  // The transcript's last known position, ours or the reader's: a reader
  // scroll below it is the reader moving up.
  const lastKnownScrollTopRef = useRef<number | null>(null);
  const lastProgrammaticScrollRef = useRef<{
    top: number;
    at: number;
  } | null>(null);
  const lastClientHeightRef = useRef<number | null>(null);
  const [isUserScrolledUp, setIsUserScrolledUp] = useState(false);
  const [scrollAnchorVersion, setScrollAnchorVersion] = useState(0);
  const [readerRestoreRequest, setReaderRestoreRequest] = useState<
    (ChatReaderRestoreRequest & { sessionId: string; version: number }) | null
  >(null);
  const currentReaderRestoreRequest =
    readerRestoreRequest?.sessionId === activeSession.id
      ? readerRestoreRequest
      : null;
  const pinFrameRef = useRef<number | undefined>(undefined);
  const formScope = chatFormDraftsStore.scope(
    apiBase,
    activeSession.id,
    activeSession.conversationId,
  );
  const loadingOlderRef = useRef(false);
  const olderCommitPendingRef = useRef(false);
  const olderRestoringRef = useRef(false);
  const olderRequestHeightRef = useRef(0);
  const olderGenerationRef = useRef(0);
  const olderRestoreFrameRef = useRef<number | undefined>(undefined);
  const [olderCommitEpoch, setOlderCommitEpoch] = useState(0);
  const previousTranscriptRows = useRef<readonly TranscriptRow[]>([]);
  // The running "Scroll to bottom" glide. While it runs the reader is still
  // treated as scrolled up (nothing else may snap the transcript), every
  // frame is our own write, and reader input cancels it. The control itself
  // is gone for the glide and returns if the reader cancels it.
  const scrollAnimationRef = useRef<ScrollToBottomAnimation | null>(null);
  const scrollAnimationTokenRef = useRef<object | null>(null);
  const [scrollingToBottom, setScrollingToBottom] = useState(false);
  // Reader input that can move the transcript: a pointer or touch still down,
  // or wheel/key input within the grace window.
  const readerInputRef = useRef({
    /** A finger is on the screen (touch events, not pointer events). */
    touching: false,
    /** A mouse or pen button is down. */
    pressing: false,
    /** Scrolls before this time are the reader's. */
    until: 0,
    /** Content growth before this time follows the reader's own interaction. */
    interactedUntil: 0,
  });
  const readerActing = useCallback(() => {
    const input = readerInputRef.current;
    return input.touching || input.pressing || performance.now() < input.until;
  }, []);
  useTranscriptLayoutTrace(messagesContainerRef, activeSession.id, () => ({
    isUserScrolledUp: isUserScrolledUpRef.current,
  }));

  // Every programmatic scrollTop write goes through these so the scroll
  // handler can tell our own echoes apart from reader movement. The recorded
  // (clamped) position is what the echo carries.
  const noteProgrammaticScroll = useCallback((el: HTMLElement) => {
    lastProgrammaticScrollRef.current = {
      top: el.scrollTop,
      at: performance.now(),
    };
    lastKnownScrollTopRef.current = el.scrollTop;
    noteTranscriptProgrammaticScroll(el.scrollTop);
  }, []);
  const writeProgrammaticScroll = useCallback(
    (el: HTMLDivElement, top: number) => {
      el.scrollTop = top;
      noteProgrammaticScroll(el);
    },
    [noteProgrammaticScroll],
  );

  // Dock snap changes are known synchronously by the parent. Handle that
  // discrete resize in a layout effect instead of relying solely on the
  // browser's later ResizeObserver delivery, which can arrive after a native
  // scroll event has already moved the transcript.
  useLayoutEffect(() => {
    const el = messagesContainerRef.current;
    if (!el || layoutHeight === undefined) return;
    if (isUserScrolledUpRef.current && visibleAnchorRef.current) {
      if (restoreChatScrollAnchor(el, visibleAnchorRef.current)) {
        noteProgrammaticScroll(el);
      }
    } else {
      writeProgrammaticScroll(el, el.scrollHeight);
    }
    visibleAnchorRef.current = captureChatScrollAnchor(el);
    lastClientHeightRef.current = el.clientHeight;
  }, [layoutHeight, noteProgrammaticScroll, writeProgrammaticScroll]);

  const submitForm = useCallback(
    (submission: UIBlockFormSubmission, formKey: string) => {
      if (activeSession.replay) return;
      const pending = chatFormDraftsStore.beginSubmit(
        formScope,
        formKey,
        Object.fromEntries(
          submission.values.map((field) => [field.name, field.value]),
        ),
      );
      if (!pending) return;
      let admissionReported = false;
      const onAdmission = (
        status: 'accepted' | 'not-invoked' | 'indeterminate',
      ) => {
        admissionReported = true;
        chatFormDraftsStore.finishSubmit(formScope, formKey, pending, status);
      };
      void sendMessage(
        activeSession.id,
        activeSession.agentSlug,
        activeSession.conversationId,
        formatFormSubmission(submission),
        undefined,
        undefined,
        undefined,
        {
          queueOnBusy: true,
          onAdmission,
          claimRetry: () =>
            chatFormDraftsStore.claimRetry(formScope, formKey, pending),
        },
      ).then(
        (accepted) => {
          if (!admissionReported)
            onAdmission(accepted === true ? 'accepted' : 'indeterminate');
        },
        () => {
          if (!admissionReported) onAdmission('indeterminate');
        },
      );
    },
    [
      sendMessage,
      formScope,
      activeSession.id,
      activeSession.agentSlug,
      activeSession.conversationId,
      activeSession.replay,
    ],
  );

  const uiBlockActions = useMemo(
    () => ({ submitForm, formScope, readOnly: Boolean(activeSession.replay) }),
    [submitForm, formScope, activeSession.replay],
  );

  const messages = useMemo(() => {
    const loaded = activeSession.messages || EMPTY_MESSAGES;
    const represented = new Set<string>();
    for (const [key, child] of transcriptChildren) {
      const inLoadedRow = loaded.some(
        (message) =>
          message.role === 'assistant' &&
          message.sessionId === child.item.reporterThreadId &&
          (child.toolAnchor
            ? message.contentParts?.some(
                (part) => part.toolCallId === child.item.parent?.toolCallId,
              )
            : message.turnId === child.spawn?.turnId),
      );
      const inStreamingRow =
        !suppressStreamingRow &&
        isTurnStreamLive(activeSession) &&
        activeSession.currentSessionId === child.item.reporterThreadId &&
        activeSession.openTurnId === child.spawn?.turnId;
      if (child.spawn?.standalone || inLoadedRow || inStreamingRow)
        represented.add(key);
    }
    const visible = loaded.filter(
      (message) =>
        !message.childWorkKey || !represented.has(message.childWorkKey),
    );
    return visible.length === loaded.length ? loaded : visible;
  }, [activeSession, suppressStreamingRow, transcriptChildren]);
  // archive#3300: the turn fold, not the session flags — a settled turn must
  // not reconstruct its own streaming row after resume. See the doc comment
  // on `isTurnStreamLive` for why `isSessionExecutionActive` was the wrong
  // derivation for THIS row specifically.
  const turnLive = isTurnStreamLive(activeSession);
  // The background banner below means "turn over, work continues", so it
  // reads turn liveness, not whether this row renders: suppression moves a
  // live turn into the transcript window without ending it (#2654).
  const isStreaming = turnLive && !suppressStreamingRow;
  const localBackgroundTasks = activeSession.backgroundTasks ?? [];
  const serverBackgroundCount =
    activeSession.conversationActivity?.runningChildWork?.count ?? 0;
  const currentBackgroundLabel =
    localBackgroundTasks.length > 0
      ? backgroundTasksLabel(localBackgroundTasks)
      : serverBackgroundCount === 1
        ? 'Background agent working'
        : `${serverBackgroundCount} background agents working`;
  const backgroundBannerLabel = liveStatusUnavailable
    ? `Last known: ${currentBackgroundLabel.charAt(0).toLowerCase()}${currentBackgroundLabel.slice(1)} (status unavailable)`
    : currentBackgroundLabel;
  // Animated dots claim the work is happening now; omit them for a
  // last-known label.
  const backgroundBannerDots = liveStatusUnavailable ? null : <LoadingDots />;

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
    return projectTranscriptChildRows(
      projected,
      transcriptChildren,
      approvalEvents,
    );
  }, [activeSession.id, messages, transcriptChildren, approvalEvents]);
  const transcriptRowsRef = useRef(transcriptRows);
  transcriptRowsRef.current = transcriptRows;

  const [transcriptRevealHash, setTranscriptRevealHash] = useState(
    () => window.location.hash,
  );
  useEffect(() => {
    const onHashChange = () => setTranscriptRevealHash(window.location.hash);
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);
  // The status pill (or the approval queue) asks for a pending approval's
  // card. A long transcript virtualizes its rows, so the card's row may not
  // be mounted: find the row that carries the request and let the
  // virtualizer bring it in; the requester then focuses the card.
  const [approvalRevealRowId, setApprovalRevealRowId] = useState<string>();
  useEffect(() => {
    const onReveal = (event: Event) => {
      const detail = (event as CustomEvent<RevealApprovalDetail>).detail;
      if (!detail?.requestId) return;
      const row = transcriptRowsRef.current.find(
        (candidate) =>
          candidate.kind !== 'subagent' &&
          (candidate.message.contentParts ?? []).some(
            (part) =>
              part.approvalId === detail.requestId &&
              (detail.threadId === undefined ||
                part.approvalThreadId === detail.threadId),
          ),
      );
      if (!row) return;
      isUserScrolledUpRef.current = true;
      setIsUserScrolledUp(true);
      setApprovalRevealRowId(row.id);
    };
    window.addEventListener(REVEAL_APPROVAL_EVENT, onReveal);
    return () => window.removeEventListener(REVEAL_APPROVAL_EVENT, onReveal);
  }, []);
  useEffect(() => {
    if (!approvalRevealRowId) return;
    // One reveal per request: clear it so the next tap can ask again.
    const timer = setTimeout(() => setApprovalRevealRowId(undefined), 500);
    return () => clearTimeout(timer);
  }, [approvalRevealRowId]);
  const requestedMessageRowId = (() => {
    const encoded = transcriptRevealHash.match(/^#station-message=(.+)$/)?.[1];
    if (!encoded) return undefined;
    try {
      return `${activeSession.id}:message:${decodeURIComponent(encoded)}`;
    } catch {
      return undefined;
    }
  })();

  useLayoutEffect(() => {
    const element = messagesContainerRef.current;
    if (!element) return;
    const restoreReader = (event: Event) => {
      const request = (event as CustomEvent<ChatReaderRestoreRequest>).detail;
      if (
        !request ||
        !Number.isFinite(request.scrollTop) ||
        (request.anchor &&
          (!request.anchor.key || !Number.isFinite(request.anchor.offset)))
      )
        return;
      event.preventDefault();
      isUserScrolledUpRef.current = true;
      visibleAnchorRef.current = request.anchor ?? null;
      setIsUserScrolledUp(true);
      setReaderRestoreRequest((current) => ({
        ...request,
        sessionId: activeSession.id,
        version: (current?.version ?? 0) + 1,
      }));
    };
    element.addEventListener(CHAT_READER_RESTORE_EVENT, restoreReader);
    return () =>
      element.removeEventListener(CHAT_READER_RESTORE_EVENT, restoreReader);
  }, [activeSession.id]);

  useLayoutEffect(() => {
    const element = messagesContainerRef.current;
    if (!element || !currentReaderRestoreRequest) return;
    if (transcriptRows.length > VIRTUALIZE_AFTER_MESSAGE_COUNT) return;
    const restored = currentReaderRestoreRequest.anchor
      ? restoreChatScrollAnchor(element, currentReaderRestoreRequest.anchor)
      : false;
    if (!restored) {
      writeProgrammaticScroll(element, currentReaderRestoreRequest.scrollTop);
    } else {
      noteProgrammaticScroll(element);
    }
    if (restored) visibleAnchorRef.current = captureChatScrollAnchor(element);
  }, [
    currentReaderRestoreRequest,
    transcriptRows.length,
    noteProgrammaticScroll,
    writeProgrammaticScroll,
  ]);

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
    // The reveal is the reader's position now: a later content resize keeps
    // this row, not the one they were on before the link opened.
    const element = messagesContainerRef.current;
    if (element) visibleAnchorRef.current = captureChatScrollAnchor(element);
  }, [messages, requestedMessageRowId]);
  const agent = agents.find((a) => a.slug === activeSession.agentSlug);

  // Keep the view pinned to the bottom as content grows (new messages, live
  // streaming) unless the user has scrolled up. A layout effect writes scrollTop
  // before paint so there is no visible jump; rAF covers late layout (images,
  // markdown reflow) without fighting the browser via a 0ms timeout.
  const lastMessage = messages[messages.length - 1];
  // A projected open turn grows without a shell flush or message-count change.
  const tailContentLength = lastMessage?.content?.length ?? 0;
  const tailPartsLength = lastMessage?.contentParts?.length ?? 0;
  const pinToLatest = useCallback(() => {
    if (pinFrameRef.current !== undefined)
      cancelAnimationFrame(pinFrameRef.current);
    const el = messagesContainerRef.current;
    if (!el || isUserScrolledUpRef.current) return;
    writeProgrammaticScroll(el, el.scrollHeight);
    markTranscriptPhase('pin-layout');
    pinFrameRef.current = requestAnimationFrame(() => {
      pinFrameRef.current = undefined;
      if (messagesContainerRef.current && !isUserScrolledUpRef.current) {
        markTranscriptPhase('pin-raf');
        writeProgrammaticScroll(
          messagesContainerRef.current,
          messagesContainerRef.current.scrollHeight,
        );
      }
    });
  }, [writeProgrammaticScroll]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: content growth triggers a pin before paint
  useLayoutEffect(() => {
    pinToLatest();
    return () => {
      if (pinFrameRef.current !== undefined)
        cancelAnimationFrame(pinFrameRef.current);
    };
  }, [
    isUserScrolledUp,
    messages.length,
    tailContentLength,
    tailPartsLength,
    isStreaming,
    pinToLatest,
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
    if (transcriptRows.length > VIRTUALIZE_AFTER_MESSAGE_COUNT) return;
    const el = messagesContainerRef.current;
    if (!el || !isUserScrolledUpRef.current || !visibleAnchorRef.current) {
      return;
    }
    if (restoreChatScrollAnchor(el, visibleAnchorRef.current)) {
      noteProgrammaticScroll(el);
    }
    visibleAnchorRef.current = captureChatScrollAnchor(el);
  }, [transcriptRows, noteProgrammaticScroll]);

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
        if (
          visibleAnchorRef.current &&
          restoreChatScrollAnchor(el, visibleAnchorRef.current)
        ) {
          noteProgrammaticScroll(el);
        }
      } else {
        writeProgrammaticScroll(el, el.scrollHeight);
      }
      visibleAnchorRef.current = captureChatScrollAnchor(el);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [noteProgrammaticScroll, writeProgrammaticScroll]);

  // The scroller's own box does not change when its CONTENT grows, and most
  // growth arrives after the pin above has run: the Markdown renderer, code
  // highlighting and turn footers are code-split and replace a row's readable
  // source frames later. Observe the content itself. A pinned transcript
  // follows that growth to the end; a reader keeps the row they were on, which
  // matters because native scroll anchoring is disabled for this scroller.
  const messagesLengthRef = useRef(messages.length);
  messagesLengthRef.current = messages.length;
  useLayoutEffect(() => {
    const el = messagesContainerRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      // A running glide aims at the live end on every frame already.
      if (scrollAnimationRef.current) return;
      if (!isUserScrolledUpRef.current) {
        // Growth the reader caused (opening a tool card near the end) or that
        // lands while they are scrolling stays where it is.
        if (
          readerActing() ||
          performance.now() < readerInputRef.current.interactedUntil
        )
          return;
        if (el.scrollHeight - el.scrollTop - el.clientHeight > 0) {
          writeProgrammaticScroll(el, el.scrollHeight);
          markTranscriptPhase('content-repin');
        }
        return;
      }
      // The virtualizer owns keyed row correction for long transcripts.
      if (messagesLengthRef.current > VIRTUALIZE_AFTER_MESSAGE_COUNT) return;
      const anchor = visibleAnchorRef.current;
      if (anchor && restoreChatScrollAnchor(el, anchor)) {
        noteProgrammaticScroll(el);
        markTranscriptPhase('content-reanchor', { key: traceKey(anchor.key) });
      }
      visibleAnchorRef.current = captureChatScrollAnchor(el);
    });
    for (const child of el.children) observer.observe(child);
    const children = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.removedNodes)
          if (node instanceof Element) observer.unobserve(node);
        for (const node of mutation.addedNodes)
          if (node instanceof Element) observer.observe(node);
      }
    });
    children.observe(el, { childList: true });
    return () => {
      observer.disconnect();
      children.disconnect();
    };
  }, [noteProgrammaticScroll, readerActing, writeProgrammaticScroll]);

  // Ends the scroll-load suppression a press's restoration holds. Genuine
  // reader input, a session switch and the settle loop all end it the same way.
  const endOlderRestoreSuppression = useCallback(() => {
    if (olderRestoreFrameRef.current !== undefined)
      cancelAnimationFrame(olderRestoreFrameRef.current);
    olderRestoreFrameRef.current = undefined;
    olderRestoringRef.current = false;
  }, []);
  // ChatDockBody keeps this component mounted across chats, so one chat's
  // request state must not outlive the chat: a request still in flight for the
  // previous session finds a newer generation when it settles and stands down.
  useEffect(() => {
    void activeSession.id;
    olderGenerationRef.current += 1;
    olderCommitPendingRef.current = false;
    loadingOlderRef.current = false;
    endOlderRestoreSuppression();
  }, [activeSession.id, endOlderRestoreSuppression]);

  const loadOlder = async () => {
    if (!onLoadOlder || historyLoading || loadingOlderRef.current) return;
    loadingOlderRef.current = true;
    const generation = olderGenerationRef.current;
    // A press during an earlier request's restoration starts a new one; the
    // old frame loop must not clear the new request's scroll suppression.
    endOlderRestoreSuppression();
    olderRestoringRef.current = true;
    const element = messagesContainerRef.current;
    olderRequestHeightRef.current = element?.scrollHeight ?? 0;
    markTranscriptPhase('older-request');
    if (element) {
      visibleAnchorRef.current = captureChatScrollAnchor(element);
      isUserScrolledUpRef.current = true;
      setIsUserScrolledUp(true);
      setScrollAnchorVersion((version) => version + 1);
    }
    try {
      await onLoadOlder();
    } catch (error) {
      if (generation === olderGenerationRef.current) {
        loadingOlderRef.current = false;
        olderRestoringRef.current = false;
      }
      throw error;
    }
    if (generation !== olderGenerationRef.current) return;
    // The request is not over when its promise settles, and the stretch after
    // it has two parts (#3288). Until the merged page commits, the DOM still
    // shows the old top with the button enabled, so a press there is a press
    // on a view that is already being replaced: the shared in-flight flag
    // holds until that commit. After the commit the view is current, so a
    // press is a new request; but the virtualizer then walks the reader's row
    // back over several frames, through positions inside the auto-load band
    // that nothing marks as ours, and those scroll events are the press's own
    // restoration, not the reader: scroll-driven loads stay suppressed until
    // the layout stops moving (the frame loop below) or the reader provides
    // input. The state write guarantees a commit even when the load changed
    // nothing, and batches with the hook's own writes so that commit carries
    // the page.
    olderCommitPendingRef.current = true;
    setOlderCommitEpoch((epoch) => epoch + 1);
  };
  useLayoutEffect(() => {
    void olderCommitEpoch;
    if (!olderCommitPendingRef.current) return;
    olderCommitPendingRef.current = false;
    loadingOlderRef.current = false;
    markTranscriptPhase('older-commit');
    const requestHeight = olderRequestHeightRef.current;
    let stableFrames = 0;
    let frames = 0;
    let lastTop: number | undefined;
    let lastHeight: number | undefined;
    const step = () => {
      olderRestoreFrameRef.current = undefined;
      const element = messagesContainerRef.current;
      frames += 1;
      if (!element) return endOlderRestoreSuppression();
      // Settled means the layout has stopped moving. The row to restore is not
      // tracked by key: under virtualization its node is recycled out and may
      // not return for a long time. A page that grew the content while the
      // reader sits inside the band has not been restored yet, however still
      // it is.
      const moved =
        element.scrollTop !== lastTop || element.scrollHeight !== lastHeight;
      const unrestored =
        element.scrollTop <= OLDER_AUTO_LOAD_BAND_PX &&
        element.scrollHeight > requestHeight;
      lastTop = element.scrollTop;
      lastHeight = element.scrollHeight;
      stableFrames = moved || unrestored ? 0 : stableFrames + 1;
      // The cap only bounds a layout that never stops moving.
      if (stableFrames >= OLDER_RESTORE_STABLE_FRAMES || frames >= 120)
        return endOlderRestoreSuppression();
      olderRestoreFrameRef.current = requestAnimationFrame(step);
    };
    olderRestoreFrameRef.current = requestAnimationFrame(step);
  }, [olderCommitEpoch, endOlderRestoreSuppression]);
  useEffect(() => endOlderRestoreSuppression, [endOlderRestoreSuppression]);

  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const target = e.currentTarget;
    // A transcript with no height (a short dock gives the composer priority and
    // shrinks it to nothing) cannot be read, so the scroll event its collapse
    // can dispatch is the layout moving, not the reader leaving the bottom.
    // Treating it as the latter raised "Scroll to bottom" over a transcript
    // nobody can see, in the composer's scarcest row. The size observer
    // re-pins or re-anchors it when it has height again.
    if (target.clientHeight === 0) {
      lastClientHeightRef.current = 0;
      return;
    }
    const previousClientHeight = lastClientHeightRef.current;
    const resized =
      previousClientHeight !== null &&
      Math.abs(target.clientHeight - previousClientHeight) >=
        RESIZE_REANCHOR_THRESHOLD_PX;
    lastClientHeightRef.current = target.clientHeight;
    // Every frame of a "Scroll to bottom" glide is our own write, and reader
    // input cancels the glide before its own scroll arrives. Momentum the
    // reader started before tapping emits no input event: a scroll that moves
    // against the glide is theirs and ends it.
    if (scrollAnimationRef.current) {
      // (Content that shrank under the glide clamps it to the new end; that
      // reads as reaching the end below, which pins, the glide's own goal.)
      const glide = lastProgrammaticScrollRef.current;
      if (!glide || target.scrollTop >= glide.top - PROGRAMMATIC_SCROLL_ECHO_PX)
        return;
      scrollAnimationRef.current.cancel();
    }
    // A dock/keyboard resize can dispatch `scroll` before ResizeObserver gets
    // its turn. Preserve the reader's prior intent during that event: an
    // already-pinned transcript stays pinned, while an intentionally scrolled
    // transcript is restored by the observer from its captured anchor.
    if (resized) {
      if (!isUserScrolledUpRef.current) {
        writeProgrammaticScroll(target, target.scrollHeight);
        visibleAnchorRef.current = null;
      }
      return;
    }
    // Our own positioning writes (tail-follow pins, anchor restores) dispatch
    // scroll events too. A write always targets the position the current
    // reader state already implies, so an event landing on the last write is
    // its echo — not the reader moving. Anything else is reader movement, no
    // matter the device (wheel, touch, keyboard and scrollbar drags all just
    // move scrollTop), with one exception: the layout clamp below.
    const echo = lastProgrammaticScrollRef.current;
    if (
      echo &&
      performance.now() - echo.at <= PROGRAMMATIC_SCROLL_ECHO_MS &&
      Math.abs(target.scrollTop - echo.top) <= PROGRAMMATIC_SCROLL_ECHO_PX
    ) {
      return;
    }
    // A pinned transcript that lands a little short with no reader input was
    // clamped by layout, not scrolled: a sibling measuring itself can briefly
    // hand the transcript more height (the composer used to collapse its
    // draft to one row to size it). The browser clamps scrollTop to the new end, and
    // the height comes back within the same frame — no resize is ever
    // observed. Without this the newest message stayed that many pixels short.
    const acting = readerActing();
    const previousTop = lastKnownScrollTopRef.current;
    lastKnownScrollTopRef.current = target.scrollTop;
    // Momentum keeps scrolling after the finger lifts; while it does, the
    // reader's window stays open.
    if (acting)
      readerInputRef.current.until = Math.max(
        readerInputRef.current.until,
        performance.now() + READER_SCROLL_EXTEND_MS,
      );
    const shortBy =
      target.scrollHeight - target.scrollTop - target.clientHeight;
    if (
      !isUserScrolledUpRef.current &&
      !acting &&
      shortBy > 0 &&
      shortBy <= PINNED_TOLERANCE_PX
    ) {
      writeProgrammaticScroll(target, target.scrollHeight);
      markTranscriptPhase('clamp-repin', { shortBy });
      return;
    }
    setReaderRestoreRequest(null);
    if (
      hasOlderMessages &&
      target.scrollTop <= OLDER_AUTO_LOAD_BAND_PX &&
      !olderRestoringRef.current
    )
      void loadOlder();
    setScrollAnchorVersion((version) => version + 1);
    // Resize animations can emit a scroll event between two ResizeObserver
    // frames. Treat a small transient gap as still pinned so a dock/keyboard
    // transition cannot be mistaken for deliberate reader navigation.
    // The tolerance absorbs layout transitions, not the reader: a reader who
    // is moving up has left the end however few pixels they have moved, or a
    // streaming pin would undo a slow drag on every token.
    // Still at the end (a bounce settling back, a clamp as the viewport
    // grows) is not leaving it, whichever way it moved.
    const readerMovingUp =
      acting &&
      shortBy > 1 &&
      previousTop !== null &&
      target.scrollTop < previousTop - 0.5;
    const isAtBottom = shortBy <= PINNED_TOLERANCE_PX && !readerMovingUp;
    isUserScrolledUpRef.current = !isAtBottom;
    setIsUserScrolledUp(!isAtBottom);
    visibleAnchorRef.current = isAtBottom
      ? null
      : captureChatScrollAnchor(target);
  };

  const cancelScrollToBottom = useCallback(() => {
    scrollAnimationRef.current?.cancel();
  }, []);
  const onReaderInput = useCallback(
    (event: React.SyntheticEvent) => {
      const input = readerInputRef.current;
      const now = performance.now();
      if (event.type === 'touchstart') {
        input.touching = true;
        input.interactedUntil = now + READER_INTERACTION_GRACE_MS;
        // A touch's events stay with the node it began on. A virtualized row
        // can leave the document mid-drag, and its touchend then never
        // reaches the window: listen on the node itself as well.
        const origin = event.target as EventTarget;
        const listening = new AbortController();
        const release = (end: Event) => {
          listening.abort();
          releaseTouchRef.current(end);
        };
        origin.addEventListener('touchend', release, {
          signal: listening.signal,
        });
        origin.addEventListener('touchcancel', release, {
          signal: listening.signal,
        });
      } else if (event.type === 'pointerdown') {
        // A touch is tracked by its touch events: the browser cancels the
        // pointer as soon as the finger starts panning.
        const pointer = event as React.PointerEvent;
        // A secondary press opens a context menu that often swallows the
        // release.
        if (pointer.pointerType !== 'touch' && pointer.button === 0)
          input.pressing = true;
        input.interactedUntil = now + READER_INTERACTION_GRACE_MS;
      } else {
        input.until = now + READER_INPUT_GRACE_MS;
        if (event.type === 'keydown')
          input.interactedUntil = now + READER_INTERACTION_GRACE_MS;
      }
      endOlderRestoreSuppression();
      cancelScrollToBottom();
    },
    [endOlderRestoreSuppression, cancelScrollToBottom],
  );
  // A press can end outside the transcript, so its end is observed globally.
  const releaseTouchRef = useRef<(event: Event) => void>(() => {});
  useEffect(() => {
    const releaseTouch = (event: Event) => {
      const input = readerInputRef.current;
      if (!input.touching) return;
      // The reader is still touching while any finger is down.
      if ((event as TouchEvent).touches?.length) return;
      input.touching = false;
      input.until = Math.max(
        input.until,
        performance.now() + TOUCH_MOMENTUM_GRACE_MS,
      );
    };
    const releasePress = (event: Event) => {
      const input = readerInputRef.current;
      if ((event as PointerEvent).pointerType === 'touch' || !input.pressing)
        return;
      input.pressing = false;
      input.until = Math.max(
        input.until,
        performance.now() + READER_INPUT_GRACE_MS,
      );
    };
    // Leaving the page or opening a context menu can swallow a release.
    const releaseAll = () => {
      const input = readerInputRef.current;
      input.touching = false;
      input.pressing = false;
    };
    releaseTouchRef.current = releaseTouch;
    const listeners: Array<[string, (event: Event) => void]> = [
      ['touchend', releaseTouch],
      ['touchcancel', releaseTouch],
      ['pointerup', releasePress],
      ['pointercancel', releasePress],
      ['contextmenu', releaseAll],
      ['blur', releaseAll],
    ];
    for (const [type, listener] of listeners)
      window.addEventListener(type, listener, true);
    document.addEventListener('visibilitychange', releaseAll);
    return () => {
      for (const [type, listener] of listeners)
        window.removeEventListener(type, listener, true);
      document.removeEventListener('visibilitychange', releaseAll);
    };
  }, []);

  // Glide to the newest message, then hand back to tail-follow. The reader
  // stays "scrolled up" for the glide so the pin and the virtualizer's
  // follow cannot snap it; reader input cancels and leaves them in control.
  const handleScrollToBottom = () => {
    const el = messagesContainerRef.current;
    if (!el) return;
    setReaderRestoreRequest(null);
    visibleAnchorRef.current = null;
    scrollAnimationRef.current?.cancel();
    const token = {};
    scrollAnimationTokenRef.current = token;
    setScrollingToBottom(true);
    markTranscriptPhase('scroll-to-bottom-start');
    const finish = (completed: boolean) => {
      if (scrollAnimationTokenRef.current !== token) return;
      scrollAnimationTokenRef.current = null;
      scrollAnimationRef.current = null;
      setScrollingToBottom(false);
      markTranscriptPhase(
        completed ? 'scroll-to-bottom-end' : 'scroll-to-bottom-cancel',
      );
      if (!completed) return;
      isUserScrolledUpRef.current = false;
      setIsUserScrolledUp(false);
    };
    const animation = animateScrollToBottom(el, {
      write: (top) => writeProgrammaticScroll(el, top),
      onFinish: finish,
    });
    // An instant jump (reduced motion) has already finished.
    if (scrollAnimationTokenRef.current === token)
      scrollAnimationRef.current = animation;
  };
  // A glide belongs to the chat it started in; a switch or unmount ends it
  // where the reader asked to be — following the tail.
  useEffect(() => {
    void activeSession.id;
    return () => {
      if (!scrollAnimationRef.current) return;
      scrollAnimationRef.current.cancel();
      isUserScrolledUpRef.current = false;
      setIsUserScrolledUp(false);
    };
  }, [activeSession.id]);

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

  // `useDerivedSessions` mints a new `ChatSession` per streamed token by
  // design, so handing the whole object to a memoised row made every mounted
  // bubble re-render on every token. These are the only fields a row reads
  // (`MessageBubbleSession`); keyed on their values, the object is stable
  // across the tokens that do not move any of them.
  // Requests still waiting on the USER: an answered one stays open on the
  // server until `request.resolved`, and no longer holds the typing dots back.
  const waitingApprovalCount = useMemo(
    () =>
      requestsWaitingOnUser({
        pendingApprovals: activeSession.pendingApprovals,
        answeredApprovals: activeSession.answeredApprovals,
      }).length,
    [activeSession.pendingApprovals, activeSession.answeredApprovals],
  );
  const bubbleSession: MessageBubbleSession = useMemo(
    () => ({
      id: activeSession.id,
      agentSlug: activeSession.agentSlug,
      agentName: activeSession.agentName,
      projectSlug: activeSession.projectSlug,
      conversationId: activeSession.conversationId,
      messageCount: messages.length,
      isThinking: activeSession.isThinking,
      pendingApprovalCount: waitingApprovalCount,
      activityShownElsewhere: statusShownElsewhere,
      foldSettledWork: true,
      // The server's open turn decides liveness (`isTurnStreamLive`), so it
      // also names the live turn; `openTurnId` is the pre-record fallback.
      liveTurnId: turnLive
        ? (activeSession.conversationActivity?.openTurn?.turnId ??
          activeSession.openTurnId)
        : undefined,
      liveTailRow: turnLive && Boolean(suppressStreamingRow),
    }),
    [
      turnLive,
      activeSession.conversationActivity?.openTurn?.turnId,
      activeSession.openTurnId,
      suppressStreamingRow,
      activeSession.id,
      activeSession.agentSlug,
      activeSession.agentName,
      activeSession.projectSlug,
      activeSession.conversationId,
      activeSession.isThinking,
      waitingApprovalCount,
      statusShownElsewhere,
      messages.length,
    ],
  );

  type RowPresentation = {
    turn: React.ContextType<typeof TranscriptTurnContext>;
    fork: ForkTurnSource | null | undefined;
  };
  const previousPresentation = useRef(new Map<string, RowPresentation>());
  const rowPresentation = useMemo(() => {
    const next = new Map<string, RowPresentation>();
    const seenTurns = new Set<string>();
    for (const row of transcriptRows) {
      if (row.kind === 'subagent') continue;
      const message = row.message;
      const key = JSON.stringify([message.sessionId, message.turnId]);
      const turn =
        message.role === 'assistant'
          ? {
              threadId: message.sessionId,
              turnId: message.turnId,
              messageId: message.id,
              firstRow: !seenTurns.has(key),
            }
          : undefined;
      if (turn) seenTurns.add(key);
      const fork =
        message.role === 'user'
          ? precedingForkSource(messages, row.index)
          : undefined;
      const previous = previousPresentation.current.get(row.id);
      next.set(row.id, {
        turn: isShallowEqual(previous?.turn, turn) ? previous?.turn : turn,
        fork:
          previous && isShallowEqual(previous.fork, fork)
            ? previous.fork
            : fork,
      });
    }
    previousPresentation.current = next;
    return next;
  }, [transcriptRows, messages]);

  const renderDefaultMessage = (
    msg: ChatMessage,
    idx: number,
    rowId: string,
  ) => (
    <MessageBubble
      key={`${activeSession.id}-msg-${messageAnchorKey(msg)}`}
      msg={msg as any}
      idx={idx}
      activeSession={bubbleSession}
      agents={agents as any}
      chatFontSize={fontSize}
      showReasoning={showReasoning}
      showToolDetails={showToolDetails}
      onCopy={handleCopy}
      onForkFromTurn={onForkFromTurn}
      continuesTurn={
        msg.turnId !== undefined && messages[idx - 1]?.turnId === msg.turnId
      }
      userForkSource={rowPresentation.get(rowId)?.fork}
      onNewChatFromMessage={
        msg.role === 'user' ? onNewChatFromMessage : undefined
      }
      onToolApproval={activeSession.replay ? undefined : handleToolApproval}
      anchorKey={messageAnchorKey(msg)}
      owner={owner}
      accountableHuman={accountableHuman}
    />
  );

  const renderMessage = (msg: ChatMessage, idx: number, rowId: string) => {
    if (renderOverride) {
      const override = renderOverride(msg, idx);
      if (override !== null) return override;
    }
    return renderDefaultMessage(msg, idx, rowId);
  };

  const renderTranscriptRow = (row: ChildTranscriptRow) => {
    if (row.kind === 'subagent')
      return (
        <div
          className="chat-message-anchor"
          data-chat-message-key={row.id}
          data-chat-turn-id={row.child.spawn?.turnId}
        >
          <SubagentTranscriptCard child={row.child} />
        </div>
      );
    const messageId = (row.message as ChatMessage & { id?: string }).id;
    return (
      <div
        className="chat-message-anchor"
        data-chat-message-key={row.id}
        data-chat-turn-id={row.message.turnId}
        data-chat-role={row.message.role}
        data-chat-text-length={row.message.content?.length ?? 0}
        {...(messageId
          ? { id: `transcript-message-${encodeURIComponent(messageId)}` }
          : {})}
      >
        <TranscriptTurnContext.Provider
          value={rowPresentation.get(row.id)?.turn}
        >
          {renderMessage(row.message, row.index, row.id)}
        </TranscriptTurnContext.Provider>
      </div>
    );
  };

  const agentIcon = useMemo(
    () => <AgentIcon agent={agent || FALLBACK_AGENT} size={20} />,
    [agent],
  );

  // archive#1424 fix (then): the streaming row's
  // identity/owner attribution is resolved from the CURRENT live agent
  // binding — honest while this turn is actually executing. The engine chip
  // is deliberately NOT threaded here: it briefly asserted an engine
  // identity while streaming and then retracted it the instant the row
  // converted to a persisted `MessageBubble`. No surface may assert an
  // engine identity it's going to take back.
  // archive#1434 made the persisted row's chip real (it reads the turn's own
  // provenance envelope), and this row still shows none — deliberately. The
  // envelope is assembled from the turn's TERMINAL event, so while the turn
  // is still streaming there is no per-turn record to read; the only source
  // available here is the live binding this comment already rules out. The
  // resulting transition is additive (nothing claimed, then a fact once it
  // is observed), never a retraction — pinned by
  // `MessageAttribution.streamingParity.test.tsx`.
  // archive#1424: falls back to the session's own
  // threaded `agentName` (never blank) when `agents.find` misses — e.g. the
  // agent was deleted after this session started — so the row still reads
  // as attributable instead of silently dropping the identity text.
  const streamingAttributionAgent = useMemo(() => {
    const name = agent?.name ?? activeSession.agentName;
    return name ? { name } : null;
  }, [agent, activeSession.agentName]);

  const renderReasoning = useCallback(
    (content: string, i: number, hasAnswerText: boolean) => (
      <ReasoningSection
        key={i}
        content={content}
        fontSize={fontSize}
        show={showReasoning}
        hasAnswerText={hasAnswerText}
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
          !activeSession.replay && part.needsApproval && part.approvalId
            ? (action) =>
                handleToolApproval(
                  activeSession.id,
                  activeSession.agentSlug,
                  part.approvalId!,
                  part.toolName || part.name || '',
                  action,
                  part.approvalThreadId,
                  part.approvalEventId,
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
      activeSession.replay,
    ],
  );

  return (
    <ApprovalSheetProvider
      apiBase={apiBase}
      requests={sheetRequests}
      onCheck={async (request) => {
        if (
          !request.approvalThreadId ||
          !request.approvalId ||
          !request.approvalEventId
        )
          throw new Error('This request has no current inspection reference.');
        const { inspectApprovalAnswer } = await import(
          '../../hooks/orchestration/answerRequest'
        );
        const outcome = await inspectApprovalAnswer(apiBase, {
          threadId: request.approvalThreadId,
          requestId: request.approvalId,
          requestEventId: request.approvalEventId,
        });
        const current = activeChatsStore.getSnapshot()[activeSession.id];
        if (outcome === 'pending' && current) {
          activeChatsStore.updateChat(activeSession.id, {
            answeredApprovals: current.answeredApprovals?.filter(
              (id) => id !== request.approvalId,
            ),
          });
        }
        if (outcome === 'already-settled') {
          if (current)
            activeChatsStore.updateChat(activeSession.id, {
              pendingApprovals: current.pendingApprovals?.filter(
                (id) => id !== request.approvalId,
              ),
              orchestrationHistoryRevision:
                (current.orchestrationHistoryRevision ?? 0) + 1,
            });
        }
        return outcome;
      }}
      onApprove={(request, action) =>
        handleToolApproval(
          activeSession.id,
          activeSession.agentSlug,
          request.approvalId ?? '',
          request.toolName || request.name || '',
          action,
          request.approvalThreadId,
          request.approvalEventId,
        )
      }
    >
      <UIBlockActionsContext.Provider value={uiBlockActions}>
        <TranscriptChildrenContext.Provider value={transcriptChildren}>
          {onQuote && !activeSession.replay && (
            <QuoteSelectionToolbar
              container={messagesContainerRef}
              messages={messages}
              onQuote={onQuote}
            />
          )}
          <SessionSummaryCard
            activeSession={activeSession}
            hasSettingsEntryPoint={hasSettingsEntryPoint}
          />
          <div
            className="chat-messages"
            ref={messagesContainerRef}
            role="log"
            tabIndex={-1}
            aria-label="Conversation transcript"
            data-chat-session-id={activeSession.id}
            aria-live="polite"
            style={{ fontSize: `${fontSize}px` }}
            onScroll={handleScroll}
            onWheel={onReaderInput}
            onTouchStart={onReaderInput}
            onPointerDown={onReaderInput}
            onKeyDown={onReaderInput}
          >
            {hasOlderMessages && (
              <div className="session-history-controls">
                <button
                  type="button"
                  className="button button--secondary session-history-controls__more"
                  disabled={historyLoading}
                  onClick={() => void loadOlder()}
                >
                  {historyLoading
                    ? 'Loading earlier messages…'
                    : 'Earlier messages'}
                </button>
              </div>
            )}
            {historyNotice}
            {transcriptRows.length === 0 && !isStreaming ? (
              (emptyState ?? (
                <ChatEmptyState
                  agentSlug={activeSession.agentSlug}
                  agentName={activeSession.agentName}
                />
              ))
            ) : (
              <>
                {transcriptRows.length > 0 &&
                  (transcriptRows.length > VIRTUALIZE_AFTER_MESSAGE_COUNT ? (
                    <TranscriptVirtualizer
                      rows={transcriptRows}
                      scrollElement={messagesContainerRef}
                      onProgrammaticScroll={noteProgrammaticScroll}
                      renderRow={renderTranscriptRow}
                      followTail={!isUserScrolledUp && !requestedMessageRowId}
                      followTick={`${tailContentLength}:${tailPartsLength}`}
                      anchorVersion={scrollAnchorVersion}
                      revealRowId={
                        requestedMessageRowId ??
                        approvalRevealRowId ??
                        currentReaderRestoreRequest?.anchor?.key
                      }
                      restoreAnchor={currentReaderRestoreRequest?.anchor}
                      restoreAnchorVersion={
                        currentReaderRestoreRequest?.version
                      }
                      // Read at mount only: a reader already in the transcript
                      // when it crosses into virtualization keeps their row.
                      initialAnchor={
                        isUserScrolledUp ? visibleAnchorRef.current : null
                      }
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
                    <TranscriptTurnContext.Provider
                      value={{
                        threadId: activeSession.currentSessionId,
                        turnId: activeSession.openTurnId,
                        wholeTurn: true,
                      }}
                    >
                      <ActiveStreamingMessage
                        sessionId={activeSession.id}
                        agentIcon={agentIcon}
                        agentIconStyle={EMPTY_STYLE}
                        fontSize={fontSize}
                        showReasoning={showReasoning}
                        renderReasoning={renderReasoning}
                        renderToolCall={renderToolCall}
                        activityHint={activeSession.activityHint}
                        elapsedMs={activeSession.replay?.elapsedMs}
                        conversationActivity={
                          activeSession.conversationActivity
                        }
                        turnStartedAt={activeSession.openTurnStartedAt}
                        suppressActivity={suppressActivity}
                        hideProgressSilence={progressSilenceShownElsewhere}
                        statusLabel={
                          activeSession.orchestrationStatus ===
                            'awaiting-approval' &&
                          chatWaitsOnUser(activeSession)
                            ? // station#2235: the status alone asserts nothing about
                              // an approval — a crashed turn's needs_input folds to
                              // this status with no request behind it. Name the
                              // approval only when a request is still waiting on
                              // the user; without one the session is waiting on the
                              // user, not on a decision. A session whose requests
                              // are all answered is waiting on the engine, and says
                              // nothing here.
                              waitingApprovalCount > 0
                              ? 'Waiting for approval'
                              : 'Waiting on you'
                            : undefined
                        }
                        attributionAgent={streamingAttributionAgent}
                        owner={owner}
                        onContentChange={pinToLatest}
                      />
                    </TranscriptTurnContext.Provider>
                  </div>
                )}
                {/* Backgrounded provider tasks outlive the assistant turn: the
                session is honestly idle, but work continues. Keep a live
                affordance so the chat never looks done while it isn't. */}
                {!turnLive &&
                  (localBackgroundTasks.length > 0 ||
                    serverBackgroundCount > 0) &&
                  (onOpenBackgroundTasks && localBackgroundTasks.length > 0 ? (
                    // archive#1301: a `<button>` cannot
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
                        aria-label={`${backgroundBannerLabel} — open background tasks`}
                      >
                        {backgroundBannerDots}
                        <span
                          className="background-tasks-banner__label"
                          aria-hidden="true"
                        >
                          {backgroundBannerLabel}
                        </span>
                      </button>
                      <span
                        className="background-tasks-banner__sr-status"
                        role="status"
                      >
                        {backgroundBannerLabel}
                      </span>
                    </>
                  ) : (
                    <div className="background-tasks-banner" role="status">
                      {backgroundBannerDots}
                      <span className="background-tasks-banner__label">
                        {backgroundBannerLabel}
                      </span>
                    </div>
                  ))}
              </>
            )}
            {/* Mounted while empty too: its live region must exist before the
            first request arrives (#2344). */}
            {!activeSession.replay && (
              <PendingApprovalStrip
                requests={pendingApprovalRequests}
                settled={approvalEventsSettled !== false}
                onApprove={(request, action) =>
                  handleToolApproval(
                    activeSession.id,
                    activeSession.agentSlug,
                    request.approvalId ?? '',
                    request.toolName || request.name || '',
                    action,
                    request.approvalThreadId,
                    request.approvalEventId,
                  )
                }
              />
            )}
          </div>
          {isUserScrolledUp &&
            !scrollingToBottom &&
            (scrollControlsTarget ? (
              createPortal(
                <ScrollToBottomButton onClick={handleScrollToBottom} />,
                scrollControlsTarget,
              )
            ) : (
              <ScrollToBottomButton onClick={handleScrollToBottom} />
            ))}
        </TranscriptChildrenContext.Provider>
      </UIBlockActionsContext.Provider>
    </ApprovalSheetProvider>
  );
}

export const ChatMessageList = React.memo(ChatMessageListComponent);

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
import { conversationAccessFor } from '../../connections/station-connection';
import { chatBelongsToStation } from '../../connections/station-state';
import { useAgents } from '../../contexts/AgentsContext';
import { useApiBase } from '../../contexts/ApiBaseContext';
import type { ChatContentPart } from '../../contexts/active-chats-state';
import { activeChatsStore } from '../../contexts/active-chats-store';
import { chatFormDraftsStore } from '../../contexts/chat-form-drafts-store';
import { useDeviceSettings } from '../../contexts/DeviceSettingsContext';
import {
  rememberSettledRequest,
  useStreamCatchingUp,
} from '../../hooks/orchestration/heldDuringCatchUp';
import { unansweredApprovalRequests } from '../../hooks/orchestration/pendingRequestRows';
import type { ReaderPlace } from '../../hooks/orchestration/readerPlace';
import { useSendMessage } from '../../hooks/useActiveChatSessions';
import { useCoarsePointer } from '../../hooks/useCoarsePointer';
import { useCopyToClipboardToast } from '../../hooks/useCopyToClipboardToast';
import { useIsMobile } from '../../hooks/useIsMobile';
import { deviceSettingsStore } from '../../lib/device-settings-store';
import type { ChatMessage, ChatSession } from '../../types';
import type { SavedAnswerQuote } from '../../utils/answer-quotes';
import { visibleChildWorkNoticeKey } from '../../utils/child-work-display';
import { isTurnStreamLive } from '../../utils/execution';
import { isShallowEqual } from '../../utils/isShallowEqual';
import type { OwnerAttribution } from '../../utils/ownerAttribution';
import {
  chatWaitsOnUser,
  requestAttentionKind,
  requestsWaitingOnUser,
} from '../../utils/waiting-approvals';
import { attentionWord } from '../../views/home/work-status';
import { useOptionalConversationConnection } from '../conversation/ConversationConnectionContext';
import { useApprovalAnswering } from '../conversation/useApprovalAnswering';
import { AgentIcon } from '../icons/AgentIcon';
import { LazyBoundary } from '../LazyBoundary';
import {
  REVEAL_APPROVAL_EVENT,
  type RevealApprovalDetail,
} from '../status/approvalReveal';
import { ApprovalSheetProvider } from './ApprovalSheetProvider';
import { incomingMessageLabel } from './agent-message/IncomingAgentHeader';
import {
  animateScrollToBottom,
  type ScrollToBottomAnimation,
} from './animateScrollToBottom';
import { ApprovalsHeldContext } from './approvalsHeld';
import { ChatBackgroundStrip } from './BackgroundTaskActivity';
import {
  BrowserTurnActivityProvider,
  LiveBrowserTurnActivities,
} from './BrowserTurnActivity';
import { ChatEmptyState } from './ChatEmptyState';
import {
  CHAT_READER_RESTORE_EVENT,
  type ChatReaderRestoreRequest,
  type ChatScrollAnchor,
  captureChatScrollAnchor,
  createResizeReanchorGate,
  restoreChatScrollAnchor,
} from './chatScrollAnchor';
import {
  type ForkTurnSource,
  type MessageResendRequest,
  type MessageResendSource,
  messageResendSource,
  precedingForkSource,
  regenerateSource,
  sameMessageResendSource,
} from './fork-turn-source';
import { formatFormSubmission } from './formSubmission';
import { IndexedTranscriptTurnRail } from './IndexedTranscriptTurnRail';
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
import { ModelChangeMarker } from './TranscriptChangeMarker';
import { transcriptMarkerLabel } from './TranscriptMarker';
import {
  TranscriptTurnRail,
  turnLabel,
  turnStepTarget,
  useTranscriptTurnViewport,
} from './TranscriptTurnRail';
import { TranscriptVirtualizer } from './TranscriptVirtualizer';
import {
  type ChildTranscriptRow,
  foldTranscriptChildren,
  projectTranscriptChildRows,
  type TranscriptChild,
  TranscriptTurnContext,
} from './transcript-child-work';
import { BROWSE_TURNS_EVENT } from './transcript-turn-browser-events';
import {
  lastRecordedTurn,
  modelChangeBetween,
  transcriptChangeFacts,
} from './transcriptChangeMarkers';
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
  type TranscriptTurnLandmark,
  transcriptTurnLandmarks,
} from './transcriptTurnLandmarks';
import {
  UIBlockActionsContext,
  type UIBlockFormSubmission,
} from './UIBlockActionsContext';
import { TranscriptToolRecordSource } from './useObservedRunningToolCalls';

const loadTurnBrowser = () =>
  import('./TranscriptTurnBrowser').then((module) => ({
    default: module.TranscriptTurnBrowser,
  }));

interface ChatMessageListProps {
  recordAgents?: ReturnType<typeof useAgents>;
  externalScrollContainerRef?: React.RefObject<HTMLDivElement | null>;
  preserveReading?: boolean;
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
  /** Content drawn under a default-rendered message, or null for none. */
  renderAfterMessage?: (
    msg: ChatMessage,
    idx: number,
  ) => React.ReactNode | null;
  emptyState?: React.ReactNode;
  historyNotice?: React.ReactNode;
  /** The transcript's last line once no turn streams (a settled note). */
  transcriptFooter?: React.ReactNode;
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
  onLoadTurn?: (turnId: string, signal?: AbortSignal) => Promise<boolean>;
  /**
   * Told where the reader is: away from the end (scrolled up, or holding a
   * row with the end out of view) and the turn of the first row they see, so
   * the transcript's window keeps those rows while they read.
   */
  onReaderPlaceChange?: (place: ReaderPlace) => void;
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
  /** #4406: Regenerate an answer, or Edit and resend a message, in a fork. */
  onResendFromMessage?: (request: MessageResendRequest) => void;
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
  /**
   * The rows are this client's recent copy, still being re-read: a request
   * on them may already be answered elsewhere, so none is offered to answer
   * until the read lands.
   */
  approvalsHeld?: boolean;
}

// Stable fallback so `agent || FALLBACK_AGENT` doesn't allocate a new object
// (and therefore a new <AgentIcon> element identity) on every render.
const FALLBACK_AGENT = { name: 'AI' };

// Stable empty style object — StreamingMessage is memoized, so a fresh `{}`
// literal here would defeat that memo on every ChatMessageList render.
const EMPTY_STYLE: React.CSSProperties = {};

// A resize below this delta is treated as jitter (sub-pixel layout rounding,
// font-metric noise) rather than a genuine composer-height change, so it
// doesn't re-anchor the transcript scroll. Keeps composer auto-resize
// (which re-measures on every keystroke) from repeatedly snapping the
// scroll position even when nothing visually grew.
const RESIZE_REANCHOR_THRESHOLD_PX = 4;

/**
 * Every name one message goes by across its copies: the composer's bubble
 * (`clientId`), the same bubble once its turn starts (`sourceEventId`, its
 * `turn.started`) and the server's copy, whose id is `<that event>:user`.
 */
function userMessageNames(message: ChatMessage): string[] {
  const names: string[] = [];
  if (message.id) {
    names.push(`id:${message.id}`);
    if (message.id.endsWith(':user'))
      names.push(`event:${message.id.slice(0, -':user'.length)}`);
  }
  if (message.clientId) names.push(`client:${message.clientId}`);
  if (message.sourceEventId) names.push(`event:${message.sourceEventId}`);
  if (names.length === 0)
    names.push(`content:${message.timestamp ?? ''}:${message.content}`);
  return names;
}
/**
 * The held disclosure as the page has it now, if it is still open: the one
 * the reader activated or, when its row was drawn again, an open one in that
 * row. Null when it was closed or went away.
 */
function openHeldToggle(
  scroller: Element,
  held: { row: Element; toggle: Element },
): Element | null {
  const { toggle } = held;
  if (toggle.isConnected)
    return toggle.getAttribute('aria-expanded') === 'false' ||
      (toggle.matches('summary') &&
        !(toggle.parentElement as HTMLDetailsElement | null)?.open)
      ? null
      : toggle;
  const key = held.row.getAttribute('data-chat-message-key');
  const row = held.row.isConnected
    ? held.row
    : Array.from(scroller.querySelectorAll('[data-chat-message-key]')).find(
        (candidate) => candidate.getAttribute('data-chat-message-key') === key,
      );
  return (
    row?.querySelector('[aria-expanded="true"], details[open] > summary') ??
    null
  );
}
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
// The names of the reader's messages a transcript remembers, so a message
// that reappears (a withdrawn bubble uncovering it) is never new again. One
// message carries up to four; older names leave first.
const SEEN_USER_NAMES_MAX = 2_000;
// Keys that move the transcript when it has focus.
const SCROLL_KEYS = new Set([
  'ArrowUp',
  'ArrowDown',
  'PageUp',
  'PageDown',
  'Home',
  'End',
  ' ',
]);
// How much of a held row must show to read as its header, and the gap left
// above it when a shorter view brings it back.
const HELD_ROW_HEADER_PX = 48;
const HELD_ROW_MARGIN_PX = 8;
// A turn jump lets the virtualizer settle its reveal (measurement passes can
// move it for a few frames) before retaining the revealed row as the reader's.
const TURN_REVEAL_STABLE_FRAMES = 3;
const TURN_REVEAL_MAX_FRAMES = 60;
const STATION_MESSAGE_HASH = /^#station-message=/;
const EMPTY_MESSAGES: ChatMessage[] = [];

function sameLandmarks(
  left: readonly TranscriptTurnLandmark[],
  right: readonly TranscriptTurnLandmark[],
): boolean {
  return (
    left.length === right.length &&
    left.every((landmark, index) => isShallowEqual(landmark, right[index]))
  );
}
const NO_PENDING_APPROVALS: ReturnType<typeof unansweredApprovalRequests> = [];

const SETTLED_CATCH_UP_DELAY_MS = 250;
const settledCatchUps = new Map<string, ReturnType<typeof setTimeout>>();
/**
 * One history refetch per burst of stale requests on a chat: it brings in the
 * resolutions this view missed and any request opened since.
 */
function scheduleSettledCatchUp(chatId: string) {
  if (settledCatchUps.has(chatId)) return;
  settledCatchUps.set(
    chatId,
    setTimeout(() => {
      settledCatchUps.delete(chatId);
      const current = activeChatsStore.getSnapshot()[chatId];
      if (!current) return;
      activeChatsStore.updateChat(chatId, {
        orchestrationHistoryRevision:
          (current.orchestrationHistoryRevision ?? 0) + 1,
      });
    }, SETTLED_CATCH_UP_DELAY_MS),
  );
}
function ChatMessageListComponent({
  externalScrollContainerRef,
  preserveReading = false,
  sendMessage,
  apiBase,
  agents,
  activeSession,
  scrollControlsTarget,
  suppressStreamingRow,
  fontSize,
  layoutHeight,
  showReasoning,
  showToolDetails,
  renderOverride,
  renderAfterMessage,
  emptyState,
  historyNotice,
  transcriptFooter,
  hasOlderMessages,
  historyLoading,
  suppressActivity,
  statusShownElsewhere,
  progressSilenceShownElsewhere,
  onLoadOlder,
  onLoadTurn,
  onReaderPlaceChange,
  onOpenBackgroundTasks,
  liveStatusUnavailable = false,
  owner,
  accountableHuman,
  hasSettingsEntryPoint,
  onForkFromTurn,
  onNewChatFromMessage,
  onResendFromMessage,
  onQuote,
  approvalEvents,
  approvalEventsSettled,
  approvalsHeld = false,
}: ChatMessageListProps & {
  sendMessage: ReturnType<typeof useSendMessage>;
  apiBase: string;
  agents: ReturnType<typeof useAgents>;
}) {
  const isMobile = useIsMobile();
  const coarsePointer = useCoarsePointer();
  const touchTurnControls = isMobile || coarsePointer;
  const [turnBrowserOpen, setTurnBrowserOpen] = useState(false);
  const [pendingTurnJump, setPendingTurnJump] = useState<string | null>(null);
  const turnNavigationRequest = useRef<AbortController | null>(null);
  const cancelTurnNavigation = useCallback(() => {
    turnNavigationRequest.current?.abort();
    turnNavigationRequest.current = null;
    setPendingTurnJump(null);
  }, []);
  useEffect(() => {
    void activeSession.id;
    return () => turnNavigationRequest.current?.abort();
  }, [activeSession.id]);
  const openTurnBrowser = useCallback(() => setTurnBrowserOpen(true), []);
  const loadTurnAndReveal = useCallback(
    async (turnId: string, signal: AbortSignal) => {
      if (!onLoadTurn) return false;
      turnNavigationRequest.current?.abort();
      const request = new AbortController();
      turnNavigationRequest.current = request;
      const abort = () => request.abort(signal.reason);
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
      try {
        const found = await onLoadTurn(turnId, request.signal);
        request.signal.throwIfAborted();
        if (found) setPendingTurnJump(turnId);
        return found;
      } catch (error) {
        request.signal.throwIfAborted();
        throw error;
      } finally {
        signal.removeEventListener('abort', abort);
        if (turnNavigationRequest.current === request)
          turnNavigationRequest.current = null;
      }
    },
    [onLoadTurn],
  );
  useEffect(() => {
    const browse = (event: Event) => {
      if (
        (event as CustomEvent<{ chatStoreId: string }>).detail?.chatStoreId ===
        activeSession.id
      )
        setTurnBrowserOpen(true);
    };
    window.addEventListener(BROWSE_TURNS_EVENT, browse);
    return () => window.removeEventListener(BROWSE_TURNS_EVENT, browse);
  }, [activeSession.id]);
  useEffect(() => {
    void activeSession.id;
    setTurnBrowserOpen(false);
    setPendingTurnJump(null);
  }, [activeSession.id]);
  const { chatAnswerWidth } = useDeviceSettings();
  const target = useOptionalConversationConnection();
  const handleCopy = useCopyToClipboardToast();
  const handleToolApproval = useApprovalAnswering(apiBase);
  const pendingApprovalRequests = useMemo(
    () =>
      approvalEvents &&
      approvalEvents.length > 0 &&
      !approvalsHeld &&
      !activeSession.replay &&
      !target?.record?.readOnly
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
      approvalsHeld,
      target?.record?.readOnly,
    ],
  );
  const transcriptChildren = useMemo(
    () => foldTranscriptChildren(approvalEvents),
    [approvalEvents],
  );
  const sheetRequests = useMemo(
    () =>
      activeSession.replay || target?.record?.readOnly || approvalsHeld
        ? []
        : unansweredApprovalRequests(
            [],
            (approvalEvents ?? [])
              .map((item) => item.event)
              .filter((event) => Boolean(event.eventId)),
          ).filter(
            (request) => !request.inputRequest && !request.inputRequestUrl,
          ),
    [
      activeSession.replay,
      approvalEvents,
      approvalsHeld,
      target?.record?.readOnly,
    ],
  );
  // A reconnect replays what this view missed one event at a time; the sheet
  // holds its list until the replay ends (`ApprovalSheetProvider`).
  const sheetCatchingUp = useStreamCatchingUp(apiBase);
  // The store is already live at the shell; reading its scalar snapshot here
  // avoids adding a second subscription/allocation to every streaming row.
  // A mid-stream toggle is observed on the next existing 80 ms stream flush.
  const smoothReveal =
    deviceSettingsStore.get('featureSettings').smoothReveal ?? false;
  const ActiveStreamingMessage = smoothReveal
    ? SmoothStreamingMessage
    : StreamingMessage;

  const ownScrollRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = externalScrollContainerRef ?? ownScrollRef;
  const visibleAnchorRef = useRef<ChatScrollAnchor | null>(null);
  const isUserScrolledUpRef = useRef(preserveReading);
  // The transcript's last known position, ours or the reader's: a reader
  // scroll below it is the reader moving up.
  const lastKnownScrollTopRef = useRef<number | null>(null);
  const observedHeightRef = useRef(0);
  const scrollHeightRef = useRef(0);
  const growthDeltaRef = useRef(0);
  const tailIntentRef = useRef(false);
  const measureGrowth = useCallback((element: HTMLElement) => {
    const height = element.scrollHeight;
    if (observedHeightRef.current !== height) {
      growthDeltaRef.current = Math.max(0, height - observedHeightRef.current);
      observedHeightRef.current = height;
    }
    return height;
  }, []);
  const lastProgrammaticScrollRef = useRef<{
    top: number;
    at: number;
  } | null>(null);
  const lastClientHeightRef = useRef<number | null>(null);
  const [isUserScrolledUp, setIsUserScrolledUp] = useState(preserveReading);
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
    /** A mouse or pen button is down on the transcript's own scrollbar. */
    draggingScrollbar: false,
    /**
     * Scrolls before this time are the reader's own movement: wheel, a scroll
     * key, touch momentum, a scrollbar drag just released. Unlike `until`, a
     * press on the content (opening a row) does not open it.
     */
    scrollUntil: 0,
  });
  // A pinned reader who opened something at the end (a tool row, reasoning)
  // keeps it where it is: the tail, streaming text and new turns included,
  // stops being followed until the reader returns to the end, and Scroll to
  // bottom shows from the moment the hold starts. Only growth of the row whose
  // disclosure they activated starts it; an incidental tap on text or a link
  // does not. `readerHeld` shows the button while held with the end out of
  // view: showing it at the start puts the composer's layout change there, not
  // under a later scroll, and a transcript that still fits shows none.
  const readerHoldRef = useRef(false);
  const [readerHeld, setReaderHeld] = useState(false);
  const activatedRowRef = useRef<{
    row: Element;
    height: number;
    /** The disclosure the reader activated: closing it ends the hold. */
    toggle: Element;
  } | null>(null);
  // The transcript's height when the hold began, before Scroll to bottom took
  // its line: what the end is measured against once the row closes.
  const heldClientHeightRef = useRef(0);
  const showHeldControl = useCallback((el: HTMLElement) => {
    setReaderHeld(
      readerHoldRef.current &&
        el.scrollHeight - el.scrollTop - el.clientHeight > 1,
    );
  }, []);
  const releaseReaderHold = useCallback(() => {
    readerHoldRef.current = false;
    activatedRowRef.current = null;
    setReaderHeld(false);
  }, []);
  const readerActing = useCallback(() => {
    const input = readerInputRef.current;
    return input.touching || input.pressing || performance.now() < input.until;
  }, []);
  // Whether a scroll now is the reader moving the transcript: what the hold
  // listens to. A scroll from layout (content growing or shrinking, the
  // browser clamping scrollTop, a restore writing it) is not.
  const readerScrolling = useCallback(() => {
    const input = readerInputRef.current;
    return (
      input.touching ||
      input.draggingScrollbar ||
      performance.now() < input.scrollUntil
    );
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

  const recordReaderIdentityRef = useRef(activeSession.id);
  const recordPreservingRef = useRef(preserveReading);
  useLayoutEffect(() => {
    const changed = recordReaderIdentityRef.current !== activeSession.id;
    const revealing = preserveReading && !recordPreservingRef.current;
    recordReaderIdentityRef.current = activeSession.id;
    recordPreservingRef.current = preserveReading;
    if (!externalScrollContainerRef || (!changed && !revealing)) return;
    isUserScrolledUpRef.current = preserveReading;
    setIsUserScrolledUp(preserveReading);
    visibleAnchorRef.current = null;
    const element = messagesContainerRef.current;
    if (element && !preserveReading)
      writeProgrammaticScroll(element, element.scrollHeight);
  }, [
    activeSession.id,
    preserveReading,
    externalScrollContainerRef,
    messagesContainerRef,
    writeProgrammaticScroll,
  ]);

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
  }, [
    layoutHeight,
    noteProgrammaticScroll,
    writeProgrammaticScroll,
    messagesContainerRef,
  ]);

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
    () => ({
      submitForm,
      formScope,
      readOnly: Boolean(
        activeSession.replay ||
          target?.record ||
          (target?.station &&
            target.station.capabilities.uiBlockActions.state !== 'allowed'),
      ),
      canSendChildInstruction:
        !activeSession.replay &&
        !target?.record &&
        (!target?.station ||
          target.station.capabilities.childInstruction.state === 'allowed') &&
        conversationAccessFor(activeSession, target?.station)?.continue ===
          true,
    }),
    [submitForm, formScope, target, activeSession.replay, activeSession],
  );

  // The children the loaded transcript draws as their own card: anchored to
  // a loaded row, to the turn streaming now, or standalone.
  const cardedChildren = useMemo(() => {
    const loaded = activeSession.messages || EMPTY_MESSAGES;
    const represented = new Map<string, TranscriptChild>();
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
        represented.set(key, child);
    }
    return represented;
  }, [activeSession, suppressStreamingRow, transcriptChildren]);
  const messages = useMemo(() => {
    const loaded = activeSession.messages || EMPTY_MESSAGES;
    const represented = cardedChildren;
    const visible = loaded.filter((message) => {
      const key = message.childWorkKey
        ? visibleChildWorkNoticeKey(message.childWorkKey, apiBase)
        : undefined;
      return key !== null && (!key || !represented.has(key));
    });
    return visible.length === loaded.length ? loaded : visible;
  }, [activeSession, apiBase, cardedChildren]);
  // Running work the transcript already shows is not listed again under the
  // strip: a subagent card (with its own activity and elapsed time), or a
  // call in a tool batch, which reads "running" from the same live record.
  const shownTaskIds = useMemo(() => {
    const ids = new Set<string>();
    for (const child of cardedChildren.values()) {
      ids.add(child.item.childId);
      if (child.item.parent?.toolCallId) ids.add(child.item.parent.toolCallId);
    }
    for (const message of messages)
      for (const part of message.contentParts ?? [])
        if (part.toolCallId) ids.add(part.toolCallId);
    return ids;
  }, [cardedChildren, messages]);
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

  // The dock supplies the bounded event-window projection. This component
  // owns only that projection's one scroll surface, so it cannot create a
  // second event reader.
  // chat-24: model changes, fresh contexts and engine switches, derived from
  // what each turn recorded, so every reader of the chat derives the same rows.
  const changeFacts = useMemo(
    () => transcriptChangeFacts(messages),
    [messages],
  );
  const transcriptRows = useMemo(() => {
    const projected = projectTranscriptMessages(
      activeSession.id,
      messages,
      previousTranscriptRows.current,
    );
    previousTranscriptRows.current = projected;
    // A recorded switch that never ran is not a row at all.
    const shown = projected.some((row) => changeFacts.get(row.index)?.hidden)
      ? projected.filter((row) => !changeFacts.get(row.index)?.hidden)
      : projected;
    return projectTranscriptChildRows(
      shown,
      transcriptChildren,
      approvalEvents,
    );
  }, [
    activeSession.id,
    messages,
    changeFacts,
    transcriptChildren,
    approvalEvents,
  ]);
  // A turn still streaming outside the rows: its pill shows from the model
  // its start asked for, so the answer does not move down when it ends.
  const liveSessionId = activeSession.currentSessionId ?? activeSession.id;
  // Only what a started turn asked for: `model` can be a composer pick that
  // was never sent.
  const liveRequestedModel = activeSession.orchestrationModel;
  const liveModelChange = useMemo(
    () =>
      isStreaming
        ? modelChangeBetween(lastRecordedTurn(messages, changeFacts), {
            sessionId: liveSessionId,
            ...(liveRequestedModel ? { requested: liveRequestedModel } : {}),
            settled: false,
          })
        : undefined,
    [isStreaming, messages, changeFacts, liveSessionId, liveRequestedModel],
  );
  const transcriptRowsRef = useRef(transcriptRows);
  transcriptRowsRef.current = transcriptRows;
  // Where the reader is, for the window that feeds these rows.
  const readerAway = isUserScrolledUp || readerHeld;
  useEffect(() => {
    void scrollAnchorVersion;
    if (!onReaderPlaceChange) return;
    const element = messagesContainerRef.current;
    let turnId: string | undefined;
    if (readerAway && element) {
      const anchor = captureChatScrollAnchor(element);
      const rows = transcriptRowsRef.current;
      const first = anchor
        ? rows.findIndex((row) => row.id === anchor.key)
        : -1;
      for (let index = first; first >= 0 && index < rows.length; index += 1) {
        const row = rows[index]!;
        turnId = row.kind === 'subagent' ? undefined : row.message.turnId;
        if (turnId) break;
      }
    }
    onReaderPlaceChange({ away: readerAway, ...(turnId ? { turnId } : {}) });
  }, [
    readerAway,
    scrollAnchorVersion,
    onReaderPlaceChange,
    messagesContainerRef,
  ]);
  // Gone, the list reads nothing: the window must not stay kept for it. Only
  // on unmount, so a report that merely re-runs never reads as back at the end.
  const readerPlaceChangeRef = useRef(onReaderPlaceChange);
  readerPlaceChangeRef.current = onReaderPlaceChange;
  useEffect(() => () => readerPlaceChangeRef.current?.({ away: false }), []);
  // #342: the user turns, from the whole row model — a virtualized transcript
  // mounts only the rows near the reader. Kept by identity while no turn's
  // summary changes, so streaming text does not re-render the rail.
  const previousTurnLandmarks = useRef<readonly TranscriptTurnLandmark[]>([]);
  const turnLandmarks = useMemo(() => {
    const next = transcriptTurnLandmarks(transcriptRows);
    if (sameLandmarks(previousTurnLandmarks.current, next))
      return previousTurnLandmarks.current;
    previousTurnLandmarks.current = next;
    return next;
  }, [transcriptRows]);
  const turnLandmarksRef = useRef(turnLandmarks);
  turnLandmarksRef.current = turnLandmarks;
  const rowIndexById = useMemo(
    () => new Map(transcriptRows.map((row, index) => [row.id, index])),
    [transcriptRows],
  );
  // History replay keeps its own timeline; the live transcript gets the rail.
  const turnNavigation = !activeSession.replay && turnLandmarks.length > 0;
  const TurnRail =
    target?.requestScope && activeSession.conversationId && onLoadTurn
      ? IndexedTranscriptTurnRail
      : TranscriptTurnRail;
  const turnRailRef = useRef<HTMLElement>(null);
  const turnViewport = useTranscriptTurnViewport({
    enabled: turnNavigation,
    scrollElement: messagesContainerRef,
    railRef: turnRailRef,
    landmarks: turnLandmarks,
    rowIndexById,
    rowCount: transcriptRows.length,
  });

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
      scrollAnimationRef.current?.cancel();
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
      scrollAnimationRef.current?.cancel();
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
  }, [activeSession.id, messagesContainerRef]);

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
    messagesContainerRef,
  ]);

  // A command-palette transcript result carries the stable runtime message id
  // in the location hash. Re-run when messages arrive, rather than trusting a
  // timer after opening an older session; the asynchronous bounded window may
  // not have committed on that timer tick.
  useLayoutEffect(() => {
    // The DOM target can only exist after the projected message count changes.
    void messages.length;
    if (!requestedMessageRowId) return;
    scrollAnimationRef.current?.cancel();
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
  }, [messages, requestedMessageRowId, messagesContainerRef]);
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
    if (!el || isUserScrolledUpRef.current || readerHoldRef.current) return;
    writeProgrammaticScroll(el, el.scrollHeight);
    markTranscriptPhase('pin-layout');
    pinFrameRef.current = requestAnimationFrame(() => {
      pinFrameRef.current = undefined;
      if (
        messagesContainerRef.current &&
        !isUserScrolledUpRef.current &&
        !readerHoldRef.current
      ) {
        markTranscriptPhase('pin-raf');
        writeProgrammaticScroll(
          messagesContainerRef.current,
          messagesContainerRef.current.scrollHeight,
        );
      }
    });
  }, [writeProgrammaticScroll, messagesContainerRef]);
  // Only a message of the reader's that is new ends the hold. Its id is not
  // its identity: the composer's bubble (client id) gains its `turn.started`
  // event and is then replaced by the server's copy (`<that event>:user`),
  // so the newest message is the one seen before when any name matches.
  const seenUserNamesRef = useRef<Set<string> | null>(null);
  const firstMessageNamesRef = useRef<string[]>([]);
  // Whether a turn was live before this render's messages arrived.
  const turnWasLiveRef = useRef(turnLive);
  const turnLiveRef = useRef(turnLive);
  turnLiveRef.current = turnLive;
  // A hold belongs to the chat it started in. Declared before the pin below,
  // so a switched-to chat is pinned in the same pass. What the last chat's
  // messages were called is forgotten too: the new chat's first render is
  // nothing new, as on a fresh mount.
  useLayoutEffect(() => {
    void activeSession.id;
    releaseReaderHold();
    seenUserNamesRef.current = null;
    firstMessageNamesRef.current = [];
    turnWasLiveRef.current = turnLiveRef.current;
  }, [activeSession.id, releaseReaderHold]);
  // What needs the reader ends a hold and brings the end into view: their own
  // message (a send, a queued follow-up delivered) and a request opening. A
  // reader who scrolled away from the held row stays where they are, as with
  // no hold: Scroll to bottom still shows.
  const releaseHoldToLatest = useCallback(() => {
    if (!readerHoldRef.current) return false;
    releaseReaderHold();
    if (isUserScrolledUpRef.current) return false;
    isUserScrolledUpRef.current = false;
    setIsUserScrolledUp(false);
    return true;
  }, [releaseReaderHold]);
  // Before the pin below, which then follows the new message.
  useLayoutEffect(() => {
    const firstBefore = firstMessageNamesRef.current;
    firstMessageNamesRef.current = messages[0]
      ? userMessageNames(messages[0])
      : [];
    let index = messages.length - 1;
    while (index >= 0 && messages[index]!.role !== 'user') index -= 1;
    const names = index >= 0 ? userMessageNames(messages[index]!) : [];
    const seen = seenUserNamesRef.current;
    const remember = () => {
      const next = seenUserNamesRef.current ?? new Set<string>();
      for (const name of names) next.add(name);
      for (const name of next) {
        if (next.size <= SEEN_USER_NAMES_MAX) break;
        next.delete(name);
      }
      seenUserNamesRef.current = next;
    };
    if (!seen || names.some((name) => seen.has(name))) {
      remember();
      return;
    }
    if (names.length === 0) return;
    // A bubble sent while a turn runs is a follow-up Station queues: the
    // send path shows it (its id is its client id) until Station answers,
    // then withdraws it. It counts once it belongs to a turn: its own turn
    // starting, or Station delivering it. A steered message counts when the
    // server's copy arrives.
    const message = messages[index]!;
    if (!message.turnId && !message.sourceEventId && turnWasLiveRef.current)
      return;
    remember();
    // Earlier history loaded in front of the window is not new.
    const formerFirst = messages.findIndex((candidate) =>
      userMessageNames(candidate).some((name) => firstBefore.includes(name)),
    );
    if (formerFirst > index) return;
    releaseHoldToLatest();
  }, [messages, releaseHoldToLatest]);
  useLayoutEffect(() => {
    turnWasLiveRef.current = turnLive;
  }, [turnLive]);
  const openRequestKeys = useMemo(
    () =>
      unansweredApprovalRequests(
        [],
        (approvalEvents ?? [])
          .map((item) => item.event)
          .filter((event) => Boolean(event.eventId)),
      ).map((request) => `${request.approvalThreadId}:${request.approvalId}`),
    [approvalEvents],
  );
  const openRequestKeysRef = useRef(openRequestKeys);
  useLayoutEffect(() => {
    const before = new Set(openRequestKeysRef.current);
    openRequestKeysRef.current = openRequestKeys;
    if (
      openRequestKeys.some((key) => !before.has(key)) &&
      releaseHoldToLatest()
    )
      pinToLatest();
  }, [openRequestKeys, releaseHoldToLatest, pinToLatest]);
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
  }, [transcriptRows, noteProgrammaticScroll, messagesContainerRef]);

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
      // Hidden (`display: none` under a New chat draft): there is nothing to
      // read, and an anchor captured now would be garbage. Keep the one from
      // before, and re-anchor on the way back whatever the gate says, since
      // an engine may have reset the scroll position meanwhile.
      if (el.clientHeight === 0) {
        lastClientHeightRef.current = 0;
        return;
      }
      const returning = lastClientHeightRef.current === 0;
      lastClientHeightRef.current = el.clientHeight;
      const resized = reanchorGate.shouldReanchor(el.clientHeight);
      if (scrollAnimationRef.current) return;
      if (!returning && !resized) return;
      if (isUserScrolledUpRef.current || readerHoldRef.current) {
        if (
          visibleAnchorRef.current &&
          restoreChatScrollAnchor(el, visibleAnchorRef.current)
        ) {
          noteProgrammaticScroll(el);
        }
        // What the reader just opened stays visible: a shorter view (the
        // keyboard opening, the pending list appearing) brings the held
        // row's header back into it, moving it no further than that. A
        // reader who scrolled away from it is left where they are.
        const held =
          readerHoldRef.current && !isUserScrolledUpRef.current
            ? activatedRowRef.current?.row
            : undefined;
        if (held?.isConnected) {
          const top =
            held.getBoundingClientRect().top - el.getBoundingClientRect().top;
          const below = top + HELD_ROW_HEADER_PX - el.clientHeight;
          if (top < 0)
            writeProgrammaticScroll(
              el,
              el.scrollTop + top - HELD_ROW_MARGIN_PX,
            );
          else if (below > 0)
            writeProgrammaticScroll(
              el,
              el.scrollTop + below + HELD_ROW_MARGIN_PX,
            );
        }
      } else {
        writeProgrammaticScroll(el, el.scrollHeight);
      }
      visibleAnchorRef.current = captureChatScrollAnchor(el);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [noteProgrammaticScroll, writeProgrammaticScroll, messagesContainerRef]);

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
      measureGrowth(el);
      // Hidden: no anchor to take (see the size observer above).
      if (el.clientHeight === 0) return;
      // A running glide aims at the live end on every frame already.
      if (scrollAnimationRef.current) return;
      const held = readerHoldRef.current ? activatedRowRef.current : null;
      const toggle = held ? openHeldToggle(el, held) : null;
      if (held && toggle && toggle !== held.toggle)
        activatedRowRef.current = { ...held, toggle };
      if (held && !toggle) {
        releaseReaderHold();
        if (held.toggle.isConnected) {
          // What they were holding was closed in place. With the end in view
          // (ignoring the line Scroll to bottom took) the tail is followed
          // again; past it, they are a reader scrolled up like any other.
          const shortBy =
            el.scrollHeight -
            el.scrollTop -
            el.clientHeight -
            Math.max(0, heldClientHeightRef.current - el.clientHeight);
          if (shortBy > PINNED_TOLERANCE_PX) {
            isUserScrolledUpRef.current = true;
            setIsUserScrolledUp(true);
            visibleAnchorRef.current = captureChatScrollAnchor(el);
            return;
          }
        }
        // Otherwise it went away (a finished turn folds its tool rows, a row
        // is drawn again closed): nothing is left to protect. A reader still
        // at it follows the end below, as with no hold; one who scrolled
        // away stays where they are.
      }
      if (!isUserScrolledUpRef.current) {
        // Growth the reader caused (opening a tool card near the end) or that
        // lands while they are scrolling stays where it is, and so does what
        // it opened as it finishes rendering after the grace.
        const interacting =
          readerActing() ||
          performance.now() < readerInputRef.current.interactedUntil;
        const activated = activatedRowRef.current;
        if (
          !externalScrollContainerRef &&
          interacting &&
          activated?.row.isConnected &&
          activated.row.getBoundingClientRect().height !== activated.height &&
          !readerHoldRef.current
        ) {
          readerHoldRef.current = true;
          heldClientHeightRef.current = el.clientHeight;
        }
        if (
          !externalScrollContainerRef &&
          (readerHoldRef.current || interacting)
        ) {
          visibleAnchorRef.current = captureChatScrollAnchor(el);
          showHeldControl(el);
          return;
        }
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
      if (externalScrollContainerRef) {
        measureGrowth(el);
        // A record's sibling metadata can grow before ResizeObserver runs.
        // Classify a pending upward move before following that growth.
        if (
          !isUserScrolledUpRef.current &&
          !scrollAnimationRef.current &&
          el.scrollTop >= (lastKnownScrollTopRef.current ?? 0) - 1
        )
          writeProgrammaticScroll(el, el.scrollHeight);
      }
      for (const mutation of mutations) {
        for (const node of mutation.removedNodes)
          if (node instanceof Element) observer.unobserve(node);
        for (const node of mutation.addedNodes)
          if (node instanceof Element) observer.observe(node);
      }
    });
    children.observe(el, {
      childList: true,
      ...(externalScrollContainerRef
        ? {
            subtree: true,
            characterData: true,
            attributes: true,
            attributeFilter: ['style', 'class', 'hidden', 'open'],
          }
        : {}),
    });
    return () => {
      observer.disconnect();
      children.disconnect();
    };
  }, [
    noteProgrammaticScroll,
    readerActing,
    writeProgrammaticScroll,
    externalScrollContainerRef,
    measureGrowth,
    messagesContainerRef,
    showHeldControl,
    releaseReaderHold,
  ]);

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
  }, [olderCommitEpoch, endOlderRestoreSuppression, messagesContainerRef]);
  useEffect(() => endOlderRestoreSuppression, [endOlderRestoreSuppression]);

  const handleScroll = (e: { currentTarget: HTMLDivElement }) => {
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
    if (scrollAnimationRef.current) return;
    // A dock/keyboard resize can dispatch `scroll` before ResizeObserver gets
    // its turn. Preserve the reader's prior intent during that event: an
    // already-pinned transcript stays pinned, while an intentionally scrolled
    // transcript is restored by the observer from its captured anchor.
    if (resized) {
      if (!isUserScrolledUpRef.current && !readerHoldRef.current) {
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
      !tailIntentRef.current &&
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
    if (readerHoldRef.current) {
      // Only the reader ends or leaves a hold. A scroll from layout (content
      // growing or shrinking under the held row, the browser clamping
      // scrollTop) neither marks them scrolled up nor counts as their return.
      if (!readerScrolling()) {
        showHeldControl(target);
        return;
      }
      readerInputRef.current.scrollUntil = Math.max(
        readerInputRef.current.scrollUntil,
        performance.now() + READER_SCROLL_EXTEND_MS,
      );
    }
    // Back at the end: the tail is followed again.
    if (shortBy <= 1) releaseReaderHold();
    if (
      !isUserScrolledUpRef.current &&
      !readerHoldRef.current &&
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
    const height = measureGrowth(target);
    const anchored =
      height > scrollHeightRef.current &&
      previousTop !== null &&
      Math.abs(
        target.scrollTop - previousTop - (height - scrollHeightRef.current),
      ) <= 1;
    const reachedOldTail =
      externalScrollContainerRef &&
      previousTop !== null &&
      ((tailIntentRef.current && target.scrollTop >= previousTop) ||
        (target.scrollTop > previousTop &&
          !anchored &&
          shortBy <= growthDeltaRef.current + 2));
    tailIntentRef.current = false;
    scrollHeightRef.current = height;
    const isAtBottom =
      (shortBy <= (externalScrollContainerRef ? 2 : PINNED_TOLERANCE_PX) ||
        reachedOldTail) &&
      !readerMovingUp;
    if (reachedOldTail) writeProgrammaticScroll(target, height);
    isUserScrolledUpRef.current = !isAtBottom;
    setIsUserScrolledUp(!isAtBottom);
    visibleAnchorRef.current = isAtBottom
      ? null
      : captureChatScrollAnchor(target);
  };

  const externalScrollHandler = useRef(handleScroll);
  externalScrollHandler.current = handleScroll;
  useEffect(() => {
    const element = externalScrollContainerRef?.current;
    if (!element) return;
    const scroll = () =>
      externalScrollHandler.current({ currentTarget: element });
    element.addEventListener('scroll', scroll);
    return () => element.removeEventListener('scroll', scroll);
  }, [externalScrollContainerRef]);

  const cancelScrollToBottom = useCallback(() => {
    scrollAnimationRef.current?.cancel();
  }, []);
  const onReaderInput = useCallback(
    (event: {
      type: string;
      target: EventTarget | null;
      pointerType?: string;
      button?: number;
      key?: string;
      deltaY?: number;
      deltaMode?: number;
      ctrlKey?: boolean;
      shiftKey?: boolean;
      defaultPrevented?: boolean;
      preventDefault?: () => void;
    }) => {
      const input = readerInputRef.current;
      const element = messagesContainerRef.current;
      if (element && externalScrollContainerRef) {
        measureGrowth(element);
        growthDeltaRef.current = 0;
        const distance =
          element.scrollHeight - element.scrollTop - element.clientHeight;
        const keyStep =
          event.key === 'End'
            ? Infinity
            : event.key === 'ArrowDown'
              ? 40
              : event.key === 'PageDown' || event.key === ' '
                ? element.clientHeight * 0.875
                : 0;
        if (
          event.type === 'keydown' &&
          event.target === element &&
          !event.defaultPrevented &&
          keyStep > 0 &&
          distance <= keyStep
        ) {
          event.preventDefault?.();
          tailIntentRef.current = true;
          isUserScrolledUpRef.current = false;
          setIsUserScrolledUp(false);
          writeProgrammaticScroll(element, element.scrollHeight);
          return;
        }
        tailIntentRef.current =
          !event.defaultPrevented &&
          ((event.type === 'keydown' &&
            event.target === element &&
            event.key === 'End') ||
            (event.type === 'wheel' &&
              !event.ctrlKey &&
              !event.shiftKey &&
              event.deltaMode === 0 &&
              (event.deltaY ?? 0) > 0 &&
              element.scrollTop + (event.deltaY ?? 0) >=
                element.scrollHeight - element.clientHeight - 2));
      }
      const now = performance.now();
      if (
        event.type === 'touchstart' ||
        event.type === 'pointerdown' ||
        (event.type === 'keydown' &&
          (event.key === 'Enter' || event.key === ' '))
      ) {
        // The row whose disclosure this activates, if it activates one.
        const toggle =
          event.target instanceof Element
            ? event.target.closest('[aria-expanded], summary')
            : null;
        const row = toggle?.closest('.chat-message-anchor');
        // A press elsewhere while a row is held keeps the held row's record:
        // its closing still ends the hold.
        if (toggle && row)
          activatedRowRef.current = {
            row,
            height: row.getBoundingClientRect().height,
            toggle,
          };
        else if (!readerHoldRef.current) activatedRowRef.current = null;
      }
      if (event.type === 'touchstart') {
        input.touching = true;
        input.interactedUntil = now + READER_INTERACTION_GRACE_MS;
        // A touch's events stay with the node it began on. A virtualized row
        // can leave the document mid-drag, and its touchend then never
        // reaches the window: listen on the node itself as well.
        const origin = event.target;
        const listening = new AbortController();
        const release = (end: Event) => {
          listening.abort();
          releaseTouchRef.current(end);
        };
        origin?.addEventListener('touchend', release, {
          signal: listening.signal,
        });
        origin?.addEventListener('touchcancel', release, {
          signal: listening.signal,
        });
      } else if (event.type === 'pointerdown') {
        // A touch is tracked by its touch events: the browser cancels the
        // pointer as soon as the finger starts panning.
        const pointer = event;
        // A secondary press opens a context menu that often swallows the
        // release.
        if (pointer.pointerType !== 'touch' && pointer.button === 0) {
          input.pressing = true;
          // A press on the scroller itself, not on a row inside it, is on
          // its scrollbar: the drag that follows is the reader moving.
          if (element && event.target === element)
            input.draggingScrollbar = true;
        }
        input.interactedUntil = now + READER_INTERACTION_GRACE_MS;
      } else {
        input.until = now + READER_INPUT_GRACE_MS;
        // Space on a disclosure inside the transcript opens it; on the
        // scroller itself it pages.
        if (
          event.type === 'wheel' ||
          (event.type === 'keydown' &&
            SCROLL_KEYS.has(event.key ?? '') &&
            (event.key !== ' ' || event.target === element))
        )
          input.scrollUntil = now + READER_INPUT_GRACE_MS;
        if (event.type === 'keydown')
          input.interactedUntil = now + READER_INTERACTION_GRACE_MS;
      }
      endOlderRestoreSuppression();
      cancelScrollToBottom();
    },
    [
      endOlderRestoreSuppression,
      cancelScrollToBottom,
      externalScrollContainerRef,
      messagesContainerRef,
      measureGrowth,
      writeProgrammaticScroll,
    ],
  );
  const externalInputHandler = useRef(onReaderInput);
  externalInputHandler.current = onReaderInput;
  useEffect(() => {
    const element = externalScrollContainerRef?.current;
    if (!element) return;
    const input = (event: Event) => externalInputHandler.current(event);
    const types = ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const;
    for (const type of types)
      element.addEventListener(type, input, { passive: true });
    return () => {
      for (const type of types) element.removeEventListener(type, input);
    };
  }, [externalScrollContainerRef]);
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
      input.scrollUntil = Math.max(
        input.scrollUntil,
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
      if (input.draggingScrollbar)
        input.scrollUntil = Math.max(
          input.scrollUntil,
          performance.now() + READER_INPUT_GRACE_MS,
        );
      input.draggingScrollbar = false;
    };
    // Leaving the page or opening a context menu can swallow a release.
    const releaseAll = () => {
      const input = readerInputRef.current;
      input.touching = false;
      input.pressing = false;
      input.draggingScrollbar = false;
    };
    releaseTouchRef.current = releaseTouch;
    const listeners: Array<[string, (event: Event) => void]> = [
      ['touchend', releaseTouch],
      ['touchcancel', releaseTouch],
      ['pointerup', releasePress],
      ['pointercancel', releasePress],
      ['contextmenu', releaseAll],
      // The window losing focus, not an element inside it: a press on the
      // transcript focuses it, and the blur that follows inside the page
      // reaches this capturing listener too.
      ['blur', (event) => !(event.target instanceof Node) && releaseAll()],
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

  // A followed message link holds the transcript on its message until the
  // reader goes elsewhere. An explicit ask for the latest — like a turn
  // jump — is elsewhere: strip the hash so the link stops holding after it.
  const clearMessageRevealHash = useCallback(() => {
    if (!STATION_MESSAGE_HASH.test(window.location.hash)) return;
    window.history.replaceState(
      window.history.state,
      '',
      `${window.location.pathname}${window.location.search}`,
    );
    setTranscriptRevealHash('');
  }, []);
  // Glide to the newest message, then hand back to tail-follow. The reader
  // stays "scrolled up" for the glide so the pin and the virtualizer's
  // follow cannot snap it; reader input cancels and leaves them in control.
  const handleScrollToBottom = () => {
    cancelTurnNavigation();
    const el = messagesContainerRef.current;
    if (!el) return;
    // Before the glide, not after it: a message settling mid-glide must not
    // re-arm the link's hold against the very trip to the end the reader
    // just asked for.
    clearMessageRevealHash();
    // The latest-message control leaves during the glide; keep its focus
    // in the conversation.
    if (document.activeElement?.closest('.chat-scroll-to-bottom'))
      el.focus({ preventScroll: true });
    setReaderRestoreRequest(null);
    visibleAnchorRef.current = null;
    setScrollAnchorVersion((version) => version + 1);
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
      // The glide's own frames skip the scroll handler's release.
      releaseReaderHold();
    };
    const animation = animateScrollToBottom(el, {
      write: (top) => writeProgrammaticScroll(el, top),
      onFinish: finish,
    });
    // An instant jump (reduced motion) has already finished.
    if (scrollAnimationTokenRef.current === token)
      scrollAnimationRef.current = animation;
  };
  // #342: a turn jump reveals the turn's prompt row through the same path a
  // message link uses. One reveal per jump: the virtualizer has scrolled by
  // the time effects run, and clearing lets the same turn be asked for again.
  const [turnRevealRowId, setTurnRevealRowId] = useState<string>();
  useEffect(() => {
    if (turnRevealRowId !== undefined) setTurnRevealRowId(undefined);
  }, [turnRevealRowId]);
  const turnRevealFrameRef = useRef<number | undefined>(undefined);
  useEffect(
    () => () => {
      if (turnRevealFrameRef.current !== undefined)
        cancelAnimationFrame(turnRevealFrameRef.current);
    },
    [],
  );
  const jumpToTurn = useCallback(
    (turnIndex: number) => {
      cancelTurnNavigation();
      const landmark = turnLandmarksRef.current[turnIndex];
      const element = messagesContainerRef.current;
      if (!landmark || !element) return;
      scrollAnimationRef.current?.cancel();
      // The reader chose an earlier turn: hold the transcript there. Text
      // still streaming must not pull it back to the end (tail-follow and the
      // pin both read this) until the reader returns to the latest.
      isUserScrolledUpRef.current = true;
      setIsUserScrolledUp(true);
      setReaderRestoreRequest(null);
      setApprovalRevealRowId(undefined);
      clearMessageRevealHash();
      if (transcriptRowsRef.current.length > VIRTUALIZE_AFTER_MESSAGE_COUNT) {
        setTurnRevealRowId(landmark.rowId);
        markTranscriptPhase('turn-jump', { key: traceKey(landmark.rowId) });
        // Once the reveal has settled, the revealed row is the reader's: a
        // later measurement above it keeps it in place (`anchorVersion`).
        if (turnRevealFrameRef.current !== undefined)
          cancelAnimationFrame(turnRevealFrameRef.current);
        let frames = 0;
        let stableFrames = 0;
        let lastTop: number | undefined;
        const settle = () => {
          turnRevealFrameRef.current = undefined;
          const current = messagesContainerRef.current;
          if (!current) return;
          frames += 1;
          stableFrames = current.scrollTop === lastTop ? stableFrames + 1 : 0;
          lastTop = current.scrollTop;
          if (
            stableFrames >= TURN_REVEAL_STABLE_FRAMES ||
            frames >= TURN_REVEAL_MAX_FRAMES
          ) {
            setScrollAnchorVersion((version) => version + 1);
            return;
          }
          turnRevealFrameRef.current = requestAnimationFrame(settle);
        };
        turnRevealFrameRef.current = requestAnimationFrame(settle);
        return;
      }
      // Every row of a short transcript is mounted: centre the prompt row.
      const node = [
        ...element.querySelectorAll<HTMLElement>(
          ':scope > .chat-message-anchor[data-chat-message-key], :scope > .chat-messages > .chat-message-anchor[data-chat-message-key], :scope > .conversation-reader > .chat-messages > .chat-message-anchor[data-chat-message-key]',
        ),
      ].find(
        (candidate) => candidate.dataset.chatMessageKey === landmark.rowId,
      );
      if (!node) return;
      const bounds = element.getBoundingClientRect();
      const rect = node.getBoundingClientRect();
      writeProgrammaticScroll(
        element,
        Math.max(
          0,
          element.scrollTop +
            rect.top -
            bounds.top -
            Math.max(0, (element.clientHeight - rect.height) / 2),
        ),
      );
      visibleAnchorRef.current = captureChatScrollAnchor(element);
    },
    [
      writeProgrammaticScroll,
      clearMessageRevealHash,
      messagesContainerRef,
      cancelTurnNavigation,
    ],
  );
  useEffect(() => {
    if (!pendingTurnJump) return;
    const index = turnLandmarks.findIndex(
      (turn) => turn.turnId === pendingTurnJump,
    );
    if (index >= 0) {
      jumpToTurn(index);
      setPendingTurnJump(null);
    }
  }, [pendingTurnJump, turnLandmarks, jumpToTurn]);
  const previousTurn = turnStepTarget(turnViewport, -1, turnLandmarks.length);
  const nextTurn = turnStepTarget(turnViewport, 1, turnLandmarks.length);
  // A step keeps focus on itself, so where it landed is said aloud: the
  // rail's ticks are named by focus, the steps have only this.
  // Clear-then-set: the region empties, then takes the new text a frame
  // later, so stepping to the same turn twice is announced twice.
  const [turnAnnouncement, setTurnAnnouncement] = useState('');
  const announceFrameRef = useRef<number | undefined>(undefined);
  const announcementOwner = useRef<
    { chatId: string; indexed: boolean } | undefined
  >(undefined);
  const announceTurnStep = useCallback(
    (text: string, indexed = false) => {
      announcementOwner.current = { chatId: activeSession.id, indexed };
      if (announceFrameRef.current !== undefined)
        cancelAnimationFrame(announceFrameRef.current);
      setTurnAnnouncement('');
      announceFrameRef.current = requestAnimationFrame(() => {
        announceFrameRef.current = undefined;
        setTurnAnnouncement(text);
      });
    },
    [activeSession.id],
  );
  const announceIndexedTurnStep = useCallback(
    (text: string) => announceTurnStep(text, true),
    [announceTurnStep],
  );
  const stepToTurn = useCallback(
    (turnIndex: number) => {
      const landmarks = turnLandmarksRef.current;
      const landmark = landmarks[turnIndex];
      if (!landmark) return;
      jumpToTurn(turnIndex);
      announceTurnStep(
        turnLabel(
          landmark,
          turnIndex,
          landmarks.length,
          Boolean(hasOlderMessages),
        ),
      );
    },
    [jumpToTurn, hasOlderMessages, announceTurnStep],
  );
  // Loaded-window positions become stale as rows arrive. An indexed position
  // survives that load; its destination must still be announced after reveal.
  const loadedTurnCount = turnLandmarks.length;
  useEffect(() => {
    void activeSession.id;
    void hasOlderMessages;
    void loadedTurnCount;
    if (
      announcementOwner.current?.chatId === activeSession.id &&
      announcementOwner.current.indexed
    )
      return;
    announcementOwner.current = undefined;
    if (announceFrameRef.current !== undefined)
      cancelAnimationFrame(announceFrameRef.current);
    announceFrameRef.current = undefined;
    setTurnAnnouncement('');
  }, [activeSession.id, hasOlderMessages, loadedTurnCount]);
  useEffect(
    () => () => {
      if (announceFrameRef.current !== undefined)
        cancelAnimationFrame(announceFrameRef.current);
    },
    [],
  );

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
  const callerContinue = conversationAccessFor(
    activeSession,
    target?.station,
  )?.continue;
  const callerStartChat = conversationAccessFor(
    activeSession,
    target?.station,
  )?.startChat;
  const bubbleSession: MessageBubbleSession = useMemo(
    () => ({
      id: activeSession.id,
      agentSlug: activeSession.agentSlug,
      agentName: activeSession.agentName,
      projectSlug: activeSession.projectSlug,
      conversationId: activeSession.conversationId,
      // Rebuilt from its two values (see the deps): each open read returns a
      // new object, and identity would re-render every bubble on every read.
      callerAccess:
        callerContinue === undefined || callerStartChat === undefined
          ? undefined
          : { continue: callerContinue, startChat: callerStartChat },
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
      callerContinue,
      callerStartChat,
      activeSession.isThinking,
      waitingApprovalCount,
      statusShownElsewhere,
      messages.length,
    ],
  );

  type RowPresentation = {
    turn: React.ContextType<typeof TranscriptTurnContext>;
    fork: ForkTurnSource | null | undefined;
    resend: MessageResendSource | null;
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
              threadId:
                message.sessionId ??
                activeSession.currentSessionId ??
                activeSession.id,
              turnId: message.turnId,
              messageId: message.id,
              browserOwner: `row:${row.index}`,
              firstRow: !seenTurns.has(key),
            }
          : undefined;
      if (turn) seenTurns.add(key);
      const fork =
        message.role === 'user'
          ? precedingForkSource(messages, row.index)
          : undefined;
      // Computed only where a handler can use it: the walk is per row.
      const resend = !onResendFromMessage
        ? null
        : message.role === 'user'
          ? messageResendSource(messages, row.index)
          : message.role === 'assistant'
            ? regenerateSource(messages, row.index)
            : null;
      const previous = previousPresentation.current.get(row.id);
      next.set(row.id, {
        turn: isShallowEqual(previous?.turn, turn) ? previous?.turn : turn,
        fork:
          previous && isShallowEqual(previous.fork, fork)
            ? previous.fork
            : fork,
        resend:
          previous && sameMessageResendSource(previous.resend, resend)
            ? previous.resend
            : resend,
      });
    }
    previousPresentation.current = next;
    return next;
  }, [
    transcriptRows,
    messages,
    onResendFromMessage,
    activeSession.currentSessionId,
    activeSession.id,
  ]);

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
      resendSource={rowPresentation.get(rowId)?.resend}
      onResendFromMessage={onResendFromMessage}
      onToolApproval={
        activeSession.replay || target?.record?.readOnly || approvalsHeld
          ? undefined
          : handleToolApproval
      }
      anchorKey={messageAnchorKey(msg)}
      owner={owner}
      accountableHuman={accountableHuman}
      previousEngine={changeFacts.get(idx)?.previousEngine}
      startedFrom={changeFacts.get(idx)?.startedFrom}
      afterMarker={changeFacts.get(idx)?.afterMarker === true}
    />
  );

  const renderMessage = (msg: ChatMessage, idx: number, rowId: string) => {
    if (renderOverride) {
      const override = renderOverride(msg, idx);
      if (override !== null) return override;
    }
    const after = renderAfterMessage?.(msg, idx) ?? null;
    const message = renderDefaultMessage(msg, idx, rowId);
    return after === null ? (
      message
    ) : (
      <>
        {message}
        {after}
      </>
    );
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
    const modelChange = changeFacts.get(row.index)?.modelChange;
    const article = (
      <article
        className="chat-message-anchor"
        data-chat-message-key={row.id}
        data-chat-turn-id={row.message.turnId}
        data-chat-role={row.message.role}
        data-history-entry={row.message.historyEntry}
        data-role={row.message.role}
        data-transcript-message-id={messageId}
        data-testid={
          target?.record && !transcriptMarkerLabel(row.message.contentParts)
            ? 'session-transcript-message'
            : undefined
        }
        data-agent-sender-session={row.message.sender?.sessionId}
        aria-label={
          row.message.sender
            ? incomingMessageLabel(row.message.sender)
            : undefined
        }
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
      </article>
    );
    // The model change is its own item before the answer it explains, read
    // once and never as part of that answer.
    return modelChange ? (
      <>
        <ModelChangeMarker change={modelChange} />
        {article}
      </>
    ) : (
      article
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
        autoExpand={!isMobile}
      />
    ),
    [fontSize, isMobile, showReasoning],
  );

  const renderToolCall = useCallback(
    (part: ChatContentPart, i: number) => (
      <ToolCallDisplay
        key={i}
        toolCall={part}
        sessionId={
          activeSession.replay
            ? undefined
            : (activeSession.currentSessionId ?? activeSession.id)
        }
        showDetails={showToolDetails}
        onApprove={
          !activeSession.replay &&
          !approvalsHeld &&
          part.needsApproval &&
          part.approvalId
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
      activeSession.currentSessionId,
      activeSession.agentSlug,
      activeSession.replay,
      approvalsHeld,
    ],
  );

  // One object per open turn rather than per render: a new value re-renders
  // every consumer under the memoised streaming row.
  const streamingTurnContext = useMemo(
    () => ({
      threadId: activeSession.currentSessionId ?? activeSession.id,
      turnId:
        activeSession.conversationActivity?.openTurn?.turnId ??
        activeSession.openTurnId,
      wholeTurn: true,
      browserOwner: 'stream',
    }),
    [
      activeSession.currentSessionId,
      activeSession.id,
      activeSession.conversationActivity?.openTurn?.turnId,
      activeSession.openTurnId,
    ],
  );

  const scrollToBottomControl =
    (isUserScrolledUp || readerHeld) && !scrollingToBottom ? (
      <ScrollToBottomButton onClick={handleScrollToBottom} />
    ) : null;
  const scrollControls = scrollToBottomControl;

  // A request Station reports settled that this view still lists: drop it
  // from the pending set and refetch history, which brings in the
  // resolution this view missed and any request opened since.
  // Several stale requests found together (the sheet checks every listed
  // request when it opens) share one refetch, not one each.
  const catchUpSettledRequest = (request: { approvalId?: string }) => {
    const chatId = activeSession.id;
    rememberSettledRequest(request.approvalId);
    const current = activeChatsStore.getSnapshot()[chatId];
    if (!current) return;
    activeChatsStore.updateChat(chatId, {
      pendingApprovals: current.pendingApprovals?.filter(
        (id) => id !== request.approvalId,
      ),
    });
    scheduleSettledCatchUp(chatId);
  };

  return (
    <ApprovalsHeldContext.Provider value={approvalsHeld}>
      <ApprovalSheetProvider
        apiBase={apiBase}
        requests={sheetRequests}
        catchingUp={sheetCatchingUp}
        onCheck={async (request) => {
          if (
            !request.approvalThreadId ||
            !request.approvalId ||
            !request.approvalEventId
          )
            throw new Error(
              'This request has no current inspection reference.',
            );
          const { inspectApprovalAnswer } = await import(
            '../../hooks/orchestration/answerRequest'
          );
          const outcome = await inspectApprovalAnswer(apiBase, {
            threadId: request.approvalThreadId,
            requestId: request.approvalId,
            requestEventId: request.approvalEventId,
            requestScope: target?.requestScope,
          });
          const current = activeChatsStore.getSnapshot()[activeSession.id];
          if (outcome === 'pending' && current) {
            activeChatsStore.updateChat(activeSession.id, {
              answeredApprovals: current.answeredApprovals?.filter(
                (id) => id !== request.approvalId,
              ),
            });
          }
          if (outcome === 'already-settled') catchUpSettledRequest(request);
          return outcome;
        }}
        onSettledElsewhere={catchUpSettledRequest}
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
          <TranscriptToolRecordSource.Provider value={apiBase}>
            <BrowserTurnActivityProvider
              transcriptChildren={transcriptChildren}
              messages={messages}
              chatId={activeSession.id}
              threadId={activeSession.currentSessionId ?? activeSession.id}
              liveTurnId={
                activeSession.conversationActivity?.openTurn?.turnId ??
                activeSession.openTurnId
              }
              live={turnLive}
              includeStream={isStreaming}
            >
              {onQuote && !activeSession.replay && (
                <QuoteSelectionToolbar
                  container={messagesContainerRef}
                  messages={messages}
                  onQuote={onQuote}
                />
              )}
              {/* Summaries are this Station's own derived records; a chat another
              Station owns has none here, and its tunnel offers no summary read. */}
              {!target?.record && chatBelongsToStation(activeSession) && (
                <SessionSummaryCard
                  activeSession={activeSession}
                  hasSettingsEntryPoint={hasSettingsEntryPoint}
                />
              )}
              <div
                className="chat-messages"
                data-surface="transcript"
                data-touch-turn-controls={
                  (turnNavigation && touchTurnControls) || undefined
                }
                data-answer-width={chatAnswerWidth}
                ref={
                  externalScrollContainerRef ? undefined : messagesContainerRef
                }
                role="log"
                tabIndex={-1}
                aria-label="Conversation transcript"
                data-chat-session-id={activeSession.id}
                aria-live="polite"
                style={{ fontSize: `${fontSize}px` }}
                onScroll={externalScrollContainerRef ? undefined : handleScroll}
                onWheel={externalScrollContainerRef ? undefined : onReaderInput}
                onTouchStart={
                  externalScrollContainerRef ? undefined : onReaderInput
                }
                onPointerDown={
                  externalScrollContainerRef ? undefined : onReaderInput
                }
                onKeyDown={
                  externalScrollContainerRef ? undefined : onReaderInput
                }
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
                  emptyState !== undefined ? (
                    emptyState
                  ) : (
                    <ChatEmptyState
                      agentSlug={activeSession.agentSlug}
                      agentName={activeSession.agentName}
                    />
                  )
                ) : (
                  <>
                    {transcriptRows.length > 0 &&
                      (transcriptRows.length >
                      VIRTUALIZE_AFTER_MESSAGE_COUNT ? (
                        <TranscriptVirtualizer
                          rows={transcriptRows}
                          scrollElement={messagesContainerRef}
                          onProgrammaticScroll={noteProgrammaticScroll}
                          renderRow={renderTranscriptRow}
                          followTail={
                            !isUserScrolledUp &&
                            !readerHeld &&
                            !requestedMessageRowId
                          }
                          followTick={`${tailContentLength}:${tailPartsLength}`}
                          anchorVersion={scrollAnchorVersion}
                          preserveAnchor={!scrollingToBottom}
                          revealRowId={
                            requestedMessageRowId ??
                            approvalRevealRowId ??
                            turnRevealRowId ??
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
                    {liveModelChange ? (
                      <ModelChangeMarker change={liveModelChange} />
                    ) : null}
                    {isStreaming && (
                      <div
                        className="chat-message-anchor"
                        data-chat-message-key={`${activeSession.id}:streaming`}
                      >
                        <TranscriptTurnContext.Provider
                          value={streamingTurnContext}
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
                              waitingApprovalCount > 0
                                ? requestAttentionKind(activeSession) ===
                                  'answer'
                                  ? attentionWord('answer')
                                  : 'Waiting for approval'
                                : activeSession.orchestrationStatus ===
                                      'awaiting-approval' &&
                                    chatWaitsOnUser(activeSession)
                                  ? attentionWord('waiting')
                                  : undefined
                            }
                            attributionAgent={streamingAttributionAgent}
                            owner={owner}
                            onContentChange={pinToLatest}
                          />
                        </TranscriptTurnContext.Provider>
                      </div>
                    )}
                    <LiveBrowserTurnActivities />
                    {/* Backgrounded provider tasks outlive the assistant turn: the
                session is honestly idle, but work continues. Keep a live
                affordance so the chat never looks done while it isn't. */}
                    {!turnLive && (
                      <ChatBackgroundStrip
                        chatThreadId={activeSession.id}
                        source={apiBase}
                        shownTaskIds={shownTaskIds}
                        localTasks={localBackgroundTasks}
                        serverCount={serverBackgroundCount}
                        liveStatusUnavailable={liveStatusUnavailable}
                        onOpen={onOpenBackgroundTasks}
                      />
                    )}
                  </>
                )}
                {transcriptRows.length > 0 && !isStreaming
                  ? transcriptFooter
                  : null}
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
                {/* Room at the end for the composer's floating status row
                (chat.css shows it). A row of its own, not a pseudo-element,
                so the tail-follow sees it come and go. */}
                <div
                  className="chat-messages__status-room"
                  aria-hidden="true"
                />
              </div>
              {turnBrowserOpen && (
                <LazyBoundary
                  load={loadTurnBrowser}
                  pending={null}
                  componentProps={{
                    conversationId: activeSession.conversationId,
                    landmarks: turnLandmarks,
                    onJumpLoaded: jumpToTurn,
                    onLoadTurn: onLoadTurn ? loadTurnAndReveal : undefined,
                    onClose: () => setTurnBrowserOpen(false),
                  }}
                />
              )}
              {turnNavigation && (
                <TurnRail
                  // A chat switch starts the rail over: a hover or a dismissed
                  // preview names a turn index in the chat it was made in.
                  key={activeSession.id}
                  landmarks={turnLandmarks}
                  rowCount={transcriptRows.length}
                  scrollElement={messagesContainerRef}
                  railRef={turnRailRef}
                  activeTurn={turnViewport.activeTurn}
                  onJump={jumpToTurn}
                  olderHistory={Boolean(hasOlderMessages)}
                  onBrowse={openTurnBrowser}
                  previousTurn={previousTurn}
                  nextTurn={nextTurn}
                  onStep={stepToTurn}
                  touchControls={touchTurnControls}
                  touchStepsShown={isUserScrolledUp}
                  conversationId={activeSession.conversationId!}
                  activeStartVisible={turnViewport.activeStartVisible}
                  onAnnounceStep={announceIndexedTurnStep}
                  onLoadTurn={loadTurnAndReveal}
                />
              )}
              {/* Mounted with the navigation, before anything is said: a region
          created together with its text is often not read. */}
              {turnNavigation && (
                <span
                  className="sr-only"
                  role="status"
                  data-testid="transcript-turn-announcement"
                >
                  {turnAnnouncement}
                </span>
              )}
              {scrollControls &&
                (scrollControlsTarget
                  ? createPortal(scrollControls, scrollControlsTarget)
                  : scrollControls)}
            </BrowserTurnActivityProvider>
          </TranscriptToolRecordSource.Provider>
        </UIBlockActionsContext.Provider>
      </ApprovalSheetProvider>
    </ApprovalsHeldContext.Provider>
  );
}

function LiveChatMessageList(props: ChatMessageListProps) {
  const host = useApiBase();
  const target = useOptionalConversationConnection();
  const sendMessage = useSendMessage(target?.apiBase ?? host.apiBase);
  const agents = useAgents();
  return (
    <ChatMessageListComponent
      {...props}
      sendMessage={sendMessage}
      apiBase={target?.apiBase ?? host.apiBase}
      agents={
        target?.station ? (props.recordAgents ?? EMPTY_RECORD_AGENTS) : agents
      }
    />
  );
}
const EMPTY_RECORD_AGENTS: ReturnType<typeof useAgents> = [];
const recordSendUnavailable: ReturnType<typeof useSendMessage> = async () =>
  false;
export const ChatMessageList = React.memo(function ChatMessageList(
  props: ChatMessageListProps,
) {
  const target = useOptionalConversationConnection();
  return target?.record ? (
    <ChatMessageListComponent
      {...props}
      sendMessage={recordSendUnavailable}
      apiBase={target.apiBase}
      agents={props.recordAgents ?? EMPTY_RECORD_AGENTS}
    />
  ) : (
    <LiveChatMessageList {...props} />
  );
});

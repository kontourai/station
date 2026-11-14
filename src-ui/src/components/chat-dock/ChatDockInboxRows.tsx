import {
  INBOX_SECTION_IDS,
  type InboxSectionId,
} from '@kontourai/station-contracts/device-settings';
import type { GitReadLocation } from '@kontourai/station-sdk';
import {
  Fragment,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { activeChatsStore } from '../../contexts/active-chats-store';
import { chatDraftsStore } from '../../contexts/chat-drafts-store';
import { useConversationOnScreen } from '../../contexts/conversation-on-screen-store';
import { useSessionWorkClaims } from '../../contexts/WorkClaimsContext';
import { useContextMenuGesture } from '../../hooks/useContextMenuGesture';
import { useDocumentFocused } from '../../hooks/useDocumentFocused';
import { useInboxSwipe } from '../../hooks/useInboxSwipe';
import { agentMark, workIdentityMarks } from '../../utils/identity-marks';
import { relativeTime } from '../../utils/relativeTime';
import type { SessionIconAgent } from '../../utils/sessionDisplay';
import {
  isCurrentInboxItem,
  rowReadStateUnknown,
  rowReadsUnread,
} from '../../views/home/conversation-read-state';
import {
  draftDiscardThreadId,
  draftSessionIds,
} from '../../views/home/draft-lane';
import { workAttentionCount } from '../../views/home/home-lane-model';
import type { HomeWorkItem } from '../../views/home/home-view-model';
import { useObservedWorkStatus } from '../../views/home/useObservedWorkStatus';
import type { WorkFacts, WorkFactsById } from '../../views/home/work-facts';
import { workStatusText } from '../../views/home/work-status';
import { ActionOverflowMenu } from '../ActionOverflowMenu';
import { Button } from '../Button';
import { DisclosureToggle } from '../DisclosureToggle';
import { DiscardDraftButton } from '../drafts/DiscardDraftButton';
import {
  CheckGlyph,
  CloseGlyph,
  DiscardGlyph,
  EditGlyph,
  FolderGlyph,
  MoreGlyph,
  RefreshGlyph,
  ReturnGlyph,
  TimeGlyph,
} from '../icons/Glyph';
import { displayableProjectIcon, ProjectIcon } from '../icons/ProjectIcon';
import { IdentityMarks } from '../inbox-row/IdentityMarks';
import {
  InboxRowChips,
  InboxRowStatusGlyph,
  InboxRowStatusLine,
} from '../inbox-row/InboxRowStatus';
import {
  type InboxRowAction,
  type InboxRowCommand,
  type InboxRowSnoozeAction,
  inboxRowActions,
} from '../inbox-row/inbox-row-actions';
import { inboxRowChips } from '../inbox-row/inbox-row-chips';
import { rowProjectMarks } from '../inbox-row/row-project-marks';
import { WorkGroupLabel } from '../inbox-row/WorkGroupLabel';
import { WorkItemFamily } from '../inbox-row/WorkItemFamily';
import { LazyBoundary } from '../LazyBoundary';
import {
  ResponsiveDialogHeader,
  ResponsiveDialogSurface,
} from '../ResponsiveDialogSurface';
import { ErrorState } from '../state';
import type { MobileActivityGroup } from './mobile-activity-groups';
import { useConversationWorkState } from './useConversationWorkState';
import './ChatDockInboxPanel.css';
import {
  endConversationReferenceDrag,
  startConversationReferenceDrag,
  useReferenceableConversations,
} from '../chat/conversationReferenceDrag';
import '../inbox-row/InboxRow.css';
// The danger row treatment the sheet's Discard shares with every overflow.
import '../ActionOverflowMenu.css';

const SETTLED_PAGE_SIZE = 20;

/**
 * kontourai/station#3312 — the one inbox, two chromes split.
 *
 * Row and group anatomy is defined here once and consumed by every inbox
 * surface: the desktop dock panel (`ChatDockInboxPanel`), the mobile
 * embedded Inbox (`MobileInboxPanel`), Home's work lanes (`HomeWorkRow`)
 * and the project sidebar's open chats. Scroll, header and responsive layout
 * stay host-owned; work grouping and status remain shared.
 *
 * THE ROW (#3043) has a fixed line budget: a meta line (agent mark, agent
 * and project, time), the title, ONE status line chosen by the status ladder
 * (`workStatus`), and a chip line that exists only when a chip does. The
 * budget yields in one place: a failure or unanswerable REASON may wrap to
 * a second line, because the user needs to read it. Time and the hover/focus
 * actions share one slot at the end of the meta line; the actions are
 * positioned over it rather than laid out beside it, so a row's height and
 * its text never move on hover. Settled and snoozed rows use the one-line
 * `slim` size.
 *
 * Everything the budget leaves off the row (model, kind, folder, last
 * progress, the whole reason) is on the metadata card: a tooltip on hover or
 * keyboard focus, and a Details sheet on a touch chrome.
 *
 * The row's metadata hover card (`ChatInboxHoverCard`) is part of the shared
 * anatomy: hover/focus opens it on a hover chrome, touch pointers never do.
 *
 * `chrome="touch"` (the sheet, and Home, which is used on phones) lays the
 * actions out as an always-visible ≥44px column instead: there is no hover
 * to reveal them with.
 */

/** Moves focus off a row that is about to be removed (#1054). */
export function moveFocusBeforeRemovingInboxRow(
  root: HTMLElement | null,
  action: HTMLButtonElement,
) {
  const row = action.closest<HTMLElement>('.chat-dock-inbox__row');
  if (!root || !row) return;
  const rows = Array.from(
    root.querySelectorAll<HTMLElement>('.chat-dock-inbox__row'),
  );
  const index = rows.indexOf(row);
  const adjacent = rows[index + 1] ?? rows[index - 1];
  const adjacentItem = adjacent?.querySelector<HTMLButtonElement>(
    '.chat-dock-inbox__item',
  );
  if (adjacentItem) {
    adjacentItem.focus();
    return;
  }
  root.focus();
}

/**
 * The agent an inbox row is attributed to, as a mark — or `null`, which
 * draws no agent mark at all. The row's own committed `agentSlug` looked up
 * in the live catalog, never its display `agentLabel`, and never an engine
 * standing in for an unresolved agent (the row names an agent in text).
 *
 * Kept as the inbox's name for `agentMark` (`utils/identity-marks.ts`), the
 * one resolver every row surface shares. A row draws the engines that ran it
 * first (`workIdentityMarks`) and falls back to this.
 */
export function inboxRowIconAgent(
  item: HomeWorkItem,
  agents: readonly SessionIconAgent[] | undefined,
): SessionIconAgent | null {
  return agentMark(item.agentSlug, item.provider, agents);
}

/** Pencil on the project line for a row with an unsent composer draft. */
function DraftMarker() {
  return (
    <span
      className="inbox-row__draft-marker"
      data-testid="inbox-row-draft-marker"
      title="Unsent draft"
      aria-hidden="true"
    >
      <EditGlyph />
    </span>
  );
}

/**
 * The project's mark before its name: its icon when it has one, else its
 * colour as a dot. Decorative (`aria-hidden`): the name beside it is what
 * says which project, and the colour is never applied to text.
 */
function ProjectAccentSwatch({
  accent,
  icon,
  name,
  size = 12,
  fallback = 'dot',
}: {
  accent: string | undefined;
  icon: string | undefined;
  name: string;
  size?: number;
  fallback?: 'dot' | 'initials';
}) {
  return (
    <ProjectIcon
      project={{ name, icon }}
      accent={accent}
      size={size}
      fallback={fallback}
      className="inbox-row__project-accent"
    />
  );
}

/**
 * The row's metadata hover card (`ChatInboxHoverCard`), lazily chunk-loaded
 * on first open so the dock's eager bundle never carries the card's data
 * imports. Hover opens it after the same delay `GitTooltip` uses; focus
 * opens it immediately, which is the keyboard path. Touch/pen pointers
 * never open it — the sheet's touch chrome has no hover to be honest about.
 *
 * State is per-row on purpose: only the hovered row mounts a card, so two
 * cards can never be open at once without a coordinator.
 */
const INBOX_HOVER_OPEN_DELAY_MS = 300;

function useInboxRowHoverCard() {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const timeout = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(
    () => () => {
      clearTimeout(timeout.current);
    },
    [],
  );
  const open = useCallback((node: HTMLElement) => {
    clearTimeout(timeout.current);
    setAnchor(node);
  }, []);
  const close = useCallback(() => {
    clearTimeout(timeout.current);
    setAnchor(null);
  }, []);
  const onPointerEnter = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      if (event.pointerType === 'touch' || event.pointerType === 'pen') return;
      clearTimeout(timeout.current);
      const target = event.currentTarget;
      timeout.current = setTimeout(
        () => setAnchor(target),
        INBOX_HOVER_OPEN_DELAY_MS,
      );
    },
    [],
  );
  const onPointerLeave = close;
  // focusin/focusout bubble, so a focus move BETWEEN the row's own controls
  // (open button → snooze) must not close the card: only a focus leaving the
  // row entirely does.
  const onFocus = useCallback(
    (event: React.FocusEvent<HTMLElement>) => {
      open(event.currentTarget);
    },
    [open],
  );
  const onBlur = useCallback(
    (event: React.FocusEvent<HTMLElement>) => {
      if (event.currentTarget.contains(event.relatedTarget as Node)) return;
      close();
    },
    [close],
  );
  return {
    anchor,
    open,
    close,
    onPointerEnter,
    onPointerLeave,
    onFocus,
    onBlur,
  };
}

const loadChatInboxHoverCard = () =>
  import('./ChatInboxHoverCard').then((module) => ({
    default: module.ChatInboxHoverCard,
  }));

const loadChatInboxDetailsSheet = () =>
  import('./ChatInboxHoverCard').then((module) => ({
    default: module.ChatInboxDetailsSheet,
  }));

/**
 * The row's snooze control (D7): ONE button that opens the duration choice,
 * never a one-tap default. A snoozed row shows Unsnooze instead.
 */
function SnoozeActions({
  action,
  showLabel = false,
}: {
  showLabel?: boolean;
  action: InboxRowSnoozeAction;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const choose = (wakeAt: number) => {
    if (triggerRef.current) action.choose(wakeAt, triggerRef.current);
    setMenuOpen(false);
  };
  if (action.isSnoozed) {
    return (
      <button
        type="button"
        className="chat-dock-inbox__row-action inbox-row__action"
        title={action.label}
        aria-label={action.accessibleLabel}
        onClick={(event) => action.choose(null, event.currentTarget)}
      >
        <ReturnGlyph />
        {showLabel && <span>{action.shortLabel}</span>}
      </button>
    );
  }
  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="chat-dock-inbox__row-action inbox-row__action"
        title={action.label}
        aria-label={action.accessibleLabel}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        onClick={() => setMenuOpen((open) => !open)}
      >
        <TimeGlyph />
        {showLabel && <span>{action.shortLabel}</span>}
      </button>
      {menuOpen && (
        <ResponsiveDialogSurface
          layer={showLabel ? 'dialog' : 'popover'}
          ariaLabel={action.accessibleLabel}
          onClose={() => setMenuOpen(false)}
          returnFocusTarget={triggerRef.current}
          anchorRef={triggerRef}
          overlayClassName="composer-popover-overlay composer-popover-overlay--start"
          panelClassName="composer-popover-panel chat-dock-inbox__snooze-menu"
        >
          <ResponsiveDialogHeader
            title="Snooze"
            closeLabel="Close snooze menu"
            onClose={() => setMenuOpen(false)}
          />
          <div role="menu" aria-label={action.accessibleLabel}>
            {action.choices.map((option) => (
              <button
                key={option.label}
                type="button"
                role="menuitem"
                onClick={() => choose(option.wakeAt)}
              >
                {option.label}
              </button>
            ))}
          </div>
        </ResponsiveDialogSurface>
      )}
    </>
  );
}

function InboxCommandButton({
  action,
  placement,
  onSelect = action.select,
}: {
  action: InboxRowCommand;
  placement: 'row' | 'sheet' | 'swipe';
  onSelect?: (trigger: HTMLButtonElement) => void;
}) {
  const icons = {
    settle: CheckGlyph,
    reopen: RefreshGlyph,
    close: CloseGlyph,
    restore: ReturnGlyph,
    discard: DiscardGlyph,
  };
  const Glyph = icons[action.icon];
  return (
    <Button
      variant="ghost"
      className={[
        placement === 'sheet'
          ? 'menu-row'
          : placement === 'row'
            ? 'chat-dock-inbox__row-action inbox-row__action'
            : `inbox-row__swipe-${action.id === 'close' ? 'dismiss' : action.id}`,
        action.danger ? 'action-overflow__row--danger' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      disabled={action.pending}
      title={action.label}
      aria-label={
        placement !== 'sheet' || action.id === 'discard-unsent'
          ? action.accessibleLabel
          : undefined
      }
      onClick={(event) => onSelect(event.currentTarget)}
    >
      <span
        className={placement === 'sheet' ? 'menu-row__glyph' : undefined}
        aria-hidden="true"
      >
        <Glyph />
      </span>
      {placement !== 'row' && (
        <span>{placement === 'swipe' ? action.shortLabel : action.label}</span>
      )}
    </Button>
  );
}

interface InboxRowProps {
  item: HomeWorkItem;
  isCurrent: boolean;
  isSnoozed: boolean;
  /** Live-tab membership for hosts offering tab close rather than dismissal. */
  isOpenChat: boolean;
  now: number;
  onActivate: (item: HomeWorkItem) => void;
  /**
   * Absent hides the snooze actions — the compact sidebar host (#3314) lists
   * open chats from a store snoozing does not filter, so offering a snooze
   * there would be a control whose effect is invisible where it is offered.
   */
  onSnoozeWake?: (
    item: HomeWorkItem,
    wakeAt: number | null,
    action: HTMLButtonElement,
  ) => void;
  /** Tab teardown for hosts without inbox dismissal. */
  onCloseChat?: (sessionId: string, action: HTMLButtonElement) => void;
  onDismiss?: (item: HomeWorkItem, action: HTMLButtonElement) => void;
  onRestore?: (item: HomeWorkItem, action: HTMLButtonElement) => void;
  resolution?: { settled: boolean; pending: boolean; onChange: () => void };
  isDismissed?: boolean;
  swipeActions?: boolean;
  swipeOpen?: boolean;
  onSwipeOpenChange?: (open: boolean) => void;
  /**
   * #2312: offers server-side Discard on Draft rows, independently of inbox
   * dismissal. Runs after the command succeeds for focus and tab teardown.
   */
  onDraftDiscarded?: (item: HomeWorkItem, action: HTMLButtonElement) => void;
  /**
   * The live agent catalog, for the row's leading agent icon. Absent (or
   * empty) renders no icons and no icon column — the compact sidebar host
   * keeps compact callers on the shared row anatomy.
   *
   * Must be referentially stable across renders: it is what
   * `inboxRowIconAgent` returns entries OF (a copy only for its #3355
   * engine fallback), and `ChatDockInboxPanel`'s
   * `memo()` wrap compares it shallowly.
   */
  agents?: readonly SessionIconAgent[];
  /**
   * The row's local session working directory and its Project (#2412: git
   * reads name the Project), resolved by the host from its session records
   * for the row's `orchestrationThreadId`. Absent (chat-only rows, unbound
   * chats, hosts without session data, remote rows) renders no git section
   * in the hover card — never a guess. Deliberately NOT a `HomeWorkItem`
   * field: that type is the workspace-home projection surface, and widening
   * it invalidates every existing grant.
   */
  gitLocation?: GitReadLocation;
  /**
   * The row's project colour (`useProjectAccents`, the sidebar's own
   * allocation), drawn as a decorative swatch before the project name.
   * Never a text colour: the name stays as text in the row's own
   * foreground. Absent (no project, or a host without the project list)
   * draws no swatch.
   */
  projectAccent?: string;
  /**
   * The row's project icon (`useProjectIcons`), drawn in place of the colour
   * swatch when the project has one. Absent draws the swatch.
   */
  projectIcon?: string;
  /**
   * `card` (the default) is the full row for work that needs you, is
   * running or is idle. `slim` is the one-line row for snoozed and settled
   * work: status icon, title, status word, time.
   */
  size?: 'card' | 'slim';
  /**
   * `hover` reveals the actions over the time slot on hover or keyboard
   * focus. `touch` shows them always, as ≥44px targets beside the row.
   */
  chrome?: 'hover' | 'touch';
  /** The picker keeps one overflow action; its sheet holds the other actions. */
  actionsInDetails?: boolean;
  /** Home: the row's snooze lapsed recently. */
  isWoken?: boolean;
  /**
   * The metadata card: a tooltip on hover/focus under the `hover` chrome, a
   * Details action that opens the same card as a sheet under `touch`. False
   * only for a caller that renders the bare row.
   */
  hoverCard?: boolean;
  /**
   * The row's status facts (`WorkFacts`), derived beside the item by the
   * host from its session and chat records. Absent, the row says only what
   * its lifecycle label says. Deliberately NOT `HomeWorkItem` fields, for
   * the reason `gitLocation` is not.
   */
  facts?: WorkFacts;
  /** The focus-preservation key; defaults to the item id. */
  rowKey?: string;
  /**
   * Whether this row's Details sheet is open, owned by the LIST (keyed by
   * item id) so a row that changes lane, and so remounts, keeps its sheet
   * and hands focus back to its new position. A bare row keeps its own.
   */
  detailsOpen?: boolean;
  onDetailsOpenChange?: (open: boolean) => void;
}

/**
 * Whether this row's chat holds unsent composer text on THIS device.
 *
 * Read from the store the composer itself writes (`chatDraftsStore`, keyed
 * by the chat store key the composer uses — `item.chatSessionId`), never a
 * copy, so the cue appears and clears with the text. Rows with no local chat
 * (orchestration-only, remote, attached) have no composer here and so no
 * cue: the text is per device and per open chat, not server state.
 *
 * Suppressed on a `Draft`-lifecycle row, whose "Draft" chip already says
 * nothing has been sent — two draft words on one row would read as two
 * different facts.
 */
function useHasUnsentComposerDraft(item: HomeWorkItem): boolean {
  const key = item.lifecycleLabel === 'Draft' ? undefined : item.chatSessionId;
  return useSyncExternalStore(
    chatDraftsStore.subscribe,
    () => (key ? chatDraftsStore.hasDraft(key) : false),
    () => false,
  );
}

/**
 * The row title. Unread sets it bold (#3075), and a weight change must not
 * move anything: a bolder title is wider, so it could re-wrap a two-line
 * phone title or shift an ellipsis. The title therefore always takes the
 * size of its bold rendering (an invisible bold copy, `data-title`, laid in
 * the same grid cell by CSS), whichever weight is showing.
 */
function InboxRowTitle({ title }: { title: string }) {
  return (
    <strong
      className="chat-dock-inbox__title inbox-row__title"
      title={title}
      data-title={title}
    >
      <span className="inbox-row__title-text">{title}</span>
    </strong>
  );
}

export function InboxRow({
  item,
  isCurrent,
  isSnoozed,
  isOpenChat,
  now,
  onActivate,
  onSnoozeWake,
  onCloseChat,
  onDismiss,
  onRestore,
  resolution,
  isDismissed = false,
  swipeActions = false,
  swipeOpen,
  onSwipeOpenChange,
  onDraftDiscarded,
  agents,
  gitLocation,
  projectAccent: suppliedProjectAccent,
  projectIcon: suppliedProjectIcon,
  size = 'card',
  chrome = 'hover',
  actionsInDetails = false,
  isWoken = false,
  hoverCard = true,
  facts,
  rowKey,
  detailsOpen: controlledDetailsOpen,
  onDetailsOpenChange,
}: InboxRowProps) {
  // The slug maps belong to the host; peer facts must not borrow its artwork.
  const projectIcon = facts?.station ? undefined : suppliedProjectIcon;
  const projectAccent = facts?.station ? undefined : suppliedProjectAccent;
  const identity = workIdentityMarks(item, agents);
  // #3159: a row whose conversation a message may reference is a drag source.
  const referenceable = useReferenceableConversations();
  const discardThreadId = onDraftDiscarded ? draftDiscardThreadId(item) : null;
  const hover = useInboxRowHoverCard();
  const hoverCardId = useId();
  const statusId = useId();
  const [ownDetailsOpen, setOwnDetailsOpen] = useState(false);
  const detailsOpen = controlledDetailsOpen ?? ownDetailsOpen;
  const setDetailsOpen = onDetailsOpenChange ?? setOwnDetailsOpen;
  const detailsTriggerRef = useRef<HTMLButtonElement>(null);
  // The sheet anchors to, and returns focus to, the Details button. A row
  // that mounts with its sheet already open (it just changed lane) has no
  // button in the DOM until its first commit, so the sheet waits for it.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const hasUnsentDraft = useHasUnsentComposerDraft(item);
  // #3075: the server's read state. The current chat in a focused window is
  // being read as its output lands, so it never reads as unread here (the
  // dock is telling the server the same thing).
  const documentFocused = useDocumentFocused();
  const onScreen = useConversationOnScreen(item);
  const unread = rowReadsUnread(item, onScreen && documentFocused);
  const readUnknown = rowReadStateUnknown(item, onScreen && documentFocused);
  // The ONE status read (#3042): the line here and the lane this row was
  // filed under come from the same function.
  const status = useObservedWorkStatus(item, now, facts);
  const claims = useSessionWorkClaims(facts?.hostDetails === false ? {} : item);
  const remoteProject = Boolean(item.environmentId || facts?.station);
  const stationLabel = facts?.station?.label ?? item.environmentLabel;
  const chips = inboxRowChips(item, { isWoken, claims, stationLabel });
  // Provider identity does not establish which app originated a transcript.
  const agentText = item.agentLabel;
  const directoryContext =
    !item.projectSlug && item.projectLabel === 'No project' && item.cwdLabel;
  const contextLabel = directoryContext
    ? `Directory · ${directoryContext}`
    : item.projectLabel;
  const hasTime = item.updatedAt > 0;
  const tooltip = hoverCard && chrome === 'hover';
  const details = hoverCard && chrome === 'touch';
  const detailsOpenRef = useRef(detailsOpen);
  detailsOpenRef.current = detailsOpen;
  const fromSheet = (action: (trigger: HTMLButtonElement) => void) => {
    setDetailsOpen(false);
    if (detailsTriggerRef.current) {
      detailsTriggerRef.current.focus();
      action(detailsTriggerRef.current);
    }
  };
  const composerDraftSessionId =
    hasUnsentDraft && item.chatSessionId ? item.chatSessionId : undefined;
  const actions = inboxRowActions({
    title: item.title,
    now,
    snooze: onSnoozeWake
      ? {
          isSnoozed,
          choose: (wakeAt, trigger) => onSnoozeWake(item, wakeAt, trigger),
        }
      : undefined,
    close:
      !isDismissed &&
      (onDismiss || (onCloseChat && isOpenChat && item.chatSessionId))
        ? {
            dismiss: Boolean(onDismiss),
            select: (trigger) => {
              if (onDismiss) onDismiss(item, trigger);
              else if (item.chatSessionId)
                onCloseChat?.(item.chatSessionId, trigger);
            },
          }
        : undefined,
    restore:
      isDismissed && onRestore
        ? (trigger) => onRestore(item, trigger)
        : undefined,
    resolution: resolution
      ? {
          ...resolution,
          select: (trigger) => {
            trigger
              .closest('.inbox-row')
              ?.querySelector<HTMLButtonElement>('.inbox-row__open')
              ?.focus();
            resolution.onChange();
          },
        }
      : undefined,
    discardUnsent: composerDraftSessionId
      ? () => {
          activeChatsStore.clearInput(composerDraftSessionId);
          chatDraftsStore.clear(composerDraftSessionId);
        }
      : undefined,
    discard:
      discardThreadId && onDraftDiscarded
        ? {
            threadId: discardThreadId,
            onDiscarded: (trigger) => onDraftDiscarded(item, trigger),
          }
        : undefined,
  });
  const hasActions =
    details || actions.some((action) => action.id !== 'discard-unsent');
  const direct = !details
    ? 'all'
    : actionsInDetails || size === 'slim'
      ? 'none'
      : actions.find((action) => action.id === 'discard')
        ? 'discard'
        : actions.find((action) => action.id === 'snooze')
          ? 'snooze'
          : actions.find((action) => action.id === 'close')
            ? 'close'
            : 'none';
  const beside = (action: InboxRowAction) =>
    direct === 'all' || direct === action.id;
  const trayActions = actions.filter(
    (action) =>
      action.id === 'resolution' ||
      action.id === 'snooze' ||
      (action.id === 'close' && onDismiss),
  );
  const canSwipe = Boolean(
    details && swipeActions && !isDismissed && trayActions.length,
  );
  const swipe = useInboxSwipe(canSwipe, {
    open: swipeOpen,
    onOpenChange: onSwipeOpenChange,
    actionWidth: trayActions.length * 72,
  });
  const openDetails = () => {
    swipe.close();
    setDetailsOpen(true);
    return true;
  };
  const renderDiscard = (
    action: Extract<InboxRowAction, { kind: 'discard' }>,
    inSheet: boolean,
  ) => (
    <DiscardDraftButton
      threadId={action.threadId}
      title={item.title}
      label={inSheet ? action.label : undefined}
      className={
        inSheet
          ? 'menu-row action-overflow__row--danger'
          : 'chat-dock-inbox__row-action inbox-row__action'
      }
      closeSessionIds={draftSessionIds(item)}
      onDiscarded={(trigger) => {
        if (!inSheet) action.onDiscarded(trigger);
        else if (detailsOpenRef.current) fromSheet(action.onDiscarded);
        else action.onDiscarded(trigger);
      }}
    />
  );
  const sheetMenu = actions.length ? (
    <div
      className="menu-surface chat-dock-inbox-details__menu"
      data-testid="inbox-row-details-actions"
    >
      {actions.map((action) =>
        action.kind === 'snooze' && !action.isSnoozed ? (
          <fieldset key={action.id} className="menu-group">
            <legend className="menu-group__label">{action.label}</legend>
            {action.choices.map((choice) => (
              <Button
                key={choice.label}
                variant="ghost"
                className="menu-row"
                onClick={() =>
                  fromSheet((trigger) => action.choose(choice.wakeAt, trigger))
                }
              >
                <span className="menu-row__glyph" aria-hidden="true">
                  <TimeGlyph />
                </span>
                {choice.label}
              </Button>
            ))}
          </fieldset>
        ) : (
          <div key={action.id} className="menu-group">
            {action.kind === 'snooze' ? (
              <Button
                variant="ghost"
                className="menu-row"
                onClick={() =>
                  fromSheet((trigger) => action.choose(null, trigger))
                }
              >
                <span className="menu-row__glyph" aria-hidden="true">
                  <ReturnGlyph />
                </span>
                {action.label}
              </Button>
            ) : action.kind === 'discard' ? (
              renderDiscard(action, true)
            ) : (
              <InboxCommandButton
                action={action}
                placement="sheet"
                onSelect={() => fromSheet(action.select)}
              />
            )}
          </div>
        ),
      )}
    </div>
  ) : undefined;
  const gesture = useContextMenuGesture({
    enabled: details,
    onOpen: openDetails,
  });
  const describedBy =
    tooltip && hover.anchor ? `${statusId} ${hoverCardId}` : statusId;
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: hover/focus host for the metadata card; the keyboard paths are the row button (focus opens the card) and Escape (the card closes itself).
    <div
      className={[
        'chat-dock-inbox__row',
        'inbox-row',
        `inbox-row--${size}`,
        `inbox-row--${chrome}`,
        hasActions ? 'inbox-row--has-actions' : '',
        isCurrent ? 'is-current' : '',
        canSwipe ? 'inbox-row--swipe' : '',
        swipe.open ? 'inbox-row--swiped' : '',
        swipe.dragging ? 'inbox-row--dragging' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      style={swipe.style}
      data-testid="inbox-row"
      data-unread={unread ? '' : undefined}
      data-read-unknown={readUnknown ? '' : undefined}
      data-row-key={rowKey ?? item.id}
      data-status-rung={status.rung}
      data-lane={status.lane}
      {...gesture}
      onPointerDown={(event) => {
        gesture.onPointerDown(event);
        swipe.onPointerDown(event);
      }}
      onPointerMove={(event) => {
        gesture.onPointerMove(event);
        swipe.onPointerMove(event);
      }}
      onPointerUp={(event) => {
        gesture.onPointerUp(event);
        swipe.onPointerUp(event);
      }}
      onPointerCancel={(event) => {
        gesture.onPointerCancel(event);
        swipe.onPointerCancel();
      }}
      onLostPointerCapture={swipe.onLostPointerCapture}
      onClickCapture={(event) => {
        swipe.onClickCapture(event);
        if (!event.isPropagationStopped()) gesture.onClickCapture(event);
      }}
      onKeyDown={(event) => {
        if (
          event.key === 'Escape' &&
          swipe.open &&
          event.target instanceof Node &&
          event.currentTarget.contains(event.target)
        ) {
          event.preventDefault();
          event.stopPropagation();
          if (
            event.target instanceof Element &&
            event.target.closest('.inbox-row__swipe-actions')
          ) {
            event.currentTarget
              .querySelector<HTMLButtonElement>('.inbox-row__open')
              ?.focus();
          }
          swipe.close();
        }
      }}
      onPointerEnter={tooltip ? hover.onPointerEnter : undefined}
      onPointerLeave={tooltip ? hover.onPointerLeave : undefined}
      onFocus={tooltip ? hover.onFocus : undefined}
      onBlur={tooltip ? hover.onBlur : undefined}
    >
      {canSwipe && (
        <div
          className="inbox-row__swipe-actions"
          hidden={!swipe.actionsVisible}
          aria-hidden={!swipe.open}
          inert={!swipe.open}
        >
          {trayActions.map((action) =>
            action.kind === 'snooze' ? (
              <SnoozeActions key={action.id} action={action} showLabel />
            ) : action.kind === 'command' ? (
              <InboxCommandButton
                key={action.id}
                action={action}
                placement="swipe"
              />
            ) : null,
          )}
        </div>
      )}
      <button
        type="button"
        className="chat-dock-inbox__item inbox-row__open"
        aria-label={`${item.title}${unread ? ', unread' : readUnknown ? ', read status unknown' : ''}, ${contextLabel}${stationLabel ? `, Station: ${stationLabel}` : ''}${item.controlMode === 'read-only-attached' ? `, ${item.agentLabel}, third-party session` : ''}${hasUnsentDraft ? ', unsent draft' : ''}`}
        // The accessible name is the explicit label above, so the status
        // (word, and any reason, in full) is offered as the description;
        // otherwise a screen reader would never hear what state the row is
        // in or why it failed.
        aria-describedby={describedBy}
        aria-current={isCurrent ? 'true' : undefined}
        onClick={() => onActivate(item)}
        {...(referenceable?.ids.has(item.id)
          ? {
              draggable: true,
              onDragStart: (event: React.DragEvent<HTMLElement>) =>
                startConversationReferenceDrag(event, {
                  id: item.id,
                  title: item.title,
                  apiBase: referenceable.apiBase,
                }),
              onDragEnd: endConversationReferenceDrag,
            }
          : {})}
      >
        {size === 'slim' ? (
          <>
            <span className="inbox-row__slim-status" data-tone={status.tone}>
              <InboxRowStatusGlyph rung={status.rung} />
            </span>
            <ProjectAccentSwatch
              accent={projectAccent}
              icon={projectIcon}
              fallback={remoteProject ? 'initials' : 'dot'}
              name={contextLabel}
            />
            <InboxRowTitle title={item.title} />
            {hasUnsentDraft && <DraftMarker />}
            {/* Provenance survives the one-line size: a remote row must
                never read as local work. */}
            {stationLabel && (
              <span className="inbox-row__slim-remote">
                <bdi>{stationLabel}</bdi>
              </span>
            )}
            <span
              id={statusId}
              className="inbox-row__slim-word"
              data-testid="inbox-row-status"
              // No duration in the tooltip: it would be frozen at the
              // list's coarse clock beside a ticking number.
              title={workStatusText(status)}
            >
              {status.word}
              {/* One line shows only the word; the detail and reason
                  behind it are still the row's description for a screen
                  reader. */}
              {(status.detail || status.reason) && (
                <span className="sr-only">
                  {` · ${status.detail ?? status.reason}`}
                </span>
              )}
            </span>
            {hasTime && (
              <span className="inbox-row__time">
                {relativeTime(item.updatedAt, now)}
              </span>
            )}
          </>
        ) : (
          <>
            <span className="inbox-row__meta">
              {/* Decorative, deliberately: the agent is stated in words
                  beside it, and this icon sits INSIDE a button that carries
                  an explicit `aria-label`. Passing no `accessibleLabel` is
                  what makes `BrandIcon` render `aria-hidden` rather than
                  `role="img"`, so the row gains a picture and not a second
                  announcement or a tab stop. An unresolved agent renders no
                  icon at all, never a stand-in. */}
              <IdentityMarks
                identity={identity}
                size={actionsInDetails ? 20 : 16}
              />
              <span className="inbox-row__meta-text">
                <span className="inbox-row__agent">{agentText}</span>
                {!actionsInDetails && (
                  <>
                    {' '}
                    ·{' '}
                    <ProjectAccentSwatch
                      accent={projectAccent}
                      icon={projectIcon}
                      fallback={remoteProject ? 'initials' : 'dot'}
                      name={contextLabel}
                    />
                    <span className="inbox-row__project">{contextLabel}</span>
                    {hasUnsentDraft && <DraftMarker />}
                  </>
                )}
              </span>
              {/* Never a fabricated duration: an item with no real
                  timestamp shows no time. */}
              {hasTime && (
                <span className="inbox-row__time">
                  {relativeTime(item.updatedAt, now)}
                </span>
              )}
            </span>
            <InboxRowTitle title={item.title} />
            <InboxRowStatusLine id={statusId} status={status} now={now} />
            {actionsInDetails && (
              <span className="inbox-row__project-context">
                {/* One project mark: its own icon when it has one, else the
                    folder. The colour dot beside the folder read as a stray
                    separator ("[folder] • name"). */}
                {displayableProjectIcon(projectIcon) || remoteProject ? (
                  <ProjectAccentSwatch
                    size={24}
                    accent={projectAccent}
                    icon={projectIcon}
                    name={contextLabel}
                    fallback={remoteProject ? 'initials' : 'dot'}
                  />
                ) : (
                  <FolderGlyph />
                )}
                <span className="inbox-row__project">{contextLabel}</span>
                {hasUnsentDraft && <DraftMarker />}
              </span>
            )}
            <InboxRowChips chips={chips} />
          </>
        )}
      </button>
      {hasActions && (
        <div className="chat-dock-inbox__row-actions inbox-row__actions">
          {/* No separate "open" control: the row itself opens, and a second
              one would be a redundant tab stop on every row. */}
          {details && (
            <button
              ref={detailsTriggerRef}
              type="button"
              className="chat-dock-inbox__row-action inbox-row__action"
              title="Chat actions and details"
              aria-label={`Details for ${item.title}`}
              aria-haspopup="dialog"
              aria-expanded={detailsOpen}
              onClick={() => {
                if (detailsOpen) setDetailsOpen(false);
                else openDetails();
              }}
            >
              <MoreGlyph />
            </button>
          )}
          {actions
            .filter(beside)
            .map((action) =>
              action.kind === 'snooze' ? (
                <SnoozeActions key={action.id} action={action} />
              ) : action.kind === 'discard' ? (
                <Fragment key={action.id}>
                  {renderDiscard(action, false)}
                </Fragment>
              ) : action.id !== 'discard-unsent' ? (
                <InboxCommandButton
                  key={action.id}
                  action={action}
                  placement="row"
                />
              ) : null,
            )}
        </div>
      )}
      {tooltip && hover.anchor && (
        <LazyBoundary
          load={loadChatInboxHoverCard}
          pending={null}
          componentProps={{
            item,
            now,
            facts,
            gitLocation,
            projectAccent,
            projectIcon,
            anchor: hover.anchor,
            onClose: hover.close,
            id: hoverCardId,
          }}
        />
      )}
      {details && detailsOpen && mounted && (
        <LazyBoundary
          load={loadChatInboxDetailsSheet}
          pending={null}
          componentProps={{
            item,
            now,
            facts,
            gitLocation,
            projectAccent,
            projectIcon,
            triggerRef: detailsTriggerRef,
            onClose: () => setDetailsOpen(false),
            actions: sheetMenu,
          }}
        />
      )}
    </div>
  );
}

function InboxTaskRow({
  item,
  now,
  facts,
  onActivate,
  onSnoozeWake,
  onDismiss,
  onRestore,
  isSnoozed,
  isDismissed,
}: Pick<
  InboxRowProps,
  | 'item'
  | 'now'
  | 'facts'
  | 'onActivate'
  | 'onSnoozeWake'
  | 'onDismiss'
  | 'onRestore'
  | 'isSnoozed'
  | 'isDismissed'
>) {
  const id = useId();
  const status = useObservedWorkStatus(item, now, facts);
  const actions = inboxRowActions({
    title: item.title,
    now,
    snooze: onSnoozeWake
      ? {
          isSnoozed: Boolean(isSnoozed),
          choose: (wakeAt, trigger) => onSnoozeWake(item, wakeAt, trigger),
        }
      : undefined,
    close:
      !isDismissed && onDismiss
        ? { dismiss: true, select: (trigger) => onDismiss(item, trigger) }
        : undefined,
    restore:
      isDismissed && onRestore
        ? (trigger) => onRestore(item, trigger)
        : undefined,
  });
  return (
    <div
      className="chat-dock-inbox__row inbox-row inbox-row--task"
      data-row-key={item.id}
    >
      <span className="inbox-row__task-label">Task · {item.projectLabel}</span>
      <InboxRowTitle title={item.title} />
      <InboxRowStatusLine id={id} status={status} now={now} />
      <div className="inbox-row__task-actions">
        <Button
          variant="ghost"
          className="chat-dock-inbox__item inbox-row__task-open"
          aria-label={`Open task ${item.title}`}
          onClick={() => onActivate(item)}
        >
          Open task
        </Button>
        <ActionOverflowMenu
          label={`Actions for task ${item.title}`}
          actions={actions.flatMap((action) => {
            if (action.kind === 'snooze') {
              const choices = action.isSnoozed
                ? [{ label: action.label, wakeAt: null }]
                : action.choices.map((choice) => ({
                    label: `${action.label} ${choice.label}`,
                    wakeAt: choice.wakeAt,
                  }));
              return choices.map((choice) => ({
                key: choice.label,
                label: choice.label,
                onSelect: (trigger: HTMLElement) => {
                  if (trigger instanceof HTMLButtonElement)
                    action.choose(choice.wakeAt, trigger);
                },
              }));
            }
            return action.kind === 'command'
              ? [
                  {
                    key: action.id,
                    label: action.label,
                    onSelect: (trigger: HTMLElement) => {
                      if (trigger instanceof HTMLButtonElement)
                        action.select(trigger);
                    },
                  },
                ]
              : [];
          })}
        />
      </div>
    </div>
  );
}

export type CollapsibleInboxSectionId = InboxSectionId;

export interface InboxGroupListProps {
  groups: MobileActivityGroup[];
  /** Namespace for the group-label element ids (two hosts, one document). */
  idPrefix: string;
  activeChatSessionId: string | null;
  openChatIds: ReadonlySet<string>;
  now: number;
  /**
   * Desktop chrome: the snoozed/earlier sections toggle collapsed, persisted
   * by the host. Absent (sheet chrome) renders plain labeled groups.
   */
  collapsible?: {
    sections: Partial<Record<CollapsibleInboxSectionId, boolean>>;
    onToggle: (id: CollapsibleInboxSectionId) => void;
    order?: readonly InboxSectionId[];
    onReorder?: (order: InboxSectionId[]) => void;
  };
  /** Sheet chrome: each group label says how many ("Needs you · 2"). */
  showGroupCounts?: boolean;
  onActivate: (item: HomeWorkItem) => void;
  onSnoozeWake: InboxRowProps['onSnoozeWake'];
  onCloseChat?: InboxRowProps['onCloseChat'];
  onDismiss?: InboxRowProps['onDismiss'];
  onRestore?: InboxRowProps['onRestore'];
  swipeActions?: boolean;
  onDraftDiscarded?: InboxRowProps['onDraftDiscarded'];
  /** Live agent catalog for the rows' leading icons — see `InboxRowProps`. */
  agents?: InboxRowProps['agents'];
  /**
   * Local session git locations by thread id — the host's session
   * records, passed once. Rows resolve their own `gitLocation` from their
   * `orchestrationThreadId`; a row that resolves nothing gets no git
   * section (see `InboxRowProps.gitLocation`). Must be referentially stable
   * across renders for the same reason `agents` is.
   */
  gitLocationByThreadId?: ReadonlyMap<string, GitReadLocation>;
  /**
   * Project accents by slug (`useProjectAccents`). Rows resolve their own
   * `projectAccent` through `rowProjectMarks`. Referentially stable, like
   * the other shared props.
   */
  projectAccentBySlug?: ReadonlyMap<string, string>;
  /** Project icons by slug (`useProjectIcons`), resolved like the accents. */
  projectIconBySlug?: ReadonlyMap<string, string>;
  /** See `InboxRowProps.chrome`. */
  chrome?: InboxRowProps['chrome'];
  actionsInDetails?: InboxRowProps['actionsInDetails'];
  /**
   * Status facts by item id (`buildWorkFacts`), the host's session and chat
   * records read once. Referentially stable, like the other shared props.
   */
  workFacts?: WorkFactsById;
}

/** Snoozed and settled ("Earlier") work renders as the slim one-line row. */
const SLIM_GROUPS: ReadonlySet<MobileActivityGroup['id']> = new Set([
  'snoozed',
  'earlier',
]);

export function InboxGroupList({
  groups,
  idPrefix,
  activeChatSessionId,
  openChatIds,
  now,
  collapsible,
  showGroupCounts = false,
  onActivate,
  onSnoozeWake,
  onCloseChat,
  onDismiss,
  onRestore,
  swipeActions,
  onDraftDiscarded,
  agents,
  gitLocationByThreadId,
  projectAccentBySlug,
  projectIconBySlug,
  chrome,
  actionsInDetails,
  workFacts,
}: InboxGroupListProps) {
  const [expandedFamilies, setExpandedFamilies] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const resolutionState = useConversationWorkState();
  const [settledVisibleCount, setSettledVisibleCount] =
    useState(SETTLED_PAGE_SIZE);
  // Owned here, by item id, so the sheet outlives the row's remount when
  // the item moves to another lane.
  const [detailsFor, setDetailsFor] = useState<string | null>(null);
  const [swipedFor, setSwipedFor] = useState<string | null>(null);
  const isCurrent = (item: HomeWorkItem) =>
    isCurrentInboxItem(item, activeChatSessionId);
  /** The rows a group actually renders, including the current row beyond page one. */
  const renderedItems = (group: MobileActivityGroup): HomeWorkItem[] => {
    const collapsed =
      collapsible &&
      group.id !== 'dismissed' &&
      collapsible.sections[group.id] === false;
    if (collapsed) return [];
    if (group.id === 'earlier' || group.id === 'settled')
      return group.items.filter(
        (item, index) =>
          index < settledVisibleCount ||
          isCurrent(item) ||
          Boolean(group.childrenById?.get(item.id)?.some(isCurrent)),
      );
    return group.items;
  };
  // A sheet belongs to a row that is on screen. Once its row is gone
  // (collapsed, folded away, discarded, snoozed) the open state is cleared,
  // so the sheet cannot reopen unprompted when the row comes back.
  const rowRendered = (rowId: string | null) =>
    rowId !== null &&
    groups.some((group) =>
      renderedItems(group).some(
        (item) =>
          item.id === rowId ||
          group.childrenById?.get(item.id)?.some((child) => child.id === rowId),
      ),
    );
  const detailsRowRendered = rowRendered(detailsFor);
  const swipedRowRendered = rowRendered(swipedFor);
  useEffect(() => {
    if (detailsFor !== null && !detailsRowRendered) setDetailsFor(null);
  }, [detailsFor, detailsRowRendered]);
  useEffect(() => {
    if (swipedFor !== null && !swipedRowRendered) setSwipedFor(null);
  }, [swipedFor, swipedRowRendered]);
  const renderItem = (group: MobileActivityGroup, item: HomeWorkItem) =>
    item.kind === 'task' ? (
      <InboxTaskRow
        item={item}
        now={now}
        facts={workFacts?.get(item.id)}
        onActivate={onActivate}
        onSnoozeWake={group.id === 'dismissed' ? undefined : onSnoozeWake}
        isSnoozed={group.id === 'snoozed'}
        isDismissed={group.id === 'dismissed'}
        onDismiss={onDismiss}
        onRestore={onRestore}
      />
    ) : (
      <InboxRow
        key={item.id}
        item={item}
        isCurrent={isCurrent(item)}
        isSnoozed={group.id === 'snoozed'}
        isOpenChat={Boolean(
          item.chatSessionId && openChatIds.has(item.chatSessionId),
        )}
        now={now}
        onActivate={onActivate}
        onSnoozeWake={group.id === 'dismissed' ? undefined : onSnoozeWake}
        onCloseChat={onCloseChat}
        onDismiss={onDismiss}
        onRestore={onRestore}
        isDismissed={group.id === 'dismissed'}
        resolution={
          resolutionState.supported &&
          workFacts?.get(item.id)?.hostDetails !== false &&
          item.kind !== 'remote-session' &&
          item.controlMode !== 'read-only-attached' &&
          item.conversationId &&
          !['Running', 'Needs attention', 'Draft'].includes(item.lifecycleLabel)
            ? {
                settled: Object.hasOwn(
                  resolutionState.settled,
                  item.conversationId,
                ),
                pending: resolutionState.change.isPending,
                onChange: () =>
                  resolutionState.change.mutate({
                    conversationId: item.conversationId!,
                    settled: !Object.hasOwn(
                      resolutionState.settled,
                      item.conversationId!,
                    ),
                  }),
              }
            : undefined
        }
        swipeActions={swipeActions}
        swipeOpen={swipedFor === item.id}
        onSwipeOpenChange={(open) =>
          setSwipedFor((current) =>
            open ? item.id : current === item.id ? null : current,
          )
        }
        onDraftDiscarded={onDraftDiscarded}
        agents={agents}
        chrome={chrome}
        actionsInDetails={actionsInDetails}
        facts={workFacts?.get(item.id)}
        detailsOpen={detailsFor === item.id}
        onDetailsOpenChange={(open) => setDetailsFor(open ? item.id : null)}
        size={!actionsInDetails && SLIM_GROUPS.has(group.id) ? 'slim' : 'card'}
        gitLocation={
          gitLocationByThreadId?.get(
            item.orchestrationThreadId ?? item.chatSessionId ?? '',
          ) ?? undefined
        }
        {...(workFacts?.get(item.id)?.hostDetails === false
          ? {}
          : rowProjectMarks(item, projectAccentBySlug, projectIconBySlug))}
      />
    );
  const renderRow = (group: MobileActivityGroup, item: HomeWorkItem) => (
    <WorkItemFamily
      key={item.id}
      root={item}
      members={group.childrenById?.get(item.id)}
      now={now}
      forceExpanded={group.childrenById?.get(item.id)?.some(isCurrent)}
      expanded={expandedFamilies.has(item.id)}
      onExpandedChange={(open) =>
        setExpandedFamilies((previous) => {
          const next = new Set(previous);
          if (open) next.add(item.id);
          else next.delete(item.id);
          return next;
        })
      }
      onMembersHidden={() => {
        if (
          group.childrenById
            ?.get(item.id)
            ?.some((child) => child.id === detailsFor)
        )
          setDetailsFor(null);
      }}
      renderRow={(member) => renderItem(group, member)}
    />
  );
  const isGroupExpanded = (group: MobileActivityGroup) =>
    group.id === 'dismissed' ||
    !collapsible ||
    collapsible.sections[group.id] !== false;
  const sectionOrder = [
    ...new Set([
      ...(collapsible?.order ?? []),
      ...groups.flatMap((group) =>
        group.id === 'dismissed' ? [] : [group.id],
      ),
      ...INBOX_SECTION_IDS,
    ]),
  ];
  const shelfRank = (group: MobileActivityGroup) =>
    !collapsible?.order?.length &&
    (group.id === 'earlier' ||
      (group.id === 'settled' && resolutionState.supported))
      ? 2
      : isGroupExpanded(group)
        ? 0
        : 1;
  const visibleGroups = groups
    .filter((group) => group.items.length > 0)
    .sort(
      (left, right) =>
        shelfRank(left) - shelfRank(right) ||
        (left.id === 'dismissed'
          ? sectionOrder.length
          : sectionOrder.indexOf(left.id)) -
          (right.id === 'dismissed'
            ? sectionOrder.length
            : sectionOrder.indexOf(right.id)),
    );
  const peersOf = (group: MobileActivityGroup) =>
    visibleGroups.filter(
      (peer) =>
        peer.id !== 'dismissed' &&
        isGroupExpanded(peer) === isGroupExpanded(group),
    );
  const moveSection = (group: MobileActivityGroup, offset: -1 | 1) => {
    if (group.id === 'dismissed') return;
    const peers = peersOf(group);
    const adjacent = peers[peers.indexOf(group) + offset];
    if (!adjacent || adjacent.id === 'dismissed') return;
    const order = [...sectionOrder];
    const from = order.indexOf(group.id);
    const to = order.indexOf(adjacent.id);
    [order[from], order[to]] = [order[to], order[from]];
    collapsible?.onReorder?.(order);
  };
  const firstCollapsed = visibleGroups.find((group) => !isGroupExpanded(group));
  return (
    <>
      {resolutionState.query.isError && (
        <ErrorState
          variant="compact"
          title="Conversation resolution unavailable"
          action={
            <Button
              variant="secondary"
              onClick={() => void resolutionState.query.refetch()}
            >
              Retry
            </Button>
          }
        />
      )}
      {visibleGroups.map((group) => {
        const collapsibleId: CollapsibleInboxSectionId | null =
          collapsible && group.id !== 'dismissed' ? group.id : null;
        const isExpanded = isGroupExpanded(group);
        // Whether a count shows is this host's choice (`showGroupCounts`, and
        // a collapsed Snoozed always says how many it hides); how it reads is
        // the shared label's: "Snoozed · 2", visible text, never a badge.
        const count =
          !isExpanded ||
          group.id === 'dismissed' ||
          resolutionState.supported ||
          (collapsible && group.id === 'snoozed') ||
          showGroupCounts
            ? group.id === 'needsYou'
              ? workAttentionCount(group.items, now, group.childrenById)
              : group.items.length
            : undefined;
        const label = <WorkGroupLabel label={group.label} count={count} />;
        const labelId = `${idPrefix}-${group.id}`;

        return (
          <section
            key={group.id}
            className={`chat-dock-inbox__group${!isExpanded ? ' chat-dock-inbox__group--collapsed' : ''}${group === firstCollapsed ? ' chat-dock-inbox__group--shelf-start' : ''}`}
            aria-labelledby={labelId}
          >
            {collapsibleId ? (
              <div className="chat-dock-inbox__section-header">
                <DisclosureToggle
                  id={labelId}
                  className="chat-dock-inbox__section-toggle"
                  expanded={isExpanded}
                  onToggle={() => collapsible!.onToggle(collapsibleId)}
                >
                  {label}
                </DisclosureToggle>
                {collapsible?.onReorder && peersOf(group).length > 1 && (
                  <ActionOverflowMenu
                    label={`Arrange ${group.label} section`}
                    actions={[
                      {
                        key: 'up',
                        label: 'Move up',
                        disabled: peersOf(group).indexOf(group) === 0,
                        onSelect: () => moveSection(group, -1),
                      },
                      {
                        key: 'down',
                        label: 'Move down',
                        disabled: peersOf(group).at(-1) === group,
                        onSelect: () => moveSection(group, 1),
                      },
                    ]}
                  />
                )}
              </div>
            ) : (
              <h3 id={labelId} className="chat-dock-inbox__group-label">
                {label}
              </h3>
            )}

            {isExpanded &&
              renderedItems(group).map((item) => renderRow(group, item))}
            {isExpanded &&
              (group.id === 'earlier' || group.id === 'settled') &&
              settledVisibleCount < group.items.length && (
                <Button
                  variant="ghost"
                  className="chat-dock-inbox__show-more"
                  aria-label="Show more earlier chats and tasks"
                  onClick={(event) => {
                    const container = event.currentTarget.closest('section');
                    const previous = new Set(
                      container?.querySelectorAll('.chat-dock-inbox__item'),
                    );
                    const lastPage =
                      settledVisibleCount + SETTLED_PAGE_SIZE >=
                      group.items.length;
                    const restoreFocus =
                      document.activeElement === event.currentTarget;
                    setSettledVisibleCount(
                      (count) => count + SETTLED_PAGE_SIZE,
                    );
                    if (lastPage && restoreFocus)
                      requestAnimationFrame(() => {
                        Array.from(
                          container?.querySelectorAll<HTMLButtonElement>(
                            '.chat-dock-inbox__item',
                          ) ?? [],
                        )
                          .find((row) => !previous.has(row))
                          ?.focus();
                      });
                  }}
                >
                  Show more
                </Button>
              )}
          </section>
        );
      })}
    </>
  );
}

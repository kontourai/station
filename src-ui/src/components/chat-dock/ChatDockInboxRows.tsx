import { parseEngineId } from '@kontourai/station-contracts/agent-identity';
import type { GitReadLocation } from '@kontourai/station-sdk';
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { activeChatsStore } from '../../contexts/active-chats-store';
import { chatDraftsStore } from '../../contexts/chat-drafts-store';
import { relativeTime } from '../../utils/relativeTime';
import type { SessionIconAgent } from '../../utils/sessionDisplay';
import {
  draftDiscardThreadId,
  draftSessionIds,
  olderDraftsLabel,
  splitDraftsByAge,
} from '../../views/home/draft-lane';
import type { HomeWorkItem } from '../../views/home/home-view-model';
import type { WorkFacts, WorkFactsById } from '../../views/home/work-facts';
import { workStatus, workStatusText } from '../../views/home/work-status';
import { DisclosureToggle } from '../DisclosureToggle';
import { DiscardDraftButton } from '../drafts/DiscardDraftButton';
import { AgentIcon } from '../icons/AgentIcon';
import { hasBundledEngineMark } from '../icons/BrandIcon';
import {
  CloseGlyph,
  DiscardGlyph,
  FolderGlyph,
  InfoGlyph,
  MoreGlyph,
  ReturnGlyph,
  TimeGlyph,
} from '../icons/Glyph';
import { ProjectIcon } from '../icons/ProjectIcon';
import {
  InboxRowChips,
  InboxRowStatusGlyph,
  InboxRowStatusLine,
} from '../inbox-row/InboxRowStatus';
import { inboxRowChips } from '../inbox-row/inbox-row-chips';
import { rowProjectMarks } from '../inbox-row/row-project-marks';
import { WorkGroupLabel } from '../inbox-row/WorkGroupLabel';
import { LazyBoundary } from '../LazyBoundary';
import {
  ResponsiveDialogHeader,
  ResponsiveDialogSurface,
} from '../ResponsiveDialogSurface';
import type { MobileActivityGroup } from './mobile-activity-groups';
import {
  SNOOZE_OPTIONS,
  type SnoozeOption,
  snoozeWakeAt,
} from './mobile-activity-groups';
import './ChatDockInboxPanel.css';
import {
  endConversationReferenceDrag,
  startConversationReferenceDrag,
  useReferenceableConversations,
} from '../chat/conversationReferenceDrag';
import '../inbox-row/InboxRow.css';
// The danger row treatment the sheet's Discard shares with every overflow.
import '../ActionOverflowMenu.css';

/**
 * kontourai/station#3312 — the one inbox, two chromes split.
 *
 * Row and group anatomy is defined here once and consumed by every inbox
 * surface: the desktop dock panel (`ChatDockInboxPanel`), the mobile
 * portaled sheet (`MobileTaskSwitcher`), Home's work lanes (`HomeWorkRow`)
 * and the project sidebar's open chats. Only the chrome stays host-owned —
 * panel scroll/footer vs sheet portal, focus trap, sticky header, and
 * visual-viewport sizing (the #1051 fixes live in the sheet).
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
 * The agent an inbox row is attributed to, drawn as its leading icon — or
 * `null`, which renders NO icon at all.
 *
 * Resolution is deliberately narrow: the row's own committed `agentSlug`,
 * looked up in the live agent catalog. Two fallbacks it pointedly does not
 * have:
 *
 * - It never reads `agentLabel`. That is a display string
 *   (`home-view-model.ts`'s `safeAgentLabel`) whose fallbacks include a bare
 *   provider id and the literal "Agent not reported" — matching artwork to
 *   one would be deriving an identity from a label.
 * - It never stands an ENGINE in for an UNRESOLVED agent the way
 *   `sessionIconAgent` does for a session row. That fallback is correct
 *   there, where the engine name is also the text beside the icon; here it
 *   would put an engine mark at the head of a row whose meta line names an
 *   agent, which is exactly the misattribution
 *   `home-view-model.ts`'s `safeAgentLabel` docblock records ("a Home row
 *   therefore said 'Bedrock' beside a Station engine icon"). An unresolvable
 *   row shows no icon rather than a stand-in that implies an engine.
 *
 * One fallback it does have (#3355): the agent RESOLVED, is bound to an
 * engine connection, but the catalog could not report that engine's id. The
 * row's own recorded `provider` — the engine its execution actually ran on —
 * then supplies the mark, so a Codex agent does not degrade to "CO"
 * initials. Only an engine with a bundled mark qualifies (anything else
 * would draw the same initials anyway), never an ACP-bound agent (`'acp'`
 * keeps its initials; its provider is not an engine's identity), and never an
 * unbound agent, whose missing engine is the truth rather than a gap.
 *
 * The catalog entry is returned BY REFERENCE whenever no fallback applies,
 * so resolving it is allocation-free; the fallback returns a copy carrying
 * the provider's `engineId`. Neither suppresses `<AgentIcon>` renders:
 * reconciliation identity is determined by type/key/position, and
 * `AgentIcon` is not memoized.
 */
export function inboxRowIconAgent(
  item: HomeWorkItem,
  agents: readonly SessionIconAgent[] | undefined,
): SessionIconAgent | null {
  if (!agents || !item.agentSlug) return null;
  const agent = agents.find((candidate) => candidate.slug === item.agentSlug);
  if (!agent) return null;
  if (
    agent.engineId ||
    !agent.execution?.agentConnectionId ||
    agent.engineConnectionType === 'acp'
  ) {
    return agent;
  }
  const provider = parseEngineId(item.provider);
  return provider && provider !== 'acp' && hasBundledEngineMark(provider)
    ? { ...agent, engineId: provider }
    : agent;
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
}: {
  accent: string | undefined;
  icon: string | undefined;
  name: string;
}) {
  return (
    <ProjectIcon
      project={{ name, icon }}
      accent={accent}
      size={12}
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
  item,
  isSnoozed,
  now,
  onWake,
}: {
  item: HomeWorkItem;
  isSnoozed: boolean;
  now: number;
  onWake: (wakeAt: number | null, action: HTMLButtonElement) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const choose = (option: SnoozeOption) => {
    if (triggerRef.current)
      onWake(snoozeWakeAt(option, now), triggerRef.current);
    setMenuOpen(false);
  };
  if (isSnoozed) {
    return (
      <button
        type="button"
        className="chat-dock-inbox__row-action inbox-row__action"
        title="Unsnooze"
        aria-label={`Unsnooze ${item.title}`}
        onClick={(event) => onWake(null, event.currentTarget)}
      >
        <ReturnGlyph />
      </button>
    );
  }
  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="chat-dock-inbox__row-action inbox-row__action"
        title="Snooze"
        aria-label={`Snooze ${item.title}`}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        onClick={() => setMenuOpen((open) => !open)}
      >
        <TimeGlyph />
      </button>
      {menuOpen && (
        <ResponsiveDialogSurface
          layer="popover"
          ariaLabel={`Snooze ${item.title}`}
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
          <div role="menu" aria-label={`Snooze ${item.title}`}>
            {SNOOZE_OPTIONS.map((option) => (
              <button
                key={option.label}
                type="button"
                role="menuitem"
                onClick={() => choose(option)}
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

interface InboxRowProps {
  item: HomeWorkItem;
  isCurrent: boolean;
  isSnoozed: boolean;
  /** Whether the row's chat has a live tab, which makes it closable. */
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
  /** Absent hides the close action (a host with no tab teardown path). */
  onCloseChat?: (sessionId: string, action: HTMLButtonElement) => void;
  /**
   * #2312: present offers "Discard draft" on rows the server calls a Draft —
   * open chat or not, which is what makes an orchestration-only Draft
   * dismissable at all. The discard itself is the server command; this runs
   * after it succeeded, for the host's focus move and tab teardown.
   */
  onDraftDiscarded?: (item: HomeWorkItem, action: HTMLButtonElement) => void;
  /**
   * The live agent catalog, for the row's leading agent icon. Absent (or
   * empty) renders no icons and no icon column — the compact sidebar host
   * (`SidebarOpenChats`) keeps today's layout byte-for-byte.
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

export function InboxRow({
  item,
  isCurrent,
  isSnoozed,
  isOpenChat,
  now,
  onActivate,
  onSnoozeWake,
  onCloseChat,
  onDraftDiscarded,
  agents,
  gitLocation,
  projectAccent,
  projectIcon,
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
  const iconAgent = inboxRowIconAgent(item, agents);
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
  // The ONE status read (#3042): the line here and the lane this row was
  // filed under come from the same function.
  const status = workStatus(item, now, facts);
  const chips = inboxRowChips(item, { hasUnsentDraft, isWoken });
  // An attached transcript's meta line names the app it lives in; the
  // status word ("Elsewhere") says this Station cannot answer there.
  const agentText = item.agentLabel;
  const hasTime = item.updatedAt > 0;
  const closable = Boolean(onCloseChat && isOpenChat && item.chatSessionId);
  const tooltip = hoverCard && chrome === 'hover';
  const details = hoverCard && chrome === 'touch';
  // A host that offers nothing (the sidebar's open chats) gets no slot and
  // no extra tab stop: the row is already its own open control.
  const hasActions = Boolean(
    details || onSnoozeWake || discardThreadId || closable,
  );
  // TOUCH CHROME shows Details and at most ONE direct action, so a phone
  // row keeps its title: Discard on a Draft (it is what a Draft row is for),
  // otherwise snooze where the row can be snoozed, otherwise close. A slim
  // row is one line and shows Details alone.
  // Whatever is not beside the row is an ordinary button inside the Details
  // sheet. Hover chrome reveals every action over the time slot as before.
  const snoozable = Boolean(onSnoozeWake);
  const direct: 'all' | 'snooze' | 'close' | 'discard' | 'none' = !details
    ? 'all'
    : actionsInDetails || size === 'slim'
      ? 'none'
      : discardThreadId
        ? 'discard'
        : snoozable
          ? 'snooze'
          : closable
            ? 'close'
            : 'none';
  const beside = (action: 'snooze' | 'close' | 'discard') =>
    direct === 'all' || direct === action;
  // Sheet actions hand the host the Details trigger: it lives in the row, so
  // the host's focus move can find the row the action is about to remove.
  const fromSheet = (action: (trigger: HTMLButtonElement) => void) => {
    setDetailsOpen(false);
    if (detailsTriggerRef.current) action(detailsTriggerRef.current);
  };
  // The actions that are not beside the row, as the sheet's menu list: the
  // shared menu primitive's groups and rows (`.menu-group`, `.menu-row`), an
  // icon and a label on each, snooze presets under their own group label and
  // the destructive Discard last. They are buttons in a labelled list, not
  // `role="menu"`: the sheet is a dialog that also holds read-only details
  // and takes focus as a dialog, and a menu role would promise roving arrow
  // keys this composite does not implement. `undefined` when the row keeps
  // nothing in the sheet, so no empty list is rendered.
  const sheetSnoozePresets =
    !beside('snooze') && onSnoozeWake && !isSnoozed ? onSnoozeWake : undefined;
  const sheetUnsnooze =
    !beside('snooze') && onSnoozeWake && isSnoozed ? onSnoozeWake : undefined;
  const sheetClose = !beside('close') && closable;
  const sheetDiscard =
    !beside('discard') && discardThreadId && onDraftDiscarded
      ? { threadId: discardThreadId, onDraftDiscarded }
      : undefined;
  // U11 (design round 2026-10): an UNSENT composer draft — text typed into
  // an open chat on this device, the row's "Unsent draft" chip — had no way
  // off a phone. It is this device's text, not a server Draft, so discarding
  // it clears the composer and the store the chip reads, nothing else.
  const composerDraftSessionId =
    hasUnsentDraft && item.chatSessionId ? item.chatSessionId : undefined;
  const sheetMenu =
    sheetSnoozePresets ||
    sheetUnsnooze ||
    sheetClose ||
    sheetDiscard ||
    composerDraftSessionId ? (
      <div
        className="menu-surface chat-dock-inbox-details__menu"
        data-testid="inbox-row-details-actions"
      >
        {sheetSnoozePresets && (
          <fieldset className="menu-group">
            <legend className="menu-group__label">Snooze</legend>
            {SNOOZE_OPTIONS.map((option) => (
              <button
                key={option.label}
                type="button"
                className="menu-row"
                onClick={() =>
                  fromSheet((trigger) =>
                    sheetSnoozePresets(
                      item,
                      snoozeWakeAt(option, now),
                      trigger,
                    ),
                  )
                }
              >
                <span className="menu-row__glyph" aria-hidden="true">
                  <TimeGlyph />
                </span>
                {option.label}
              </button>
            ))}
          </fieldset>
        )}
        {(sheetUnsnooze || sheetClose) && (
          <div className="menu-group">
            {sheetUnsnooze && (
              <button
                type="button"
                className="menu-row"
                onClick={() =>
                  fromSheet((trigger) => sheetUnsnooze(item, null, trigger))
                }
              >
                <span className="menu-row__glyph" aria-hidden="true">
                  <ReturnGlyph />
                </span>
                Unsnooze
              </button>
            )}
            {sheetClose && (
              <button
                type="button"
                className="menu-row"
                onClick={() =>
                  fromSheet((trigger) =>
                    onCloseChat?.(item.chatSessionId!, trigger),
                  )
                }
              >
                <span className="menu-row__glyph" aria-hidden="true">
                  <CloseGlyph />
                </span>
                Close chat
              </button>
            )}
          </div>
        )}
        {composerDraftSessionId && (
          <div className="menu-group">
            <button
              type="button"
              className="menu-row action-overflow__row--danger"
              aria-label={`Discard unsent draft for ${item.title}`}
              onClick={() => {
                activeChatsStore.clearInput(composerDraftSessionId);
                chatDraftsStore.clear(composerDraftSessionId);
                setDetailsOpen(false);
              }}
            >
              <span className="menu-row__glyph" aria-hidden="true">
                <DiscardGlyph />
              </span>
              Discard unsent draft
            </button>
          </div>
        )}
        {/* Destructive, so last and marked. It is the shared discard
            button (its accessible name and its server command unchanged),
            and like every sheet action it closes the sheet and hands the
            host the row's own trigger to move focus from. */}
        {sheetDiscard && (
          <div className="menu-group">
            <DiscardDraftButton
              threadId={sheetDiscard.threadId}
              title={item.title}
              label="Discard draft"
              className="menu-row action-overflow__row--danger"
              closeSessionIds={draftSessionIds(item)}
              onDiscarded={() =>
                fromSheet((trigger) =>
                  sheetDiscard.onDraftDiscarded(item, trigger),
                )
              }
            />
          </div>
        )}
      </div>
    ) : undefined;
  const discardButton =
    discardThreadId && onDraftDiscarded ? (
      <DiscardDraftButton
        threadId={discardThreadId}
        title={item.title}
        className="chat-dock-inbox__row-action inbox-row__action"
        closeSessionIds={draftSessionIds(item)}
        onDiscarded={(action) => onDraftDiscarded(item, action)}
      />
    ) : null;
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
      ]
        .filter(Boolean)
        .join(' ')}
      data-testid="inbox-row"
      data-row-key={rowKey ?? item.id}
      data-status-rung={status.rung}
      data-lane={status.lane}
      onPointerEnter={tooltip ? hover.onPointerEnter : undefined}
      onPointerLeave={tooltip ? hover.onPointerLeave : undefined}
      onFocus={tooltip ? hover.onFocus : undefined}
      onBlur={tooltip ? hover.onBlur : undefined}
    >
      <button
        type="button"
        className="chat-dock-inbox__item inbox-row__open"
        aria-label={`${item.title}, ${item.projectLabel}${item.controlMode === 'read-only-attached' ? `, started in ${item.agentLabel}` : ''}${hasUnsentDraft ? ', unsent draft' : ''}`}
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
            <strong
              className="chat-dock-inbox__title inbox-row__title"
              title={item.title}
            >
              {item.title}
            </strong>
            {/* Provenance survives the one-line size: a remote row must
                never read as local work. */}
            {item.environmentLabel && (
              <span className="inbox-row__slim-remote">
                <bdi>{item.environmentLabel}</bdi>
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
              {iconAgent && (
                <span title={agentText}>
                  <AgentIcon
                    agent={iconAgent}
                    size={actionsInDetails ? 20 : 16}
                    accessibleLabel={actionsInDetails ? agentText : undefined}
                    className="chat-dock-inbox__avatar"
                  />
                </span>
              )}
              <span
                className={`inbox-row__meta-text${actionsInDetails && iconAgent ? ' sr-only' : ''}`}
              >
                <span className="inbox-row__agent">{agentText}</span>
                {!actionsInDetails && (
                  <>
                    {' '}
                    ·{' '}
                    <ProjectAccentSwatch
                      accent={projectAccent}
                      icon={projectIcon}
                      name={item.projectLabel}
                    />
                    <span className="inbox-row__project">
                      {item.projectLabel}
                    </span>
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
            <strong
              className="chat-dock-inbox__title inbox-row__title"
              title={item.title}
            >
              {item.title}
            </strong>
            <InboxRowStatusLine
              id={statusId}
              status={status}
              now={now}
              // The picker hides the time slot (its status sits there), so
              // the time trails the status line instead.
              lastActivityAt={
                actionsInDetails && hasTime ? item.updatedAt : undefined
              }
            />
            {actionsInDetails && (
              <span className="inbox-row__project-context">
                <FolderGlyph />
                <ProjectAccentSwatch
                  accent={projectAccent}
                  icon={projectIcon}
                  name={item.projectLabel}
                />
                <span className="inbox-row__project">{item.projectLabel}</span>
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
              title={actionsInDetails ? 'Chat actions and details' : 'Details'}
              aria-label={`Details for ${item.title}`}
              aria-haspopup="dialog"
              aria-expanded={detailsOpen}
              onClick={() => setDetailsOpen(!detailsOpen)}
            >
              {actionsInDetails ? <MoreGlyph /> : <InfoGlyph />}
            </button>
          )}
          {beside('snooze') && onSnoozeWake && (
            <SnoozeActions
              item={item}
              isSnoozed={isSnoozed}
              now={now}
              onWake={(wakeAt, action) => onSnoozeWake(item, wakeAt, action)}
            />
          )}
          {beside('close') && closable && (
            <button
              type="button"
              className="chat-dock-inbox__row-action inbox-row__action"
              title="Close chat"
              aria-label={`Close ${item.title}`}
              onClick={(event) =>
                onCloseChat?.(item.chatSessionId!, event.currentTarget)
              }
            >
              <span aria-hidden="true">×</span>
            </button>
          )}
          {beside('discard') && discardButton}
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

export type CollapsibleInboxSectionId = 'snoozed' | 'earlier';

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
    sections: Record<CollapsibleInboxSectionId, boolean>;
    onToggle: (id: CollapsibleInboxSectionId) => void;
  };
  /** Sheet chrome: each group label says how many ("Needs you · 2"). */
  showGroupCounts?: boolean;
  onActivate: (item: HomeWorkItem) => void;
  onSnoozeWake: InboxRowProps['onSnoozeWake'];
  onCloseChat?: InboxRowProps['onCloseChat'];
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
  onDraftDiscarded,
  agents,
  gitLocationByThreadId,
  projectAccentBySlug,
  projectIconBySlug,
  chrome,
  actionsInDetails,
  workFacts,
}: InboxGroupListProps) {
  const [olderDraftsOpen, setOlderDraftsOpen] = useState(false);
  // Owned here, by item id, so the sheet outlives the row's remount when
  // the item moves to another lane.
  const [detailsFor, setDetailsFor] = useState<string | null>(null);
  /** The rows a group actually renders: none while its section is
   *  collapsed, and older drafts only once their disclosure is open. */
  const renderedItems = (group: MobileActivityGroup): HomeWorkItem[] => {
    const collapsed =
      collapsible &&
      (group.id === 'snoozed' || group.id === 'earlier') &&
      !collapsible.sections[group.id];
    if (collapsed) return [];
    if (group.id !== 'drafts') return group.items;
    const { recent, older } = splitDraftsByAge(group.items, now);
    return olderDraftsOpen ? [...recent, ...older] : recent;
  };
  // A sheet belongs to a row that is on screen. Once its row is gone
  // (collapsed, folded away, discarded, snoozed) the open state is cleared,
  // so the sheet cannot reopen unprompted when the row comes back.
  const detailsRowRendered =
    detailsFor !== null &&
    groups.some((group) =>
      renderedItems(group).some((item) => item.id === detailsFor),
    );
  useEffect(() => {
    if (detailsFor !== null && !detailsRowRendered) setDetailsFor(null);
  }, [detailsFor, detailsRowRendered]);
  const renderRow = (group: MobileActivityGroup, item: HomeWorkItem) => (
    <InboxRow
      key={item.id}
      item={item}
      isCurrent={
        item.chatSessionId === activeChatSessionId ||
        item.orchestrationThreadId === activeChatSessionId
      }
      isSnoozed={group.id === 'snoozed'}
      isOpenChat={Boolean(
        item.chatSessionId && openChatIds.has(item.chatSessionId),
      )}
      now={now}
      onActivate={onActivate}
      onSnoozeWake={onSnoozeWake}
      onCloseChat={onCloseChat}
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
      {...rowProjectMarks(item, projectAccentBySlug, projectIconBySlug)}
    />
  );
  // #2312: Drafts untouched for a day fold under one disclosure. Nothing is
  // deleted; the rows are a click away and still discardable.
  const renderDraftRows = (group: MobileActivityGroup) => {
    const { recent, older } = splitDraftsByAge(group.items, now);
    return (
      <>
        {recent.map((item) => renderRow(group, item))}
        {older.length > 0 && (
          <DisclosureToggle
            className="chat-dock-inbox__section-toggle chat-dock-inbox__older-drafts"
            expanded={olderDraftsOpen}
            onToggle={() => setOlderDraftsOpen((open) => !open)}
          >
            {olderDraftsLabel(older.length)}
          </DisclosureToggle>
        )}
        {olderDraftsOpen && older.map((item) => renderRow(group, item))}
      </>
    );
  };
  return (
    <>
      {groups.map((group) => {
        const collapsibleId: CollapsibleInboxSectionId | null =
          collapsible && (group.id === 'snoozed' || group.id === 'earlier')
            ? group.id
            : null;
        const isExpanded = collapsibleId
          ? collapsible!.sections[collapsibleId]
          : true;
        // Whether a count shows is this host's choice (`showGroupCounts`, and
        // a collapsed Snoozed always says how many it hides); how it reads is
        // the shared label's: "Snoozed · 2", visible text, never a badge.
        const count =
          (collapsible && group.id === 'snoozed') ||
          (!collapsibleId && showGroupCounts)
            ? group.items.length
            : undefined;
        const label = <WorkGroupLabel label={group.label} count={count} />;
        const labelId = `${idPrefix}-${group.id}`;

        return (
          <section
            key={group.id}
            className="chat-dock-inbox__group"
            aria-labelledby={labelId}
          >
            {collapsibleId ? (
              <DisclosureToggle
                id={labelId}
                className="chat-dock-inbox__section-toggle"
                expanded={isExpanded}
                onToggle={() => collapsible!.onToggle(collapsibleId)}
              >
                {label}
              </DisclosureToggle>
            ) : (
              <h3 id={labelId} className="chat-dock-inbox__group-label">
                {label}
              </h3>
            )}

            {isExpanded &&
              (group.id === 'drafts'
                ? renderDraftRows(group)
                : group.items.map((item) => renderRow(group, item)))}
          </section>
        );
      })}
    </>
  );
}

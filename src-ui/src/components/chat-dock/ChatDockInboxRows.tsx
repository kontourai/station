import { useRef, useState } from 'react';
import { relativeTime } from '../../utils/relativeTime';
import type { SessionIconAgent } from '../../utils/sessionDisplay';
import type { HomeWorkItem } from '../../views/home/home-view-model';
import {
  hasLifecycleChip,
  LifecycleStatusChip,
} from '../home/LifecycleStatusChip';
import { AgentIcon } from '../icons/AgentIcon';
import { ReturnGlyph, TimeGlyph } from '../icons/Glyph';
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

/**
 * kontourai/station#3312 — the one inbox, two chromes split.
 *
 * Row and group anatomy (project chip, title, meta, answerability, lifecycle
 * state, snooze/close actions) is defined here once and consumed by both
 * inbox surfaces: the desktop dock panel (`ChatDockInboxPanel`) and the
 * mobile portaled sheet (`MobileTaskSwitcher`). Only the chrome stays
 * host-owned — panel scroll/footer vs sheet portal, focus trap, sticky
 * header, and visual-viewport sizing (the #1051 fixes live in the sheet).
 *
 * The `chat-dock-inbox__*` class family is the single styling source; the
 * sheet host wraps the list in `.chat-dock-inbox--touch`, which converts the
 * hover-revealed desktop row actions into always-visible ≥44px touch targets.
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
 * - It never falls back to the ENGINE's product name the way
 *   `sessionIconAgent` does for a session row. That fallback is correct
 *   there, where the engine name is also the text beside the icon; here it
 *   would put an engine mark at the head of a row whose meta line names an
 *   agent, which is exactly the misattribution
 *   `home-view-model.ts`'s `safeAgentLabel` docblock records ("a Home row
 *   therefore said 'Bedrock' beside a Station engine icon"). An unresolvable
 *   row shows no icon rather than a stand-in that implies an engine.
 *
 * The catalog entry is returned BY REFERENCE, never wrapped in a fresh
 * `{ … }`, so resolving it is allocation-free. This does not suppress
 * `<AgentIcon>` renders: reconciliation identity is determined by
 * type/key/position, and `AgentIcon` is not memoized.
 */
export function inboxRowIconAgent(
  item: HomeWorkItem,
  agents: readonly SessionIconAgent[] | undefined,
): SessionIconAgent | null {
  if (!agents || !item.agentSlug) return null;
  return agents.find((agent) => agent.slug === item.agentSlug) ?? null;
}

export function SnoozeActions({
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
  return (
    <>
      <button
        type="button"
        className="chat-dock-inbox__row-action"
        aria-label={
          isSnoozed ? `Unsnooze ${item.title}` : `Snooze ${item.title}`
        }
        onClick={(event) =>
          onWake(
            isSnoozed ? null : snoozeWakeAt(SNOOZE_OPTIONS[0], now),
            event.currentTarget,
          )
        }
      >
        {isSnoozed ? <ReturnGlyph /> : <TimeGlyph />}
      </button>
      {!isSnoozed && (
        <button
          ref={triggerRef}
          type="button"
          className="chat-dock-inbox__row-action chat-dock-inbox__snooze-menu-trigger"
          aria-label={`Choose snooze duration for ${item.title}`}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((open) => !open)}
        >
          <span aria-hidden="true">▾</span>
        </button>
      )}
      {menuOpen && (
        <ResponsiveDialogSurface
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

export interface InboxRowProps {
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
   * The live agent catalog, for the row's leading agent icon. Absent (or
   * empty) renders no icons and no icon column — the compact sidebar host
   * (`SidebarOpenChats`) keeps today's layout byte-for-byte.
   *
   * Must be referentially stable across renders: it is what
   * `inboxRowIconAgent` returns entries OF, and `ChatDockInboxPanel`'s
   * `memo()` wrap compares it shallowly.
   */
  agents?: readonly SessionIconAgent[];
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
  agents,
}: InboxRowProps) {
  const iconAgent = inboxRowIconAgent(item, agents);
  // The icon COLUMN is reserved for the whole list, not per row: a host that
  // supplies a catalog is a host that shows agent icons, and rows whose
  // agent does not resolve must still line their text up with the rows whose
  // agent does. The alternative — collapsing the column per row — ragged the
  // left edge of a mixed list, which reads as broken rather than as absent
  // information.
  const showsIcons = Boolean(agents?.length);
  return (
    <div
      className={`chat-dock-inbox__row${isCurrent ? ' is-current' : ''}`}
      data-testid="inbox-row"
    >
      <button
        type="button"
        className={`chat-dock-inbox__item${showsIcons ? ' chat-dock-inbox__item--avatars' : ''}`}
        aria-label={`${item.title}, ${item.projectLabel}`}
        aria-current={isCurrent ? 'true' : undefined}
        onClick={() => onActivate(item)}
      >
        {/* Decorative, deliberately: the agent is already stated in words on
            the meta line below, and this icon sits INSIDE a button that
            carries an explicit `aria-label` — an accessible name a child's
            label could not contribute to anyway. Passing no
            `accessibleLabel` is what makes `BrandIcon` render `aria-hidden`
            rather than `role="img"`, so the row gains a picture and not a
            second announcement or a tab stop. */}
        {iconAgent && (
          <AgentIcon
            agent={iconAgent}
            size={20}
            className="chat-dock-inbox__avatar"
          />
        )}
        <span className="chat-dock-inbox__project">{item.projectLabel}</span>
        <strong className="chat-dock-inbox__title">{item.title}</strong>
        <span className="chat-dock-inbox__meta">
          {item.agentLabel} · {item.modelLabel}
        </span>
        {/* station#1783: the chip is a pointer; this is what computed it.
            `LIFECYCLE_CHIP_LABELS` is shared, so adding `'Unanswerable'` to
            it reached this surface — and a chip with no basis two components
            over is the same label-not-derivation defect the Home row
            avoids. */}
        {item.unanswerableNotice && (
          <span
            className="chat-dock-inbox__answerability"
            data-testid="inbox-row-answerability"
          >
            {item.unanswerableNotice}
          </span>
        )}
        {/* station#3688: the observation behind a red Failed chip, same
            contract as the answerability notice above — the chip is a
            pointer; this is what computed it. Absent when no reason was
            recorded: the bare chip is honest, invented prose is not. */}
        {item.failureNotice && (
          <span
            className="chat-dock-inbox__answerability"
            data-testid="inbox-row-failure-reason"
          >
            {item.failureNotice}
          </span>
        )}
        <span className="chat-dock-inbox__state">
          {hasLifecycleChip(item.lifecycleLabel) ? (
            <>
              <LifecycleStatusChip lifecycle={item.lifecycleLabel} />
              {/* Chip AND recency, not either/or: a `Failed`/`Completed` row
                  used to lose its time entirely, so "how long has it sat
                  like this?" was unanswerable from the inbox while Home's
                  own row shows both (HomeWorkRow). `updatedAt` is the last
                  observed activity — the closest derivation to "since" this
                  item carries. */}
              {item.updatedAt > 0 && (
                <span className="chat-dock-inbox__since">
                  {relativeTime(item.updatedAt, now)}
                </span>
              )}
            </>
          ) : (
            relativeTime(item.updatedAt, now)
          )}
        </span>
      </button>
      {(onSnoozeWake || (onCloseChat && isOpenChat && item.chatSessionId)) && (
        <div className="chat-dock-inbox__row-actions">
          {onSnoozeWake && (
            <SnoozeActions
              item={item}
              isSnoozed={isSnoozed}
              now={now}
              onWake={(wakeAt, action) => onSnoozeWake(item, wakeAt, action)}
            />
          )}
          {onCloseChat && isOpenChat && item.chatSessionId && (
            <button
              type="button"
              className="chat-dock-inbox__row-action"
              aria-label={`Close ${item.title}`}
              onClick={(event) =>
                onCloseChat(item.chatSessionId!, event.currentTarget)
              }
            >
              <span aria-hidden="true">×</span>
            </button>
          )}
        </div>
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
  /** Sheet chrome: a count badge beside each group label. */
  showGroupCounts?: boolean;
  onActivate: (item: HomeWorkItem) => void;
  onSnoozeWake: InboxRowProps['onSnoozeWake'];
  onCloseChat?: InboxRowProps['onCloseChat'];
  /** Live agent catalog for the rows' leading icons — see `InboxRowProps`. */
  agents?: InboxRowProps['agents'];
}

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
  agents,
}: InboxGroupListProps) {
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
        const label =
          collapsible && group.id === 'snoozed'
            ? `${group.label} (${group.items.length})`
            : group.label;
        const labelId = `${idPrefix}-${group.id}`;

        return (
          <section
            key={group.id}
            className="chat-dock-inbox__group"
            aria-labelledby={labelId}
          >
            {collapsibleId ? (
              <button
                type="button"
                id={labelId}
                className="chat-dock-inbox__section-toggle"
                aria-expanded={isExpanded}
                onClick={() => collapsible!.onToggle(collapsibleId)}
              >
                <span aria-hidden="true">{isExpanded ? '−' : '+'}</span>
                {label}
              </button>
            ) : (
              <h3 id={labelId} className="chat-dock-inbox__group-label">
                {label}
                {showGroupCounts && (
                  <span
                    className="chat-dock-inbox__group-count"
                    aria-hidden="true"
                  >
                    {group.items.length}
                  </span>
                )}
              </h3>
            )}

            {isExpanded &&
              group.items.map((item) => (
                <InboxRow
                  key={item.id}
                  item={item}
                  isCurrent={item.chatSessionId === activeChatSessionId}
                  isSnoozed={group.id === 'snoozed'}
                  isOpenChat={Boolean(
                    item.chatSessionId && openChatIds.has(item.chatSessionId),
                  )}
                  now={now}
                  onActivate={onActivate}
                  onSnoozeWake={onSnoozeWake}
                  onCloseChat={onCloseChat}
                  agents={agents}
                />
              ))}
          </section>
        );
      })}
    </>
  );
}

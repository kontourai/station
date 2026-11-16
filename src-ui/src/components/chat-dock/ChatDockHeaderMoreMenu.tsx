import type React from 'react';
import { ActionOverflowMenu, type OverflowAction } from '../ActionOverflowMenu';

/**
 * The More menu's groups, in the order they render, each set off by a
 * separator: the chats to switch to, this chat's commands and panels, its
 * clipboard rows, facts about where it came from, then the region's own rows.
 */
export const DOCK_MORE_GROUPS = [
  'switch',
  'chat',
  'copy',
  'about',
  'region',
] as const;
export type DockMoreGroup = (typeof DOCK_MORE_GROUPS)[number];

/** One row of the dock header's More menu; an ungrouped row is a "chat" row. */
export type DockMoreAction = OverflowAction & { group?: DockMoreGroup };

/**
 * Orders rows by group (stable within one) and draws one separator at each
 * group boundary, so no caller has to know which group precedes its own.
 */
export function groupDockMoreActions(
  actions: readonly DockMoreAction[],
): DockMoreAction[] {
  const rank = (action: DockMoreAction) =>
    DOCK_MORE_GROUPS.indexOf(action.group ?? 'chat');
  return actions
    .map((action, index) => ({ action, index }))
    .sort((a, b) => rank(a.action) - rank(b.action) || a.index - b.index)
    .map(({ action }, index, rows) => ({
      ...action,
      separatorBefore:
        index > 0 &&
        (rows[index - 1]?.action.group ?? 'chat') !== (action.group ?? 'chat'),
    }));
}

/**
 * The dock header's folded secondary commands (#1536 section F).
 *
 * The menu itself is the shared `ActionOverflowMenu`; what is the dock's own
 * is kept here: its name, its 28px bar trigger, rendering a single folded
 * command inline rather than behind a list of one, and the glyph slot that
 * lines its labels up with the header menus beside it.
 */
export function ChatDockHeaderMoreMenu(props: {
  actions: readonly DockMoreAction[];
  triggerRef?: React.RefObject<HTMLButtonElement | null>;
  badgeCount?: number;
  badgeLabel?: string;
  /** Live state behind the rows with no count on the trigger; see `ActionOverflowMenu`. */
  status?: string;
}) {
  return (
    <ActionOverflowMenu
      {...props}
      label="More dock actions"
      // A lone working chat stays behind the trigger: the trigger is what
      // carries the "N working" count, and an inline row would drop it.
      inlineSingle={
        !(props.actions.length === 1 && props.actions[0]?.group === 'switch')
      }
      reserveGlyphColumn
      triggerClassName="chat-dock__more-btn"
    />
  );
}

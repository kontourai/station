import type React from 'react';
import { ActionOverflowMenu, type OverflowAction } from '../ActionOverflowMenu';

/** One row of the dock header's More menu. */
export type DockMoreAction = OverflowAction;

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
}) {
  return (
    <ActionOverflowMenu
      {...props}
      label="More dock actions"
      inlineSingle
      reserveGlyphColumn
      triggerClassName="chat-dock__more-btn"
    />
  );
}

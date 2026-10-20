import type { RefObject } from 'react';
import {
  ResponsiveDialogHeader,
  ResponsiveDialogSurface,
} from '../ResponsiveDialogSurface';
import {
  type SessionContextCardProps,
  SessionContextRows,
} from './SessionContextCard';

/**
 * The session context card's rows behind its entry point: an anchored popover
 * under the header chip on a desktop dock too narrow for the card, a bottom
 * sheet (opened from the Chat actions sheet) on a phone. Back, Escape and the
 * backdrop close it through `ResponsiveDialogSurface`.
 */
export function SessionContextSheet({
  anchorRef,
  returnFocusTarget,
  onClose,
  ...props
}: SessionContextCardProps & {
  anchorRef: RefObject<HTMLElement | null>;
  returnFocusTarget?: HTMLElement | null;
  onClose: () => void;
}) {
  return (
    <ResponsiveDialogSurface
      layer="popover"
      ariaLabel="This chat"
      onClose={onClose}
      historyMode="entry"
      anchorRef={anchorRef}
      returnFocusTarget={returnFocusTarget}
      overlayClassName="session-context-sheet-overlay"
      panelClassName="session-context-sheet-panel"
    >
      <ResponsiveDialogHeader
        title="This chat"
        closeLabel="Close chat context"
        onClose={onClose}
      />
      <div className="session-context-card session-context-card--sheet">
        <SessionContextRows
          {...props}
          inventoryTrigger={returnFocusTarget}
          wrap={(action) => {
            onClose();
            action();
          }}
        />
      </div>
    </ResponsiveDialogSurface>
  );
}

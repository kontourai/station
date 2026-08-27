import type { ReactNode } from 'react';
import {
  ResponsiveDialogCloseButton,
  ResponsiveDialogSurface,
} from '../ResponsiveDialogSurface';
import type { ToolCallGroup, ToolCallLike } from './tool-call-groups';
import './chat.css';

export interface ToolCallBatchSheetProps<P extends ToolCallLike> {
  group: ToolCallGroup<P>;
  renderCall: (part: P, index: number) => ReactNode;
  titleId: string;
  onClose: () => void;
}

/**
 * The batch's detail surface — a desktop popover / mobile bottom sheet from
 * one `ResponsiveDialogSurface` implementation. `historyMode="entry"` so an
 * Android back-swipe dismisses this sheet instead of navigating the page
 * underneath. Each row reuses the caller's own `renderCall` (a
 * `ToolCallDisplay`), so opening a row reveals the exact same full detail —
 * including the readable command block — the transcript already offers for
 * a single, uncollapsed tool call.
 */
export function ToolCallBatchSheet<P extends ToolCallLike>({
  group,
  renderCall,
  titleId,
  onClose,
}: ToolCallBatchSheetProps<P>) {
  return (
    <ResponsiveDialogSurface
      onClose={onClose}
      ariaLabelledBy={titleId}
      historyMode="entry"
      overlayClassName="tool-call-batch-sheet__overlay"
      panelClassName="tool-call-batch-sheet__panel"
    >
      <div className="tool-call-batch-sheet__header">
        <h3 id={titleId} className="tool-call-batch-sheet__title">
          {group.summary}
        </h3>
        <ResponsiveDialogCloseButton
          onClick={onClose}
          label="Close tool call details"
        />
      </div>
      <div className="tool-call-batch-sheet__list">
        {group.calls.map((call) => (
          <div
            key={call.part.toolCallId ?? `tool-call-row:${call.index}`}
            className="tool-call-batch-sheet__row"
          >
            {renderCall(call.part, call.index)}
          </div>
        ))}
      </div>
    </ResponsiveDialogSurface>
  );
}

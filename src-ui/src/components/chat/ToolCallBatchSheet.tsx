import type { ReactNode } from 'react';
import {
  ResponsiveDialogCloseButton,
  ResponsiveDialogSurface,
} from '../ResponsiveDialogSurface';
import type { ToolCallGroup, ToolCallLike } from './tool-call-groups';
import './chat.css';

export interface ToolCallBatchSheetProps<P extends ToolCallLike> {
  group: ToolCallGroup<P>;
  renderCall: (part: P, index: number, expanded?: boolean) => ReactNode;
  renderInterlude?: (part: P, index: number) => ReactNode;
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
  renderInterlude,
  titleId,
  onClose,
}: ToolCallBatchSheetProps<P>) {
  // A folded turn's narration sits between the calls it was written between.
  const rows = [
    ...group.calls.map((call) => ({ kind: 'call' as const, call })),
    ...(renderInterlude
      ? group.interludes.map((note) => ({ kind: 'note' as const, note }))
      : []),
  ].sort(
    (a, b) =>
      (a.kind === 'call' ? a.call.index : a.note.index) -
      (b.kind === 'call' ? b.call.index : b.note.index),
  );
  return (
    <ResponsiveDialogSurface
      layer="dialog"
      onClose={onClose}
      ariaLabelledBy={titleId}
      historyMode="entry"
      overlayClassName="tool-call-batch-sheet__overlay"
      panelClassName="tool-call-batch-sheet__panel"
    >
      <div className="tool-call-batch-sheet__header">
        <h3 id={titleId} className="tool-call-batch-sheet__title">
          {group.aggregateSummary}
        </h3>
        <ResponsiveDialogCloseButton
          onClick={onClose}
          label="Close tool call details"
        />
      </div>
      <div className="tool-call-batch-sheet__list">
        {rows.map((row) =>
          row.kind === 'note' ? (
            <div
              key={`tool-call-note:${row.note.index}`}
              className="tool-call-batch-sheet__note"
            >
              {renderInterlude?.(row.note.part, row.note.index)}
            </div>
          ) : (
            <div
              key={
                row.call.part.toolCallId ?? `tool-call-row:${row.call.index}`
              }
              className="tool-call-batch-sheet__row"
            >
              {/* An explicit disclosure overrides the inline visibility preference. */}
              {renderCall(row.call.part, row.call.index, true)}
            </div>
          ),
        )}
      </div>
    </ResponsiveDialogSurface>
  );
}

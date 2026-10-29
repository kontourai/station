import { useRef, useState } from 'react';
import { ArrowDownGlyph } from '../icons/Glyph';
import { LazyBoundary } from '../LazyBoundary';
import '../chat/chat.css';

const loadSheet = () =>
  import('./EngineApprovalDisclosureSheet').then((module) => ({
    default: module.EngineApprovalDisclosureSheet,
  }));

/** The short form the pill shows; the sheet and accessible name say more. */
export const ENGINE_APPROVAL_CHIP_LABEL = 'Set by engine';

interface EngineApprovalDisclosureChipProps {
  /** The engine's display name, for the explanation. */
  engineName?: string;
  /** The engine advertises its own session modes (shown beside this chip). */
  engineHasModes?: boolean;
}

/**
 * #3290: the approval control of an ACP engine that decides for itself which
 * of its actions ask before they run (`acpApprovalControl` is `engine`).
 *
 * Station answers only the requests such an engine sends and has no channel
 * to make it ask for others, so it offers no approval mode here: a mode
 * nothing applies would be a state nothing computes. The chip says who
 * decides, and opens a sheet explaining it; on a phone a hover title is not
 * readable, which is why this is a button and not an inert label.
 */
export function EngineApprovalDisclosureChip({
  engineName,
  engineHasModes = false,
}: EngineApprovalDisclosureChipProps) {
  const [isSheetOpen, setIsSheetOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const subject = engineName?.trim() || 'This engine';
  const summary = `${subject} decides which of its actions ask before they run.`;
  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="choice-trigger chat-input__approval-chip chat-input__approval-chip--default"
        aria-haspopup="dialog"
        aria-expanded={isSheetOpen}
        aria-label={`Approval: ${ENGINE_APPROVAL_CHIP_LABEL}. ${summary}`}
        title={`Approval: ${summary}`}
        onClick={() => setIsSheetOpen((open) => !open)}
      >
        <span className="chat-input__chip-stack">
          <span className="chat-input__chip-caption" aria-hidden="true">
            Approval
          </span>
          <span className="chat-input__approval-chip-label" aria-hidden="true">
            {ENGINE_APPROVAL_CHIP_LABEL}
          </span>
        </span>
        <ArrowDownGlyph className="choice-caret" />
      </button>
      {isSheetOpen && (
        <LazyBoundary
          load={loadSheet}
          componentProps={{
            triggerRef,
            engineName: subject,
            engineHasModes,
            onClose: () => setIsSheetOpen(false),
          }}
          pending={null}
        />
      )}
    </>
  );
}

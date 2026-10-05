import type { RefObject } from 'react';
import {
  ResponsiveDialogHeader,
  ResponsiveDialogSurface,
} from '../ResponsiveDialogSurface';

interface EngineApprovalDisclosureSheetProps {
  triggerRef: RefObject<HTMLButtonElement | null>;
  engineName: string;
  engineHasModes: boolean;
  onClose: () => void;
}

/**
 * #3290: what the approval control of an engine-decided ACP engine means.
 * Read-only by design: there is no Station mode to pick.
 */
export function EngineApprovalDisclosureSheet({
  triggerRef,
  engineName,
  engineHasModes,
  onClose,
}: EngineApprovalDisclosureSheetProps) {
  return (
    <ResponsiveDialogSurface
      layer="popover"
      ariaLabel="Approval"
      onClose={onClose}
      historyMode="entry"
      returnFocusTarget={triggerRef.current}
      anchorRef={triggerRef}
      overlayClassName="composer-popover-overlay composer-popover-overlay--start"
      panelClassName="composer-popover-panel composer-mode-sheet"
    >
      <ResponsiveDialogHeader
        title="Approval"
        subtitle="Set by the engine"
        closeLabel="Close approval details"
        onClose={onClose}
      />
      <div className="composer-mode-sheet__disclosure">
        <p>
          {engineName} decides which of its actions ask before they run. Station
          shows each request it sends and waits for your answer, but cannot make
          it ask for others, so Station&apos;s approval modes do not apply here.
        </p>
        <p>
          {engineHasModes
            ? "To change what asks, use the engine's Mode, if it offers approval levels there, or its own settings."
            : "To change what asks, use the engine's own settings."}
        </p>
      </div>
    </ResponsiveDialogSurface>
  );
}

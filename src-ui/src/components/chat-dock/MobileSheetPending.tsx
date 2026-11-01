import type { CSSProperties } from 'react';
import {
  ResponsiveDialogHeader,
  ResponsiveDialogSurface,
} from '../ResponsiveDialogSurface';

/** Immediate, accessible acknowledgement while a phone sheet chunk loads. */
export function MobileSheetPending({
  label,
  style,
  onClose,
  returnFocusTarget,
}: {
  label: string;
  style?: CSSProperties;
  onClose: () => void;
  returnFocusTarget?: HTMLElement | null;
}) {
  return (
    <ResponsiveDialogSurface
      layer="dialog"
      onClose={onClose}
      ariaLabel={label}
      overlayStyle={style}
      returnFocusTarget={returnFocusTarget}
      initialFocusPolicy="panel"
      overlayClassName="composer-popover-overlay composer-popover-overlay--end"
      panelClassName="composer-popover-panel"
    >
      <ResponsiveDialogHeader
        title={label}
        subtitle="Loading"
        closeLabel={`Close ${label.toLowerCase()}`}
        onClose={onClose}
      />
      <p role="status" aria-busy="true" className="composer-mode-sheet__notes">
        Loading {label.toLowerCase()}…
      </p>
    </ResponsiveDialogSurface>
  );
}

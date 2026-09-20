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
      overlayClassName="mobile-task-switcher__overlay"
      panelClassName="mobile-task-switcher__panel"
    >
      <ResponsiveDialogHeader
        title={label}
        subtitle="Loading"
        closeLabel={`Close ${label.toLowerCase()}`}
        onClose={onClose}
      />
      <p role="status" aria-busy="true" className="mobile-task-switcher__list">
        Loading {label.toLowerCase()}…
      </p>
    </ResponsiveDialogSurface>
  );
}

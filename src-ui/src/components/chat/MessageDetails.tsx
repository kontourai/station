import { type ReactNode, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  ResponsiveDialogHeader,
  ResponsiveDialogSurface,
} from '../ResponsiveDialogSurface';

/** Secondary facts and actions stay available without competing with the message. */
export function MessageDetails({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className="message-details__trigger"
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        ⋯
      </button>
      {open &&
        createPortal(
          <ResponsiveDialogSurface
            ariaLabel={label}
            onClose={() => setOpen(false)}
            historyMode="entry"
            overlayClassName="composer-popover-overlay"
            panelClassName="composer-popover-panel message-details__panel"
          >
            <ResponsiveDialogHeader
              title={label}
              closeLabel="Close message details"
              onClose={() => setOpen(false)}
            />
            <div className="message-details__body">{children}</div>
          </ResponsiveDialogSurface>,
          document.body,
        )}
    </>
  );
}

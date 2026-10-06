/**
 * Browser entry for ActionOverflowMenu.dialog-layering.test.tsx. Bundled with
 * esbuild and run in Chromium, so the REAL components mount, measure and
 * layer themselves — the menu's layer is read from computed style, which
 * jsdom does not compute.
 *
 * `window.__scenario` picks what hosts the ActionRow.
 */
import { type ReactNode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ActionRow } from '../../components/ActionRow';
import { Dialog } from '../../components/Dialog';
import { ResponsiveDialogSurface } from '../../components/ResponsiveDialogSurface';

declare global {
  interface Window {
    __scenario?: string;
    __selected?: string[];
  }
}

const select = (label: string) => () => {
  window.__selected = [...(window.__selected ?? []), label];
};

const row = (
  <ActionRow
    overflowLabel="More skill actions"
    primary={<button type="button">Save</button>}
    overflow={[
      { key: 'a', label: 'Duplicate', onSelect: select('Duplicate') },
      { key: 'b', label: 'Export', onSelect: select('Export') },
      {
        key: 'c',
        label: 'Remove',
        tone: 'danger',
        onSelect: select('Remove'),
      },
    ]}
  />
);

const noop = () => {};
const inDialog = (children: ReactNode) => (
  <Dialog title="Edit skill" closeLabel="Close" onClose={noop}>
    {children}
  </Dialog>
);

/**
 * Mounts its children one commit AFTER its host, the way a surface opened
 * from a dialog is: it is appended to the body later, so at an equal layer it
 * paints above the dialog it came from.
 */
function OpenedLater({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(true), []);
  return open ? children : null;
}

const scenarios: Record<string, ReactNode> = {
  page: <div style={{ padding: 200 }}>{row}</div>,
  dialog: inDialog(row),
  // A dialog on the SYSTEM layer, above ordinary dialogs.
  system: (
    <ResponsiveDialogSurface
      layer="system"
      ariaLabel="System notice"
      onClose={noop}
      panelClassName="station-dialog__panel"
    >
      <div style={{ padding: 24 }}>{row}</div>
    </ResponsiveDialogSurface>
  ),
  // A second surface opened FROM a dialog. It portals to the body, so the
  // first dialog is not among the trigger's DOM ancestors.
  'dialog-in-dialog': inDialog(
    <>
      <p>Outer dialog</p>
      <OpenedLater>
        <Dialog title="Inner" closeLabel="Close inner" onClose={noop}>
          {row}
        </Dialog>
      </OpenedLater>
    </>,
  ),
  // A popover-layer surface opened from a dialog: also body-portalled, and
  // its OWN layer is below the dialog's.
  'popover-in-dialog': inDialog(
    <>
      <p>Outer dialog</p>
      <OpenedLater>
        <ResponsiveDialogSurface
          layer="popover"
          ariaLabel="Options"
          onClose={noop}
          panelClassName="station-dialog__panel"
        >
          <div style={{ padding: 24 }}>{row}</div>
        </ResponsiveDialogSurface>
      </OpenedLater>
    </>,
  ),
};

const root = document.createElement('div');
document.body.append(root);
createRoot(root).render(scenarios[window.__scenario ?? 'page']);

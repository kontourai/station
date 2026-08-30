import { FolderBrowserModal } from '../../components/modals/FolderBrowserModal';

// #1014: the folder browser moved to a shared component
// (`components/modals/FolderBrowserModal`) so every path input can reach it,
// not just plugin installation. This wrapper keeps plugin management's own
// `plugins__*` classnames wired through unchanged, so the move is behaviour-
// and pixel-preserving for this consumer — see
// `views/plugin-management/__tests__/FolderPickerModal.test.tsx`.
//
// This file no longer renders `ResponsiveDialogSurface` directly — it
// delegates entirely to `FolderBrowserModal`, which does. Named here for
// `docs/ui/responsive-surfaces.json`'s `contract` adoption check
// (scripts/responsive-surface-ratchet.mjs), which reads this file's own
// source: the modal this component puts on screen is still, transitively,
// a ResponsiveDialogSurface dialog.
export function FolderPickerModal({
  onSelect,
  onClose,
}: {
  onSelect: (path: string) => void;
  onClose: () => void;
}) {
  return (
    <FolderBrowserModal
      onSelect={onSelect}
      onClose={onClose}
      titleId="folder-picker-title"
      closeLabel="Close folder picker"
      classNames={{
        overlay: 'plugins__modal-overlay',
        panel: 'plugins__modal plugins__folder-modal',
        header: 'plugins__modal-header',
        title: 'plugins__modal-title',
        body: 'plugins__modal-body',
        message: 'plugins__modal-message',
        messageError: 'plugins__message--error',
        pathRow: 'plugins__folder-path',
        selectButton: 'plugins__folder-select-btn',
        list: 'plugins__folder-list',
        entry: 'plugins__folder-entry',
        icon: 'plugins__folder-icon',
        name: 'plugins__folder-name',
      }}
    />
  );
}

import { createPortal } from 'react-dom';
import {
  ResponsiveDialogSurface,
  ResponsiveSurfaceActions,
} from '../../components/ResponsiveDialogSurface';

export function DeleteIntegrationModal({
  integrationName,
  onCancel,
  onConfirm,
}: {
  integrationName: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  // #1180: opened from `Delete` inside `IntegrationEditorPanel` — the detail
  // content `SplitPaneLayout` portals into `PageFrame`'s mobile-detail slot
  // on a phone, exempt from the `inert` its sibling frame div carries while
  // that sheet is open (PageFrame.tsx:155). Rendered in place, this modal is
  // a plain sibling of `SplitPaneLayout` in `IntegrationsView`, not that
  // exempt content, so it inherited the `inert` its own trigger was exempt
  // from: visible, but `.focus()` a no-op and both buttons unclickable.
  // `createPortal` to `document.body` is the same escape `ConfirmModal` and
  // `PluginModalStack` (#1131) already use — DOM placement only, so React
  // context and event bubbling still follow the component tree.
  return createPortal(
    <ResponsiveDialogSurface
      onClose={onCancel}
      ariaLabelledBy="delete-integration-title"
      overlayClassName="plugins__confirm-overlay"
      panelClassName="plugins__confirm"
    >
      <h3 id="delete-integration-title">Delete Tool Server</h3>
      <p>Remove &ldquo;{integrationName}&rdquo;? This cannot be undone.</p>
      <ResponsiveSurfaceActions className="plugins__confirm-actions">
        <button
          type="button"
          className="plugins__confirm-cancel"
          onClick={onCancel}
        >
          Cancel
        </button>
        <button
          type="button"
          className="plugins__confirm-delete"
          onClick={onConfirm}
        >
          Delete
        </button>
      </ResponsiveSurfaceActions>
    </ResponsiveDialogSurface>,
    document.body,
  );
}

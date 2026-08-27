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
  return (
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
    </ResponsiveDialogSurface>
  );
}

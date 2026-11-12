import { ConfirmModal } from '../../components/modals/ConfirmModal';

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
    <ConfirmModal
      isOpen
      title="Delete tool server"
      message={`Delete “${integrationName}”? This cannot be undone.`}
      confirmLabel="Delete"
      variant="danger"
      role="alertdialog"
      onCancel={onCancel}
      onConfirm={onConfirm}
    />
  );
}

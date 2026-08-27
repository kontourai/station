import { useRef } from 'react';
import { useTopmostModal } from './useTopmostModal';

export interface ConfirmModalProps {
  isOpen: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
  variant?: 'danger' | 'warning' | 'default';
}

export function ConfirmModal({
  isOpen,
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  onConfirm,
  onCancel,
  variant = 'default',
}: ConfirmModalProps) {
  const cancelButtonRef = useRef<HTMLButtonElement>(null);
  const { dialogRef, onKeyDown } = useTopmostModal({
    isOpen,
    onClose: onCancel,
    initialFocusRef: cancelButtonRef,
  });

  if (!isOpen) return null;

  return (
    <div className="modal-overlay">
      <button
        type="button"
        className="enterprise-modal-backdrop enterprise-modal-backdrop--fill"
        tabIndex={-1}
        aria-label="Dismiss dialog"
        onClick={onCancel}
      />
      <div
        className={`modal-dialog modal-dialog--${variant} enterprise-modal-layer`}
        ref={dialogRef}
        onKeyDown={onKeyDown}
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-modal-title"
      >
        <div className="modal-header">
          <h3 id="confirm-modal-title">{title}</h3>
        </div>
        <div className="modal-body">
          <p>{message}</p>
        </div>
        <div className="modal-footer">
          <button
            type="button"
            ref={cancelButtonRef}
            className="btn btn--secondary"
            onClick={onCancel}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            className={`btn btn--${variant === 'danger' ? 'danger' : 'primary'}`}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

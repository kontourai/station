import { useEffect, useRef, useState } from 'react';
import { isComposingKeyEvent } from '../../lib/isComposingKeyEvent';
import { Button } from '../Button';
import './PromptModal.css';
import {
  ResponsiveDialogSurface,
  ResponsiveSurfaceActions,
} from '../ResponsiveDialogSurface';

export interface PromptModalProps {
  isOpen: boolean;
  title: string;
  /** Label shown above the input. */
  label?: string;
  /** Pre-filled value (e.g. the current name when renaming). */
  initialValue?: string;
  placeholder?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Inline validation. Return an error string to block submit, or null. */
  validate?: (value: string) => string | null;
  onConfirm: (value: string) => void;
  onCancel: () => void;
}

/**
 * A single-text-input modal — the input counterpart to ConfirmModal. Used for
 * "name your new file/folder" and "rename" flows. Enter submits, Escape
 * cancels, the input is focused and (for rename) its basename is pre-selected.
 */
export function PromptModal({
  isOpen,
  title,
  label,
  initialValue = '',
  placeholder,
  confirmLabel = 'Save',
  cancelLabel = 'Cancel',
  validate,
  onConfirm,
  onCancel,
}: PromptModalProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(initialValue);

  // Reset to the provided initial value each time the modal opens.
  useEffect(() => {
    if (isOpen) setValue(initialValue);
  }, [isOpen, initialValue]);

  useEffect(() => {
    if (!isOpen) return;
    // ResponsiveDialogSurface owns focus. Preserve the rename-friendly range.
    const input = inputRef.current;
    if (input) {
      const dot = input.value.lastIndexOf('.');
      input.setSelectionRange(0, dot > 0 ? dot : input.value.length);
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const error = validate ? validate(value) : null;
  const submit = () => {
    if (error) return;
    const trimmed = value.trim();
    if (!trimmed) return;
    onConfirm(trimmed);
  };

  return (
    <ResponsiveDialogSurface
      onClose={onCancel}
      ariaLabelledBy="prompt-modal-title"
      overlayClassName="modal-overlay"
      panelClassName="modal-dialog"
      initialFocusRef={inputRef}
      initialFocusPolicy="always"
    >
      <div className="modal-header">
        <h3 id="prompt-modal-title">{title}</h3>
      </div>
      <div className="modal-body">
        {label && (
          <label className="prompt-modal__label" htmlFor="prompt-modal-input">
            {label}
          </label>
        )}
        <input
          id="prompt-modal-input"
          ref={inputRef}
          className="prompt-modal__input"
          type="text"
          value={value}
          placeholder={placeholder}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !isComposingKeyEvent(e)) {
              e.preventDefault();
              submit();
            }
          }}
        />
        {error && <p className="prompt-modal__error">{error}</p>}
      </div>
      <ResponsiveSurfaceActions className="modal-footer">
        <Button variant="secondary" onClick={onCancel}>
          {cancelLabel}
        </Button>
        <Button
          variant="primary"
          onClick={submit}
          disabled={!value.trim() || !!error}
        >
          {confirmLabel}
        </Button>
      </ResponsiveSurfaceActions>
    </ResponsiveDialogSurface>
  );
}

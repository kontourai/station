import { useState } from 'react';
import { ConfirmModal } from './ConfirmModal';

interface NoteActionsProps {
  hasNote: boolean;
  dirty: boolean;
  saving: boolean;
  enhancing: boolean;
  vaulting: boolean;
  onNew: () => void;
  onSave: () => void;
  onEnhance: () => void;
  onVault: () => void;
  onDelete: () => void;
}

export function NoteActions({
  hasNote,
  dirty,
  saving,
  enhancing,
  vaulting,
  onNew,
  onSave,
  onEnhance,
  onVault,
  onDelete,
}: NoteActionsProps) {
  const [confirmDelete, setConfirmDelete] = useState(false);

  return (
    <div className="note-actions">
      <button
        type="button"
        className="note-action-btn"
        onClick={onNew}
        title="New note"
      >
        + New
      </button>

      {hasNote && (
        <>
          <button
            type="button"
            className={`note-action-btn note-action-btn--primary ${dirty ? 'note-action-btn--dirty' : ''}`}
            onClick={onSave}
            disabled={saving || !dirty}
            title="Save note"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>

          <button
            type="button"
            className="note-action-btn"
            onClick={onEnhance}
            disabled={enhancing}
            title="AI enhance note"
          >
            {enhancing ? 'Enhancing…' : '✨ Enhance'}
          </button>

          <button
            type="button"
            className="note-action-btn"
            onClick={onVault}
            disabled={vaulting}
            title="Save to vault"
          >
            {vaulting ? 'Saving…' : '🔒 Vault'}
          </button>

          <button
            type="button"
            className="note-action-btn note-action-btn--danger"
            onClick={() => setConfirmDelete(true)}
            title="Delete note"
          >
            Delete
          </button>
        </>
      )}

      <ConfirmModal
        isOpen={confirmDelete}
        title="Delete Note"
        message="Are you sure you want to delete this note? This cannot be undone."
        confirmLabel="Delete"
        variant="danger"
        onConfirm={() => {
          setConfirmDelete(false);
          onDelete();
        }}
        onCancel={() => setConfirmDelete(false)}
      />
    </div>
  );
}

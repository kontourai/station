import { useState, useSyncExternalStore } from 'react';
import {
  chatDraftsStore,
  type PortableDraft,
} from '../../contexts/chat-drafts-store';
import type { FileAttachment } from '../../types';
import {
  ResponsiveDialogHeader,
  ResponsiveDialogSurface,
} from '../ResponsiveDialogSurface';

interface PortableDraftsMenuProps {
  input: string;
  attachments: FileAttachment[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRestore: (draft: PortableDraft) => void;
}

export function PortableDraftsMenu({
  input,
  attachments,
  open,
  onOpenChange,
  onRestore,
}: PortableDraftsMenuProps) {
  const drafts = useSyncExternalStore(
    chatDraftsStore.subscribe,
    chatDraftsStore.getPortableSnapshot,
    chatDraftsStore.getPortableSnapshot,
  );
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const close = () => onOpenChange(false);

  return (
    <>
      <button
        type="button"
        className="chat-input__drafts-button"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => onOpenChange(true)}
      >
        Drafts
      </button>
      {open && (
        <ResponsiveDialogSurface
          ariaLabel="Portable drafts"
          onClose={close}
          historyMode="entry"
          overlayClassName="composer-popover-overlay composer-popover-overlay--end"
          panelClassName="composer-popover-panel"
        >
          <ResponsiveDialogHeader
            title="Portable drafts"
            closeLabel="Close portable drafts"
            onClose={close}
          />
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (!input.trim() && attachments.length === 0) return;
              setSaving(true);
              void chatDraftsStore
                .stash(name, input, attachments)
                .then(() => setName(''))
                .finally(() => setSaving(false));
            }}
          >
            <label>
              Draft name
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Name this prompt"
              />
            </label>
            <button
              type="submit"
              disabled={saving || (!input.trim() && attachments.length === 0)}
            >
              {saving ? 'Stashing…' : 'Stash current prompt'}
            </button>
          </form>
          <ul className="portable-drafts-menu__list" aria-label="Saved drafts">
            {drafts.map((draft) => (
              <li key={draft.id}>
                <button
                  type="button"
                  onClick={() => {
                    onRestore(draft);
                    close();
                  }}
                >
                  <strong>{draft.name}</strong>
                  <span>{draft.text || 'Image-only prompt'}</span>
                  {draft.droppedImageNames.length > 0 && (
                    <small>Dropped: {draft.droppedImageNames.join(', ')}</small>
                  )}
                  {draft.unreadableImageNames.length > 0 && (
                    <small>
                      Unreadable: {draft.unreadableImageNames.join(', ')}
                    </small>
                  )}
                </button>
              </li>
            ))}
          </ul>
        </ResponsiveDialogSurface>
      )}
    </>
  );
}

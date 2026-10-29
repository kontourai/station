import { useId, useState, useSyncExternalStore } from 'react';
import {
  chatDraftsStore,
  type PortableDraft,
} from '../../contexts/chat-drafts-store';
import type { FileAttachment } from '../../types';
import type { SavedAnswerQuote } from '../../utils/answer-quotes';
import { Button } from '../Button';
import { Dialog } from '../Dialog';
import { Empty } from '../state';
import './PortableDraftsMenu.css';
import { ComposerIconAction } from './ComposerIconAction';
import { composerDisplayValue } from './composer-mentions';

interface PortableDraftsMenuProps {
  quotes?: readonly SavedAnswerQuote[];
  input: string;
  attachments: FileAttachment[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRestore: (draft: PortableDraft) => void;
}

export function PortableDraftsMenu({
  input,
  quotes = [],
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
  const nameId = useId();
  const [name, setName] = useState('');
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const close = () => onOpenChange(false);

  return (
    <>
      <ComposerIconAction
        label="Drafts"
        className="chat-input__drafts-button"
        expanded={open}
        onClick={() => onOpenChange(true)}
      >
        <svg
          viewBox="0 0 24 24"
          width="18"
          height="18"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          aria-hidden="true"
        >
          <path d="M7 3h8l4 4v14H7z" />
          <path d="M15 3v5h4M10 12h6M10 16h6M3 7v14" />
        </svg>
      </ComposerIconAction>
      {open && (
        <Dialog
          title="Saved drafts"
          subtitle="Keep a prompt to use in another chat on this device."
          closeLabel="Close saved drafts"
          onClose={close}
          historyMode="entry"
          panelClassName="portable-drafts-menu"
        >
          <form
            className="portable-drafts-menu__form"
            onSubmit={(event) => {
              event.preventDefault();
              if (
                !input.trim() &&
                attachments.length === 0 &&
                quotes.length === 0
              )
                return;
              setSaving(true);
              void chatDraftsStore
                .stash(name, input, attachments, undefined, quotes)
                .then(() => {
                  setName('');
                  setSaved(true);
                })
                .finally(() => setSaving(false));
            }}
          >
            <label htmlFor={nameId}>
              Draft name <span>(optional)</span>
            </label>
            <input
              id={nameId}
              value={name}
              onChange={(event) => {
                setName(event.target.value);
                setSaved(false);
              }}
              placeholder="Use the prompt text as the name"
            />
            <Button
              variant="primary"
              type="submit"
              disabled={
                saving ||
                (!input.trim() &&
                  attachments.length === 0 &&
                  quotes.length === 0)
              }
            >
              {saving ? 'Saving…' : 'Save current prompt'}
            </Button>
            <p className="portable-drafts-menu__hint" role="status">
              {saved
                ? 'Draft saved. Your current message is still in the composer.'
                : 'Saves a copy of your message, attachments, and quoted context.'}
            </p>
          </form>
          <h3 className="portable-drafts-menu__heading">Saved prompts</h3>
          {drafts.length === 0 && (
            <Empty
              label="Save prompts for later"
              description="Write a message in the composer, then save it here to reuse later. Drafts stay on this device."
            />
          )}
          <ul className="portable-drafts-menu__list" aria-label="Saved drafts">
            {drafts.map((draft) => (
              <li key={draft.id}>
                <Button
                  variant="ghost"
                  className="portable-drafts-menu__draft"
                  type="button"
                  onClick={() => {
                    onRestore(draft);
                    close();
                  }}
                >
                  <strong>{draft.name}</strong>
                  <span>
                    {composerDisplayValue(draft.text) ||
                      (draft.quotes?.length
                        ? 'Quoted context'
                        : 'Image-only prompt')}
                  </span>
                  {draft.droppedImageNames.length > 0 && (
                    <small>Dropped: {draft.droppedImageNames.join(', ')}</small>
                  )}
                  {draft.unreadableImageNames.length > 0 && (
                    <small>
                      Unreadable: {draft.unreadableImageNames.join(', ')}
                    </small>
                  )}
                </Button>
              </li>
            ))}
          </ul>
        </Dialog>
      )}
    </>
  );
}

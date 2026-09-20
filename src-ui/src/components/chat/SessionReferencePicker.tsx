import { useState } from 'react';
import {
  appendComposerSessionReference,
  sessionReferenceBlockReason,
} from './composer-mentions';

export const SESSION_REFERENCE_DRAG_TYPE =
  'application/x-station-conversation-reference';

export interface SessionReferenceCandidate {
  id: string;
  title: string;
  projectSlug?: string;
}

export function SessionReferencePicker({
  value,
  candidates,
  activeConversationId,
  authority,
  isCurrent,
  onChange,
}: {
  value: string;
  candidates: readonly SessionReferenceCandidate[];
  activeConversationId?: string;
  authority?: string | null;
  isCurrent?: () => boolean;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const stage = (candidate: SessionReferenceCandidate) => {
    const reason = sessionReferenceBlockReason({
      value,
      conversationId: candidate.id,
      activeConversationId,
      authority,
      isCurrent,
    });
    if (reason) return;
    onChange(
      appendComposerSessionReference(value, {
        label: candidate.title || 'Conversation',
        conversationId: candidate.id,
        projectSlug: candidate.projectSlug,
        authority: authority!,
      }),
    );
    setOpen(false);
  };
  return (
    <div className="session-reference-picker">
      <button
        type="button"
        className="composer-actions-menu__trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="Reference a conversation"
        title="Reference a conversation"
        disabled={!authority || isCurrent?.() === false}
        onClick={() => setOpen((current) => !current)}
      >
        <span aria-hidden="true">↗</span>
      </button>
      {open ? (
        <div
          className="file-mention-picker session-reference-picker__list"
          role="listbox"
          aria-label="Conversations"
        >
          {candidates.length === 0 ? (
            <div className="file-mention-picker__status">
              No conversations available
            </div>
          ) : null}
          {candidates.slice(0, 100).map((candidate) => {
            const reason = sessionReferenceBlockReason({
              value,
              conversationId: candidate.id,
              activeConversationId,
              authority,
              isCurrent,
            });
            return (
              <button
                key={candidate.id}
                type="button"
                role="option"
                aria-selected="false"
                className="file-mention-picker__option"
                disabled={!!reason}
                title={reason ?? candidate.title}
                draggable={!reason}
                onDragStart={(event) => {
                  if (reason) return;
                  event.dataTransfer.setData(
                    SESSION_REFERENCE_DRAG_TYPE,
                    candidate.id,
                  );
                }}
                onClick={() => stage(candidate)}
              >
                <span aria-hidden="true">↗</span>
                <span>{candidate.title || 'Conversation'}</span>
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

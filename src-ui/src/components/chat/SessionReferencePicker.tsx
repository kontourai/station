import { useState } from 'react';
import {
  ResponsiveDialogHeader,
  ResponsiveDialogSurface,
} from '../ResponsiveDialogSurface';
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
  onClose,
}: {
  value: string;
  candidates: readonly SessionReferenceCandidate[];
  activeConversationId?: string;
  authority?: string | null;
  isCurrent?: () => boolean;
  onChange: (value: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
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
    onClose();
  };
  const visible = candidates
    .filter((candidate) =>
      `${candidate.title} ${candidate.projectSlug ?? ''}`
        .toLocaleLowerCase()
        .includes(query.toLocaleLowerCase()),
    )
    .slice(0, 8);
  return (
    <ResponsiveDialogSurface
      layer="popover"
      ariaLabel="Reference a conversation"
      onClose={onClose}
      historyMode="entry"
      overlayClassName="composer-popover-overlay composer-popover-overlay--start"
      panelClassName="composer-popover-panel"
    >
      <ResponsiveDialogHeader
        title="Reference a conversation"
        closeLabel="Close conversation references"
        onClose={onClose}
      />
      <input
        aria-label="Find conversations"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Find a conversation"
        disabled={!authority || isCurrent?.() === false}
      />
      <div
        className="file-mention-picker session-reference-picker__list"
        role="listbox"
        aria-label="Conversations"
      >
        {visible.length === 0 ? (
          <div className="file-mention-picker__status">
            No matching conversations
          </div>
        ) : null}
        {visible.map((candidate) => {
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
    </ResponsiveDialogSurface>
  );
}

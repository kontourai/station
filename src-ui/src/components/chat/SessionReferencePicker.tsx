import { fetchConversationInventory } from '@kontourai/station-sdk';
import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ResponsiveDialogHeader,
  ResponsiveDialogSurface,
} from '../ResponsiveDialogSurface';
import {
  appendComposerSessionReference,
  sessionReferenceBlockReason,
} from './composer-mentions';

const SESSION_REFERENCE_DRAG_TYPE =
  'application/x-station-conversation-reference';

export interface SessionReferenceCandidate {
  id: string;
  title: string;
  projectSlug?: string;
}

export function SessionReferencePicker({
  value,
  activeConversationId,
  authority,
  requestScope,
  onChange,
  onClose,
  onCandidateDragged,
}: {
  value: string;
  activeConversationId?: string;
  authority?: string | null;
  requestScope?: {
    apiBase: string;
    authorityKey: string;
    isCurrent: () => boolean;
  };
  onChange: (value: string) => void;
  onClose: () => void;
  onCandidateDragged: (candidate: SessionReferenceCandidate | null) => void;
}) {
  const [query, setQuery] = useState('');
  const [dragging, setDragging] = useState(false);
  const draggingRef = useRef(false);
  const dragOverlay = useRef<HTMLElement | null>(null);
  const dragSource = useRef<HTMLElement | null>(null);
  const finishDrag = useCallback(() => {
    dragOverlay.current?.classList.remove(
      'session-reference-picker__drag-passthrough',
    );
    dragOverlay.current = null;
    dragSource.current?.classList.remove(
      'session-reference-picker__drag-source',
    );
    dragSource.current = null;
    draggingRef.current = false;
    setDragging(false);
    onCandidateDragged(null);
  }, [onCandidateDragged]);
  useEffect(() => {
    if (!dragging) return;
    const onDragEnd = () => finishDrag();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') finishDrag();
    };
    window.addEventListener('dragend', onDragEnd, true);
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.removeEventListener('dragend', onDragEnd, true);
      window.removeEventListener('keydown', onKeyDown, true);
    };
  }, [dragging, finishDrag]);
  const inventory = useQuery({
    queryKey: [
      'conversation-reference-candidates',
      requestScope?.apiBase ?? '',
      requestScope?.authorityKey ?? '',
    ],
    queryFn: async ({ signal }) => {
      try {
        return {
          page: await fetchConversationInventory(requestScope?.apiBase, {
            limit: 25,
            signal,
            requestScope,
          }),
          unavailable: false as const,
        };
      } catch {
        return { page: null, unavailable: true as const };
      }
    },
    enabled: !!authority && requestScope?.isCurrent() === true,
    staleTime: 0,
    retry: false,
  });
  const candidates = (
    inventory.isFetching ? [] : (inventory.data?.page?.items ?? [])
  )
    .filter((conversation) => conversation.referenceEligibility?.eligible)
    .map((conversation) => ({
      id: conversation.id,
      title: conversation.title,
      ...(conversation.projectSlug
        ? { projectSlug: conversation.projectSlug }
        : {}),
    }));
  const stage = (candidate: SessionReferenceCandidate) => {
    const reason = sessionReferenceBlockReason({
      value,
      conversationId: candidate.id,
      activeConversationId,
      authority,
      isCurrent: requestScope?.isCurrent,
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
  const inventoryPage = inventory.data?.page;
  const emptyMessage = (() => {
    if (!inventoryPage || visible.length > 0) return null;
    const searched = inventoryPage.items.length;
    const hasQuery = query.trim().length > 0;
    if (hasQuery)
      return inventoryPage.hasMore
        ? `No matches in the ${searched} most recent conversations. Older conversations aren’t searched.`
        : 'No matching conversations';
    if (candidates.length === 0) {
      if (inventoryPage.hasMore)
        return `No referenceable conversations in the ${searched} most recent. Older conversations aren’t shown.`;
      return searched === 0
        ? 'No conversations yet'
        : 'No conversations available to reference';
    }
    return null;
  })();
  return (
    <ResponsiveDialogSurface
      layer="popover"
      ariaLabel="Reference a conversation"
      onClose={() => {
        if (dragging) finishDrag();
        onClose();
      }}
      historyMode="entry"
      overlayClassName={`composer-popover-overlay composer-popover-overlay--start${dragging ? ' session-reference-picker__drag-passthrough' : ''}`}
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
        disabled={!authority || requestScope?.isCurrent() !== true}
      />
      <div
        className="file-mention-picker session-reference-picker__list"
        role="listbox"
        aria-label="Conversations"
      >
        {inventory.isFetching ? (
          <div className="file-mention-picker__status" role="status">
            Loading conversations…
          </div>
        ) : null}
        {!inventory.isFetching && inventory.data?.unavailable ? (
          <div className="file-mention-picker__status" role="alert">
            Conversations are unavailable. Close and try again.
          </div>
        ) : null}
        {!inventory.isFetching &&
        inventory.isSuccess &&
        !inventory.data.unavailable &&
        emptyMessage ? (
          <div className="file-mention-picker__status">{emptyMessage}</div>
        ) : null}
        {visible.map((candidate) => {
          const reason = sessionReferenceBlockReason({
            value,
            conversationId: candidate.id,
            activeConversationId,
            authority,
            isCurrent: requestScope?.isCurrent,
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
              onPointerDown={(event) => {
                if (reason) return;
                dragOverlay.current = event.currentTarget.closest<HTMLElement>(
                  '.composer-popover-overlay',
                );
                dragOverlay.current?.classList.add(
                  'session-reference-picker__drag-passthrough',
                );
                dragSource.current = event.currentTarget;
                dragSource.current.classList.add(
                  'session-reference-picker__drag-source',
                );
              }}
              onPointerUp={() => {
                if (!draggingRef.current) finishDrag();
              }}
              onPointerCancel={finishDrag}
              onDragStart={(event) => {
                if (reason) return;
                draggingRef.current = true;
                setDragging(true);
                onCandidateDragged(candidate);
                event.dataTransfer.setData(
                  SESSION_REFERENCE_DRAG_TYPE,
                  candidate.id,
                );
              }}
              onDragEnd={finishDrag}
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

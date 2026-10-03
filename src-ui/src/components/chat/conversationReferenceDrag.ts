import type React from 'react';

/**
 * #3159: dragging a conversation onto a composer, from the reference picker
 * or from an Activity or inbox row.
 *
 * The drop never trusts `dataTransfer` for anything but the id: another
 * window, tab or app can put any string under this type. What becomes a
 * reference is the row this window itself started dragging, and only when
 * it came from the same Station access scope as the composer it lands on.
 */
export const CONVERSATION_REFERENCE_DRAG_TYPE =
  'application/x-station-conversation-reference';

export interface DraggedConversationReference {
  id: string;
  title: string;
  projectSlug?: string;
  /** The Station access scope the row was listed under. */
  apiBase: string;
  authorityKey: string;
}

let dragged: DraggedConversationReference | null = null;

/** A row drag source: records custody and sets the drag payload. */
export function startConversationReferenceDrag(
  event: React.DragEvent<HTMLElement>,
  reference: DraggedConversationReference,
): void {
  dragged = reference;
  event.dataTransfer.setData(CONVERSATION_REFERENCE_DRAG_TYPE, reference.id);
  event.dataTransfer.effectAllowed = 'copyLink';
}

export function endConversationReferenceDrag(): void {
  dragged = null;
}

/** The row this window is dragging, if it is `id` and from `scope`. */
export function draggedConversationReference(
  id: string,
  scope: { apiBase: string; authorityKey: string } | undefined,
): DraggedConversationReference | null {
  return dragged &&
    scope &&
    dragged.id === id &&
    dragged.apiBase === scope.apiBase &&
    dragged.authorityKey === scope.authorityKey
    ? dragged
    : null;
}

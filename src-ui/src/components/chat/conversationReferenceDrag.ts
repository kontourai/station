import type React from 'react';
import { useSyncExternalStore } from 'react';

/**
 * #3159: dragging a conversation onto a composer, from the reference picker
 * or from an Activity or inbox row.
 *
 * The drop never trusts `dataTransfer` for anything but the id: another
 * window, tab or app can put any string under this type. What becomes a
 * reference is the row this window itself started dragging, and only when
 * it came from the same Station as the composer it lands on.
 */
export const CONVERSATION_REFERENCE_DRAG_TYPE =
  'application/x-station-conversation-reference';

export interface DraggedConversationReference {
  id: string;
  title: string;
  projectSlug?: string;
  /** The Station the row was listed from. */
  apiBase: string;
}

/**
 * The conversations a message may reference, as the conversation inventory
 * says (`referenceEligibility`), for the Station it was read from. Published
 * by the dock, which reads that inventory; rows read it to decide whether
 * they are drag sources. `null` until published: nothing is draggable.
 */
export interface ReferenceableConversations {
  apiBase: string;
  ids: ReadonlySet<string>;
}

let dragged: DraggedConversationReference | null = null;
let referenceable: ReferenceableConversations | null = null;
const listeners = new Set<() => void>();

export function publishReferenceableConversations(
  next: ReferenceableConversations | null,
): void {
  referenceable = next;
  for (const listener of listeners) listener();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export function useReferenceableConversations(): ReferenceableConversations | null {
  return useSyncExternalStore(
    subscribe,
    () => referenceable,
    () => null,
  );
}

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

/** The row this window is dragging, if it is `id` and from `scope`'s Station. */
export function draggedConversationReference(
  id: string,
  scope: { apiBase: string } | undefined,
): DraggedConversationReference | null {
  return dragged &&
    scope &&
    dragged.id === id &&
    dragged.apiBase === scope.apiBase
    ? dragged
    : null;
}

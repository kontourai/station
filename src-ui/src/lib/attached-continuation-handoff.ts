/**
 * #3552: Activity shows an external conversation as the ordinary chat, but a
 * continuation is made and followed up only in the chat dock (#3454): the
 * dock opens the continued conversation as its Agent's chat, which is what
 * keeps follow-ups in the conversation's own folder. So a message typed in
 * Activity is handed to the dock's reader of the same conversation, which
 * asks once to confirm and then continues with that exact text.
 *
 * One pending hand-off at a time, taken once by the reader it names. A reader
 * already open on that conversation is told, since it will not remount.
 */
type Handoff = { threadId: string; draft: string; scope?: string };

export function attachedContinuationScope(
  stationId: string | null,
  apiBase: string,
): string {
  return JSON.stringify([stationId, apiBase]);
}

let pending: Handoff | null = null;
const listeners = new Set<() => void>();

export function handOffAttachedContinuation(handoff: Handoff): void {
  pending = handoff;
  for (const listener of listeners) listener();
}

/** The draft handed to this conversation's reader, consumed on read. */
export function takeAttachedContinuationHandoff(
  threadId: string,
  scope?: string,
): string | null {
  if (
    !pending ||
    pending.threadId !== threadId ||
    (pending.scope !== undefined && pending.scope !== scope)
  )
    return null;
  const { draft } = pending;
  pending = null;
  return draft;
}

/**
 * The dock's reader of this conversation is gone without taking its draft
 * (it never loaded, or the person closed it): drop it, so it cannot surface
 * later in an unrelated visit.
 */
export function discardAttachedContinuationHandoff(
  threadId: string,
  scope?: string,
): void {
  if (
    pending?.threadId === threadId &&
    (pending.scope === undefined || pending.scope === scope)
  )
    pending = null;
}

export function subscribeAttachedContinuationHandoff(
  listener: () => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

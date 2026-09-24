import type { HomeWorkItem } from './home-view-model';

/**
 * #2312: a Draft untouched for longer than this is collapsed under
 * "N older drafts" in every Drafts group. Presentation only — nothing is
 * deleted, and the server remains the source of the Draft fact itself.
 */
const DRAFT_AGE_OUT_MS = 24 * 60 * 60 * 1000;

/**
 * Splits a Drafts group by the recency each row already carries (`updatedAt`,
 * epoch ms — the session summary's recency). A row with no recency (`<= 0`)
 * stays in the recent part: an unknown age is not evidence of an old one.
 */
export function splitDraftsByAge<T extends { updatedAt: number }>(
  drafts: readonly T[],
  now: number,
): { recent: T[]; older: T[] } {
  const recent: T[] = [];
  const older: T[] = [];
  for (const draft of drafts) {
    if (draft.updatedAt > 0 && now - draft.updatedAt > DRAFT_AGE_OUT_MS)
      older.push(draft);
    else recent.push(draft);
  }
  return { recent, older };
}

/** "1 older draft" / "3 older drafts". */
export function olderDraftsLabel(count: number): string {
  return `${count} older ${count === 1 ? 'draft' : 'drafts'}`;
}

/**
 * The session a row's "Discard draft" action targets, or `null` when the row
 * offers none. Only a row labelled Draft — which is the server's
 * `OrchestrationSessionSummary.draft` fold — and only with a server session
 * to name: a chat-only row has nothing the server could delete. The server
 * re-derives the fact before deleting, so a stale label is refused there.
 */
export function draftDiscardThreadId(
  item: Pick<HomeWorkItem, 'lifecycleLabel' | 'orchestrationThreadId'>,
): string | null {
  return item.lifecycleLabel === 'Draft' && item.orchestrationThreadId
    ? item.orchestrationThreadId
    : null;
}

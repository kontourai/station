/**
 * Getting the user to a pending approval's own card, wherever it is.
 *
 * Two surfaces point at approvals: the chat pane's status pill (this chat's
 * requests) and the app-wide "Approval needed" queue (every request). A card
 * can be on screen, scrolled out of view, or not mounted at all (a long
 * transcript virtualizes its rows), so a jump asks the transcript that owns
 * the request to bring its row in (`REVEAL_APPROVAL_EVENT`, handled by
 * `ChatMessageList`), then focuses the card's first decision button.
 */
export const REVEAL_APPROVAL_EVENT = 'station:reveal-approval';

export interface RevealApprovalDetail {
  requestId: string;
  /** The request's thread, when known; request ids are already unique. */
  threadId?: string;
}

function cardFor(
  root: ParentNode,
  { requestId, threadId }: RevealApprovalDetail,
): HTMLElement | undefined {
  return Array.from(
    root.querySelectorAll<HTMLElement>('[data-approval-id]'),
  ).find(
    (element) =>
      element.dataset.approvalId === requestId &&
      (threadId === undefined || element.dataset.approvalThread === threadId),
  );
}

/** Mounted and laid out (a hidden or collapsed card has no box). */
function isRendered(element: HTMLElement): boolean {
  const box = element.getBoundingClientRect();
  return box.width > 0 && box.height > 0;
}

function focusCard(card: HTMLElement) {
  card.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
  const sheetTrigger = card.querySelector<HTMLButtonElement>(
    '.request-sheet-trigger:not(:disabled)',
  );
  if (sheetTrigger) {
    sheetTrigger.click();
    return;
  }
  card
    .querySelector<HTMLButtonElement>('.tool-call__approve-btn:not(:disabled)')
    ?.focus({ preventScroll: true });
}

/**
 * Bring one request's card into view and focus it. Resolves true when a
 * rendered card took focus. A card that is not mounted yet is requested from
 * its transcript and awaited for a few frames.
 */
export async function revealApprovalCard(
  detail: RevealApprovalDetail,
  root: ParentNode = document,
): Promise<boolean> {
  const present = cardFor(root, detail);
  if (present && isRendered(present)) {
    focusCard(present);
    return true;
  }
  window.dispatchEvent(
    new CustomEvent<RevealApprovalDetail>(REVEAL_APPROVAL_EVENT, { detail }),
  );
  for (let frame = 0; frame < 12; frame += 1) {
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const card = cardFor(root, detail);
    if (card && isRendered(card)) {
      focusCard(card);
      return true;
    }
  }
  return false;
}

// ── Which threads' approvals a visible chat pane is presenting ─────────────
// A chat pane that shows its own approval in its status pill claims that
// chat's threads, so the app-wide queue does not float a second copy of the
// same decision over the pane (it used to sit on the pane header's `…`).

const claims = new Map<symbol, readonly string[]>();
const listeners = new Set<() => void>();
let snapshot: ReadonlySet<string> = new Set();

function publish() {
  snapshot = new Set([...claims.values()].flat());
  for (const listener of listeners) listener();
}

export function claimApprovalThreads(threadIds: readonly string[]): () => void {
  const key = Symbol('approval-claim');
  claims.set(key, threadIds);
  publish();
  return () => {
    claims.delete(key);
    publish();
  };
}

export function subscribeApprovalClaims(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getApprovalClaims(): ReadonlySet<string> {
  return snapshot;
}

/** Focus a card that is already mounted and laid out; false when none is. */
export function focusRenderedApprovalCard(
  detail: RevealApprovalDetail,
  root: ParentNode = document,
): boolean {
  const card = cardFor(root, detail);
  if (!card || !isRendered(card)) return false;
  focusCard(card);
  return true;
}

/** Ask the app-wide approval queue to open, listing every request. */
export const OPEN_APPROVAL_QUEUE_EVENT = 'station:open-approval-queue';

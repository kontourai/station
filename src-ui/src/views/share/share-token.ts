import {
  ANSWER_SHARE_TOKEN_FRAGMENT_KEY,
  readAnswerShareTokenFromFragment,
} from '@kontourai/station-contracts/answer-share';

/**
 * Capture-and-scrub for the permalink's share token (station#1423, security
 * review L-3 and N-2).
 *
 * L-3 wants the token out of the address bar the moment it has been read: a
 * fragment is already never sent to a server, but it is still visible on
 * screen, kept in session history, and restored by session restore.
 *
 * N-2 is what that broke. Once scrubbed, the error boundary's Reload button
 * and any ordinary refresh reloaded a URL with no token — so the recovery
 * affordance was guaranteed to fail, under copy that blamed the recipient for
 * "copying only part of the link". So the token is kept in module state for
 * the lifetime of the page and written BACK into the fragment immediately
 * before a deliberate reload. Module scope rather than a React ref because
 * the error boundary lives outside the component tree that holds the ref —
 * that is the whole case it has to serve.
 *
 * Deliberately not `sessionStorage`: this is a capability, and persisting it
 * anywhere the browser keeps across a tab's lifetime is the thing L-3 is
 * reducing, not adding to.
 */

let captured: string | undefined;

/**
 * Reads the token from the fragment, remembers it, and clears the fragment.
 * Returns the token, or `undefined` when the link carried none.
 *
 * Idempotent across re-mounts: after the first call the fragment is empty, so
 * later calls answer from the captured value rather than concluding the link
 * was incomplete.
 */
export function captureShareToken(): string | undefined {
  const fromFragment = readAnswerShareTokenFromFragment(window.location.hash);
  if (fromFragment) {
    captured = fromFragment;
    window.history.replaceState(
      null,
      '',
      `${window.location.pathname}${window.location.search}`,
    );
  }
  return fromFragment ?? captured;
}

/** The token this page loaded with, if it had one. */
export function capturedShareToken(): string | undefined {
  return captured;
}

/**
 * Restores the fragment and reloads. The only supported way to reload this
 * page: a bare `location.reload()` after {@link captureShareToken} has run
 * would drop the token and land on the missing-token state, which is a
 * recovery affordance that guarantees its own failure.
 */
export function reloadSharePage(): void {
  if (captured) {
    window.location.hash = `${ANSWER_SHARE_TOKEN_FRAGMENT_KEY}=${captured}`;
  }
  window.location.reload();
}

/** Test seam only — module state would otherwise leak between cases. */
export function resetCapturedShareTokenForTests(): void {
  captured = undefined;
}

/**
 * The bound on `resolveLocalUiSession`'s retry of an `unavailable` host answer
 * (#1639), as data with no DOM dependency.
 *
 * Separate from `local-ui-bootstrap.ts` because the first-run readiness wait
 * budgets for this ladder (`tests/helpers/local-ui-access-readiness.ts`) and is
 * typechecked in a Node-only project. Importing the resolver from there drags
 * `window` into a lane that has no DOM lib; the policy the two must agree on is
 * these three values, so they live where both can read them.
 */

/**
 * How long to wait before each retry of the identity read, in order. The LENGTH
 * of this list is the retry bound: there is no other way to add an attempt.
 *
 * Deliberately short. What makes a second attempt succeed is that the host
 * answered in the meantime, not that this waited a long time — so the wait's
 * only job is to not hammer a proxy that just said it was starved.
 */
export const LOCAL_UI_SESSION_HOST_RETRY_DELAYS_MS = [250, 750] as const;

/** Total identity reads one resolution may make, retries included. */
export const LOCAL_UI_SESSION_ATTEMPT_LIMIT =
  LOCAL_UI_SESSION_HOST_RETRY_DELAYS_MS.length + 1;

/**
 * The deliberate waiting a full retry ladder adds to a resolution. It does NOT
 * include the extra requests themselves, which cost whatever the host takes to
 * answer — a caller budgeting for the gate to settle owes both.
 */
export const LOCAL_UI_SESSION_HOST_RETRY_TOTAL_DELAY_MS =
  LOCAL_UI_SESSION_HOST_RETRY_DELAYS_MS.reduce((total, ms) => total + ms, 0);

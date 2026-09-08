/**
 * The bounds on `resolveLocalUiSession`'s identity read — how often it retries an
 * `unavailable` host answer (#1639) and how long it waits on any one of them
 * (#1661) — as data with no DOM dependency.
 *
 * Separate from `local-ui-bootstrap.ts` because the first-run readiness wait
 * budgets for this ladder (`tests/helpers/local-ui-access-readiness.ts`) and is
 * typechecked in a Node-only project. Importing the resolver from there drags
 * `window` into a lane that has no DOM lib; the policy the two must agree on is
 * these values, so they live where both can read them.
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

/**
 * The slowest `/api/system/identity` answer ever measured from this gate: a
 * loaded host took this long to answer `{"ready":false,"status":"unavailable"}`
 * through the UI proxy (station#1617).
 *
 * A SAMPLE, and it is here as the evidence the first deadline below is answerable
 * to rather than as a budget — `tests/helpers/local-ui-access-readiness.ts` used
 * to multiply it as though it were a bound, which is what #1661 is about. The
 * relationship between the two is pinned by
 * `scripts/__tests__/local-ui-access-readiness.test.ts`, so shrinking the
 * deadline toward this sample fails a test rather than a user's page load.
 */
export const OBSERVED_SLOW_IDENTITY_ANSWER_MS = 6_600;

/**
 * How long ONE identity read may take before the gate stops waiting on it, per
 * attempt in order (#1661). The list's length is `LOCAL_UI_SESSION_ATTEMPT_LIMIT`
 * and `scripts/__tests__/local-ui-access-readiness.test.ts` pins that, because a
 * short list would leave an attempt with no deadline at all.
 *
 * WHY THE GATE OWNS A DEADLINE. Before this, the only bound on one read was the
 * UI proxy's own 30 s upstream timeout (`proxyToBackend`,
 * `packages/cli/src/commands/lifecycle.ts`), so the gate's worst case was
 * inherited rather than declared — and the first-run readiness budget was derived
 * from a single 6.6 s observed sample of a loaded host (station#1617), roughly a
 * quarter of what one attempt could legitimately spend. Fixing station#1654 put a
 * long answer INSIDE the retry ladder instead of ending it, which made the gap
 * guaranteed rather than possible. A deadline the client declares is what turns
 * the readiness budget into a derivation.
 *
 * ESCALATING, WITH THE LAST ATTEMPT THE LONGEST. The last attempt is the last
 * chance, so extra time buys the most there: a host too slow for the first two
 * rungs can still get in on the third. The readiness budget spends the FIRST
 * entry three times (twice in the ladder, once as the answer on the reloaded
 * page) and the last entry once, so a longer final attempt is close to free.
 *
 * SAFE UNDER LOAD, and this is why the early deadlines can be aggressive: an
 * abandoned read does not leave its work running. The client abort closes the
 * socket, and the proxy's `res.on('close')` destroys the upstream request with
 * it, so three aborted attempts do not triple a starved host's work — each one
 * cancels upstream as it goes.
 *
 * THE RESIDUAL BAND, for a working host that needs T ms to answer identity:
 *
 *  - T <= 10 000: admitted on the first attempt, at T. Unchanged, and this is
 *    where the one measured loaded host (6.6 s) sits, with 3.4 s of slack.
 *  - 10 000 < T <= 16 000: admitted LATE, on the third attempt, at about
 *    T + 21 000 (two aborted reads plus 1 s of backoff) — up to ~37 s. Today
 *    such a host is admitted at T.
 *  - T > 16 000: REFUSED where today it is admitted. The gate spends ~37 s and
 *    renders "Reconnecting to this Station"; the reload it offers starts a fresh
 *    ladder that fails the same way, so a host this slow is effectively locked
 *    out until it speeds up. Today it gets in at T, up to the proxy's 30 s.
 *  - T >= 30 000: not admitted before or after. The difference is the report —
 *    today the proxy's timeout answer sends this browser to PAIR (station#1654);
 *    now it is named as a host that is away, with this browser's access intact.
 *
 * The band's upper edge is a deliberate trade of "degraded" against "broken" and
 * cost the first-run journey's ceiling 20 s to narrow (`tests/first-run-live`
 * `.spec.ts`). It is bounded below by evidence — 10 000 is 1.5x the only slow
 * answer ever measured — and above by that budget, not by a preference.
 */
export const LOCAL_UI_SESSION_IDENTITY_DEADLINES_MS = [
  10_000, 10_000, 16_000,
] as const;

/**
 * The deadline governing one attempt, by its zero-based index.
 *
 * Past the list's end it is the LAST entry, not `undefined`: a drifting list must
 * fail closed at a bounded wait rather than leave an attempt with no deadline at
 * all. `scripts/__tests__/local-ui-access-readiness.test.ts` pins the list's
 * length to the attempt limit, so that fallback is unreachable today.
 */
export function localUiSessionIdentityDeadlineMs(attemptIndex: number): number {
  return (
    LOCAL_UI_SESSION_IDENTITY_DEADLINES_MS[attemptIndex] ??
    LOCAL_UI_SESSION_IDENTITY_DEADLINES_MS[
      LOCAL_UI_SESSION_IDENTITY_DEADLINES_MS.length - 1
    ]
  );
}

/**
 * What a full ladder of identity reads may spend on the READS themselves, with
 * every attempt hitting its deadline. Separate from
 * `LOCAL_UI_SESSION_HOST_RETRY_TOTAL_DELAY_MS`, which is only the deliberate
 * waiting between them; a caller budgeting for the gate to settle owes both.
 */
export const LOCAL_UI_SESSION_IDENTITY_TOTAL_DEADLINE_MS =
  LOCAL_UI_SESSION_IDENTITY_DEADLINES_MS.reduce((total, ms) => total + ms, 0);

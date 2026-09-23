import type { ProviderSession } from './provider.js';
import type { SessionLifecycleState } from './session-lifecycle.js';

/**
 * DOES THIS SESSION NEED THE USER — the one ordered adjudication, shared by
 * the two surfaces that answer it (station#3227 B1).
 *
 * Before this module the answer was derived twice: the client fold
 * (`src-ui/src/utils/session-state.ts`, `orchestrationLifecycleLabel`) and
 * the server's attention projection (`src-server/services/projects/
 * attention-projection.ts`, `projectLifecycle`), with nothing holding them
 * together. They had already drifted three reachable ways, every one
 * probe-confirmed live:
 *
 * - a `blocked` session sat under "Needs you" and in the project badge while
 *   the bell counted 0 — the server had no `blocked` arm;
 * - a `status: 'closed'` session with a stale `needs_input` lifecycleState
 *   was filed under Recently finished on every client surface while the bell
 *   still counted it — the server had no closed short-circuit;
 * - the same for a closed session with a sticky `pendingReview` flag.
 *
 * The ORDER is the contract, and it is the client fold's order because each
 * step of it is a fixed defect:
 *
 * 1. `failed` outranks everything — including a first send that did not
 *    take (`isFirstSendFailure`, #2310). `status` (transport state) and
 *    `lifecycleState` (event-fold outcome) are independent, so a runtime that
 *    crashes and then has its connection torn down (`status: 'closed'`) must
 *    read Failed, never Completed (station#1296 review).
 * 2. finished — `completed`/`canceled`, or a session the board explicitly
 *    closed (`status: 'closed'`), can never need attention: a stale sticky
 *    flag must not outrank a session that has actually ended.
 * 3. awaiting — `pendingReview`, or a `needs_input`/`review_pending`/
 *    `blocked` lifecycleState: the session is waiting on the user. `via`
 *    names which door it came through, in the server's established
 *    precedence: a `needs_input` state is the most specific ask, then a
 *    pending review (flag or state), then a bare `blocked` state.
 * 4. active — everything else; whether that renders Running or Ready is the
 *    client's `hasActiveTurn` refinement (#1069), deliberately not decided
 *    here.
 *
 * TWO FACTS STAY CONSUMER-SIDE ON PURPOSE, so this module cannot silently
 * adjudicate what the surfaces deliberately adjudicate differently:
 *
 * - `answerability`: within `awaiting`, the client relabels an unanswerable
 *   session (`'Unanswerable'`, de-prioritized but never dropped —
 *   station#1783) while the server projects nothing (the bell counts
 *   ACTIONABLE items only — station#1745). Same input, different documented
 *   renderings of it.
 * - the server's request-outranks-failure exception: within `failed`, an
 *   answerable session with `pendingReview` still projects the more specific
 *   `review_pending` ITEM (station#1548 — the open approval is still
 *   genuinely outstanding on a retryable failure) while every client label
 *   reads Failed. The item says what to DO; the label says what happened.
 *   Both are true, both are pinned by their own tests.
 */
export interface SessionAttentionSubject {
  lifecycleState?: SessionLifecycleState;
  status?: ProviderSession['status'];
  pendingReview?: boolean;
  /** Only `kind` is read — see {@link isFirstSendFailure}. */
  terminalAttribution?: { kind: string };
}

/**
 * #2310: the conversation's only sends did not take and no activity has been
 * recorded since (`terminalAttribution.kind` `send_refused`/`send_failed`,
 * derived by the server from command receipts). The session's
 * `lifecycleState` is left as the event fold — control paths such as
 * conversation continuation treat it as runtime truth — so every surface
 * that asks "did this fail?" must ask this too. {@link
 * sessionAttentionDisposition} does.
 */
export function isFirstSendFailure(
  subject: Pick<SessionAttentionSubject, 'terminalAttribution'>,
): boolean {
  const kind = subject.terminalAttribution?.kind;
  return kind === 'send_refused' || kind === 'send_failed';
}

/** Which door an `awaiting` session came through — and, server-side, which attention kind it projects. */
export type SessionAwaitingVia = 'needs_input' | 'review_pending' | 'blocked';

export type SessionAttentionDisposition =
  | { state: 'failed' }
  | { state: 'finished' }
  | { state: 'awaiting'; via: SessionAwaitingVia }
  | { state: 'active' };

export function sessionAttentionDisposition(
  subject: SessionAttentionSubject,
): SessionAttentionDisposition {
  if (subject.lifecycleState === 'failed' || isFirstSendFailure(subject)) {
    return { state: 'failed' };
  }
  if (
    subject.lifecycleState === 'completed' ||
    subject.lifecycleState === 'canceled' ||
    subject.status === 'closed'
  ) {
    return { state: 'finished' };
  }
  if (subject.lifecycleState === 'needs_input') {
    return { state: 'awaiting', via: 'needs_input' };
  }
  if (subject.pendingReview || subject.lifecycleState === 'review_pending') {
    return { state: 'awaiting', via: 'review_pending' };
  }
  if (subject.lifecycleState === 'blocked') {
    return { state: 'awaiting', via: 'blocked' };
  }
  return { state: 'active' };
}

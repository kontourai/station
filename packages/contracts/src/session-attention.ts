import type { OrchestrationSessionSummary } from './orchestration.js';
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
  // #2540: `idle` is a finished turn on a live, reusable session — the same
  // "done" to anyone reading attention as the terminal `completed` it
  // replaced for ordinary turns.
  if (
    subject.lifecycleState === 'idle' ||
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

/**
 * The canonical states a session can be in, as this product words them:
 * exactly what {@link orchestrationLifecycleLabel} can return (a strict subset
 * of the UI's `HomeLifecycleLabel`; `Current`/`Recent` belong to chat and
 * durable-task items, which are not sessions).
 */
export type SessionStateLabel =
  | 'Needs attention'
  | 'Failed'
  | 'Stopped'
  | 'Running'
  | 'Ready'
  | 'Draft'
  | 'Unanswerable'
  | 'Completed';

/**
 * WHAT STATE A SESSION IS IN: the one derivation, and the only one (moved here
 * from `src-ui/src/utils/session-state.ts`, which re-exports it, so the
 * station-control `list_project_activity` tool answers with the very word the
 * UI shows and not a second table; station#3413).
 *
 * It starts from {@link sessionAttentionDisposition} and deliberately
 * overrides `lifecycleState` in five places; each override is a fixed defect:
 *
 * | shape | `lifecycleState` says | this says |
 * |---|---|---|
 * | `running`, `hasActiveTurn: false` | Running | **Ready** (archive#1069) |
 * | `pendingReview`, `running` | Running | **Needs attention** |
 * | `status: 'closed'`, `running` | Running | **Completed** (archive#1296) |
 * | `needs_input`, `answerable: false` | Waiting on you | **Unanswerable** (archive#1783) |
 * | `queued`/`running`, `hasActiveTurn: false`, `draft: true` | Queued/Running | **Draft** (#2310) |
 *
 * `answerability` is consulted only inside the awaiting arm (a detached
 * `completed` session takes the finished arm, so an ungated check would
 * relabel the finished inventory after a restart). `hasActiveTurn` gates
 * "Running": `session.configured` moves `lifecycleState` to `running` for every
 * resumed session, and only `turn.completed` moves it off. `draft` is the
 * server's lineage-aware fold, read and never re-derived; only the active arm
 * refines to it.
 */
export function orchestrationLifecycleLabel(
  session: OrchestrationSessionSummary,
): SessionStateLabel {
  const disposition = sessionAttentionDisposition(session);
  const currentChildWork =
    session.conversationActivity?.currentThreadId === session.threadId &&
    session.conversationActivity.runningChildWork !== undefined;
  // A completed or stopped parent turn may leave reported children running.
  // Keep the attention fold unchanged: background work is not a request to
  // the user. A closed or failed session retains its terminal outcome.
  // `idle` is how an ordinary turn ends since #2540; without it a session
  // whose turn finished while its sub-agents kept running read Completed.
  if (
    (session.lifecycleState === 'idle' ||
      session.lifecycleState === 'completed' ||
      session.lifecycleState === 'canceled') &&
    session.status !== 'closed' &&
    currentChildWork &&
    disposition.state === 'finished'
  )
    return 'Running';
  // The shared fold files a canceled turn under `finished`. Refine that
  // recorded outcome to Stopped when no child work remains.
  if (session.lifecycleState === 'canceled') return 'Stopped';
  switch (disposition.state) {
    case 'failed':
      return 'Failed';
    case 'finished':
      return 'Completed';
    case 'awaiting':
      return session.answerability.answerable
        ? 'Needs attention'
        : 'Unanswerable';
    case 'active':
      if (session.hasActiveTurn || currentChildWork) return 'Running';
      return session.draft === true ? 'Draft' : 'Ready';
  }
}

/**
 * WHAT an awaiting session is waiting on (#3042), read off the same shared
 * fold plus the summary's own transition facts. Meaningful only for a session
 * {@link orchestrationLifecycleLabel} calls `Needs attention`.
 *
 * - `review_pending` is the server's fold of every open request that is not
 *   an `input` request (approval, permission, confirmation), and of the
 *   `pendingReview` flag: an approval.
 * - `needs_input` reached through `input_requested` is an open question.
 * - `needs_input` stamped by interrupted-turn recovery carries
 *   `transitionReason: 'runtime_exit'`: the turn was cut short.
 * - any other `needs_input` says only that the session waits on the user.
 *
 * A turn interrupted by a restart while an approval was open reads
 * Interrupted: recovery's abort settles the request the dead turn opened
 * (#3071), so the server no longer reports it `review_pending`.
 */
export function sessionAttentionKind(
  session: Pick<
    OrchestrationSessionSummary,
    | 'lifecycleState'
    | 'status'
    | 'pendingReview'
    | 'terminalAttribution'
    | 'transitionReason'
  >,
): 'approval' | 'answer' | 'interrupted' | 'blocked' | 'waiting' {
  const disposition = sessionAttentionDisposition(session);
  if (disposition.state !== 'awaiting') return 'waiting';
  if (disposition.via === 'review_pending') return 'approval';
  if (disposition.via === 'blocked') return 'blocked';
  if (session.transitionReason === 'input_requested') return 'answer';
  if (session.transitionReason === 'runtime_exit') return 'interrupted';
  return 'waiting';
}

/**
 * THE STATUS LADDER'S WORDS (#3042), the only place they are spelled: every
 * list, card, row and tool that names a session's state reads one of these.
 * `src-ui/src/views/home/work-status.ts` builds its rungs from this table and
 * adds only what needs UI facts (sub-agent counts, the no-progress marker).
 */
export const SESSION_STATUS_WORDS = {
  approval: 'Needs approval',
  answer: 'Needs answer',
  waiting: 'Waiting on you',
  queued: 'Queued to send',
  blocked: 'Blocked',
  interrupted: 'Interrupted',
  failed: 'Failed',
  stopped: 'Stopped',
  elsewhere: 'Elsewhere',
  running: 'Running',
  draft: 'Draft',
  done: 'Done',
  idle: 'Idle',
} as const;

/**
 * The ladder's word for a session summary alone, as `workStatus(item, now)`
 * words it without UI facts: the lane is the same with or without them, and
 * the facts only refine words inside the Running rung.
 */
export function sessionLadderWord(
  session: OrchestrationSessionSummary,
): (typeof SESSION_STATUS_WORDS)[keyof typeof SESSION_STATUS_WORDS] {
  if (session.controlMode === 'read-only-attached')
    return SESSION_STATUS_WORDS.elsewhere;
  switch (orchestrationLifecycleLabel(session)) {
    case 'Needs attention':
      return SESSION_STATUS_WORDS[sessionAttentionKind(session)];
    case 'Failed':
      return SESSION_STATUS_WORDS.failed;
    case 'Stopped':
      return SESSION_STATUS_WORDS.stopped;
    case 'Unanswerable':
      return SESSION_STATUS_WORDS.elsewhere;
    case 'Running':
      return SESSION_STATUS_WORDS.running;
    case 'Draft':
      return SESSION_STATUS_WORDS.draft;
    case 'Completed':
      return SESSION_STATUS_WORDS.done;
    case 'Ready':
      return SESSION_STATUS_WORDS.idle;
  }
}

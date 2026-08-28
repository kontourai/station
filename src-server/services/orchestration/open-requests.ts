/**
 * The ONE replay that answers "is this request still open?" (archive#1284).
 *
 * Surfaces used to hand-maintain their own copy of this fold —
 * `attention-projection.ts`'s `openRequestsById` and the approval inbox's
 * convergence sweep. Two parallel copies of the same fold over the same event
 * log is the divergent-copy disease archive#1548 was filed for at the
 * lifecycle layer; this module is the single derivation they consume so they
 * cannot disagree about which requests are outstanding.
 *
 * Since archive#1745 it also owns {@link projectRequestAnswerability}: the
 * companion question "can anything in this process still answer this open
 * request?". The two belong together because every consumer asks them
 * together, and because the second used to be answered by WRITING a synthetic
 * `request.resolved` at boot — see that function's own doc for why it is now
 * projected on read.
 *
 * It lives in its own leaf module rather than in `orchestration-service.ts`
 * because `attention-projection.ts` already depends on that module (it takes
 * an `OrchestrationService` in its constructor), so importing back would be
 * circular.
 *
 * SCOPE, STATED EXPLICITLY SO NO CALL SITE HAS TO GUESS: these functions
 * consider EVERY `request.opened` regardless of `requestType`. The lifecycle
 * fold distinguishes them (`session-lifecycle-service.ts`:
 * `requestType === 'input'` folds to `needs_input`, everything else to
 * `review_pending`), so a consumer that means only one kind must filter at
 * its own call site and say why. No filter is buried here.
 */
import type { RequestAnswerability } from '@kontourai/station-contracts/orchestration';
import type {
  ApprovalStatus,
  CanonicalRuntimeEvent,
  RequestOpenedEvent,
} from '@kontourai/station-contracts/runtime-events';
import {
  canSessionLifecycleStateResume,
  foldedSessionLifecycleState,
  type SessionLifecycleState,
} from '@kontourai/station-contracts/session-lifecycle';

/**
 * Every still-open `request.opened` event (no matching `request.resolved`),
 * keyed by `requestId`, in the order they were opened.
 */
export function collectOpenRequests(
  events: CanonicalRuntimeEvent[],
): Map<string, RequestOpenedEvent> {
  const open = new Map<string, RequestOpenedEvent>();
  for (const event of events) {
    if (event.method === 'request.opened') open.set(event.requestId, event);
    else if (event.method === 'request.resolved') open.delete(event.requestId);
  }
  return open;
}

/**
 * How much this process knows about whether it is holding the session's
 * thread right now.
 *
 * Three states, not a boolean, because `recoverSessions()` populates the
 * attachment registry asynchronously at boot: before it settles, "no adapter
 * record for this thread" means "recovery has not reached it yet", which is
 * a DIFFERENT fact from "nothing is holding it". Collapsing the two would
 * briefly answer `unanswerable` for a session about to be re-attached, and
 * hiding a live approval is the harm the attachment check exists to prevent.
 */
export type SessionThreadAttachment = 'attached' | 'detached' | 'unknown';

/**
 * Everything about the SERVING PROCESS that the answerability decoration
 * needs and a pure event fold cannot know. The third input — the session's
 * folded lifecycle state — comes from the fold itself, which is why this is
 * handed to `buildOrchestrationSessionSummary` rather than a finished
 * `RequestAnswerability`: only the builder knows the folded state, and only
 * the caller knows the process.
 *
 * This is the shape that makes the required wire member enforceable. The
 * builder cannot invent it, so every construction site must supply it, and
 * the compiler names any site that does not.
 */
export interface SessionAnswerabilityObservation {
  threadAttachment: SessionThreadAttachment;
  providerRegistered: boolean;
  observedBy: string;
  observedAt: string;
}

/**
 * THE one function that computes the `answerability` decoration every session
 * summary carries — archive#1745's read-time projection of what archive#1284
 * used to write at boot, in the wire shape ADR 0012 adopted.
 *
 * Pure, so its inputs are visible rather than read out of a service, and so
 * every arm can be exercised without booting one. The two process-local,
 * time-varying inputs (`threadAttachment`, `providerRegistered`) are supplied
 * by the serving process; `observedBy`/`observedAt` are supplied with them so
 * the negative arm records WHOSE answer it is and WHEN — see the wire type's
 * own doc for why a bare boolean would be a label rather than a derivation.
 *
 * `unanswerable` is not a claim that the request was cancelled. Nothing is
 * cancelled and nothing is written: it says that at the moment of this read,
 * no path exists by which the request could be answered, so a surface
 * offering Allow/Deny for it would be offering an action that dispatches into
 * nothing. Recompute it on the next read and it may say the opposite — a
 * plugin that registers its adapter late makes its sessions answerable again
 * with no repair step, which is the whole reason this is a projection and not
 * a persisted event.
 *
 * PREDICATE CHOICE (archive#1548 convergence — read before changing this).
 * The contract exposes three derived predicates and only ONE means what this
 * needs:
 *   - `isSessionLifecycleStateTerminal` = `{completed}` — no transition out at
 *     all. TOO NARROW: a `canceled` session holding an open request is exactly
 *     the stuck card archive#1284 was filed for, and this predicate leaves it
 *     stuck.
 *   - `isSessionLifecycleStateStopped` = `{completed, failed, canceled}` — TOO
 *     WIDE: `failed` is retriable (`failed -> queued | running`) and treating
 *     its open request as unanswerable defeats archive#1090's retry design.
 *   - `canSessionLifecycleStateResume` negated = `{completed, canceled}` — the
 *     work cannot pick up where it left off, so nothing is waiting on the
 *     answer any more. That is this predicate's actual question, and it is the
 *     same one `session-lifecycle-service.ts` uses to zero `pendingReview`, so
 *     producer and consumer agree by construction.
 * Swapping in the name-matching `isSessionLifecycleStateTerminal` silently
 * regresses the fix; `orphan-request-reconciliation.test.ts`'s "predicate pin"
 * test exists to turn that red.
 *
 * Attachment is checked FIRST and unconditionally: a thread this process is
 * holding right now can answer its own requests whatever its persisted log
 * folds to, and hiding a live approval is the harm the control case exists to
 * prevent. Note that it is a strictly stronger guard than either arm below —
 * neither of them can rescue a wrong answer here, which is why it needs its
 * own test rather than riding on a fixture that any of the three would have
 * skipped.
 *
 * `'unknown'` attachment FAILS OPEN for the same reason, and the asymmetry is
 * the whole argument for projecting rather than writing: answering
 * `unanswerable` during the boot window would briefly hide a live approval,
 * while answering `answerable` at worst shows a card one poll longer than
 * needed. With nothing persisted, being early is a cosmetic cost rather than
 * a permanent one.
 */
export function projectRequestAnswerability(input: {
  /** Whether this process holds the thread — see the three-state doc above. */
  threadAttachment: SessionThreadAttachment;
  /** The session's folded lifecycle state; `undefined` folds to `running`. */
  lifecycleState: SessionLifecycleState | undefined;
  /** An adapter for the session's provider exists in this process. */
  providerRegistered: boolean;
  /** Identity of the process making this observation. */
  observedBy: string;
  /** ISO timestamp at which it made it. */
  observedAt: string;
}): RequestAnswerability {
  if (input.threadAttachment !== 'detached') return { answerable: true };
  const observation = {
    answerable: false,
    observedBy: input.observedBy,
    observedAt: input.observedAt,
  } as const;
  if (
    !canSessionLifecycleStateResume(
      foldedSessionLifecycleState(input.lifecycleState),
    )
  ) {
    return { ...observation, qualification: 'past_resume' };
  }
  if (!input.providerRegistered) {
    return { ...observation, qualification: 'provider_absent' };
  }
  return { answerable: true };
}

/**
 * What the persisted log says about ONE request. Four states, each computed
 * from something — deliberately not three with a catch-all, because
 * "nobody can answer this" and "I could not look" are different facts and a
 * consumer must be able to act differently on them:
 *
 * - `open` — a `request.opened` with no later `request.resolved`.
 * - `resolved` — the resolving event, carrying its own `status` so a
 *   consumer maps `expired` exactly the way the live path does.
 * - `unrecorded` — the log does not name this request at all: it was never
 *   opened here. Nothing in this process can ever resolve it, so a UI
 *   affordance bound to it would dispatch into nothing.
 * - `undetermined` — no persisted log was readable: either no event store is
 *   wired, or reading it failed (a locked/busy/corrupt database). Not an
 *   answer; a consumer holding an irreversible action must hold.
 */
export type RequestReplayOutcome =
  | { state: 'open'; request: RequestOpenedEvent }
  | { state: 'resolved'; status: ApprovalStatus }
  | { state: 'unrecorded' }
  | { state: 'undetermined' };

/**
 * Replay `events` (one thread's persisted log, in order) for `requestId`.
 * Last write wins: a request re-opened after being resolved reads `open`.
 */
export function replayRequestOutcome(
  events: CanonicalRuntimeEvent[],
  requestId: string,
): RequestReplayOutcome {
  let outcome: RequestReplayOutcome = { state: 'unrecorded' };
  for (const event of events) {
    if (event.requestId !== requestId) continue;
    if (event.method === 'request.opened') {
      outcome = { state: 'open', request: event };
    } else if (event.method === 'request.resolved') {
      outcome = { state: 'resolved', status: event.status };
    }
  }
  return outcome;
}

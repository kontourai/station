export const SESSION_LIFECYCLE_STATES = [
  'queued',
  'running',
  'needs_input',
  'review_pending',
  'blocked',
  'completed',
  'failed',
  'canceled',
] as const;

export type SessionLifecycleState = (typeof SESSION_LIFECYCLE_STATES)[number];

export type SessionTransitionSource =
  | 'runtime'
  | 'user_action'
  | 'system_recovery';

export type SessionTransitionReason =
  | 'session_started'
  | 'session_configured'
  | 'turn_started'
  | 'turn_completed'
  | 'approval_requested'
  | 'review_requested'
  | 'input_requested'
  | 'request_resolved'
  | 'blocked_by_user'
  | 'retry_requested'
  | 'runtime_error'
  | 'runtime_exit'
  | 'user_canceled'
  | 'system_recovered'
  | 'manual_update'
  | 'unknown';

export type SessionLifecycleTransitionMap = Record<
  SessionLifecycleState,
  readonly SessionLifecycleState[]
>;

export const SESSION_LIFECYCLE_TRANSITIONS: SessionLifecycleTransitionMap = {
  // 'completed' from 'queued' is legal: with attach events transition-neutral
  // (station#1073), a session that attached but never ran a turn projects
  // 'queued', and closing it out from the board / the flow-gated completion
  // path is a legitimate user action (pre-#1073 the same session projected a
  // fabricated 'running', which made this transition invisible here).
  queued: ['running', 'blocked', 'completed', 'failed', 'canceled'],
  running: [
    'needs_input',
    'review_pending',
    'blocked',
    'completed',
    'failed',
    'canceled',
  ],
  needs_input: ['running', 'blocked', 'failed', 'canceled'],
  review_pending: ['running', 'blocked', 'completed', 'failed', 'canceled'],
  blocked: ['queued', 'running', 'failed', 'canceled'],
  completed: [],
  failed: ['queued', 'running'],
  canceled: ['queued'],
} as const;

export type SessionTransitionValidationCode =
  | 'allowed'
  | 'unknown_state'
  | 'same_state'
  | 'terminal_state'
  | 'illegal_transition';

export interface SessionTransitionValidationResult {
  ok: boolean;
  code: SessionTransitionValidationCode;
  message?: string;
}

export function isSessionLifecycleState(
  value: unknown,
): value is SessionLifecycleState {
  return (
    typeof value === 'string' &&
    (SESSION_LIFECYCLE_STATES as readonly string[]).includes(value)
  );
}

function permittedTransitions(
  state: SessionLifecycleState,
): readonly SessionLifecycleState[] | undefined {
  return isSessionLifecycleState(state)
    ? SESSION_LIFECYCLE_TRANSITIONS[state]
    : undefined;
}

/**
 * **Terminal** — the contract permits no transition out of this state at
 * all: `{ completed }`.
 *
 * This is the one definition of terminality in the repo, derived from
 * `SESSION_LIFECYCLE_TRANSITIONS` rather than hand-listed, and it is the
 * same predicate `validateSessionLifecycleTransition` answers
 * `terminal_state` from. station#1548: two hand-written copies of "terminal"
 * had independently drifted to `{ completed, failed, canceled }` — one in
 * the lifecycle projector, one in the attention projection — while the map
 * declares `failed -> queued | running`. A failed session is retryable, so
 * an approval opened before the failure is still outstanding, and zeroing
 * `pendingReview` on it produced no attention item at all.
 *
 * A state this contract does not recognize is reported as NOT terminal:
 * these predicates guard user-visible attention surfaces, and the safe
 * direction for an unrecognized value is "still live", never "hide it".
 */
export function isSessionLifecycleStateTerminal(
  state: SessionLifecycleState,
): boolean {
  const allowed = permittedTransitions(state);
  return allowed !== undefined && allowed.length === 0;
}

/**
 * Stable public rejection code for "a new turn was refused because the
 * session's lifecycle state is terminal". Dispatch raises it, the chat route
 * forwards it in the error body, and clients discriminate on it to say what
 * actually happened — Station declined to deliver into an ended session —
 * instead of parroting an internal lifecycle sentence. This is a STATION-side
 * refusal, not an agent failure; surfaces translating it must not attribute
 * it to the agent's work.
 */
export const SESSION_ENDED_REJECTION_CODE = 'session_ended';

/**
 * **Stopped** — the session is not doing work, and every transition the
 * contract permits out of this state re-enters the active lifecycle
 * (`queued`/`running`), i.e. the only way out is an explicit restart:
 * `{ completed, failed, canceled }`.
 *
 * This is deliberately WIDER than terminality and NARROWER than "not
 * running": a stopped state records a run outcome. Callers use it to refuse
 * to overwrite that outcome — an attach-time "idle" report must not erase a
 * failure, and a still-open request must not relabel a stopped session
 * `review_pending` and hide how it ended.
 *
 * Not to be confused with `canSessionLifecycleStateResume`: `failed` is
 * stopped AND resumable, and that combination is exactly the case
 * station#1548 exists for.
 */
export function isSessionLifecycleStateStopped(
  state: SessionLifecycleState,
): boolean {
  const allowed = permittedTransitions(state);
  return (
    allowed?.every((next) => next === 'queued' || next === 'running') ?? false
  );
}

/**
 * **Resumable** — the session is running, or the contract permits going
 * straight back to `running`, so the work it had in flight can pick up where
 * it left off: everything except `{ completed, canceled }`.
 *
 * This is the concept station#1296 actually needed, named rather than
 * borrowed from terminality. #1296's defect was a `pendingReview` flag that
 * outlived a cleanly finished session with no way to clear it; what makes
 * such a request moot is not that the state is terminal but that the work
 * cannot resume, so nothing is waiting on the answer any more. `failed` can
 * resume — a retry re-enters `running` directly — so its outstanding
 * requests stay pertinent.
 *
 * Deliberately the ONE-STEP edge, not general reachability. `canceled` also
 * reaches `running` eventually, via `queued`, but only by starting the work
 * over: the request that was open when the user cancelled is not what the
 * requeued session will be waiting on. A direct edge to `running` is the
 * contract's way of saying the SAME in-flight work continues.
 *
 * `running` is included reflexively — it is the state, not a route to it.
 * The transition map has no self-edges, so deriving this from the map alone
 * would answer `false` for a live session, and a still-open request on a
 * live session is the one case that was never in doubt.
 */
export function canSessionLifecycleStateResume(
  state: SessionLifecycleState,
): boolean {
  if (state === 'running') return true;
  const allowed = permittedTransitions(state);
  return allowed === undefined || allowed.includes('running');
}

/**
 * The ONE resolution of an absent folded lifecycle state (station#1778).
 *
 * `OrchestrationSessionSummary.lifecycleState` is declared optional, and
 * `projectSessionLifecycle` in practice always produces one; the gap is a
 * type-level omission, not a state. Consumers that need a concrete state
 * therefore reach for `?? 'running'`, and two of them doing so independently
 * is the divergent-copy shape `open-requests.ts` exists to prevent — worse
 * here, because this is "a default that decides" (`docs/guides/code-quality.md`):
 * it lands on the PERMISSIVE side, folding an unknown session toward
 * answerable/live rather than toward ended.
 *
 * That direction is deliberate and is the visible one: an unknown session
 * keeps its affordances and a dispatch through them fails loudly at the
 * server, where hiding a live approval fails silently. Naming the default
 * once means changing that judgement is one edit, not a sweep.
 */
export function foldedSessionLifecycleState(
  state: SessionLifecycleState | undefined,
): SessionLifecycleState {
  return state ?? 'running';
}

export function validateSessionLifecycleTransition(
  from: SessionLifecycleState,
  to: SessionLifecycleState,
): SessionTransitionValidationResult {
  if (!isSessionLifecycleState(from) || !isSessionLifecycleState(to)) {
    return {
      ok: false,
      code: 'unknown_state',
      message: `Unknown session lifecycle transition: ${from} -> ${to}`,
    };
  }

  if (from === to) {
    return {
      ok: false,
      code: 'same_state',
      message: `Session is already ${to}`,
    };
  }

  const allowed = SESSION_LIFECYCLE_TRANSITIONS[from];
  if (isSessionLifecycleStateTerminal(from)) {
    return {
      ok: false,
      code: 'terminal_state',
      message: `Session state ${from} is terminal`,
    };
  }

  if (!allowed.includes(to)) {
    return {
      ok: false,
      code: 'illegal_transition',
      message: `Illegal session lifecycle transition: ${from} -> ${to}`,
    };
  }

  return { ok: true, code: 'allowed' };
}

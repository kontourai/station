import type { AgentId, EngineId } from './agent-identity.js';
import type { ClientOrigin } from './client-origin.js';
import type { ConnectionRecoveryProjection } from './connection-recovery.js';
import type {
  AttachedSessionSourceMetadata,
  ModelLaunchPlan,
  ProviderSendTurnInput,
  ProviderSession,
  ProviderSessionStartInput,
  SessionControlMode,
} from './provider.js';
import type { RunFailureKind, RunStatus } from './runs.js';
import type { CanonicalRuntimeEvent } from './runtime-events.js';
import type {
  SessionLifecycleState,
  SessionTransitionReason,
  SessionTransitionSource,
} from './session-lifecycle.js';

export type {
  AttachedSessionSourceMetadata,
  ModelLaunchPlan,
  SessionControlMode,
} from './provider.js';

/**
 * `sendTurn` command input: the provider turn input plus optional ambient,
 * model-facing context (timezone, geolocation, …). The orchestration service
 * composes `ambientContext` into the model-facing `input` at one choke point
 * and never forwards the field to provider adapters; the persisted/rendered
 * user turn stays the typed `input` alone.
 */
export interface OrchestrationSendTurnInput
  extends Omit<
    ProviderSendTurnInput,
    'recoveryCorrelationId' | 'reviewIsolation'
  > {
  ambientContext?: string;
}

/**
 * Public orchestration commands never accept a credential-profile selector.
 * That opaque ref is server-only recovery state and may only reach a provider
 * spawn through the internal restart/resume seam.
 */
export type OrchestrationStartSessionInput = Omit<
  ProviderSessionStartInput,
  'credentialProfileRef' | 'reviewIsolation'
>;

export type OrchestrationCommand =
  | { type: 'startSession'; input: OrchestrationStartSessionInput }
  | {
      type: 'adoptSession';
      sourceThreadId: string;
      idempotencyKey?: string;
    }
  | { type: 'sendTurn'; input: OrchestrationSendTurnInput }
  | {
      type: 'interruptTurn';
      threadId: string;
      turnId?: string;
      /**
       * The per-turn idempotency key of the dispatch this Stop is aimed at
       * (`OrchestrationSendTurnInput.clientTurnId`). Only meaningful when the
       * engine has not started that turn yet: the cancel is then held against
       * this key, and applied to the turn THAT dispatch produces rather than
       * to whatever starts next on the thread (UX audit T1 review).
       */
      clientTurnId?: string;
    }
  | { type: 'steerTurn'; threadId: string; input: string; turnId?: string }
  | {
      type: 'respondToRequest';
      threadId: string;
      requestId: string;
      decision: 'accept' | 'acceptForSession' | 'decline' | 'cancel';
    }
  | { type: 'stopSession'; threadId: string };

/**
 * How long the orchestration service waits for the engine to acknowledge a
 * cooperative cancel before it forces teardown. Declared here — not privately
 * in the service — because the browser's Stop control has to outwait it: a
 * client request budget shorter than this one would abort a stop that is
 * working and report a failure that did not happen (UX audit T1).
 */
export const COOPERATIVE_STOP_BUDGET_MS = 5_000;

/**
 * What a Stop actually did, derived by the orchestration service from the
 * first local settlement of the cancel it dispatched — never asserted by the
 * caller and never chosen by an adapter payload.
 *
 * - `cooperative` — the engine acknowledged the cancel within
 *   {@link COOPERATIVE_STOP_BUDGET_MS}. The turn is over; the session stays
 *   resumable and its engine process is deliberately kept warm
 *   (`persistResumableStoppedSession`), so a UI that says "stopped the
 *   engine" here would be describing something that did not happen.
 * - `forced` — the budget expired with no acknowledgement, so Station
 *   published the turn's terminal itself and tore the session down
 *   (`adapter.stopSession`). Deliberately not "ended the OS process": that is
 *   what stopSession is FOR, but adapters differ — Claude's SDK path closes
 *   its handles and returns without observing a process exit — so a UI that
 *   promised process termination here would be overclaiming for some engines
 *   (UX audit T1 review).
 * - `turn-completed` — the engine finished the turn while the cancel was in
 *   flight. There is no stop outcome to report: the turn's own
 *   `turn.completed` is the only terminal fact.
 * - `pending-turn-start` — the engine session for this thread does not exist
 *   yet. A dispatched turn takes seconds to reach `turn.started`, and a Stop
 *   pressed inside that window used to be REFUSED outright (`No provider
 *   session found for thread`, observed on every real press in live
 *   verification). The cancel is recorded against the thread and applied to
 *   the turn the moment it starts; it expires unused if no turn starts.
 * - `no-active-turn` — nothing was running to interrupt (a dormant restored
 *   session, or a turn that had already settled).
 */
export type InterruptTurnResult =
  | {
      outcome: 'cooperative' | 'forced';
      threadId: string;
      turnId: string;
    }
  | { outcome: 'turn-completed'; threadId: string; turnId: string }
  | { outcome: 'pending-turn-start'; threadId: string }
  | { outcome: 'no-active-turn'; threadId: string };

/**
 * How long a `pending-turn-start` cancel stays armed. Long enough to cover the
 * observed dispatch-to-`turn.started` gap (0.5–2.6 s live, with headroom for a
 * cold engine start).
 *
 * The TTL is a backstop, not the safety property: a cancel that names a
 * `clientTurnId` is bound to the turn THAT dispatch produces and can never
 * reach another one (UX audit T1 review). The window only bounds how long an
 * uncorrelated cancel — one from a caller that sent no key — stays live.
 */
export const PENDING_TURN_INTERRUPT_TTL_MS = 60_000;

export type SteerTurnResult =
  | {
      /**
       * The input was enqueued to the live runtime iterable and durably
       * recorded in the transcript. The provider SDK exposes no delivery ack.
       */
      outcome: 'steered';
      threadId: string;
      turnId: string;
    }
  | { outcome: 'no-active-turn'; threadId: string }
  | {
      outcome: 'unsupported-engine';
      threadId: string;
      engineId: EngineId;
      engineName: string;
    }
  | {
      /**
       * A second steer arrived
       * for this thread while an earlier steer's attribution reservation
       * (`ClientOriginTurnPropagation`) was still in flight. Refused
       * outright rather than risk the earlier steer's `turn.started`
       * republishing under the WRONG (later) caller's principal — a
       * misattributed event is the one unacceptable outcome; a refused
       * one is honest and retryable.
       */
      outcome: 'concurrent-steer';
      threadId: string;
    };

/** Path- and provider-cursor-free response for attached-session adoption. */
export interface AdoptedSessionResult {
  threadId: string;
  provider: string;
  controlMode: 'station-owned';
  status: ProviderSession['status'];
  model?: string;
  createdAt: string;
  updatedAt: string;
  alreadyAdopted?: boolean;
}

export interface OrchestrationCommandReceipt {
  commandId: string;
  threadId: string;
  commandType: OrchestrationCommand['type'];
  status: 'accepted' | 'rejected' | 'failed';
  createdAt: string;
  /** Origin stamped by the authenticated request seam, when user-issued. */
  clientOrigin?: ClientOrigin;
}

/** Stable refusal code when a foreground session may already have started. */
export const FOREGROUND_MESSAGE_INDETERMINATE_CODE =
  'foreground_message_indeterminate' as const;

/**
 * Exact evidence returned when foreground start effects completed but the
 * accepted command receipt is not known durable. Callers must not retry.
 */
export interface ForegroundMessageIndeterminate {
  code: typeof FOREGROUND_MESSAGE_INDETERMINATE_CODE;
  outcome: 'indeterminate';
  receipt: OrchestrationCommandReceipt;
  receiptStatus: 'unavailable';
  session: ProviderSession;
}

export interface OrchestrationCommandDispatchResult<T = unknown> {
  receipt: OrchestrationCommandReceipt;
  result: T;
  /** Present only when provider acceptance is known but receipt durability is not. */
  receiptStatus?: 'unavailable';
}

export interface OrchestrationDelegationContext {
  taskId: string;
  environmentId?: string;
  environmentName?: string;
  connectionId?: string;
  /**
   * All three name one public delegated-task target: an Agent.
   *
   * archive#3408: `'agent'` is the only one any writer in this repo actually
   * persists — both launch writers (`station-control-delegation.ts`'s
   * delegated-task start and `execution-target-execution.ts`'s foreground
   * dispatch) write it. It was missing from this union, and from the
   * projection allowlist deriving it, so the delegation record for a locally
   * launched task carried no target and `station delegate events` refused the
   * caller's own task. `'station-agent'` and `'agent-app'` are accepted for
   * compatibility; grep found no producer of either.
   */
  targetKind?: 'station-agent' | 'agent-app' | 'agent';
  targetId?: string;
  projectSlug?: string;
  /**
   * archive#1463: how `projectSlug` came to name the project the work lands
   * in. Slugs are locally generated with local dedupe suffixes, so a
   * cross-machine name match is a coincidence, not proof of identity — the
   * durable record says which it was rather than letting every slug read as
   * a verified binding. #1425's portable manifest `id` is the join key that
   * retires this.
   *
   * - `local` — the target is this Station, so the slug IS the local
   *   identity.
   * - `directory-corroborated` — a REMOTE target whose project working
   *   directory is byte-equal to the operator-verified project path for that
   *   environment. Real corroboration of the DIRECTORY, and still not proof
   *   of project identity: #1462 is the standing proof that two projects can
   *   be configured on one directory, so the remote `getProject(slug)` may
   *   have returned either of them. Recorded and disclosed, not silent.
   * - `unverified-cross-machine` — a remote target matched by project *name*
   *   only, or whose configured path equals the verified path only after
   *   normalization/tilde expansion against the probe-captured remote home
   *   (archive#1870). Accepted by the confinement gate, but not raw byte
   *   equality, so it earns no `directory-corroborated` claim. The old
   *   `~/`-relative SUFFIX tolerance is gone: a remote `~/dev/station` no
   *   longer matches `/home/anyone/dev/station` unless the recorded remote
   *   home makes them the same directory.
   *
   * Absent means the record predates this field (archive#1463); it is not a
   * fourth state and must not be read as `local`.
   */
  projectSlugJoin?:
    | 'local'
    | 'directory-corroborated'
    | 'unverified-cross-machine';
  parentTaskId?: string;
  mode?: string;
}

/**
 * WHICH arm decided a session's open requests cannot be answered here, kept
 * so a misfiring one is distinguishable ever after: `past_resume` (the
 * session's own folded state says the work cannot pick up again) vs
 * `provider_absent` (the serving process has no adapter for the provider at
 * all). A spike in the second is the shape a broken plugin load makes.
 *
 * This vocabulary is fixed by `projectRequestAnswerability`
 * (`src-server/services/orchestration/open-requests.ts`), which is the only
 * producer. Do not mint further terms here without an arm that computes one.
 */
export type RequestAnswerabilityQualification =
  | 'past_resume'
  | 'provider_absent';

/**
 * Whether anything in the SERVING process could still answer an open request
 * on this session, as observed at the moment the summary was emitted
 * (archive#1745 / ADR 0012).
 *
 * `answerable: false` is not a claim that anything was cancelled — nothing is
 * written and nothing is resolved. It says that when this response was built,
 * no path existed by which the request could be answered, so a surface
 * offering Allow/Deny would be offering an action that dispatches into
 * nothing. Read the same session a moment later, or through a different
 * Station instance, and the answer may differ: two of the three inputs
 * (thread attachment, adapter registration) are process-local and
 * time-varying, which is precisely why the negative arm carries `observedBy`
 * and `observedAt`. Without them a consumer would read "this session is
 * unanswerable" — timeless and universal — when the truth is "the serving
 * process held no adapter for it at 12:04:03".
 *
 * CONSUMERS ANNOTATE, THEY DO NOT SILENTLY FILTER. Rendering the basis is
 * what keeps the claim honest; dropping the row on one surface while another
 * still shows it is the divergence this decoration exists to end. The one
 * deliberate, documented exception is the attention projection, whose badge
 * is a count of ACTIONABLE items and which subtracts INTO the notification
 * popover rather than out of existence.
 *
 * ═══ CONSULT THIS ONLY WHERE A REQUEST IS ACTUALLY OPEN. ═══
 *
 * The subject of the sentence is THE REQUEST, not the session, and the two
 * come apart in the most ordinary state this system has. `turn.completed`
 * folds a session to `completed` (`session-lifecycle-service.ts`); recovery
 * deliberately skips already-closed sessions at boot
 * (`orchestration-session-state.ts`), so every previously-finished session is
 * DETACHED after a restart; and a detached `completed` session takes the
 * `past_resume` arm. **`answerable: false` is therefore the steady state of
 * the entire completed-conversation inventory** — correctly, because a
 * request on such a session could not be answered here. It says nothing
 * whatever about whether one exists.
 *
 * A consumer that reads this as "something is wrong with this session" will
 * de-count, demote, or annotate every conversation the user ever finished.
 * That defect reached three
 * surfaces at once: a sidebar badge that silently read 0 instead of naming
 * unseen completed work, a Home row rendering "Done" directly above
 * "Unanswerable", and a delegated-task card annotating every clean finish.
 *
 * So: gate every read on the session actually awaiting a response —
 * `pendingReview`, `needs_input`, `review_pending`, an open `request.opened`
 * you already hold — exactly as `attention-projection.ts` does by evaluating
 * it only for `requestKind: 'orchestration'` approval notifications. If you
 * cannot name the open request your surface is deciding about, this field is
 * not the one you want.
 *
 * The positive arm deliberately carries no basis. A stale `answerable: true`
 * is backstopped by enforcement — `respondToRequest`/`sendTurn` reject on
 * adapter absence regardless of what any summary said — so it cannot make
 * anything falsely executable, and the surfaces that need the basis are the
 * ones that suppress or disable.
 */
export type RequestAnswerability =
  | { answerable: true }
  | {
      answerable: false;
      qualification: RequestAnswerabilityQualification;
      /** Identity of the Station process that made this observation. */
      observedBy: string;
      /** ISO timestamp at which that process made it. */
      observedAt: string;
    };

const REQUEST_ANSWERABILITY_QUALIFICATIONS: readonly string[] = [
  'past_resume',
  'provider_absent',
];

/**
 * Make a value received OVER THE WIRE into an honest `RequestAnswerability`.
 *
 * The required-member design enforces at CONSTRUCTION, which is exactly where
 * a cross-process boundary is not: `(await response.json()) as { data?:
 * OrchestrationSessionSummary[] }` is an ASSERTION, not a validation, so a
 * peer older than ADR 0012 sends no decoration and every element is typed
 * with a required field that is `undefined` at runtime. A consumer folding
 * `session.answerability.answerable` then throws. This is the one place that
 * cannot be closed by the type, so it is closed by hand — in ONE function,
 * used by every boundary (the SDK's fetch helpers and the server's
 * remote-session reader), because two hand-written normalizers is the
 * divergent-copy disease this whole change is about.
 *
 * ABSENT → `{ answerable: true }`, and that is not a guess dressed as an
 * observation: the reader cannot observe a remote's adapter registry or
 * thread attachments, so it has no standing to claim `unanswerable`, and the
 * absence of a claim is not a claim. It also matches the disclosed permissive
 * direction — a card that renders and whose action fails loudly at the
 * server, rather than a live approval silently hidden.
 *
 * A NEGATIVE ARM MISSING ITS BASIS is downgraded the same way. `answerable:
 * false` without `observedBy`/`observedAt` is precisely the unattributed,
 * timeless label the arm's required basis exists to prevent; forwarding it
 * would let a peer launder a label through a type that promises a
 * derivation. An unknown `qualification` is treated the same, because a term
 * no arm computes is a claim nothing derives.
 *
 * A fully-stated negative arm passes through UNTOUCHED, including its own
 * `observedBy` — the remote's answer is the remote's, and overwriting it here
 * would replace a real observation with a local guess.
 */
export function normalizeRequestAnswerability(
  value: unknown,
): RequestAnswerability {
  if (typeof value !== 'object' || value === null) return { answerable: true };
  const candidate = value as Record<string, unknown>;
  if (candidate.answerable !== false) return { answerable: true };
  const { qualification, observedBy, observedAt } = candidate;
  if (
    typeof qualification !== 'string' ||
    !REQUEST_ANSWERABILITY_QUALIFICATIONS.includes(qualification) ||
    typeof observedBy !== 'string' ||
    observedBy.length === 0 ||
    typeof observedAt !== 'string' ||
    observedAt.length === 0
  ) {
    return { answerable: true };
  }
  return {
    answerable: false,
    qualification: qualification as RequestAnswerabilityQualification,
    observedBy,
    observedAt,
  };
}

/**
 * Apply {@link normalizeRequestAnswerability} to anything carrying the member.
 * Generic over the shape so the four wire shapes share one call site style.
 */
export function withNormalizedAnswerability<
  T extends { answerability: RequestAnswerability },
>(value: T): T {
  return {
    ...value,
    answerability: normalizeRequestAnswerability(value.answerability),
  };
}

/**
 * THE copy every surface renders for an unanswerable session (archive#1780/
 * #1781/#1782/#1783), so the four of them cannot tell four different stories
 * about one observation. `null` for the positive arm: there is nothing to
 * annotate, and returning a string there would invite a surface to render
 * "answerable" as a claim the positive arm deliberately carries no basis for.
 *
 * The sentence names all three things the negative arm knows, because
 * dropping any of them reintroduces the label the arm exists to prevent:
 * WHICH arm fired (`qualification`), WHO observed it (`observedBy`), and
 * WHEN (`observedAt`). "This session is unanswerable" is timeless and
 * universal; "the serving Station held no adapter for provider 'acme' at
 * 2026-08-03T12:04:03.000Z" is a record of one process's observation, which
 * is all that was ever true.
 *
 * `observedAt` is rendered VERBATIM rather than localised. It is the
 * observing process's clock, not the reader's — a cross-process claim
 * reformatted into the reader's timezone silently reattributes it — and a
 * verbatim ISO string is the same bytes in every consumer and every test,
 * which is what makes the copy contract checkable at all.
 *
 * `provider` is optional because not every caller has the session in hand
 * (the CLI joins by thread id; a notification row joins by summary). When it
 * is absent the sentence says so rather than naming a provider it does not
 * know — an honest gap, never an invented id.
 */
export function unanswerableRequestNotice(
  answerability: RequestAnswerability,
  options?: { provider?: string },
): string | null {
  if (answerability.answerable) return null;
  const cause =
    answerability.qualification === 'provider_absent'
      ? options?.provider
        ? `no adapter for provider '${options.provider}'`
        : 'no adapter for that provider'
      : 'the session cannot resume';
  return `Unanswerable by the serving Station (${cause}) — observed by ${answerability.observedBy} at ${answerability.observedAt}.`;
}

/**
 * The honest gap when a consumer could not JOIN a request to a session
 * summary at all — distinct from an observed `answerable: true`, and never
 * collapsed into it (`docs/guides/code-quality.md`, "a default that
 * decides"). Nothing was observed, so nothing is claimed; the row still
 * renders and its action still dispatches, because a consumer that could not
 * look has no standing to gate anything.
 */
export function unknownAnswerabilityNotice(subject?: string): string {
  return subject
    ? `Answerability unknown — no session summary was joined for ${subject}.`
    : 'Answerability unknown — no session summary was joined for this request.';
}

/**
 * archive#4054: a process-local observation made by the turn-stall watchdog,
 * not a lifecycle verdict. It is deliberately absent after the next observed
 * progress event or turn end; a quiet provider run can be expected rather
 * than anomalous (notably long tool calls on muse and station-agent).
 */
export interface TurnProgressSilence {
  detectedAt: string;
  windowMs: number;
  silentSinceEventAt: string;
  provider: ProviderSession['provider'];
}

/**
 * The watchdog's one progress derivation for an active turn. Consumers must
 * render this projection and must not infer silence from `lastEventAt`: that
 * timestamp covers every canonical event, while the watchdog intentionally
 * recognizes only its narrower progress vocabulary (#2959/#3031).
 */
export interface TurnProgressObservation {
  lastProgressEventAt: string;
  progressSilence?: TurnProgressSilence;
}

/**
 * A compact, server-derived explanation for a session's CURRENT non-clean
 * ending. It is intentionally not a transcript excerpt: `detail`, when
 * present, is already one bounded, human-shaped line suitable for an inbox.
 *
 * Absent means either that the session finished cleanly or that Station has
 * no attributable terminal fact. Consumers render this projection; they must
 * not reconstruct a cause from lifecycle state, transport status, or logs.
 */
export interface TerminalAttribution {
  kind:
    | 'requested_stop'
    | 'stall_stop'
    | 'runtime_error'
    | 'timeout'
    | 'no_output'
    | 'exit';
  detail?: string;
}

export interface OrchestrationSessionSummary extends ProviderSession {
  controlMode: SessionControlMode;
  /**
   * REQUIRED, and that is the point (ADR 0012 / archive#1778). The consumer
   * sweep found six independent emission routes for this shape and no
   * natural choke point, so convention cannot enumerate them — the compiler
   * can. A seventh emission path, or a sixteenth consumer that constructs
   * one, is a compile error rather than a summary that silently carries the
   * pre-decoration answer. `packages/contracts/src/__tests__/
   * orchestration-answerability.test.ts` pins that with `@ts-expect-error`.
   */
  answerability: RequestAnswerability;
  attachedSource?: AttachedSessionSourceMetadata;
  isLoaded: boolean;
  isPersisted: boolean;
  eventCount: number;
  lastEventAt?: string;
  lastEventMethod?: CanonicalRuntimeEvent['method'];
  /** Present only while this process is watching this session's active turn. */
  turnProgress?: TurnProgressObservation;
  lifecycleState?: SessionLifecycleState;
  previousLifecycleState?: SessionLifecycleState;
  transitionReason?: SessionTransitionReason;
  transitionSource?: SessionTransitionSource;
  pendingReview?: boolean;
  blockedReason?: string;
  /**
   * Compact attribution for the current failed/stopped outcome. This is
   * absent for clean completion and for terminal sessions with no known cause.
   */
  terminalAttribution?: TerminalAttribution;
  projectSlug?: string;
  /** Durable conversation identity; may differ from this child session thread. */
  conversationId?: string;
  /** Server-resolved Station/Environment namespace that owns the conversation. */
  environmentId?: string;
  /**
   * archive#1462: present only when this Station could NOT attribute the
   * session to exactly one project — today, a read-only-attached session
   * whose working directory is configured as more than one project. It
   * carries the named candidates instead of an arbitrary winner, and
   * `projectSlug` is deliberately absent alongside it.
   *
   * Any surface that LABELS a session's project must render this state
   * rather than imply one of the candidates or fall back to "Unassigned"
   * (which would read as "no project" when the truth is "too many") — see
   * `sessionProjectLabel` in `sessionDisplay.ts`, which is the one helper
   * every such surface goes through, Home's project grouping included
   * (archive#3227 A3).
   *
   * Project-SCOPED collections are a deliberate, disclosed exception: a
   * surface that answers "which sessions belong to project X" is addressed
   * by exactly one project, and an ambiguous session has no such address.
   * `OrchestrationService.listProjectSessionBoard` therefore omits it from
   * every candidate project's board rather than claiming membership of each
   * — the alternative asserts the binding twice instead of zero times. The
   * accepted gap is that project context carries no "N sessions could not be
   * attributed" signal yet; that needs a project-context affordance of its
   * own and is tracked as archive#1519, not silently absorbed.
   *
   * `omittedCandidates` is the number of further candidates the read side
   * bounded away (`ATTACHED_SESSION_PROJECT_CANDIDATES_MAX`); when present,
   * the rendered list is a prefix and must say so.
   */
  projectAttribution?: {
    state: 'ambiguous';
    candidates: string[];
    omittedCandidates?: number;
  };
  projectLayoutSlug?: string;
  assignedAgentSlug?: AgentId;
  /**
   * A normalized, bounded title derived from the first meaningful user turn.
   * It is display-only: absent for promptless or earlier sessions and never
   * replaces the durable event transcript.
   */
  displayTitle?: string;
  delegation?: OrchestrationDelegationContext;
  /**
   * Latest model Station itself requested/configured, from
   * session.configured/turn.started metadata. archive#1182: despite the
   * historical "provider-confirmed" framing, this is a requested value, not
   * an observation — it echoes back Station's own connection/turn model
   * selection, never something the runtime independently reported. See
   * `reportedModel` for the runtime's own claim, when one is available.
   */
  effectiveModel?: string;
  /** Additive explicit name for `effectiveModel`'s requested-only meaning. */
  requestedModel?: string;
  /** Model identity from an accepted adapter configuration event, if any. */
  appliedModel?: string;
  /** Latest bounded requested model controls; absent for old events. */
  effectiveModelOptions?: Record<string, string | number | boolean>;
  /** Accepted at session start; preserved independently from reported model. */
  modelLaunchPlan?: ModelLaunchPlan;
  /**
   * archive#1182: the model identity a runtime independently reported for
   * this session (e.g. the Claude Agent SDK's per-turn assistant-message
   * model, Codex's thread/start response, an ACP agent's own model-category
   * config option, an Ollama chat response's `model` field) — distinct from
   * `effectiveModel` and never derived from it. Absent when the connected
   * engine exposes no such signal (a disclosed gap, not a zero value) or on
   * sessions persisted before this field existed. A mismatch between this
   * and `effectiveModel` is the exact disagreement this ticket exists to
   * surface, not an error state.
   */
  reportedModel?: string;
  /**
   * True when the session has an open turn: the most recent of
   * turn.started/turn.completed/turn.aborted/session.exited in the event log
   * is a turn.started. Stays true across an in-turn approval pause
   * (request.opened/resolved don't close the turn). Drives deploy-time
   * drain checks (roadmap #761): a restart while this is true would
   * silently kill an in-flight External-agent subprocess.
   */
  hasActiveTurn?: boolean;
}

export interface OrchestrationSessionDetail {
  session: OrchestrationSessionSummary;
  events: CanonicalRuntimeEvent[];
  /** Latest bounded recovery state, when Station observed a recoverable failure. */
  recovery?: ConnectionRecoveryProjection;
}

/**
 * Why a bounded read handed back less than the stored event — archive#3386.
 *
 * Absent means nothing was withheld. Present, it names WHICH budget fired, in
 * the `<what>_limit` vocabulary the attached-transcript reader already labels
 * its own bounded reads with (`AttachedSessionSourceOutcome`'s
 * `byte_limit`/`line_limit`), rather than a second spelling of one idea:
 * - `byte_limit` — the serialized payload exceeded the per-event ceiling and
 *   was reduced to its identity fields. The prompt, the attachments and every
 *   other field are absent from THIS read; they are still in the store.
 * - `output_limit` — a tool result's `output`/`error` was cut to the
 *   per-field ceiling. The rest of the payload is intact. `error` is always
 *   cut as text it was sent as. `output` is cut as text too, but — archive#3462
 *   — a non-string `output` (contract-typed `unknown`; real producers send
 *   structured results) is JSON-serialised first, so its cut text may be a
 *   truncated JSON fragment rather than valid JSON, and is not meant to be
 *   parsed back: it exists to show a bounded preview, not to round-trip the
 *   value.
 *
 * The distinction a consumer cannot make without it: bytes withheld by a read
 * budget look exactly like a blob reclaimed by retention, and an elided
 * `turn.started` looks exactly like a turn that never carried a prompt.
 */
export type RuntimeEventElisionReason = 'byte_limit' | 'output_limit';

export interface OrchestrationSequencedEvent {
  sequence: number;
  event: CanonicalRuntimeEvent;
  /**
   * Set only when THIS read withheld part of the stored payload — never a
   * statement about the event as persisted (archive#3386).
   */
  elided?: RuntimeEventElisionReason;
}

export interface OrchestrationSessionEventPage {
  session: OrchestrationSessionSummary;
  events: OrchestrationSequencedEvent[];
  hasMore: boolean;
  nextSequence: number;
}

/** Versioned bounded hydration contract for one orchestration session. */
export interface OrchestrationSessionEventWindow {
  protocolVersion: 1;
  session: OrchestrationSessionSummary;
  events: OrchestrationSequencedEvent[];
  hasMore: boolean;
  nextCursor?: string;
  /** Thread-filtered stream watermark at the snapshot transaction boundary. */
  watermark: number;
}

/**
 * Bounded transcript projection for one durable conversation. The contained
 * runtime events retain their exact child-session `threadId`; `sequence` is
 * only the conversation-local ordinal ordering used by the reader.
 */
export interface OrchestrationConversationEventWindow
  extends OrchestrationSessionEventWindow {
  conversationId: string;
  currentSessionId: string;
  /**
   * Immutable execution-session lineage for this transcript.  A conversation
   * may replace its current Session during a handoff, so a historical turn
   * must resolve its Agent from the Session that produced it rather than from
   * the conversation's current selection.  The Agent is optional because old
   * records may not have recorded one; consumers must show that gap rather
   * than borrowing the current Agent's identity.
   */
  sessionLineage?: Array<{
    sessionId: string;
    agentSlug?: AgentId;
    /** Immutable presentation snapshot captured with the execution Session. */
    agentDisplayName?: string;
    agentIcon?: string;
  }>;
  /** Station-owned boundaries between replaceable execution Sessions. */
  handoffs: ConversationHandoffProjection[];
  /** Consumed-only context-boundary facts rendered into the durable transcript. */
  contextBoundaries: import('./conversation-context-boundary.js').ConversationContextBoundaryTranscriptMarker[];
}

export const CONVERSATION_HANDOFF_CARRIED_FIELDS = Object.freeze([
  'authorizedTranscript',
  'ownerTenantWorkspace',
  'targetAgentModel',
] as const);

export const CONVERSATION_HANDOFF_RESET_FIELDS = Object.freeze([
  'providerNativeCursor',
  'toolState',
  'sessionApprovals',
  'mcpAndEngineConfiguration',
  'activeTurnsAndInterrupts',
  'queuedRequests',
  'sessionLocalGrants',
  'taskWorkflowReferences',
] as const);

export type ConversationHandoffCarriedField =
  (typeof CONVERSATION_HANDOFF_CARRIED_FIELDS)[number];
export type ConversationHandoffResetField =
  (typeof CONVERSATION_HANDOFF_RESET_FIELDS)[number];

export const CONVERSATION_HANDOFF_DISCLOSURE_LABELS: Readonly<
  Record<
    ConversationHandoffCarriedField | ConversationHandoffResetField,
    string
  >
> = Object.freeze({
  authorizedTranscript: 'Conversation transcript',
  ownerTenantWorkspace: 'Workspace and identity',
  targetAgentModel: 'Selected Agent and model',
  providerNativeCursor: 'Provider-native cursor',
  toolState: 'Tool state',
  sessionApprovals: 'Session approvals',
  mcpAndEngineConfiguration: 'MCP and engine-local configuration',
  activeTurnsAndInterrupts: 'In-flight requests and interrupts',
  queuedRequests: 'Queued requests',
  sessionLocalGrants: 'Session-local grants',
  taskWorkflowReferences: 'Session-local task and workflow references',
});

/** Browser-safe, authorized projection; provider events remain untouched. */
export interface ConversationHandoffProjection {
  predecessorSessionId: string;
  sessionId: string;
  /** Client key retained so response-loss observation can identify one effect. */
  idempotencyKey: string;
  targetAgentId: string;
  targetConnectionId?: string;
  targetModelId?: string;
  createdAt: string;
  carried: readonly ConversationHandoffCarriedField[];
  reset: readonly ConversationHandoffResetField[];
}

export type ConversationHandoffEffectStatus =
  | 'reserved'
  | 'accepted'
  | 'completed'
  | 'failed'
  | 'indeterminate';

/** Authorized durable effect truth; never re-resolves mutable Agent setup. */
export interface ConversationHandoffStatusProjection {
  conversationId: string;
  currentSessionId: string;
  status: ConversationHandoffEffectStatus;
  marker: ConversationHandoffProjection;
  providerTurnId?: string;
}

export type AgentRunStatus = RunStatus;

export type AgentRunFailureKind = RunFailureKind;

export interface AgentRunSummary {
  runId: string;
  sessionId: string;
  providerId: string;
  source: 'orchestration';
  /**
   * Whether Station's own engine owns execution, an external engine does,
   * or (persisted-but-unresolvable adapter) it's unknown — replaces the
   * Phase-A `executionClass: 'managed'|'connected'|'unknown'` field
   * (archive#1003 Phase B; docs/design/agent-engine-unification.md §4.1).
   * Derived at read time from adapter metadata, never persisted in events.
   */
  engineExecution: 'station' | 'external' | 'unknown';
  /**
   * The THIRD sibling wire shape ADR 0012 names.
   *
   * `status` here is folded from the same raw events as `lifecycleState`:
   * `deriveAgentRunStatus` returns `waiting_for_approval` for any still-open
   * `request.opened`. On `main` the boot pass converged that at runtime by
   * writing a synthetic `request.resolved`; nothing is written now, so a run
   * whose request nothing can answer reads `waiting_for_approval` forever.
   * Carrying the decoration is what gives a consumer of `/api/orchestration/
   * runs` a wire-level way to know that. Teaching `status` itself is a
   * behaviour change and is NOT done here — see archive#1798.
   */
  answerability: RequestAnswerability;
  status: AgentRunStatus;
  cwd?: string;
  runtimeThreadId?: string;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  failureKind?: AgentRunFailureKind;
  failureMessage?: string;
  retryEligible: boolean;
  attempt: number;
  eventCount: number;
}

export interface SessionBoardItem {
  sessionId: string;
  provider: string;
  controlMode: SessionControlMode;
  runtimeKind: string;
  /**
   * Station-vs-external collapse of the session's engine (archive#1003
   * Phase B — replaces the `'managed'|'connected'|'acp'|'unknown'`
   * vocabulary; mirrors `AgentRunSummary.engineExecution`'s tri-state).
   */
  agentType: 'station' | 'external' | 'unknown';
  /** Carried from the base summary's decoration, never re-derived here. */
  answerability: RequestAnswerability;
  lifecycleState: SessionLifecycleState;
  previousLifecycleState?: SessionLifecycleState;
  transitionReason?: SessionTransitionReason;
  transitionSource?: SessionTransitionSource;
  pendingReview: boolean;
  blockedReason?: string;
  projectSlug: string;
  projectLayoutSlug?: string;
  assignedAgentSlug?: AgentId;
  model?: string;
  status: ProviderSession['status'];
  createdAt: string;
  updatedAt: string;
  lastEventAt?: string;
  lastEventMethod?: CanonicalRuntimeEvent['method'];
  isLoaded: boolean;
  isPersisted: boolean;
  eventCount: number;
  retryEligible: boolean;
  openHref: string;
}

export interface TerminalProcessSummary {
  kind: 'terminal';
  sessionId: string;
  projectSlug: string;
  terminalId: string;
  cwd: string;
  status: 'starting' | 'running' | 'exited';
  pid: number | null;
  exitCode: number | null;
  hasRunningSubprocess: boolean;
  cols: number;
  rows: number;
}

export interface TerminalProcessDetail {
  process: TerminalProcessSummary;
  history: string;
}

/**
 * S2 of #1302 (conversation-surface consolidation): one item shape for the
 * global conversation-inventory endpoint (`GET /api/conversations`), folding
 * both legs the per-agent endpoint already unions — the orchestration
 * session projection (`source: 'runtime'`) and file-store conversations
 * (`source: 'store'`) — so every conversation-list surface (inbox, history
 * panel, ⌘O picker, SessionsView) can converge on one query and one item
 * model instead of each re-deriving its own. Ships dark in this slice: no
 * consumer reads it yet.
 */
export interface ConversationListItem {
  id: string;
  source: 'runtime' | 'store';
  agentSlug: AgentId;
  projectSlug?: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  /** False when the transcript is owned by an external runtime event store. */
  mutable: boolean;
  /**
   * Durable title provenance for mutable store conversations. A UI must ask
   * before replacing a human-owned title; runtime conversations have none.
   */
  titleSource?: 'user' | 'generated' | 'provider' | 'prompt';
  /**
   * Carried from the base summary's decoration. Required on this shape too:
   * `useConversationInventoryQuery`'s consumers fold the same
   * `lifecycleState`/`pendingReview` fields, so a conversation item that
   * arrived undecorated would be exactly the sixteenth consumer this
   * decoration exists to name. Store-sourced items (`source: 'store'`) have
   * no orchestration session and no serving-process answer to give; they
   * carry `{ answerable: true }`, which is the truth for a transcript that
   * has no open request to answer.
   */
  answerability: RequestAnswerability;
  controlMode?: SessionControlMode;
  lifecycleState?: SessionLifecycleState;
  pendingReview?: boolean;
  provider?: string;
  /** Engine-reported identity preferred for a resumed conversation header. */
  model?: string;
  /** Adapter-accepted model identity, distinct from a reported model claim. */
  acceptedModel?: string;
  /** Server-resolved Station/Environment namespace for this conversation. */
  environmentId?: string;
  /** Version of this conversation that the current user has opened. */
  acknowledgedAt?: string;
  hasActiveTurn?: boolean;
  /** Immutable fork facts folded by the conversation read model. */
  forkProvenance?: {
    forkedFrom?: ConversationForkProvenance;
    forkedTo: ConversationForkProvenance[];
  };
}

export interface ConversationForkProvenance {
  sourceConversationId: string;
  targetConversationId: string;
  targetAgent: string;
  forkedAt: string;
}

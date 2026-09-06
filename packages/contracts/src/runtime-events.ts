import type { PersistedChatAttachment } from './chat-attachment.js';
import type { ClientOrigin } from './client-origin.js';
import type { PrincipalRef } from './principal.js';
import { type EngineId, PROVIDER_CODEX } from './provider.js';
import type {
  SessionLifecycleState,
  SessionTransitionReason,
  SessionTransitionSource,
} from './session-lifecycle.js';
import type {
  WorkflowNextActionStatus,
  WorkflowPhase,
  WorkflowTaskStatus,
} from './workflow.js';

/**
 * Server-side EventBus channel names (server → SSE → UI). Centralized so emit
 * and subscribe sides share one set — a typo becomes a compile error instead of
 * a silent no-op. (Distinct from the per-session CanonicalRuntimeEvent methods
 * below, which describe agent-runtime events, not EventBus channels.)
 */
export const SERVER_EVENTS = {
  /** Exact answer assessment changed; identity-bearing and intentionally scoped. */
  ANSWER_ASSESSMENT_UPDATED: 'answer.assessment.updated',
  /** Exact retained-narrative association changed; Session-scoped. */
  ANSWER_NARRATIVE_UPDATED: 'answer.narrative.updated',
  ACP_STATUS: 'acp:status',
  AGENTS_CHANGED: 'agents:changed',
  APPROVAL_OPENED: 'approval:opened',
  APPROVAL_RESOLVED: 'approval:resolved',
  BUILD_UPDATED: 'build:updated',
  CONFIG_CHANGED: 'config:changed',
  CORE_UPDATED: 'core:updated',
  DATA_CHANGED: 'data:changed',
  /**
   * Station's own signal — never a
   * `CanonicalRuntimeEvent` — that an internal-machinery stop's suppressed
   * turn ultimately did NOT get re-dispatched (the credential-profile
   * restart itself failed). The generic turn-completion push pipeline
   * cannot reliably learn this in time to decide whether to suppress: the
   * adapter's orphaned-turn `runtime.error` is observed essentially
   * synchronously with the stop, well before the retry's own async result
   * is known (proven live — see `turn-completion-notifications.ts`'s
   * `wireInternalStopRedispatchFailureNotifications`).
   *
   * SESSION-SCOPED, NOT SAFE TO BROADCAST: the payload is
   * `{threadId, turnId, provider}` — the exact `threadId`/`turnId` pair
   * `canUserReadSession`/`sessionOwnerUserId` gate everywhere else they are
   * read. Its topology (emitted, no src-server subscriber other than the one
   * listener above) resembles `RUNTIME_HEALTH_CHANGED`, but that channel
   * carries only `{provider, status}` — no session identifier — which is
   * exactly why broadcasting IT on the identity-free `/events` route is
   * safe. This one is tagged `'scoped'` in `SERVER_EVENT_BROADCAST_SAFETY`
   * below (archive#3567) for the opposite reason
   * (archive#3525: an earlier version of this comment's "mirrors
   * RUNTIME_HEALTH_CHANGED" claim was exactly what let it broadcast verbatim
   * on that route before the mistake was caught — decide a new
   * channel's route eligibility by payload sensitivity, never by topological
   * resemblance to an already-safe one). Before station#3567 that route ran
   * a hand-maintained denylist of channel names; it now derives the same
   * refusal from this tag, so a future channel like this one is denied by
   * default without the route file needing to change at all.
   */
  INTERNAL_STOP_REDISPATCH_FAILED:
    'orchestration:internal-stop-redispatch-failed',
  NOTIFICATION_DELIVERED: 'notification:delivered',
  NOTIFICATION_UPDATED: 'notification:updated',
  NOTIFICATION_DISMISSED: 'notification:dismissed',
  NOTIFICATION_CLEARED: 'notification:cleared',
  OPERATIONAL_EVENT: 'operational:event',
  ORCHESTRATION_EVENT: 'orchestration:event',
  /** A live session projection changed without creating a runtime event. */
  ORCHESTRATION_SESSION_PROJECTION_UPDATED:
    'orchestration:session-projection-updated',
  PLUGINS_INSTALLED: 'plugins:installed',
  PLUGINS_REMOVED: 'plugins:removed',
  PLUGINS_UPDATED: 'plugins:updated',
  PLUGINS_SETTINGS_CHANGED: 'plugins:settings-changed',
  PLUGINS_GRANTS_CHANGED: 'plugins:grants-changed',
  PLUGINS_UPDATES_AVAILABLE: 'plugins:updates-available',
  RUNTIME_HEALTH_CHANGED: 'runtime:health-changed',
  SYSTEM_STATUS_CHANGED: 'system:status-changed',
  UI_NAVIGATE: 'ui:navigate',
} as const;

export type ServerEventName =
  (typeof SERVER_EVENTS)[keyof typeof SERVER_EVENTS];

/**
 * Whether a `SERVER_EVENTS` channel's payload is safe to relay verbatim to
 * every connected client on the identity-free broadcast route
 * (`src-server/routes/orchestration/events.ts`).
 *
 * - `'broadcast'` — the payload carries only ambient facts (a provider name,
 *   a status enum, a version, a count). Safe for any listener.
 * - `'scoped'` — the payload carries a `threadId`, `turnId`, `sessionId`, a
 *   user id, a project/file path, prompt/message content, or anything else
 *   that identifies a particular user's work. NOT safe to broadcast; the
 *   route relays it only through a channel-specific identity gate it
 *   recognizes by name (today: the notification family, the approval
 *   family, and `UI_NAVIGATE`), and denies it by default otherwise.
 */
export type BroadcastSafety = 'broadcast' | 'scoped';

/**
 * station#3567: the route used to decide relay-or-deny with a hand-maintained
 * denylist at the route itself — the default for anything NOT named there was
 * broadcast. A new session-scoped channel (station#3525) reached every
 * connected client because adding it to `SERVER_EVENTS` was, by itself,
 * enough; nobody had to touch the route, and the route's own guard test
 * (`events.routes.test.ts`) iterated `SERVER_EVENTS` and *certified* the
 * omission as correct.
 *
 * This map inverts that default. It is written as `{ [K in ServerEventName]:
 * BroadcastSafety }` — a mapped type over the exact union of channel names —
 * so TypeScript rejects the file if any `SERVER_EVENTS` member is missing an
 * entry here (`Property '...' is missing`) or if an entry here names a
 * channel `SERVER_EVENTS` doesn't have (excess-property check on a literal
 * assigned to an exact mapped type). A new `SERVER_EVENTS` member therefore
 * cannot compile without this map being updated in the same commit — the
 * decision is unavoidable at the definition site, not remembered at the
 * route.
 *
 * The route (`createEventRoutes`) reads this map first, for every channel,
 * to decide broadcast-vs-not — that half cannot drift, because the map is
 * exhaustive by construction. It does **not** read only this map: a
 * `'scoped'` channel still reaches a client only through one of the route's
 * own hand-maintained per-channel lists (today: `isApprovalEvent`,
 * `isNotificationEvent`, `isUiNavigateEvent`) that decide which dedicated
 * identity gate applies — the route file's own header comment says the same
 * thing. A `'scoped'` channel this route recognizes no gate for is denied,
 * never forwarded; that default (not "there is no second list") is what this
 * map fixes. Separately, the route's connect-time ACP status snapshot writes
 * `SERVER_EVENTS.ACP_STATUS` to every client without consulting this map at
 * all — safe only because that status is host-global/ambient, not because
 * this map governs it; a channel added there later would need its own
 * review.
 *
 * This does not, and cannot, replace judgment about what a payload actually
 * carries — a member tagged `'broadcast'` whose payload later grows a
 * `threadId` is still a leak. It closes the OTHER half: a channel that is
 * *never classified at all*.
 */
export const SERVER_EVENT_BROADCAST_SAFETY: {
  readonly [K in ServerEventName]: BroadcastSafety;
} = {
  [SERVER_EVENTS.ACP_STATUS]: 'broadcast',
  [SERVER_EVENTS.AGENTS_CHANGED]: 'broadcast',
  [SERVER_EVENTS.ANSWER_ASSESSMENT_UPDATED]: 'scoped',
  [SERVER_EVENTS.ANSWER_NARRATIVE_UPDATED]: 'scoped',
  // Approval lifecycle payloads carry an approvalId bound to a specific
  // pending request; relayed only through `canRelayApprovalEvent`'s identity
  // gate, never unconditionally.
  [SERVER_EVENTS.APPROVAL_OPENED]: 'scoped',
  [SERVER_EVENTS.APPROVAL_RESOLVED]: 'scoped',
  [SERVER_EVENTS.BUILD_UPDATED]: 'broadcast',
  [SERVER_EVENTS.CONFIG_CHANGED]: 'broadcast',
  [SERVER_EVENTS.CORE_UPDATED]: 'broadcast',
  // `{ keys: string[] }` — fixed invalidation categories ('agents',
  // 'projects', ...), never an id.
  [SERVER_EVENTS.DATA_CHANGED]: 'broadcast',
  // `{threadId, turnId, provider}` — see the member's own docblock above.
  [SERVER_EVENTS.INTERNAL_STOP_REDISPATCH_FAILED]: 'scoped',
  // Notification payloads carry notification content (title/body/actions)
  // scoped to whoever it was delivered to; relayed only through
  // `canRelayNotificationEvent`'s identity gate.
  [SERVER_EVENTS.NOTIFICATION_DELIVERED]: 'scoped',
  [SERVER_EVENTS.NOTIFICATION_UPDATED]: 'scoped',
  [SERVER_EVENTS.NOTIFICATION_DISMISSED]: 'scoped',
  // `{clearedCount, retainedCount}` — no content, no id, unlike its three
  // siblings above. Still scoped to whoever's notification list was cleared,
  // so it is gated through the same `canRelayNotificationEvent` identity
  // check as the rest of the family, not broadcast.
  [SERVER_EVENTS.NOTIFICATION_CLEARED]: 'scoped',
  // Wraps an arbitrary internal operational-work event; consumed only by the
  // capability-scoped dispatcher, never this route.
  [SERVER_EVENTS.OPERATIONAL_EVENT]: 'scoped',
  // Wraps a `CanonicalRuntimeEvent` — threadId/turnId/prompt/output content.
  // Gated elsewhere (`canUserReadSession`); never this route.
  [SERVER_EVENTS.ORCHESTRATION_EVENT]: 'scoped',
  // `{threadId}` names one session, so this follows the same ownership gate
  // as canonical orchestration events on the dedicated stream.
  [SERVER_EVENTS.ORCHESTRATION_SESSION_PROJECTION_UPDATED]: 'scoped',
  [SERVER_EVENTS.PLUGINS_INSTALLED]: 'broadcast',
  [SERVER_EVENTS.PLUGINS_REMOVED]: 'broadcast',
  [SERVER_EVENTS.PLUGINS_UPDATED]: 'broadcast',
  // Settings payload deliberately excludes every field the plugin manifest
  // marks `secret` (see the emit site) — what remains is meant to be
  // non-secret configuration, not per-user content. `field.secret` is
  // manifest-author-controlled, though, so the emit site (station#3576,
  // `emittedPluginSettings` in `plugin-config-routes.ts`) checks two more
  // axes before broadcasting: a field whose KEY NAME matches the redaction
  // module's secret-field classifier is withheld even when the author never
  // marked it `secret` (an author who names a field `apiKey`/`clientSecret`/
  // etc. and forgets the boolean is still covered — at the cost of some
  // false positives on ordinary OAuth-shaped field names, see that
  // function's docblock); a field whose VALUE merely looks credential-shaped
  // under a non-secret name is logged but still emitted, since that signal
  // alone is too unreliable to justify a silent drop.
  [SERVER_EVENTS.PLUGINS_SETTINGS_CHANGED]: 'broadcast',
  [SERVER_EVENTS.PLUGINS_GRANTS_CHANGED]: 'broadcast',
  [SERVER_EVENTS.PLUGINS_UPDATES_AVAILABLE]: 'broadcast',
  [SERVER_EVENTS.RUNTIME_HEALTH_CHANGED]: 'broadcast',
  [SERVER_EVENTS.SYSTEM_STATUS_CHANGED]: 'broadcast',
  // `{ path: string }` — not identity-carrying content by itself, but every
  // recipient ACTS on it (their own UI navigates). A hosted deployment has
  // no destination identity in this payload to route it to one tenant's
  // connections, so broadcasting it would drive every connected client's UI
  // regardless of who issued the command. Gated by `isUiNavigateEvent` /
  // its dedicated identity gate (archive#3567): delivered in
  // personal mode (this route reaches only the one user's own tabs/devices
  // there — the feature as designed), denied in hosted mode.
  [SERVER_EVENTS.UI_NAVIGATE]: 'scoped',
} as const;

/**
 * SSE frame `event:` names used only on the orchestration `/api/orchestration/events`
 * stream itself, not `EventBus` channels (`orchestration:snapshot` stays a bare
 * string literal at its existing call sites — this only adds the new one,
 * station#1092). Centralized so the server route and client hooks share one
 * literal for the ordering-safe "replay/snapshot done, now live" marker.
 */
export const ORCHESTRATION_STREAM_CAUGHT_UP_EVENT = 'orchestration:caughtUp';

export type SessionState =
  | 'created'
  | 'configured'
  | 'idle'
  | 'running'
  | 'awaiting-approval'
  | 'review_pending'
  | 'completed'
  | 'aborted'
  | 'errored'
  | 'exited';

export type ApprovalStatus = 'approved' | 'denied' | 'cancelled' | 'expired';

export type RuntimeSeverity = 'error' | 'warning';

export interface CanonicalRuntimeEventBase {
  eventId: string;
  provider: EngineId;
  threadId: string;
  createdAt: string;
  turnId?: string;
  itemId?: string;
  requestId?: string;
  sessionState?: SessionLifecycleState;
  previousState?: SessionLifecycleState;
  transitionReason?: SessionTransitionReason;
  transitionSource?: SessionTransitionSource;
  /** Server-authenticated origin for the user action that created this fact. */
  clientOrigin?: ClientOrigin;
  /**
   * station#4075 stage 2: the principal Station attributes this fact to,
   * stamped at EMIT time (never inferred after the fact) for
   * `turn.started` and ownership-shaped (`session.started`/
   * `session.configured`) events. Additive and back-compat: every event
   * persisted before this field existed simply omits it, exactly like
   * `clientOrigin` above, which this mirrors — same propagation mechanism
   * (`ClientOriginTurnPropagation`, generalized to carry both), same
   * "server-authenticated, never client-supplied" contract. See
   * `packages/contracts/src/principal.ts` for what a `PrincipalRef` is and
   * is not (attribution, never authorization).
   */
  principal?: PrincipalRef;
}

export interface SessionStartedEvent extends CanonicalRuntimeEventBase {
  method: 'session.started';
  sessionId: string;
  initialState?: SessionState;
  metadata?: Record<string, unknown>;
}

export interface SessionConfiguredEvent extends CanonicalRuntimeEventBase {
  method: 'session.configured';
  sessionId: string;
  model?: string;
  instructions?: string;
  cwd?: string;
  tools?: string[];
  metadata?: Record<string, unknown>;
}

export interface SessionStateChangedEvent extends CanonicalRuntimeEventBase {
  method: 'session.state-changed';
  sessionId: string;
  from: SessionState;
  to: SessionState;
  reason?: string;
  sessionState?: SessionLifecycleState;
  previousState?: SessionLifecycleState;
  transitionReason?: SessionTransitionReason;
  transitionSource?: SessionTransitionSource;
  /**
   * Written ONLY by
   * `InterruptedTurnRecovery.consume()`, the boot-time
   * consumer of `SessionTurnBoundaryAuthority`'s crash-reconcile verdict.
   * `runtime-event-projection.ts`'s `[TURN_INTERRUPTED]` banner render gates
   * on THIS field's presence, not on the (sessionState:'needs_input',
   * transitionReason:'runtime_exit', transitionSource:'system_recovery')
   * vocabulary triple those other fields also carry — that triple is
   * ordinary enum vocabulary any future emitter could legitimately produce
   * for an unrelated reason, so gating on it alone would let a generic
   * transition mint a banner it never earned. This field is not: nothing
   * else in this codebase sets it, and it is documented here as reserved to
   * that one caller.
   */
  interruptedTurnBoundary?: {
    /** The `orchestration_turn_boundaries` row this interruption derives from. */
    boundaryId: string;
    /**
     * The row's state at consume time: `'accepted'` means the provider had
     * already accepted the turn when its owner died; `'indeterminate'`
     * means the crash-reconcile sweep flipped a dead `invoking` owner
     * itself (or a prior consume pass left it unresolved).
     */
    priorState: 'accepted' | 'indeterminate';
    /** The provider's own turn id, when the boundary had one (`accepted`). */
    providerTurnId?: string;
    /** The dead owner's id, carried for a future slice's own diagnostics. */
    ownerId: string;
    /** The boundary row's own `created_at`/`updated_at`, not this event's. */
    boundaryCreatedAt: string;
    boundaryUpdatedAt: string;
  };
}

export interface SessionExitedEvent extends CanonicalRuntimeEventBase {
  method: 'session.exited';
  sessionId: string;
  exitCode?: number;
  reason?: string;
}

export interface TurnStartedEvent extends CanonicalRuntimeEventBase {
  method: 'turn.started';
  turnId: string;
  prompt?: string;
  /** Distinguishes input appended inside an already-running turn. */
  inputKind?: 'steer';
  /**
   * Durable, session-scoped user inputs used to reconstruct transcript media.
   * Persisted without their bytes (station#3374) — see
   * {@link PersistedChatAttachment} for which of `dataUrl`/`blobRef` a given
   * read carries, and `dispatchableChatAttachments` before sending any of
   * these back to a model.
   */
  attachments?: PersistedChatAttachment[];
  /**
   * The uncomposed ambient text used with `prompt` at dispatch time. This is
   * canonical turn context, not recovery state: replay routes it through the
   * normal send-turn composition choke point instead of persisting a second
   * copy of the composed model input.
   */
  ambientContext?: string;
  metadata?: Record<string, unknown>;
}

export interface TurnCompletedEvent extends CanonicalRuntimeEventBase {
  method: 'turn.completed';
  turnId: string;
  finishReason?: 'stop' | 'tool-calls' | 'max-tokens' | 'cancelled' | 'other';
  outputText?: string;
  /**
   * station#1182: additive, back-compat (absent on every event persisted
   * before this field existed). Carries `reportedModel` when an adapter can
   * confirm what the runtime actually ran for this turn (e.g. the Claude
   * Agent SDK's per-turn assistant-message model) — see
   * `effective-model-metadata.ts` for the requested-vs-reported contract.
   */
  metadata?: Record<string, unknown>;
}

export interface TurnAbortedEvent extends CanonicalRuntimeEventBase {
  method: 'turn.aborted';
  turnId: string;
  reason: string;
}

/**
 * The result of Station's cooperative stop protocol. This is not an engine
 * assertion: OrchestrationService emits it only after its local
 * acknowledgement/deadline race has settled.
 */
export interface SessionStopSettledEvent extends CanonicalRuntimeEventBase {
  method: 'session.stop-settled';
  turnId: string;
  outcome: 'cooperative' | 'forced';
  /**
   * station#2959: who invoked the cooperative-stop protocol for this turn —
   * a user Stop request (#2806, the original protocol) or Station's own
   * turn-stall detection noticing no progress within the agent's window.
   * Set from the initiator parameter `interruptUserTurnCooperatively` was
   * actually called with, never inferred afterward from `outcome` or
   * `reason` text. Optional only because every event persisted before this
   * field existed has neither value; every stop this service emits going
   * forward sets it.
   */
  initiatedBy?: 'user' | 'stall';
}

export interface ContentTextDeltaEvent extends CanonicalRuntimeEventBase {
  method: 'content.text-delta';
  /**
   * The CONTENT ITEM this delta belongs to — one assistant text block, one
   * reasoning block — and therefore STABLE across every delta of that item.
   * It is deliberately not per-chunk identity: `eventId` identifies this one
   * chunk, so two deltas of the same item share an `itemId` and never share
   * an `eventId`.
   *
   * An adapter mints it from the engine's own item id where the engine has
   * one (Codex's `params.itemId`, ACP's `update.messageId`, Claude's
   * message id plus content-block index); where the engine has none, it
   * mints one value when the item opens and reuses that value for the
   * item's whole run. Minting inside the streaming loop is the defect this
   * contract exists to rule out (station#3457).
   *
   * It matters because consumers may GROUP OR MERGE by it. Batching or
   * coalescing deltas keyed on `itemId` degrades to a silent no-op against
   * an adapter that re-mints per chunk, and merges unrelated content
   * against an adapter that collapses distinct items onto one turn-wide
   * value. So: distinct items — including a text item and a reasoning item
   * within one turn — must carry distinct values, and a value must not
   * repeat across turns.
   */
  itemId: string;
  delta: string;
}

export interface ContentReasoningDeltaEvent extends CanonicalRuntimeEventBase {
  method: 'content.reasoning-delta';
  /**
   * The reasoning CONTENT ITEM this delta belongs to, stable across every
   * delta of that item; per-chunk identity is `eventId`. The full contract —
   * including why a consumer may group or merge by this field, and why a
   * reasoning item must not share a value with a text item in the same turn
   * — is documented on {@link ContentTextDeltaEvent.itemId}.
   */
  itemId: string;
  delta: string;
}

export interface ToolStartedEvent extends CanonicalRuntimeEventBase {
  method: 'tool.started';
  itemId: string;
  toolCallId: string;
  toolName: string;
  arguments?: unknown;
}

export interface ToolProgressEvent extends CanonicalRuntimeEventBase {
  method: 'tool.progress';
  itemId: string;
  toolCallId: string;
  message: string;
  progress?: number;
  /**
   * Present only when Station intentionally narrowed engine-supplied tool
   * material before publishing it.  This is a receipt, never an artifact
   * reference: Station did not retain an omitted full value elsewhere.
   */
  outputReceipt?: ToolOutputReceipt;
}

/** Honest, bounded description of a tool-output projection. */
export interface ToolOutputReceipt {
  truncated: true;
  /** Closed vocabulary; values are safe for transport and telemetry. */
  reasons: Array<
    | 'bytes'
    | 'blocks'
    | 'depth'
    | 'properties'
    | 'cycle'
    | 'getter'
    | 'updates'
    | 'unsupported'
  >;
  /** Number of UTF-8 bytes retained in this bounded projection. */
  retainedBytes: number;
  /** Lower bound for bytes Station deliberately did not retain. */
  omittedBytesAtLeast: number;
  /** Number of redraw replacements dropped by the per-call update ceiling. */
  omittedUpdates: number;
  /** Projection rule used for this receipt; no source content is retained. */
  strategy: 'utf8-tail' | 'structural-omission';
  /** Full engine output is deliberately unavailable rather than stored elsewhere. */
  fullOutput: 'unavailable';
}

export interface ToolCompletedEvent extends CanonicalRuntimeEventBase {
  method: 'tool.completed';
  itemId: string;
  toolCallId: string;
  toolName: string;
  /**
   * The observed outcome of the call.
   *
   * Three of these assert what happened: `success` and `error` are the
   * engine's own verdict, and `cancelled` is a stop Station or the user
   * asked for. `unresolved` (station#1558) asserts the opposite — that no
   * verdict will ever arrive. It is published for a tool call still open
   * when its SESSION ended, where the call's fate is genuinely unknown:
   * Station never saw a result, and cannot tell whether the tool ran. Every
   * adapter that tracks its open calls settles them this way when a session
   * IT STILL OWNS ends (station#1569 item 4 extended this past Claude to
   * ACP, Codex and station-agent); a record already superseded by a restart
   * on the same thread deliberately publishes nothing, since its terminals
   * would land on the live session. It is
   * NOT a failure (nothing observed the tool fail) and NOT a cancellation
   * (nobody asked for it to stop); folding it into either would be a claim
   * Station cannot support. Without it, the row simply stayed "running"
   * forever.
   *
   * **Compatibility.** A client built before this member sees an
   * unrecognised string, and the two folds degrade differently. Neither
   * degrades *silently* only in the sense that the event's `output` carries
   * the explicit prose "No result was reported before the session ended;
   * whether the tool ran is unknown." — the enum itself is read wrongly in
   * both, and in one of them the row makes a positive claim:
   * - the durable projection (`runtime-event-projection.ts`) tested
   *   `status === 'error'` / `=== 'cancelled'` and fell through to
   *   `state: 'result'` with the sentence as the row's `result`. In an older
   *   `ToolCallDisplay` that combination satisfies `completedSuccessfully`
   *   (`state === 'result'`, no error, not cancelled), so the row renders
   *   the past-tense label with NO badge at all, and expanding it prints the
   *   status footer "Success". An older rehydrated transcript therefore
   *   presents an unresolved call as a successful one whose output happens
   *   to be that sentence;
   * - the live handler (`streamHandlers.ts`) mapped anything that was
   *   neither `success` nor `cancelled` to `state: 'error'`, so an older
   *   live client renders it as a failure carrying the same sentence.
   *
   * So the sentence, not the enum, is the only thing an older client gets
   * right, and a reader has to open the row to find it. That asymmetry is
   * the reason the text is written to stand alone. Publishers must not use
   * this status for any other situation.
   */
  status: 'success' | 'error' | 'cancelled' | 'unresolved';
  output?: unknown;
  error?: string;
  /** See {@link ToolProgressEvent.outputReceipt}. */
  outputReceipt?: ToolOutputReceipt;
  /**
   * Set by, and only by, Station's pre-tool policy evaluator
   * (`pre-tool-policy.ts`'s `deny()` — the sole writer in the tree; both
   * engine adapters copy it verbatim and nothing infers it).
   *
   * It names the AUTHORITY that refused the call, not the verdict — which
   * is why the badge does too ("Blocked by Station"). Absence means "no
   * information", never "not denied".
   */
  policyDenied?: true;
}

export interface RequestOpenedEvent extends CanonicalRuntimeEventBase {
  method: 'request.opened';
  requestId: string;
  requestType: 'approval' | 'permission' | 'confirmation' | 'input';
  title: string;
  description?: string;
  payload?: Record<string, unknown>;
}

export interface RequestResolvedEvent extends CanonicalRuntimeEventBase {
  method: 'request.resolved';
  requestId: string;
  status: ApprovalStatus;
  response?: Record<string, unknown>;
}

export interface RuntimeErrorEvent extends CanonicalRuntimeEventBase {
  method: 'runtime.error';
  severity: Extract<RuntimeSeverity, 'error'>;
  message: string;
  code?: string;
  retriable?: boolean;
  details?: Record<string, unknown>;
}

/**
 * archive#3451: the ONE `runtime.error` publish this repo's own
 * audit documents as not proof the turn is over — codex's `'error'`
 * notification (`willRetry`) may resolve the SAME turn without a new
 * `turn.started`. Scoped to `provider === PROVIDER_CODEX` because other
 * publishers (station-agent-adapter's two `runtime.error` sites) hardcode
 * `retriable: true` for turns that are ALREADY terminal, so filtering on the
 * flag alone would treat those as still in flight.
 *
 * Lives here, not in `session-lifecycle-service.ts` (src-server) or
 * `eventHandlers.ts` (src-ui), because both need it and neither can import
 * the other — src-server and src-ui build as separate bundles, and this
 * package is the one thing both already depend on for the exact fields this
 * reads (`RuntimeErrorEvent.retriable`, `PROVIDER_CODEX`). Before this fix
 * the same condition existed as FIVE independent hand copies across both
 * sides; this is the one definition all of them now import.
 */
export function isDeferredRetriableTurnError(
  event: Pick<CanonicalRuntimeEvent, 'method'> & {
    provider?: EngineId;
    retriable?: boolean;
  },
): boolean {
  return (
    event.method === 'runtime.error' &&
    event.provider === PROVIDER_CODEX &&
    event.retriable === true
  );
}

export interface RuntimeWarningEvent extends CanonicalRuntimeEventBase {
  method: 'runtime.warning';
  severity: Extract<RuntimeSeverity, 'warning'>;
  message: string;
  code?: string;
  details?: Record<string, unknown>;
}

export interface TokenUsageUpdatedEvent extends CanonicalRuntimeEventBase {
  method: 'token-usage.updated';
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  /** Provider-reported cache writes with the five-minute ephemeral TTL. */
  cacheWriteTokens5m?: number;
  /** Provider-reported cache writes with the one-hour ephemeral TTL. */
  cacheWriteTokens1h?: number;
  /** Opaque provider-reported service tier; Station does not enumerate it. */
  serviceTier?: string;
  /** Provider-reported tokens currently occupying the context window. */
  contextTokens?: number;
  /** Provider-reported total context-window capacity in tokens. */
  contextWindowTokens?: number;
  /**
   * A price catalog observation captured at event ingestion. It is optional
   * because many engines report neither a catalog nor a price. Consumers
   * must never fill it later from a live catalog: this is the historical
   * estimate's immutable provenance.
   */
  pricingSnapshot?: {
    id: string;
    capturedAt: string;
    /** Catalog authority captured at ingestion, never recovered on read. */
    source?: string;
    currency: string;
    provider: string;
    model: string;
    inputPerMillion?: number;
    outputPerMillion?: number;
    cacheReadPerMillion?: number;
    cacheWritePerMillion?: number;
  };
  /**
   * Cost in USD **as the provider reported it** (station#1299 item 4).
   *
   * The provider is the authority on what it charged, so this is carried
   * verbatim and is never recomputed from token counts against a local
   * price table. Absent means the engine reported no cost at all — which
   * is different from a reported zero, and every consumer must keep those
   * apart (see `SessionUsageAggregate.reportedCostUsd`).
   *
   * The figure's SCOPE — per-turn versus cumulative-since-this-engine-
   * process-started — is not encoded in the event; it is declared per
   * provider by `PROVIDER_COST_SCOPE` in
   * `@kontourai/station-shared/usage-fold`, because two providers can
   * report tokens and cost on the same event with different scopes (Claude
   * Code does exactly that). An adapter that starts emitting this field
   * must declare its scope there.
   *
   * A currency other than USD has no home here: an adapter whose engine
   * reports, say, EUR must not convert (Station has no rate policy) and so
   * reports no cost at all — see the ACP `usage_update` mapping.
   */
  reportedCostUsd?: number;
}

/**
 * How far a Flow run's gate evaluation has actually got, as distinct from how
 * recently its state file was written. `state.updated_at` moves on every save
 * — attach, evidence attach, projection sync — so a run that has never had a
 * gate evaluated still carries a fresh-looking stamp. Surfaces that render
 * `updated_at` as progress therefore overstate it by construction; these
 * fields are derived only from records a gate evaluation itself produced.
 */
export interface FlowRunFreshness {
  /**
   * ISO timestamp of the most recent gate evaluation, or `null` when no gate
   * has ever been evaluated on this run (or Flow recorded no timestamp for
   * the evaluations it has). Never borrowed from `state.updated_at`.
   */
  lastEvaluatedAt: string | null;
  /**
   * Present when the run cannot advance through evaluation at all because its
   * current step declares no gate: Flow's `evaluate` throws `no gate for
   * current step`, and Station's only automated evaluator (the completion
   * gate) turns that into a `wait`. The run is stuck, not in progress.
   */
  blockedReason?: 'ungated-step';
  /** Gate outcomes recorded on the run. `0` means never evaluated. */
  gateOutcomeCount: number;
  /** Evidence entries attached to the run's manifest. */
  evidenceCount: number;
}

/**
 * Emitted by the orchestration layer (not provider adapters) when a session
 * started in a Flow workspace is bound to a Flow run. The last such event in
 * a session's history is the authoritative session -> Flow run binding.
 */
export interface FlowRunAttachedEvent extends CanonicalRuntimeEventBase {
  method: 'flow.run-attached';
  runId: string;
  definitionId: string;
  cwd: string;
  /** True when an existing run was re-attached instead of newly created. */
  resumed: boolean;
  /** The run's step at attach time — names the step in "no gate on step X". */
  currentStep?: string;
  /**
   * Freshness at attach time, so a surface that only sees this event (the
   * chat chip and transcript marker) states what the run has actually
   * evaluated instead of implying progress from the binding alone.
   */
  freshness?: FlowRunFreshness;
}

export type FlowGateVerdict = 'pass' | 'route-back' | 'block' | 'wait';

/**
 * Emitted by the orchestration layer when a Flow-bound session requests
 * completion and its run is evaluated. A non-pass verdict means the session
 * was NOT marked complete; the event carries the actionable guidance.
 */
export interface FlowGateVerdictEvent extends CanonicalRuntimeEventBase {
  method: 'flow.gate-verdict';
  runId: string;
  verdict: FlowGateVerdict;
  gateId?: string;
  summary?: string;
  /** Flow's `state.next_action` text — assistant-visible guidance. */
  nextAction?: string;
  /** Route-back contract (verdict 'route-back'). */
  routeBackTo?: string;
  attempt?: number;
  maxAttempts?: number;
  /** Missing expectation ids (verdicts 'wait' and 'block'). */
  missing?: string[];
  /** Workspace-relative report paths (verdict 'pass'). */
  reportPaths?: { json: string; markdown: string };
  /** True when only a human-accepted exception can unblock (verdict 'block'). */
  exceptionRequired?: boolean;
  /**
   * @deprecated Historical Station-side producer-pin overlay payload. Flow 5.1
   * owns producer and authority policy; Station does not emit this for new
   * verdicts. Its absence is not an assessment result.
   */
  readonly producerPin?: {
    violations?: Array<{
      gate_id: string;
      expectation_id: string;
      evidence_id: string;
      producer: string | null;
      claim_type: string;
      allowed_producers: string[];
      reason: 'untrusted_producer';
    }>;
    unevaluated?: Array<{ gate_id: string; reason: string }>;
  };
  /**
   * Result of the automatic Veritas readiness attach attempt (S1c). Present
   * only when the evaluation was missing readiness-type expectations at
   * completion time: 'attached' means readiness evidence was auto-attached
   * and the run re-evaluated once; the other outcomes mean the original
   * verdict stands and `reason` says why.
   */
  autoReadiness?: {
    outcome: 'attached' | 'not-ready' | 'not-configured' | 'error';
    reason?: string;
  };
  /** The run's step after this evaluation. */
  currentStep?: string;
  /**
   * The run's freshness AFTER this evaluation, derived server-side from the
   * same run state the flow-run view reads. Carried on the event so a client
   * holding a persisted binding refreshes it from the one authority instead
   * of inferring evaluation state from the verdict payload — inference that
   * cannot see how many gates Flow actually recorded, and would disagree with
   * the server about a `wait` (which advances no transition and so records no
   * timestamp). Absent when the post-evaluation read failed.
   */
  freshness?: FlowRunFreshness;
}

export type PolicyHookProfile = 'minimal' | 'standard' | 'strict';

/**
 * Emitted by the orchestration layer (not provider adapters) when a session
 * starts in a workspace that opted into Flow Agents policy enforcement (the
 * workspace has a `.flow-agents/` directory). The last such event in a
 * session's history is the authoritative session -> policy binding, mirroring
 * the Flow run binding (S3).
 */
export interface PolicyHooksAttachedEvent extends CanonicalRuntimeEventBase {
  method: 'policy.hooks-attached';
  cwd: string;
  profile: PolicyHookProfile;
  /** 'native' when the canonical hook scripts loaded; 'typescript' when the built-in TypeScript guard runs otherwise. */
  engine: 'native' | 'typescript';
}

export type PolicyStopVerdict = 'pass' | 'warn' | 'block';

/**
 * Emitted by the orchestration layer when a policy-bound session requests
 * completion and the stop-goal-fit policy reports findings. Verdict 'block'
 * means the transition was rejected (strict mode); 'warn' means the
 * completion proceeded with the warnings recorded in session history.
 */
export interface PolicyStopVerdictEvent extends CanonicalRuntimeEventBase {
  method: 'policy.stop-verdict';
  policy: 'stop-goal-fit';
  verdict: PolicyStopVerdict;
  warnings: string[];
  /** True when strict enforcement was active for this check. */
  strict: boolean;
}

export type PlatformMutationOutcome =
  | 'allowed'
  | 'warned'
  | 'blocked'
  | 'failed';

/**
 * Emitted by the platform-mutation gate (S3 item 4) when an agent-driven
 * `station-control` mutating tool call executes — or is blocked — while the
 * Station workspace is policy-opted (`.flow-agents/` present). This is the
 * structured audit record for platform self-mutations: tool, args summary,
 * caller, outcome, and (when an active gated Flow run is bound) the run the
 * mutation was attached to as audit evidence. Non-opted workspaces never
 * produce this event.
 */
export interface PlatformMutationEvent extends CanonicalRuntimeEventBase {
  method: 'platform.mutation';
  /** Bare station-control tool name (e.g. `create_agent`). */
  tool: string;
  /** Truncated, secret-redacted JSON summary of the tool arguments. */
  argsSummary: string;
  agentSlug?: string;
  conversationId?: string;
  outcome: PlatformMutationOutcome;
  /** Policy decision that produced the outcome. */
  decision: 'allow' | 'warn' | 'block';
  profile: PolicyHookProfile;
  /** The policy-opted workspace the gate evaluated. */
  cwd: string;
  /** Bound Flow run when the mutation was gated (audit evidence attached). */
  runId?: string;
  /** Gate the audit evidence was attached to (when run-bound). */
  gateId?: string;
  /** Block/warn reason (assistant-visible for blocks). */
  reason?: string;
}

export type WorkflowStateTrigger =
  | 'session-start'
  | 'gate-verdict'
  | 'completion';

/** Which process is authorized to mutate a bound workflow sidecar. */
export type WorkflowSidecarOwnership = 'station-owned' | 'read-only-join';

/**
 * Emitted by the orchestration layer (not provider adapters) when a session
 * bound to a Flow Agents task slug (explicit `metadata.taskSlug` on
 * startSession, mirroring `metadata.flowDefinition`) creates or transitions
 * the durable `.flow-agents/<task-slug>/state.json` sidecar. The last such
 * event in a session's history is the authoritative session -> task binding.
 * The sidecar itself is the durable cross-runtime memory: a NEW session of
 * ANY runtime kind starting with the same taskSlug resumes the same state
 * (`resumed: true`).
 */
export interface WorkflowStateChangedEvent extends CanonicalRuntimeEventBase {
  method: 'workflow.state-changed';
  taskSlug: string;
  cwd: string;
  /** Durable mutation authority for every later lifecycle seam. */
  ownership: WorkflowSidecarOwnership;
  status: WorkflowTaskStatus;
  phase: WorkflowPhase;
  nextActionStatus: WorkflowNextActionStatus;
  nextActionSummary: string;
  /** Which orchestration seam produced the transition. */
  trigger: WorkflowStateTrigger;
  /** True when the sidecar already existed (cross-session/runtime resume). */
  resumed: boolean;
}

export type PlanEntryStatus = 'pending' | 'in_progress' | 'completed';

export interface PlanEntry {
  content: string;
  status: PlanEntryStatus;
}

/**
 * App-neutral plan surface (ADR-0008). Carries an agent app's current,
 * ordered plan entries as a full replace (not a delta) — mirrors ACP's own
 * `plan` session-update shape without leaking ACP vocabulary into the
 * canonical contract. First emitted by the ACP provider adapter (#148); no
 * renderer consumes it yet (#149).
 */
export interface PlanUpdatedEvent extends CanonicalRuntimeEventBase {
  method: 'plan.updated';
  entries: PlanEntry[];
}

/**
 * Namespaced, app-specific payload carrying no canonical semantics
 * (ADR-0008). Lets one agent app (e.g. Kiro's `_kiro.dev/*` JSON-RPC
 * notification family) surface extra behavior without the canonical
 * contract absorbing that app's implementation details. `namespace` and
 * `type` are opaque identifiers the emitting adapter defines; `payload` is
 * intentionally `unknown` — the canonical contract must not assume any
 * shape for app-specific data. First emitted by the ACP provider adapter
 * (#148); no renderer consumes it yet (#149).
 */
export interface ExtensionEvent extends CanonicalRuntimeEventBase {
  method: 'extension.notification';
  namespace: string;
  type: string;
  payload: unknown;
}

/**
 * An immutable cross-conversation provenance fact. It is deliberately an
 * orchestration event (rather than conversation metadata) so every engine
 * family has one append-only source of truth.
 */
export interface ConversationForkedEvent extends CanonicalRuntimeEventBase {
  method: 'conversation.forked';
  sourceConversationId: string;
  targetConversationId: string;
  targetAgent: string;
  forkedAt: string;
  /** Completed assistant turn selected as the durable branch point. */
  branchPointTurnId?: string;
  /** Execution Session that produced the selected answer, when observed. */
  sourceSessionId?: string;
  /** Native provider fork is exceptional; Station transcript replay is explicit. */
  continuation?: 'native' | 'replay-seed';
}

export type CanonicalRuntimeEvent =
  | SessionStartedEvent
  | SessionConfiguredEvent
  | SessionStateChangedEvent
  | SessionExitedEvent
  | TurnStartedEvent
  | TurnCompletedEvent
  | TurnAbortedEvent
  | SessionStopSettledEvent
  | ContentTextDeltaEvent
  | ContentReasoningDeltaEvent
  | ToolStartedEvent
  | ToolProgressEvent
  | ToolCompletedEvent
  | RequestOpenedEvent
  | RequestResolvedEvent
  | RuntimeErrorEvent
  | RuntimeWarningEvent
  | TokenUsageUpdatedEvent
  | FlowRunAttachedEvent
  | FlowGateVerdictEvent
  | PolicyHooksAttachedEvent
  | PolicyStopVerdictEvent
  | PlatformMutationEvent
  | WorkflowStateChangedEvent
  | PlanUpdatedEvent
  | ExtensionEvent
  | ConversationForkedEvent;

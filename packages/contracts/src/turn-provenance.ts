import type { ConversationContextBoundaryProvenance } from './conversation-context-boundary.js';
import type { EngineId } from './provider.js';
import type { CanonicalRuntimeEvent } from './runtime-events.js';
import {
  parseTurnProvenanceContextInjection,
  type TurnProvenanceContextInjection,
} from './turn-provenance-context.js';

/**
 * Turn provenance envelope (archive#1410, part of the per-answer
 * provenance-card epic archive#1391).
 *
 * The envelope answers, for ONE completed assistant turn: which engine ran
 * it, which model identity Station requested, which model identity the
 * runtime itself reported, which tools ran, what usage was reported, and —
 * for everything Station did not observe — *that it did not observe it*.
 *
 * Three rules the shape enforces, rather than leaving to each call site:
 *
 * 1. **Every optional fact is a slot, never a bare value.** A slot is
 *    `observed` (Station saw the value in a canonical runtime event),
 *    `referenced` (Station holds a pointer to an artifact that lives
 *    elsewhere and must be re-authorized when dereferenced), or
 *    `unavailable` with a reason. There is no fourth state and no implicit
 *    "absent field means zero/none/success" — an absent field is a bug, not
 *    a value (see `TurnProvenanceUnavailableReason`).
 * 2. **Nothing is inferred.** A slot only becomes `observed` when a
 *    canonical event carrying the value also carries the SAME `turnId`.
 *    Identity is never reconstructed from file paths, connection labels,
 *    event timestamps, adjacency in the log, or similarity to another
 *    turn. An engine that does not correlate its events to a turn produces
 *    gaps here, and that is the honest answer.
 * 3. **Nothing sensitive enters.** Prompts, generated output, tool
 *    arguments, tool results, credentials, file contents, and ambient
 *    context are all outside the envelope by construction — the assembler
 *    reads only identity/status/count fields. See
 *    `packages/shared/src/turn-provenance-fold.ts` and its secret-free
 *    tests.
 *
 * Canonical orchestration events remain the authority (#1410 R5). When a
 * turn completes, Station folds that turn's exact envelope once and persists
 * a bounded replay sidecar projection keyed by session and turn. Live output
 * uses that fold; replay reads the sidecar without scanning event history.
 * A completed turn recorded before this projection existed has no sidecar,
 * which is disclosed as an absent envelope rather than reconstructed data.
 */

/**
 * Bumped whenever the envelope's meaning changes in a way an older reader
 * would misread. Readers MUST treat an envelope whose `envelopeVersion` is
 * not one they understand as unavailable/raw rather than best-effort
 * parsing it — a partially-understood provenance claim is worse than an
 * admitted gap (#1410 AC5).
 */
export const TURN_PROVENANCE_ENVELOPE_VERSION = 1;

/**
 * Why a slot carries no value. Each reason is a distinct, checkable claim —
 * they are deliberately not collapsed into one "missing", because
 * "this engine cannot tell us" and "Station does not capture this yet" send
 * a reader to completely different places.
 */
export type TurnProvenanceUnavailableReason =
  /**
   * The engine that ran this turn emitted no canonical event carrying this
   * fact, correlated to this turn. Covers both "the engine has no such
   * signal" and "the engine has one but did not tag it with a turn id" —
   * from Station's side those are the same observation: nothing was seen.
   */
  | 'not-reported-by-engine'
  /**
   * Station itself does not capture this class of provenance yet. Used for
   * facts whose plumbing is a known, separately-tracked gap (routing
   * receipts, acquired source bytes) rather than an engine limitation.
   */
  | 'not-captured-by-station'
  /**
   * The engine DOES report this, but only for the session as a whole — the
   * figure it tags with a turn id is a running session-to-date total, not
   * that turn's own contribution. Presenting it as the turn's would
   * over-report every turn after the first, so the turn-scoped answer is a
   * disclosed gap and the reader is pointed at the session-level view
   * instead. See `CUMULATIVE_USAGE_PROVIDERS` in
   * `packages/shared/src/usage-fold.ts`.
   */
  | 'reported-only-at-session-scope'
  /**
   * Nobody has declared whether this engine's usage figures are per-turn or
   * session-cumulative, so Station cannot say what its numbers mean for one
   * answer. Fail-closed on purpose: defaulting an undeclared engine to
   * "per-turn" would silently render a future cumulative reporter's session
   * totals as a turn measurement — the exact over-report
   * `reported-only-at-session-scope` exists to prevent, but arriving
   * unannounced with a new adapter. Declaring the scope in
   * `PROVIDER_USAGE_SCOPE` (`packages/shared/src/usage-fold.ts`) is what
   * lights this up.
   */
  | 'usage-scope-undeclared'
  /**
   * Station holds this reference, and THIS viewer may not dereference it
   * (archive#1423). Produced only by the share projection
   * (`packages/shared/src/answer-share-projection.ts`), which re-applies
   * authorization to every reference before an envelope leaves the server
   * for a share holder.
   *
   * It is a separate reason rather than a reuse of the three above, and the
   * distinction is the whole point: telling a share viewer
   * `not-captured-by-station` about a trust report Station demonstrably
   * captured would be false, and passing the reference through unchanged
   * would leak a project slug and bundle id to someone with no standing on
   * that project. A named restriction is simultaneously the more honest
   * answer and the smaller disclosure — #1409 AC5's idiom ("a truthful
   * restricted-source gap with no excerpt leakage").
   */
  | 'restricted-for-this-viewer';

/**
 * The exact canonical event a value was read from. This is the audit trail
 * that makes an `observed` slot checkable: a reader can fetch that event id
 * from the orchestration event store and confirm the claim.
 */
export interface TurnProvenanceObservation {
  eventId: string;
  method: CanonicalRuntimeEvent['method'];
}

export interface TurnProvenanceUnavailableSlot {
  state: 'unavailable';
  reason: TurnProvenanceUnavailableReason;
}

export interface TurnProvenanceObservedSlot<TValue> {
  state: 'observed';
  value: TValue;
  /**
   * Non-empty: an observed slot always names where the value came from.
   * Bounded by `TURN_PROVENANCE_MAX_OBSERVATIONS` so a turn with hundreds of
   * tool calls cannot bloat every transcript payload — these are pointers
   * for spot-checking, and the orchestration event store remains the
   * complete record.
   */
  observedFrom: TurnProvenanceObservation[];
  /**
   * How many observations the cap dropped from `observedFrom`. A silently
   * truncated pointer list would let a reader conclude the slot rests on 12
   * events when it rests on 40 — the same class of quiet mis-statement the
   * whole envelope exists to prevent, so the truncation is disclosed
   * (mirroring `TurnProvenanceToolSummary.omittedNames`). Absent when
   * nothing was dropped.
   */
  omittedObservations?: number;
}

export interface TurnProvenanceReferencedSlot<TRef> {
  state: 'referenced';
  /**
   * A pointer to an artifact stored outside the envelope. The envelope
   * never inlines the artifact's contents: dereferencing goes back through
   * the owning surface's own route, which re-applies authorization for the
   * requesting principal (#1410 R4).
   */
  ref: TRef;
  observedFrom: TurnProvenanceObservation[];
}

/** A fact Station can hold directly, or admit it does not hold. */
export type TurnProvenanceSlot<TValue> =
  | TurnProvenanceObservedSlot<TValue>
  | TurnProvenanceUnavailableSlot;

/** A fact that lives in another store, or an admitted gap. */
export type TurnProvenanceRefSlot<TRef> =
  | TurnProvenanceReferencedSlot<TRef>
  | TurnProvenanceUnavailableSlot;

/**
 * The engine that executed the turn, as the canonical event stream names it
 * (`CanonicalRuntimeEventBase.provider`). This is the engine's own
 * identifier, not a display label and not a connection name.
 */
export interface TurnProvenanceEngine {
  provider: EngineId;
}

/** One distinct tool the turn invoked, with its observed outcomes. */
export interface TurnProvenanceToolUse {
  name: string;
  /** `tool.started` events observed for this name in this turn. */
  started: number;
  /** `tool.completed` events with `status: 'success'`. */
  succeeded: number;
  /** `tool.completed` events with `status: 'error'`. */
  failed: number;
  /** `tool.completed` events with `status: 'cancelled'`. */
  cancelled: number;
  /**
   * `tool.completed` events with `status: 'unresolved'` (station#1558) —
   * the session ended with the call still open, so no result can ever
   * arrive. Counted apart from `failed` and `cancelled` because Station
   * observed neither a failure nor a stop, only the absence of an outcome.
   *
   * Optional: envelopes assembled before station#1558 carry no such count,
   * and a reader must treat its absence as "not observed", never as zero
   * observed unresolved calls. Read it as `use.unresolved ?? 0`.
   */
  unresolved?: number;
}

/**
 * Tool activity observed for the turn. Only ever present when at least one
 * tool event was observed: a turn that produced no tool events yields an
 * `unavailable` slot rather than a zero-valued summary, because "the engine
 * told us nothing about tools" and "the engine ran no tools" are different
 * claims and Station usually cannot tell them apart (#1410 AC2).
 */
export interface TurnProvenanceToolSummary {
  /** Distinct tool names, capped by `TURN_PROVENANCE_MAX_TOOL_NAMES`. */
  uses: TurnProvenanceToolUse[];
  /** Distinct tool names observed but omitted from `uses` by the cap. */
  omittedNames: number;
}

/** Hard cap on named tools so one pathological turn cannot bloat a transcript. */
export const TURN_PROVENANCE_MAX_TOOL_NAMES = 12;

/** Hard cap on a slot's `observedFrom` pointers, for the same reason. */
export const TURN_PROVENANCE_MAX_OBSERVATIONS = 12;

/**
 * Token usage the engine reported for this turn. Every field is optional
 * and is present only when the engine actually reported it — a missing
 * field is never rendered as `0`. The slot as a whole is `unavailable`
 * when no `token-usage.updated` event was correlated to the turn, which is
 * the common case: most engines report no usage at all.
 */
export interface TurnProvenanceUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

/**
 * Pointer to a Surface trust report.
 *
 * **Defined and unimplemented — no producer exists (archive#1558).** This
 * docblock used to describe a live dereference path, naming the route
 * (`/api/projects/:slug/trust-bundles/:id`) and the renderer
 * (`src-ui/src/components/trust/TrustPanel.tsx`), and framed the gap as a
 * producer that exists but does not always stamp. Nothing in Station has ever
 * written `metadata.trustReport` on a terminal turn event: the reader in
 * `packages/shared/src/turn-provenance-fold.ts` and the renderer in
 * `TurnProvenanceCard.tsx` are both reachable only from hand-built fixtures.
 * Every turn therefore reports `not-captured-by-station`, which is honest —
 * what was not honest was the contract.
 *
 * The shape stays because the reader and the renderer stay: an
 * orchestration-layer producer that stamps this key gets an honoured
 * reference on the day it lands. What must not happen is deriving one from
 * the session's project, from a Flow report path, or from "the newest bundle
 * on disk" — the inference #1410 R2 forbids.
 *
 * {@link TURN_PROVENANCE_REF_SLOTS} is the machine-readable form of this
 * paragraph, and `turn-provenance-ref-slot-producers.test.ts` fails if it
 * stops matching the source tree in either direction.
 */
export interface TurnProvenanceTrustReportRef {
  kind: 'surface-trust-bundle';
  projectSlug: string;
  bundleId: string;
}

/**
 * Pointer to the routing decision that chose this engine/model.
 *
 * **Corrected (archive#1398, security review L-5).** The claim
 * this docblock used to make — "Station has no per-turn routing receipt
 * today" — stopped being true when
 * `station.fleet-routing-receipt/v1` shipped: a fleet-routed turn now has a
 * content-addressed, hash-chained envelope with a `receiptId` of exactly the
 * shape {@link TurnProvenanceRoutingReceiptRef} carries.
 *
 * What is still missing is the JOIN, not the receipt. A `DispatchReceipt`
 * carries no session or turn identity at any version
 * (`docs/design/inference-fleet.md` §3.4), so nothing links an envelope to
 * the turn that produced it except position in time — and #1410 AC4 rightly
 * requires these refs to be exact rather than positional. Manufacturing the
 * join from timestamps would be precisely the kind of plausible-but-unearned
 * provenance this envelope exists to prevent.
 *
 * So this stays an admitted gap, with the reason narrowed from "no receipt
 * exists" to "no exact join exists", and it applies only to fleet-routed
 * turns — a locally-routed turn still has no routing receipt at all. Closing
 * it needs an identity carried through Dispatch (a sibling-repo change) or a
 * Station-side correlation stamped at plan time; recorded in the design doc
 * rather than guessed at here.
 */
export interface TurnProvenanceRoutingReceiptRef {
  kind: 'dispatch-routing-receipt';
  receiptId: string;
}

/**
 * Pointer to the acquired source bytes an answer was based on. Source
 * acquisition and citation grounding are future work (archive#1409); until then
 * every turn reports `not-captured-by-station` here rather than omitting
 * the field, so a reader can tell "no sources were used" apart from
 * "Station does not track sources yet" — it is always the latter today.
 */
export interface TurnProvenanceSourceRef {
  kind: 'forage-snapshot';
  snapshotId: string;
}

export type TurnProvenanceOutcome = 'completed' | 'aborted';

/**
 * One assistant turn's provenance, versioned and secret-free.
 *
 * `sessionId`/`turnId` are read straight off the turn's own terminal
 * canonical event, so the envelope's correlation to the transcript row is
 * exact rather than positional (#1410 AC4).
 */
export interface TurnProvenanceEnvelope {
  envelopeVersion: number;
  sessionId: string;
  turnId: string;
  outcome: TurnProvenanceOutcome;
  /** `createdAt` of the terminal turn event. */
  observedAt: string;
  engine: TurnProvenanceSlot<TurnProvenanceEngine>;
  /**
   * The model Station asked for. Never a runtime confirmation — see
   * `src-server/providers/llm/effective-model-metadata.ts` (archive#1182).
   */
  requestedModel: TurnProvenanceSlot<string>;
  /** The model the runtime independently reported, when it reports one. */
  reportedModel: TurnProvenanceSlot<string>;
  tools: TurnProvenanceSlot<TurnProvenanceToolSummary>;
  usage: TurnProvenanceSlot<TurnProvenanceUsage>;
  routingReceipt: TurnProvenanceRefSlot<TurnProvenanceRoutingReceiptRef>;
  sources: TurnProvenanceRefSlot<TurnProvenanceSourceRef>;
  trustReport: TurnProvenanceRefSlot<TurnProvenanceTrustReportRef>;
  /**
   * archive#2649. OPTIONAL, and that is a persistence-compat decision rather
   * than a loophole in the "an absent field is a bug" rule: envelopes are
   * persisted VERBATIM as replay sidecars (`orchestration_turn_provenance`),
   * so every envelope folded before this field existed lacks it forever.
   * Requiring it would flip all of those to "unreadable" — a worse answer
   * than an admitted gap. The fold always emits the slot going forward;
   * readers treat an ABSENT field exactly like
   * `unavailable('not-captured-by-station')`.
   */
  contextInjection?: TurnProvenanceSlot<TurnProvenanceContextInjection>;
  /**
   * Optional for sidecars written before Station recorded consumed context
   * boundaries. When present, this records an effect, never a pending intent.
   */
  contextBoundary?: TurnProvenanceSlot<ConversationContextBoundaryProvenance>;
}

/** Every slot on the envelope that points at an artifact in another store. */
export type TurnProvenanceRefSlotName =
  | 'routingReceipt'
  | 'sources'
  | 'trustReport';

/**
 * Whether Station can actually PRODUCE each reference slot, as data.
 *
 * archive#1558: the `trustReport` docblock once described a live dereference path,
 * named its route and its renderer, and framed the absence of references as a
 * producer that sometimes doesn't stamp. There was no producer. The reader,
 * the renderer, and every test of the `referenced` state existed; the writer
 * did not — the same shape as the `fell-back-to-local` state found unreachable
 * in archive#1510, where fixtures constructing the artifact under test could
 * confirm the fold but never the reachability.
 *
 * Declaring it here makes the claim checkable instead of rhetorical.
 * `packages/shared/src/__tests__/turn-provenance-ref-slot-producers.test.ts`
 * reconciles this table against the source tree in BOTH directions: a slot
 * declared implemented with no producer fails, and a producer that lands
 * without flipping the declaration fails too, so the contract cannot
 * over-claim or silently under-claim.
 */
export interface TurnProvenanceRefSlotStatus {
  /**
   * The terminal-event metadata key a producer must stamp for this slot to
   * become `referenced`, or `null` when the slot has no metadata channel at
   * all (the fold hardcodes it unavailable, so no producer is even possible
   * without a code change).
   */
  metadataKey: string | null;
  /** True only when a non-test Station source stamps that key today. */
  producerImplemented: boolean;
  /** Why, in one sentence. Read by humans; the flag is read by the test. */
  note: string;
}

export const TURN_PROVENANCE_REF_SLOTS: Readonly<
  Record<TurnProvenanceRefSlotName, TurnProvenanceRefSlotStatus>
> = {
  routingReceipt: {
    metadataKey: null,
    producerImplemented: false,
    note: 'The receipt exists (`station.fleet-routing-receipt/v1`); the exact turn->receipt JOIN does not. A `DispatchReceipt` carries no session or turn identity at any version, and a positional match would be the unearned provenance this envelope exists to prevent. The fold hardcodes `unavailable`.',
  },
  sources: {
    metadataKey: null,
    producerImplemented: false,
    note: 'Source acquisition and citation grounding are station#1409. The fold hardcodes `unavailable` so a reader can tell "no sources were used" from "Station does not track sources yet" — it is always the latter today.',
  },
  trustReport: {
    metadataKey: 'trustReport',
    producerImplemented: false,
    note: 'The fold READS `metadata.trustReport` off the terminal event, but nothing in Station writes it. The slot is defined and unimplemented (station#1558); the reader stays so an orchestration-layer producer is honoured on the day it lands.',
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * Shared shape rules for both slot kinds.
 *
 * `reason` is checked as a non-empty string rather than against the known
 * `TurnProvenanceUnavailableReason` union on purpose: a reason this build
 * has not heard of is still a valid, honest "no value here" — it is the
 * RENDERER's job to say "unavailable for a reason this version doesn't
 * recognize". Rejecting the whole envelope over one unfamiliar reason string
 * would turn a fully-readable gap into a total blackout, which is a worse
 * answer, not a safer one.
 */
function isUnavailableSlot(value: unknown): boolean {
  return (
    isRecord(value) &&
    value.state === 'unavailable' &&
    isNonEmptyString(value.reason)
  );
}

/**
 * `requireNonEmpty` defaults to requiring at least one pointer: an
 * `observed` slot's docblock ("an observed slot always names where the
 * value came from") makes a zero-length `observedFrom` a vacuous
 * observation claim — a confident fact with nothing backing it (#1456).
 * `referenced` slots make no such claim in their own docblock, so `isRefSlot`
 * opts out explicitly rather than inheriting the tightened default.
 */
function hasObservationList(
  value: Record<string, unknown>,
  { requireNonEmpty = true }: { requireNonEmpty?: boolean } = {},
): boolean {
  return (
    Array.isArray(value.observedFrom) &&
    (!requireNonEmpty || value.observedFrom.length > 0) &&
    value.observedFrom.every(
      (entry) => isRecord(entry) && isNonEmptyString(entry.eventId),
    )
  );
}

function isValueSlot(
  value: unknown,
  isValue: (candidate: unknown) => boolean,
): boolean {
  if (isUnavailableSlot(value)) return true;
  return (
    isRecord(value) &&
    value.state === 'observed' &&
    hasObservationList(value) &&
    isValue(value.value)
  );
}

function isRefSlot(value: unknown): boolean {
  if (isUnavailableSlot(value)) return true;
  return (
    isRecord(value) &&
    value.state === 'referenced' &&
    hasObservationList(value, { requireNonEmpty: false }) &&
    isRecord(value.ref)
  );
}

function isEngineValue(value: unknown): boolean {
  return isRecord(value) && isNonEmptyString(value.provider);
}

function isToolSummaryValue(value: unknown): boolean {
  return (
    isRecord(value) &&
    Array.isArray(value.uses) &&
    value.uses.every(
      (use) =>
        isRecord(use) &&
        isNonEmptyString(use.name) &&
        typeof use.started === 'number' &&
        typeof use.succeeded === 'number' &&
        typeof use.failed === 'number' &&
        typeof use.cancelled === 'number' &&
        // station#1558: absent on every envelope written before that change,
        // so absence must stay readable — present-but-malformed still
        // rejects the whole envelope, exactly like the fields above.
        (use.unresolved === undefined || typeof use.unresolved === 'number'),
    ) &&
    typeof value.omittedNames === 'number'
  );
}

function isContextInjectionValue(value: unknown): boolean {
  return parseTurnProvenanceContextInjection(value) !== undefined;
}

function isContextBoundaryValue(
  value: unknown,
): value is ConversationContextBoundaryProvenance {
  return (
    isRecord(value) &&
    isNonEmptyString(value.boundaryId) &&
    (value.policy === 'continue-from-history' ||
      value.policy === 'empty-next-cold-start') &&
    typeof value.priorTranscriptInjected === 'boolean'
  );
}

/**
 * True when `value` is an envelope this build understands well enough to
 * render field-by-field.
 *
 * This validates EVERY slot, not just the scalar header. The reason is not
 * tidiness: the card reads `slot.state` on each field, so a
 * versioned-but-truncated envelope (correct `envelopeVersion`, missing
 * `requestedModel`/`tools`/…) would throw on the first `undefined.state` and
 * take the entire chat view down through `RouteViewBoundary`. A partially
 * decodable envelope is exactly the case #1410 AC5 is about, and the honest
 * answer to it is a single "cannot read this" row, never a crash and never a
 * half-rendered provenance claim.
 *
 * Anything that fails here — a newer version, a truncated payload, an
 * `engine: {}`, a hand-edited record — is the caller's cue to render the
 * degraded state and leave the transcript intact.
 */
export function isSupportedTurnProvenanceEnvelope(
  value: unknown,
): value is TurnProvenanceEnvelope {
  if (!isRecord(value)) return false;
  return (
    value.envelopeVersion === TURN_PROVENANCE_ENVELOPE_VERSION &&
    isNonEmptyString(value.sessionId) &&
    isNonEmptyString(value.turnId) &&
    (value.outcome === 'completed' || value.outcome === 'aborted') &&
    isNonEmptyString(value.observedAt) &&
    isValueSlot(value.engine, isEngineValue) &&
    isValueSlot(value.requestedModel, isNonEmptyString) &&
    isValueSlot(value.reportedModel, isNonEmptyString) &&
    isValueSlot(value.tools, isToolSummaryValue) &&
    isValueSlot(value.usage, isRecord) &&
    isRefSlot(value.routingReceipt) &&
    isRefSlot(value.sources) &&
    isRefSlot(value.trustReport) &&
    // archive#2649: optional for persisted pre-existing sidecars (see the
    // envelope field's docblock). Present-but-malformed still rejects the
    // whole envelope — the no-partial-decoding rule applies to new fields
    // exactly as it does to old ones.
    (value.contextInjection === undefined ||
      isValueSlot(value.contextInjection, isContextInjectionValue)) &&
    (value.contextBoundary === undefined ||
      isValueSlot(value.contextBoundary, isContextBoundaryValue))
  );
}

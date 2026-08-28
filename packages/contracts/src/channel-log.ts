/**
 * The four channel-log record types
 * (`docs/design/conversation-state.md` §3.2, §3.3, §3.8; the OQ decisions
 * ratified on archive#1484).
 *
 * **Contracts only.** Nothing here reads, writes, sequences, transports, or
 * renders anything. There is no wire, no store, and no UI here, and
 * the local-only invariant (§4.4) is untouched because nothing new is
 * rendered.
 *
 * ## The four decisions these shapes carry, and where each one lives
 *
 * - **OQ-6 — a refusal never enters the log.** It is the absence of an
 *   authored event, not an event. So {@link ChannelProposalKind} has no
 *   `refusal` member (proved exhaustively below), {@link ChannelRefusalReceipt}
 *   is declared *outside* the sequenceable set, and
 *   {@link validateChannelSequencingEnvelope} refuses an envelope whose
 *   embedded record is a refusal receipt with the coded diagnostic
 *   `refusal-not-sequenceable`.
 * - **OQ-7 — an agent's authorization is a committed grant, referenced by
 *   id.** {@link ChannelAgentAttribution} carries `authorizationId` and
 *   *nothing else that could carry a grant*: an `onBehalfOf` with any
 *   additional key is refused (`authorization-not-referenced`), because an
 *   inlined grant is a per-proposal claim wearing a reference's name. The
 *   grant record itself lives in `channel-identity.ts`.
 * - **OQ-8 — an edit is a supersession record, not a mutation.** `kind:
 *   'edit'` requires {@link ChannelProposal.supersedes}; no record in this
 *   file has a field a later writer could rewrite in place; and
 *   {@link foldChannelSupersessions} is the read-path fold, which refuses to
 *   guess when a chain forks.
 * - **OQ-3/OQ-4 — the durability enum lands now, the acknowledgement policy
 *   is deferred.** {@link ChannelDurabilityLevel} plus
 *   {@link durabilitySatisfies}. Nothing here says what the composer
 *   acknowledges at, because that policy is not this file's decision to make.
 *
 * ## Two structural rules the design states and this file enforces
 *
 * 1. **Parent identity, never parent position** (§3.2). A `parent` is a
 *    `proposalId` or a committed message id — never a sequence number. A
 *    position-shaped reference is refused with `parent-position-not-identity`,
 *    because a reference to `(epoch 3, seq 40)` names a different message
 *    after a recovery than it did before it.
 * 2. **The channel-home record is its own construct** (§3.3, CRITICAL
 *    correction 1). Authority state — home, lease, expiry, epoch — is
 *    operational, expiring, and rewritten on every handover; the portable
 *    project manifest is an identity object. {@link ChannelLocatorHint} is
 *    everything a manifest may carry, and its validator refuses every field
 *    in {@link CHANNEL_AUTHORITY_ONLY_FIELDS} by name.
 *
 * ## What is deliberately absent
 *
 * No signing, no key material, no verifier (see `channel-assurance.ts` for
 * why that is honest without a signing substrate and a lie once one exists).
 * No page cursor and
 * no cache-verification states (§8) — those are read-path surface and belong
 * with the reader that serves a read. No idempotency, quota, or replay
 * machinery (§5). No lease service (§3.4);
 * {@link ChannelHomeRecord.leaseRef} is a reference to a lease this file
 * does not mint, and a `leaseRef` is emphatically **not** a lease: §3.4's
 * whole correction is that clients verify the lease, not the epoch number,
 * and nothing here verifies anything.
 */

import { isPlainJsonObject } from './channel-assurance.js';
import { canonicalizeForDigest } from './fleet-routing-receipt.js';

export const CHANNEL_PROPOSAL_SCHEMA_VERSION =
  'station.channel-proposal/v1' as const;
export const CHANNEL_SEQUENCE_SCHEMA_VERSION =
  'station.channel-sequence/v1' as const;
export const CHANNEL_CHECKPOINT_SCHEMA_VERSION =
  'station.channel-checkpoint/v1' as const;
export const CHANNEL_HOME_SCHEMA_VERSION = 'station.channel-home/v1' as const;
/**
 * Declared here so the refusal receipt has a name — and then deliberately
 * kept out of {@link CHANNEL_SEQUENCEABLE_SCHEMA_VERSIONS}. OQ-6 in one
 * pair of constants.
 */
export const CHANNEL_REFUSAL_RECEIPT_SCHEMA_VERSION =
  'station.channel-refusal-receipt/v1' as const;

/**
 * The closed set of record kinds that may appear inside a sequencing
 * envelope. A record type that is not in this set cannot enter committed
 * history, and the refusal receipt's absence from it is OQ-6's mechanical
 * form rather than its prose form.
 */
export const CHANNEL_SEQUENCEABLE_SCHEMA_VERSIONS = Object.freeze([
  CHANNEL_PROPOSAL_SCHEMA_VERSION,
] as const);

/**
 * First committed sequence in a channel. `1`, matching the existing event
 * store's `COALESCE(MAX(sequence), 0) + 1` assignment
 * (`src-server/services/orchestration/event-store.ts:1129-1134`) so a
 * channel axis and a thread axis do not disagree about what "the first one"
 * means.
 */
export const CHANNEL_GENESIS_SEQ = 1;

/**
 * §3.2's vocabulary, plus one addition this file had to make.
 *
 * **`agent-authorization` is not in the design doc's §3.2 list, and it is
 * this module's smallest genuine invention.** OQ-7 decides that an agent's
 * authorization is "a committed grant, referenced by `authorizationId`" —
 * a committed record must therefore be committed *as some kind*, and §3.2
 * offers no home for it: it is not a `membership-change` (an agent is not a
 * member; §9.2's rule that membership is not backing exists precisely to
 * stop that conflation), and it is not an `agent-action` (an authorization
 * is the thing an action is evaluated against, so folding the two would
 * make a grant self-authorizing). Rather than overload an existing member
 * silently, the vocabulary gains one explicit entry. Recorded as a finding
 * against the doc rather than absorbed.
 *
 * There is **no `refusal` member and there must never be one** (OQ-6).
 */
export type ChannelProposalKind =
  | 'message'
  | 'edit'
  | 'reaction'
  | 'membership-change'
  | 'moderation'
  | 'agent-action'
  | 'agent-authorization';

export const CHANNEL_PROPOSAL_KINDS = [
  'message',
  'edit',
  'reaction',
  'membership-change',
  'moderation',
  'agent-action',
  'agent-authorization',
  // No annotation on this array: widening the element type would make the
  // exhaustiveness proof below vacuous (the `SELECTION_AMBIGUITY_CODES`
  // pattern in `project-identity.ts`).
] as const satisfies readonly ChannelProposalKind[];

type _ProposalKindsAreExhaustive =
  Exclude<
    ChannelProposalKind,
    (typeof CHANNEL_PROPOSAL_KINDS)[number]
  > extends never
    ? true
    : never;
const _proposalKindsAreExhaustive: _ProposalKindsAreExhaustive = true;
void _proposalKindsAreExhaustive;

export function isChannelProposalKind(
  value: unknown,
): value is ChannelProposalKind {
  return (CHANNEL_PROPOSAL_KINDS as readonly unknown[]).includes(value);
}

/**
 * Kinds for which a `supersedes` reference is REQUIRED, ALLOWED, or
 * FORBIDDEN. Stated as data because it is a policy about meaning, not a
 * validation detail: a `message` that supersedes something is not a
 * message, and an `edit` that supersedes nothing is a mutation wearing an
 * edit's name (OQ-8).
 */
export const CHANNEL_SUPERSESSION_REQUIREMENT: Readonly<
  Record<ChannelProposalKind, 'required' | 'allowed' | 'forbidden'>
> = Object.freeze({
  message: 'forbidden',
  edit: 'required',
  reaction: 'forbidden',
  // A membership change may retract an earlier one; a moderation tombstone
  // supersedes what it moderates (§6, "append-only tombstone/supersession").
  'membership-change': 'allowed',
  moderation: 'allowed',
  // An action is a thing that happened, not a revision of one.
  'agent-action': 'forbidden',
  // A revocation supersedes the grant it revokes.
  'agent-authorization': 'allowed',
});

/**
 * §3.8's four durability levels, ordered. The wire names are the design
 * doc's names; the product words ("Sending" / "Saved" / "Copied to your
 * Station", §4.2) are a rendering concern and appear nowhere here.
 */
export type ChannelDurabilityLevel =
  | 'pending-local'
  | 'committed-home'
  | 'replicated-copy'
  | 'checkpoint-witnessed';

export const CHANNEL_DURABILITY_LEVELS = [
  'pending-local',
  'committed-home',
  'replicated-copy',
  'checkpoint-witnessed',
] as const satisfies readonly ChannelDurabilityLevel[];

type _DurabilityLevelsAreExhaustive =
  Exclude<
    ChannelDurabilityLevel,
    (typeof CHANNEL_DURABILITY_LEVELS)[number]
  > extends never
    ? true
    : never;
const _durabilityLevelsAreExhaustive: _DurabilityLevelsAreExhaustive = true;
void _durabilityLevelsAreExhaustive;

export function isChannelDurabilityLevel(
  value: unknown,
): value is ChannelDurabilityLevel {
  return (CHANNEL_DURABILITY_LEVELS as readonly unknown[]).includes(value);
}

/**
 * Fail-closed durability comparison. An unrecognised `actual` satisfies
 * NOTHING — not even `pending-local` — because an unreadable level is a
 * level we did not observe, and §4.2's rule is that "not yet copied to your
 * Station" is a named state rather than an optimistic default.
 */
export function durabilitySatisfies(
  actual: unknown,
  required: ChannelDurabilityLevel,
): boolean {
  if (!isChannelDurabilityLevel(actual)) return false;
  // `required` is checked too. `indexOf` returns -1
  // for an unrecognised value and every real level's index beats -1, so an
  // unvalidated requirement made EVERY level satisfy it — fail-open on the
  // argument a per-channel policy JSON will supply. One stale enum
  // value would have shown "Copied to your Station" for a message that was
  // only `pending-local`, which is §4.2's one-checkmark-meaning-either
  // failure exactly.
  if (!isChannelDurabilityLevel(required)) return false;
  return (
    CHANNEL_DURABILITY_LEVELS.indexOf(actual) >=
    CHANNEL_DURABILITY_LEVELS.indexOf(required)
  );
}

/** The commit coordinate a sequencing envelope establishes. */
export interface ChannelCommitCoordinate {
  channelId: string;
  epoch: number;
  seq: number;
}

/**
 * A reference to another record **by identity**. §3.2: "Parent identity,
 * never parent position — a `proposalId` or a committed message id, never a
 * sequence number."
 */
export interface ChannelRecordRef {
  refKind: 'proposal' | 'committed-message';
  id: string;
}

/** Who authored a proposal: a member, on a device, with a device key. */
export interface ChannelAuthorRef {
  memberId: string;
  deviceId: string;
  /** The device key that signed. Certified by the member key — OQ-5. */
  keyId: string;
}

/**
 * Agent attribution (§3.7, OQ-7). **Exactly two fields, by contract.** The
 * validator refuses any additional key so that an implementation cannot
 * inline a grant here and call it authorization: the grant is a committed
 * log record, and this is a reference to it.
 */
export interface ChannelAgentAttribution {
  ownerMemberId: string;
  authorizationId: string;
}

/** A content-addressed body (§6, "Attachments — identity is the hash"). */
export interface ChannelContentRef {
  digest: string;
  mediaType?: string;
  byteLength?: number;
}

/**
 * `station.channel-proposal/v1` — authored and signed by a member device or
 * by an agent (§3.2).
 *
 * A proposal is **what a member asked for**, not what happened (§5.1). The
 * distinction is the whole design: if a queued write were an event, draining
 * a queue would mean inserting into committed history.
 */
export interface ChannelProposal {
  schemaVersion: typeof CHANNEL_PROPOSAL_SCHEMA_VERSION;
  /** Client-generated; the idempotency key for the whole system (§5). */
  proposalId: string;
  channelId: string;
  author: ChannelAuthorRef;
  /** Agent proposals only (§3.7). */
  onBehalfOf?: ChannelAgentAttribution;
  kind: ChannelProposalKind;
  /** Identity, never position. */
  parent?: ChannelRecordRef;
  /** OQ-8. Required for `edit`; see {@link CHANNEL_SUPERSESSION_REQUIREMENT}. */
  supersedes?: ChannelRecordRef;
  /** The epoch the author believed current when authoring. */
  baseEpoch: number;
  /** Digest of the newest checkpoint the author had verified, if any. */
  baseCheckpoint?: string;
  /**
   * The author's clock. **Untrusted**, and never the ordering clock — that
   * is the home's `committedAt` (§3.2, §5.2). Deliberately NOT sanity
   * checked: §5.2 accepts a `happenedAt` in the future and clamps its
   * display, so refusing one here would be treating the author's clock as
   * authoritative in the one place the design says it never is.
   */
  happenedAt: string;
  body?: unknown;
  bodyRef?: ChannelContentRef;
}

/**
 * `station.channel-sequence/v1` — authored and signed by the home, embedding
 * the proposal **verbatim** (§3.2).
 *
 * Embedding rather than restating is what makes a member's words unforgeable
 * by the home: the embedded bytes keep their own signature checkable. It is
 * the same decision the fleet made for its routing envelope
 * (`docs/design/inference-fleet.md` §3.4), doing more work here.
 */
export interface ChannelSequencingEnvelope {
  schemaVersion: typeof CHANNEL_SEQUENCE_SCHEMA_VERSION;
  channelId: string;
  epoch: number;
  seq: number;
  /** Byte-identical to what the author signed. */
  proposal: ChannelProposal;
  /** SHA-256 over {@link channelProposalDigestInput}. */
  proposalDigest: string;
  /** The **home's** clock. This is the ordering clock; `happenedAt` never is. */
  committedAt: string;
  /** `null` only at {@link CHANNEL_GENESIS_SEQ}. */
  prevEnvelopeDigest: string | null;
  /** The membership/moderation revision evaluated at commit time. */
  policyRevision: string;
  /** The lease under which this epoch is being sequenced (§3.4). */
  leaseRef: string;
}

/** `station.channel-checkpoint/v1` — periodic, signed by the home (§3.2). */
export interface ChannelCheckpoint {
  schemaVersion: typeof CHANNEL_CHECKPOINT_SCHEMA_VERSION;
  channelId: string;
  epoch: number;
  seq: number;
  headEnvelopeDigest: string;
  logDigest: string;
  policyRevision: string;
  observedAt: string;
}

/**
 * `station.channel-home/v1` (§3.3) — its own construct, **never** a field of
 * the portable project manifest. See {@link ChannelLocatorHint} for what a
 * manifest may carry instead.
 */
export interface ChannelHomeRecord {
  schemaVersion: typeof CHANNEL_HOME_SCHEMA_VERSION;
  channelId: string;
  epoch: number;
  homeRef: string;
  leaseRef: string;
  leaseExpiresAt: string;
  /** `null` is a peer-only channel: freeze-not-fail, never auto-promotion (§3.4). */
  witnessRef: string | null;
  policyRevision: string;
  /** `null` at the first epoch. */
  previousEpochCloseCheckpoint: string | null;
}

/**
 * `station.channel-refusal-receipt/v1` — returned to the author, **never
 * sequenced** (§3.2, OQ-6). Declared so a refusal has a checkable shape and
 * so its exclusion from {@link CHANNEL_SEQUENCEABLE_SCHEMA_VERSIONS} is a
 * fact in the type system rather than a convention.
 */
export interface ChannelRefusalReceipt {
  schemaVersion: typeof CHANNEL_REFUSAL_RECEIPT_SCHEMA_VERSION;
  channelId: string;
  /** Which proposal was refused. */
  proposalId: string;
  reasonCode: string;
  /** The policy revision the refusal was evaluated against. */
  policyRevision: string;
  observedAt: string;
}

/**
 * Everything a portable project manifest may carry about a channel: an id
 * and a locator hint (§3.3, §9.2). CRITICAL correction 1 in a type.
 */
export interface ChannelLocatorHint {
  channelId: string;
  /** A hint about where to look. Never authority, never verified. */
  locatorHint?: string;
}

/**
 * Fields that belong to the channel-home record and must never appear in a
 * portable identity document. Named so the refusal cites the field rather
 * than saying "unexpected key".
 */
export const CHANNEL_AUTHORITY_ONLY_FIELDS = Object.freeze([
  'epoch',
  'homeRef',
  'leaseRef',
  'leaseExpiresAt',
  'witnessRef',
  'policyRevision',
  'previousEpochCloseCheckpoint',
] as const);

export type ChannelDiagnosticCode =
  /** Absent or unrecognised `schemaVersion`; nothing else was inspected. */
  | 'schema-version-unknown'
  /** The default channel: some field is missing, mistyped, or contradictory. */
  | 'record-invalid'
  /**
   * A refusal receipt was offered for sequencing (OQ-6). Distinct from
   * `record-not-sequenceable` on purpose: "you tried to commit a refusal" is
   * a decision-bearing violation with its own sentence, and collapsing the
   * two would mean no test could tell which guard actually fired — a fault
   * injection that disabled the refusal-specific branch went UNCAUGHT until
   * these codes were separated.
   */
  | 'refusal-not-sequenceable'
  /** Some other record type was offered for sequencing. */
  | 'record-not-sequenceable'
  /** Authority state appeared in a portable identity document (correction 1). */
  | 'authority-field-in-locator-hint'
  /** An agent proposal inlined its authorization instead of referencing it (OQ-7). */
  | 'authorization-not-referenced'
  /** An agent action carried no `onBehalfOf` at all (§3.7). */
  | 'agent-attribution-missing'
  /** A reference named a position rather than an identity (§3.2). */
  | 'parent-position-not-identity'
  /** An edit that supersedes nothing, or a kind that may not supersede (OQ-8). */
  | 'supersession-shape-invalid'
  /** A prototype-affecting key appeared on a wire record. */
  | 'forbidden-key';

export interface ChannelDiagnostic {
  code: ChannelDiagnosticCode;
  message: string;
}

/**
 * Generic over the diagnostic union so sibling channel modules can report
 * their own coded failures through one result shape without either widening
 * this module's codes or casting theirs into it.
 */
export type ChannelValidationResult<T, D = ChannelDiagnostic> =
  | { ok: true; record: T }
  | { ok: false; errors: string[]; diagnostics: D[] };

/**
 * Accumulates every violation instead of stopping at the first, with the one
 * deliberate exception `validateProjectManifest` also makes: an unreadable
 * `schemaVersion` returns immediately, because v1 field assertions applied to
 * a v2 document are not findings about that document.
 */
class ChannelDiagnosticCollector {
  readonly diagnostics: ChannelDiagnostic[] = [];

  push(message: string): void {
    this.diagnostics.push({ code: 'record-invalid', message });
  }

  pushCoded(code: ChannelDiagnosticCode, message: string): void {
    this.diagnostics.push({ code, message });
  }

  get length(): number {
    return this.diagnostics.length;
  }

  failure<T>(): ChannelValidationResult<T> {
    return {
      ok: false,
      errors: this.diagnostics.map((diagnostic) => diagnostic.message),
      diagnostics: this.diagnostics,
    };
  }
}

/**
 * Re-exported under the local name every check below already uses. The
 * prototype check it adds matters here specifically: these validators read
 * fields with ordinary property access (which walks the prototype chain)
 * while {@link channelProposalDigestInput} reads own keys, so an object whose
 * fields live only on a prototype would validate and then digest as `{}`.
 */
const isPlainObject = isPlainJsonObject;

function requireNonEmptyString(
  value: unknown,
  fieldPath: string,
  errors: ChannelDiagnosticCollector,
): void {
  if (typeof value !== 'string' || value.length === 0) {
    errors.push(`${fieldPath}: must be a non-empty string`);
  }
}

function requireNonNegativeInteger(
  value: unknown,
  fieldPath: string,
  errors: ChannelDiagnosticCollector,
): void {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    errors.push(`${fieldPath}: must be a non-negative safe integer`);
  }
}

/**
 * Keys that no wire record may carry. `JSON.parse` turns `__proto__` into an
 * own property rather than a prototype assignment, so a hostile record can
 * carry one — and a consumer that later re-materialises the record through a
 * path which DOES honour it (`structuredClone`, a YAML/JSON5 loader, an
 * `Object.assign` into a fresh object) gets different semantics from the same
 * bytes. There is no legitimate use, so the class is refused rather than
 * accommodated. {@link canonicalizeForDigest} was separately fixed to stop
 * dropping the key from the digest; this refuses it a second time at the
 * boundary, because a faithful digest of a hostile record is still a hostile
 * record.
 */
export const CHANNEL_FORBIDDEN_RECORD_KEYS = Object.freeze([
  '__proto__',
  'constructor',
  'prototype',
] as const);

function rejectForbiddenKeys(
  value: Record<string, unknown>,
  fieldPath: string,
  errors: ChannelDiagnosticCollector,
): void {
  for (const key of Object.keys(value)) {
    if ((CHANNEL_FORBIDDEN_RECORD_KEYS as readonly string[]).includes(key)) {
      errors.pushCoded(
        'forbidden-key',
        `${fieldPath}${fieldPath ? '.' : ''}${key}: prototype-affecting keys are refused on a wire record — they survive JSON.parse as data and change meaning in any consumer that re-materialises them`,
      );
    }
    const nested = value[key];
    if (isPlainObject(nested)) {
      rejectForbiddenKeys(
        nested,
        `${fieldPath}${fieldPath ? '.' : ''}${key}`,
        errors,
      );
    }
  }
}

/**
 * Keys that would make a reference positional rather than identity-bearing.
 *
 * Exported because a sibling contract records a channel
 * reference of its own — an answer share's channel binding — and a second
 * copy of this list is exactly the drift it exists to prevent. A ref that
 * gains a `seq` in one module and not the other would refuse in one place and
 * resolve in the other, which is worse than either behaviour alone.
 */
export const CHANNEL_POSITIONAL_REF_KEYS = Object.freeze([
  'seq',
  'sequence',
  'epoch',
  'index',
  'offset',
] as const);

function validateRecordRef(
  value: unknown,
  fieldPath: string,
  errors: ChannelDiagnosticCollector,
): void {
  if (!isPlainObject(value)) {
    errors.push(`${fieldPath}: must be an object`);
    return;
  }
  if (value.refKind !== 'proposal' && value.refKind !== 'committed-message') {
    errors.push(
      `${fieldPath}.refKind: must be "proposal" or "committed-message"`,
    );
  }
  requireNonEmptyString(value.id, `${fieldPath}.id`, errors);
  for (const key of CHANNEL_POSITIONAL_REF_KEYS) {
    if (key in value) {
      errors.pushCoded(
        'parent-position-not-identity',
        `${fieldPath}.${key}: a reference names an identity, never a position (§3.2) — a coordinate names a different record after a recovery than it did before it`,
      );
    }
  }
}

/**
 * The public form of {@link validateRecordRef}.
 *
 * A `ChannelRecordRef` is now recorded outside this module — an answer share
 * binds to one committed message — and the refusal that matters there is the
 * same one that matters here: a reference names an identity, never a
 * position. Exposing the check rather than the list keeps ONE implementation
 * of `parent-position-not-identity`, so a ref that is refused inside a
 * proposal cannot be accepted inside a share binding.
 *
 * `fieldPath` defaults to `ref` so a standalone refusal still says which
 * field it is talking about.
 */
export function validateChannelRecordRef(
  value: unknown,
  fieldPath = 'ref',
): ChannelValidationResult<ChannelRecordRef> {
  const errors = new ChannelDiagnosticCollector();
  validateRecordRef(value, fieldPath, errors);
  if (errors.length > 0) return errors.failure();
  // Returns the value it was handed, never a copy — the same rule the record
  // validators hold, so a caller re-mapping the ref does so deliberately.
  return { ok: true, record: value as ChannelRecordRef };
}

/**
 * The public form of the recursive forbidden-key sweep.
 *
 * Returned as diagnostics rather than thrown so a sibling validator folds
 * them into its own result with the shared `forbidden-key` code. Same reason
 * as {@link validateChannelRecordRef}: one implementation of the refusal, so
 * a `__proto__` member refused on a proposal cannot be accepted on a record
 * that quotes one.
 */
export function findChannelForbiddenKeys(
  value: Record<string, unknown>,
  fieldPath = '',
): ChannelDiagnostic[] {
  const errors = new ChannelDiagnosticCollector();
  rejectForbiddenKeys(value, fieldPath, errors);
  return errors.diagnostics;
}

/**
 * Fail-closed proposal validator. Never throws, never casts an unverified
 * value into the type, accumulates every violation.
 */
export function validateChannelProposal(
  value: unknown,
): ChannelValidationResult<ChannelProposal> {
  const errors = new ChannelDiagnosticCollector();

  if (!isPlainObject(value)) {
    errors.push('proposal: must be an object');
    return errors.failure();
  }

  if (value.schemaVersion !== CHANNEL_PROPOSAL_SCHEMA_VERSION) {
    errors.pushCoded(
      'schema-version-unknown',
      `schemaVersion: unknown or absent (expected ${CHANNEL_PROPOSAL_SCHEMA_VERSION}, got ${JSON.stringify(value.schemaVersion)})`,
    );
    return errors.failure();
  }

  rejectForbiddenKeys(value, '', errors);

  requireNonEmptyString(value.proposalId, 'proposalId', errors);
  requireNonEmptyString(value.channelId, 'channelId', errors);

  if (!isPlainObject(value.author)) {
    errors.push('author: must be an object');
  } else {
    requireNonEmptyString(value.author.memberId, 'author.memberId', errors);
    requireNonEmptyString(value.author.deviceId, 'author.deviceId', errors);
    requireNonEmptyString(value.author.keyId, 'author.keyId', errors);
  }

  if (!isChannelProposalKind(value.kind)) {
    errors.push(
      `kind: must be one of ${CHANNEL_PROPOSAL_KINDS.join(', ')} (got ${JSON.stringify(value.kind)})`,
    );
  }

  // OQ-7. `onBehalfOf` is a REFERENCE. Two keys, no more: an extra key is
  // the shape an inlined grant would take, and an inlined grant is a
  // per-proposal claim that no other member can evaluate at commit time.
  if (value.onBehalfOf !== undefined) {
    if (!isPlainObject(value.onBehalfOf)) {
      errors.push('onBehalfOf: must be an object when present');
    } else {
      requireNonEmptyString(
        value.onBehalfOf.ownerMemberId,
        'onBehalfOf.ownerMemberId',
        errors,
      );
      requireNonEmptyString(
        value.onBehalfOf.authorizationId,
        'onBehalfOf.authorizationId',
        errors,
      );
      const extraKeys = Object.keys(value.onBehalfOf).filter(
        (key) => key !== 'ownerMemberId' && key !== 'authorizationId',
      );
      if (extraKeys.length > 0) {
        errors.pushCoded(
          'authorization-not-referenced',
          `onBehalfOf: unexpected key(s) ${extraKeys.join(', ')} — an agent's authorization is a committed grant referenced by authorizationId (OQ-7), never inlined here`,
        );
      }
    }
  } else if (value.kind === 'agent-action') {
    // Distinct from `authorization-not-referenced` for the same reason
    // `refusal-not-sequenceable` is distinct from `record-not-sequenceable`:
    // "you inlined a grant" and "you attributed nothing" are different
    // violations, and one code for both means no test can tell which guard
    // fired.
    errors.pushCoded(
      'agent-attribution-missing',
      'onBehalfOf: required for kind "agent-action" — an agent action with no authorizationId cannot be evaluated against the log (§3.7)',
    );
  }

  if (value.parent !== undefined) {
    validateRecordRef(value.parent, 'parent', errors);
  }

  // OQ-8: supersession, not mutation.
  const requirement = isChannelProposalKind(value.kind)
    ? CHANNEL_SUPERSESSION_REQUIREMENT[value.kind]
    : undefined;
  if (value.supersedes !== undefined) {
    validateRecordRef(value.supersedes, 'supersedes', errors);
    if (requirement === 'forbidden') {
      errors.pushCoded(
        'supersession-shape-invalid',
        `supersedes: kind ${JSON.stringify(value.kind)} may not supersede — a superseding record of this kind is a mutation wearing a new name (OQ-8)`,
      );
    }
    if (
      isPlainObject(value.supersedes) &&
      typeof value.supersedes.id === 'string' &&
      value.supersedes.id === value.proposalId
    ) {
      errors.pushCoded(
        'supersession-shape-invalid',
        'supersedes.id: a proposal may not supersede itself — supersession is a NEW record referring to an older one',
      );
    }
  } else if (requirement === 'required') {
    errors.pushCoded(
      'supersession-shape-invalid',
      `supersedes: required for kind ${JSON.stringify(value.kind)} — an edit that supersedes nothing is an in-place mutation, which cannot be moderated or cited by a permalink (OQ-8)`,
    );
  }

  requireNonNegativeInteger(value.baseEpoch, 'baseEpoch', errors);

  if (
    value.baseCheckpoint !== undefined &&
    (typeof value.baseCheckpoint !== 'string' ||
      value.baseCheckpoint.length === 0)
  ) {
    errors.push('baseCheckpoint: must be a non-empty string when present');
  }

  // Untrusted, and checked only for being a string. See the field docs.
  requireNonEmptyString(value.happenedAt, 'happenedAt', errors);

  const hasBody = value.body !== undefined;
  const hasBodyRef = value.bodyRef !== undefined;
  if (hasBody === hasBodyRef) {
    errors.push(
      'body/bodyRef: exactly one must be present — inline content or a content-addressed ref, never both and never neither',
    );
  }
  if (hasBodyRef) {
    if (!isPlainObject(value.bodyRef)) {
      errors.push('bodyRef: must be an object');
    } else {
      requireNonEmptyString(value.bodyRef.digest, 'bodyRef.digest', errors);
      if (
        value.bodyRef.mediaType !== undefined &&
        typeof value.bodyRef.mediaType !== 'string'
      ) {
        errors.push('bodyRef.mediaType: must be a string when present');
      }
      if (value.bodyRef.byteLength !== undefined) {
        requireNonNegativeInteger(
          value.bodyRef.byteLength,
          'bodyRef.byteLength',
          errors,
        );
      }
    }
  }

  if (errors.length > 0) return errors.failure();
  return { ok: true, record: value as unknown as ChannelProposal };
}

/**
 * The exact bytes `proposalDigest` is computed over: the embedded proposal,
 * canonicalized with the repo's existing helper
 * (`fleet-routing-receipt.ts`'s {@link canonicalizeForDigest}, which sorts
 * object keys at every depth) and serialized.
 *
 * **There is exactly one canonical byte-string for a proposal, and this is
 * it.** The DSSE envelope is carried alongside the record rather than inside
 * it (`channel-assurance.ts`, {@link ChannelSignedRecord}), so these bytes
 * are simultaneously what a digest covers and what a signer signs.
 * An embedded envelope would have forced two canonicalizations — a record
 * cannot contain its own signature — and nothing would have said which one
 * `proposalDigest` meant.
 *
 * No hashing happens here: `@kontourai/station-contracts` is imported by
 * `src-ui`, so it stays free of `node:crypto`. Callers inject a hash.
 */
export function channelProposalDigestInput(proposal: ChannelProposal): string {
  return JSON.stringify(canonicalizeForDigest(proposal));
}

export type ChannelDigestVerdict =
  | { status: 'match' }
  | { status: 'mismatch'; declared: string; computed: string };

/**
 * Recompute a sequencing envelope's `proposalDigest` and compare. Two-state
 * on purpose: the caller supplied the hash function, so there is no "we did
 * not check" branch to confuse with a match.
 *
 * @param sha256Hex A hex SHA-256 of the given string. Injected so this module
 *                  stays browser-safe; `node:crypto`'s `createHash('sha256')`
 *                  is the intended production supplier.
 */
export function verifyEmbeddedProposalDigest(
  envelope: ChannelSequencingEnvelope,
  sha256Hex: (input: string) => string,
): ChannelDigestVerdict {
  const computed = sha256Hex(channelProposalDigestInput(envelope.proposal));
  if (computed === envelope.proposalDigest) return { status: 'match' };
  return {
    status: 'mismatch',
    declared: envelope.proposalDigest,
    computed,
  };
}

/**
 * Fail-closed sequencing-envelope validator.
 *
 * Beyond field shapes it enforces three cross-field facts the design states:
 * a refusal receipt can never be sequenced (OQ-6); the envelope's
 * `channelId` must equal the embedded proposal's; and `prevEnvelopeDigest`
 * is `null` at exactly the genesis sequence and non-null everywhere else,
 * so a chain cannot silently begin in the middle.
 *
 * It does NOT check the digest — that needs a hash function, and
 * {@link verifyEmbeddedProposalDigest} is the named way to do it.
 */
export function validateChannelSequencingEnvelope(
  value: unknown,
): ChannelValidationResult<ChannelSequencingEnvelope> {
  const errors = new ChannelDiagnosticCollector();

  if (!isPlainObject(value)) {
    errors.push('envelope: must be an object');
    return errors.failure();
  }

  if (value.schemaVersion !== CHANNEL_SEQUENCE_SCHEMA_VERSION) {
    errors.pushCoded(
      'schema-version-unknown',
      `schemaVersion: unknown or absent (expected ${CHANNEL_SEQUENCE_SCHEMA_VERSION}, got ${JSON.stringify(value.schemaVersion)})`,
    );
    return errors.failure();
  }

  requireNonEmptyString(value.channelId, 'channelId', errors);
  requireNonNegativeInteger(value.epoch, 'epoch', errors);
  requireNonNegativeInteger(value.seq, 'seq', errors);
  if (typeof value.seq === 'number' && value.seq < CHANNEL_GENESIS_SEQ) {
    errors.push(
      `seq: must be >= ${CHANNEL_GENESIS_SEQ} (the genesis sequence, matching the event store's COALESCE(MAX,0)+1 assignment)`,
    );
  }
  requireNonEmptyString(value.proposalDigest, 'proposalDigest', errors);
  requireNonEmptyString(value.committedAt, 'committedAt', errors);
  requireNonEmptyString(value.policyRevision, 'policyRevision', errors);
  requireNonEmptyString(value.leaseRef, 'leaseRef', errors);

  // OQ-6, mechanically. Checked BEFORE the proposal validator so the
  // diagnostic names the actual violation rather than a pile of missing
  // proposal fields.
  const embedded = value.proposal;
  if (
    isPlainObject(embedded) &&
    embedded.schemaVersion === CHANNEL_REFUSAL_RECEIPT_SCHEMA_VERSION
  ) {
    errors.pushCoded(
      'refusal-not-sequenceable',
      `proposal: a ${CHANNEL_REFUSAL_RECEIPT_SCHEMA_VERSION} may never be sequenced — a refusal is the absence of an authored event, not an event (OQ-6). Committing refusals would let any member write into everyone else's history by proposing garbage`,
    );
  } else if (
    isPlainObject(embedded) &&
    typeof embedded.schemaVersion === 'string' &&
    !(CHANNEL_SEQUENCEABLE_SCHEMA_VERSIONS as readonly string[]).includes(
      embedded.schemaVersion,
    )
  ) {
    errors.pushCoded(
      'record-not-sequenceable',
      `proposal.schemaVersion: ${JSON.stringify(embedded.schemaVersion)} is not in the sequenceable set (${CHANNEL_SEQUENCEABLE_SCHEMA_VERSIONS.join(', ')})`,
    );
  } else {
    const embeddedResult = validateChannelProposal(embedded);
    if (!embeddedResult.ok) {
      for (const diagnostic of embeddedResult.diagnostics) {
        errors.pushCoded(diagnostic.code, `proposal.${diagnostic.message}`);
      }
    } else if (
      typeof value.channelId === 'string' &&
      embeddedResult.record.channelId !== value.channelId
    ) {
      errors.push(
        `proposal.channelId: ${JSON.stringify(embeddedResult.record.channelId)} does not match the envelope's ${JSON.stringify(value.channelId)} — a home may not sequence a proposal into a channel it was not authored for`,
      );
    }
  }

  const isGenesis = value.seq === CHANNEL_GENESIS_SEQ;
  if (value.prevEnvelopeDigest === null) {
    if (!isGenesis) {
      errors.push(
        `prevEnvelopeDigest: null is permitted only at seq ${CHANNEL_GENESIS_SEQ} — a null link anywhere else is a chain that begins in the middle, which is exactly what the head anchor exists to catch (§8.2)`,
      );
    }
  } else if (
    typeof value.prevEnvelopeDigest !== 'string' ||
    value.prevEnvelopeDigest.length === 0
  ) {
    errors.push(
      'prevEnvelopeDigest: must be a non-empty string, or null at genesis',
    );
  } else if (isGenesis) {
    errors.push(
      `prevEnvelopeDigest: must be null at seq ${CHANNEL_GENESIS_SEQ} — the genesis envelope links to nothing`,
    );
  }

  if (errors.length > 0) return errors.failure();
  return { ok: true, record: value as unknown as ChannelSequencingEnvelope };
}

export function validateChannelCheckpoint(
  value: unknown,
): ChannelValidationResult<ChannelCheckpoint> {
  const errors = new ChannelDiagnosticCollector();

  if (!isPlainObject(value)) {
    errors.push('checkpoint: must be an object');
    return errors.failure();
  }

  if (value.schemaVersion !== CHANNEL_CHECKPOINT_SCHEMA_VERSION) {
    errors.pushCoded(
      'schema-version-unknown',
      `schemaVersion: unknown or absent (expected ${CHANNEL_CHECKPOINT_SCHEMA_VERSION}, got ${JSON.stringify(value.schemaVersion)})`,
    );
    return errors.failure();
  }

  requireNonEmptyString(value.channelId, 'channelId', errors);
  requireNonNegativeInteger(value.epoch, 'epoch', errors);
  requireNonNegativeInteger(value.seq, 'seq', errors);
  requireNonEmptyString(value.headEnvelopeDigest, 'headEnvelopeDigest', errors);
  requireNonEmptyString(value.logDigest, 'logDigest', errors);
  requireNonEmptyString(value.policyRevision, 'policyRevision', errors);
  requireNonEmptyString(value.observedAt, 'observedAt', errors);

  if (errors.length > 0) return errors.failure();
  return { ok: true, record: value as unknown as ChannelCheckpoint };
}

export function validateChannelHomeRecord(
  value: unknown,
): ChannelValidationResult<ChannelHomeRecord> {
  const errors = new ChannelDiagnosticCollector();

  if (!isPlainObject(value)) {
    errors.push('channelHome: must be an object');
    return errors.failure();
  }

  if (value.schemaVersion !== CHANNEL_HOME_SCHEMA_VERSION) {
    errors.pushCoded(
      'schema-version-unknown',
      `schemaVersion: unknown or absent (expected ${CHANNEL_HOME_SCHEMA_VERSION}, got ${JSON.stringify(value.schemaVersion)})`,
    );
    return errors.failure();
  }

  requireNonEmptyString(value.channelId, 'channelId', errors);
  requireNonNegativeInteger(value.epoch, 'epoch', errors);
  requireNonEmptyString(value.homeRef, 'homeRef', errors);
  requireNonEmptyString(value.leaseRef, 'leaseRef', errors);
  requireNonEmptyString(value.leaseExpiresAt, 'leaseExpiresAt', errors);
  requireNonEmptyString(value.policyRevision, 'policyRevision', errors);

  // `null` is a real, named state — peer-only, which freezes rather than
  // auto-promoting (§3.4). An ABSENT key is not the same statement and is
  // refused, because "no witness" must be said, not implied.
  if (
    value.witnessRef !== null &&
    (typeof value.witnessRef !== 'string' || value.witnessRef.length === 0)
  ) {
    errors.push(
      'witnessRef: must be a non-empty string, or null to state explicitly that this is a peer-only channel (§3.4) — an absent key is not a statement',
    );
  }
  if (
    value.previousEpochCloseCheckpoint !== null &&
    (typeof value.previousEpochCloseCheckpoint !== 'string' ||
      value.previousEpochCloseCheckpoint.length === 0)
  ) {
    errors.push(
      'previousEpochCloseCheckpoint: must be a non-empty string, or null at the first epoch',
    );
  }

  if (errors.length > 0) return errors.failure();
  return { ok: true, record: value as unknown as ChannelHomeRecord };
}

/**
 * Fail-closed validator for the refusal receipt.
 *
 * It has one **because it is a record a reader receives from a party it does
 * not trust** — a home that refuses a member's proposal. A record type with
 * no validator
 * is invisible to the corpus gate, which can only report a missing fixture
 * for a validator that exists.
 *
 * **A refusal receipt is never sequenced** (OQ-6). Validating one says
 * nothing about admitting one:
 * {@link validateChannelSequencingEnvelope} refuses it by name.
 */
export function validateChannelRefusalReceipt(
  value: unknown,
): ChannelValidationResult<ChannelRefusalReceipt> {
  const errors = new ChannelDiagnosticCollector();

  if (!isPlainObject(value)) {
    errors.push('refusalReceipt: must be an object');
    return errors.failure();
  }

  if (value.schemaVersion !== CHANNEL_REFUSAL_RECEIPT_SCHEMA_VERSION) {
    errors.pushCoded(
      'schema-version-unknown',
      `schemaVersion: unknown or absent (expected ${CHANNEL_REFUSAL_RECEIPT_SCHEMA_VERSION}, got ${JSON.stringify(value.schemaVersion)})`,
    );
    return errors.failure();
  }

  requireNonEmptyString(value.channelId, 'channelId', errors);
  requireNonEmptyString(value.proposalId, 'proposalId', errors);
  requireNonEmptyString(value.reasonCode, 'reasonCode', errors);
  requireNonEmptyString(value.policyRevision, 'policyRevision', errors);
  requireNonEmptyString(value.observedAt, 'observedAt', errors);

  if (errors.length > 0) return errors.failure();
  return { ok: true, record: value as unknown as ChannelRefusalReceipt };
}

/**
 * Validates the ONLY channel-related shape a portable project manifest may
 * carry (§3.3, CRITICAL correction 1). Every authority field is refused by
 * name, so a future writer who tries to move the home record into the
 * manifest gets a diagnostic that says why rather than a silent success.
 */
export function validateChannelLocatorHint(
  value: unknown,
): ChannelValidationResult<ChannelLocatorHint> {
  const errors = new ChannelDiagnosticCollector();

  if (!isPlainObject(value)) {
    errors.push('locatorHint: must be an object');
    return errors.failure();
  }

  requireNonEmptyString(value.channelId, 'channelId', errors);
  if (
    value.locatorHint !== undefined &&
    (typeof value.locatorHint !== 'string' || value.locatorHint.length === 0)
  ) {
    errors.push('locatorHint: must be a non-empty string when present');
  }

  for (const field of CHANNEL_AUTHORITY_ONLY_FIELDS) {
    if (field in value) {
      errors.pushCoded(
        'authority-field-in-locator-hint',
        `${field}: channel authority state does not live in a portable identity document (§3.3, CRITICAL correction 1) — it is leased, expiring, and rewritten on every handover, and "who may write" must not travel in a file anyone can copy. Resolve it from the ${CHANNEL_HOME_SCHEMA_VERSION} record instead`,
      );
    }
  }

  if (errors.length > 0) return errors.failure();
  return { ok: true, record: value as unknown as ChannelLocatorHint };
}

/**
 * Compare two checkpoints for the same coordinate (§3.5 mechanism 3).
 *
 * **A conflict is not automatically a proof.** §3.5 calls two conflicting
 * checkpoints "a self-contained, third-party-verifiable proof of
 * equivocation" — and that sentence is only true when both are verifiably
 * signed by the same home. Unsigned, a conflict is a real thing to surface
 * and an unattributable one: anybody can fabricate an unsigned checkpoint,
 * and an unattributable one: anybody can fabricate an unsigned checkpoint,
 * so treating it as proof would let a third party frame a home. Without a
 * verifier this produces `unattributable` conflicts, which is the
 * honest answer rather than the flattering one.
 */
export type ChannelCheckpointComparison =
  | { kind: 'not-comparable'; reason: string }
  | { kind: 'consistent' }
  | {
      kind: 'conflict';
      /**
       * `attributable` only when both checkpoints carry a verified envelope
       * sharing a key id — i.e. the same signer demonstrably said both
       * things.
       */
      attribution: 'attributable' | 'unattributable';
      message: string;
    };

/**
 * @param verifiedSignerKeyId Supplied when a verifier exists: returns the key
 *   that actually produced a verified signature over the checkpoint, or
 *   `null` when there is none. Returning a **key id** rather than a boolean
 *   is load-bearing: attribution means "the SAME
 *   signer said both things", and a boolean plus the envelope's own
 *   self-declared `signatures[].keyid` cannot establish that — the declared
 *   key id is unverified metadata anyone can write, so a verifier checking
 *   key A against a record advertising key B would have produced an
 *   "equivocation proof" naming the wrong home.
 *
 *   Absent, no conflict is ever attributable — which is why an
 *   equivocation proof is not something this comparison can emit without
 *   one.
 */
export function compareChannelCheckpoints(
  a: ChannelCheckpoint,
  b: ChannelCheckpoint,
  verifiedSignerKeyId?: (checkpoint: ChannelCheckpoint) => string | null,
): ChannelCheckpointComparison {
  if (a.channelId !== b.channelId) {
    return {
      kind: 'not-comparable',
      reason: 'different channels',
    };
  }
  if (a.epoch !== b.epoch || a.seq !== b.seq) {
    return {
      kind: 'not-comparable',
      reason:
        'different commit coordinates — two checkpoints only conflict at the SAME (channel, epoch, seq)',
    };
  }
  if (a.headEnvelopeDigest === b.headEnvelopeDigest) {
    return { kind: 'consistent' };
  }

  // No verifier means never attributable — stated as an explicit `false`
  // rather than an absent-and-therefore-falsy value.
  let attributable = false;
  if (verifiedSignerKeyId) {
    const left = verifiedSignerKeyId(a);
    const right = verifiedSignerKeyId(b);
    attributable =
      typeof left === 'string' && left.length > 0 && left === right;
  }

  return {
    kind: 'conflict',
    attribution: attributable ? 'attributable' : 'unattributable',
    message: attributable
      ? `equivocation: one signer produced two different heads for (${a.channelId}, epoch ${a.epoch}, seq ${a.seq})`
      : `conflicting heads for (${a.channelId}, epoch ${a.epoch}, seq ${a.seq}), unattributable — an unsigned checkpoint proves nothing about who authored it`,
  };
}

/**
 * OQ-8's read-path fold: the effective record is the end of the supersession
 * chain, and the chain is history rather than a value that was overwritten.
 *
 * Refuses to guess. A fork (two records superseding the same target) renders
 * `ambiguous` naming every candidate — the delivery protocol's "exact match
 * or `unavailable`; ambiguity renders as unavailable naming all candidates
 * ('pick the newest' is a coin flip presented as fact)". A cycle renders
 * `cycle`, never an infinite walk and never a silently truncated one.
 */
export type ChannelSupersessionFold =
  | { kind: 'resolved'; effectiveId: string; supersededIds: readonly string[] }
  | { kind: 'ambiguous'; atId: string; candidates: readonly string[] }
  | { kind: 'cycle'; atId: string };

export interface ChannelSupersessionLink {
  /** The superseding record. */
  proposalId: string;
  /** What it supersedes. */
  supersedesId: string;
}

export function foldChannelSupersessions(
  originalId: string,
  links: readonly ChannelSupersessionLink[],
): ChannelSupersessionFold {
  // Deduplicated by (supersedesId, proposalId) before the arity test.
  // One superseding record delivered twice — a page
  // union, a replayed segment — is still ONE successor, and reporting it as
  // ambiguous would render every edited message as unavailable with the same
  // candidate named twice.
  const successors = new Map<string, Set<string>>();
  for (const link of links) {
    const existing = successors.get(link.supersedesId);
    if (existing) existing.add(link.proposalId);
    else successors.set(link.supersedesId, new Set([link.proposalId]));
  }

  const superseded: string[] = [];
  const visited = new Set<string>([originalId]);
  let current = originalId;

  for (;;) {
    const next = successors.get(current);
    if (!next || next.size === 0) {
      return {
        kind: 'resolved',
        effectiveId: current,
        supersededIds: superseded,
      };
    }
    if (next.size > 1) {
      return {
        kind: 'ambiguous',
        atId: current,
        candidates: [...next].sort(),
      };
    }
    const only = [...next][0] as string;
    if (visited.has(only)) {
      return { kind: 'cycle', atId: only };
    }
    visited.add(only);
    superseded.push(current);
    current = only;
  }
}

/**
 * Member/device key identity and agent authorization
 * (`docs/design/conversation-state.md` §2.7, §3.7, §10.4, OQ-5 and OQ-7).
 *
 * **Shapes and total functions only.** No key is generated, stored,
 * distributed, or verified here. §2.3's finding stands — nothing in this
 * repo signs anything — so every function below either reads a shape or
 * refuses to answer.
 *
 * ## OQ-5, and the two things it decides that a type can carry
 *
 * > "Per-device keys certified by a member identity key. No key recovery in
 * > v1; losing every device means re-enrolment as a new member, and the log
 * > records that honestly rather than pretending continuity."
 *
 * 1. **The chain is exactly one hop.** A member identity key certifies a
 *    device key; a device key certifies nothing.
 *    {@link resolveChannelCertification} refuses a certificate whose issuer
 *    is not the named member key, and refuses a key that certifies itself.
 *    Depth is not a parameter, so a delegation chain cannot be introduced by
 *    passing a longer list — it would need a contract change.
 * 2. **There is no recovery, and its absence is enforced rather than
 *    described.** {@link validateChannelMemberIdentityKey} refuses every
 *    field in {@link KEY_RECOVERY_FIELDS_NOT_IN_V1} by name. Recovery is a
 *    trust root (§10.4) and deserves its own decision; adding one
 *    has to delete a refusal, which is visible in a diff, rather than add a
 *    field, which is not.
 *
 * ## The axis this file must not blur (§2.7)
 *
 * Station already has *machine* identity: pairing scopes and peer
 * credentials (`environment-security.ts`, `peer-credential-store.ts`). It
 * has no *member* identity. These are different axes, and conflating them
 * would make "revoke this laptop's pairing" silently mean "invalidate
 * everything that laptop ever said". Nothing here references a pairing
 * scope, and {@link ChannelKeyRevocation} is a channel-log fact about a
 * signing key — never about a device relationship.
 *
 * ## Two different questions, two different honesty postures
 *
 * - **"Is this device key trustworthy?"** is a *cryptographic* question.
 *   Without a verifier, {@link resolveChannelCertification} answers
 *   `unknown` and never `certified`. This is `ReceiptChainStatus`'s
 *   three-state discipline (`src-server/runtime/conversation/receipt-chain.ts:64`,
 *   "because 'we did not check' must never render as 'it verified'").
 * - **"Was this agent authorized when it committed?"** is a question about
 *   *log content*, and §3.7 says so explicitly: "Every member can evaluate,
 *   from the log alone, whether an agent action was authorized at the moment
 *   it was committed." So {@link resolveAgentAuthorizationAtCommit} answers
 *   it from records, and says nothing about whether those records are
 *   trustworthy — that is `channel-assurance.ts`'s job, and keeping the two
 *   separate is what stops either one quietly standing in for the other.
 *
 * Both resolvers evaluate **at a commit coordinate, never at "now"**. A
 * revocation recorded after a message was committed does not retroactively
 * unauthorize that message; reading current state instead would rewrite
 * history every time a key was retired ("no claims about a turn/artifact
 * from mutable current state", `docs/strategy/multi-agent-delivery-protocol.md`
 * §6).
 */

import type {
  ChannelAssuranceVerifier,
  ChannelSignedRecord,
} from './channel-assurance.js';
import {
  deriveChannelRecordAssurance,
  isPlainJsonObject,
} from './channel-assurance.js';
import type {
  ChannelAuthorRef,
  ChannelCommitCoordinate,
  ChannelProposalKind,
  ChannelValidationResult,
} from './channel-log.js';
import { isChannelProposalKind } from './channel-log.js';

export const CHANNEL_MEMBER_KEY_SCHEMA_VERSION =
  'station.channel-member-key/v1' as const;
export const CHANNEL_DEVICE_CERTIFICATE_SCHEMA_VERSION =
  'station.channel-device-certificate/v1' as const;
export const CHANNEL_KEY_REVOCATION_SCHEMA_VERSION =
  'station.channel-key-revocation/v1' as const;
export const CHANNEL_AGENT_AUTHORIZATION_SCHEMA_VERSION =
  'station.channel-agent-authorization/v1' as const;
export const CHANNEL_AGENT_AUTHORIZATION_REVOCATION_SCHEMA_VERSION =
  'station.channel-agent-authorization-revocation/v1' as const;

/**
 * The one algorithm this contract names. Kept as a closed union rather than a free
 * string so that adding a second is a contract change with a review, not a
 * value somebody passes.
 */
export type ChannelKeyAlgorithm = 'ed25519';

export const CHANNEL_KEY_ALGORITHMS = [
  'ed25519',
] as const satisfies readonly ChannelKeyAlgorithm[];

/**
 * Fields that would constitute key recovery or account continuity. Refused
 * by name, because OQ-5 decided there is none in v1 and a decision that is
 * only written in prose is a decision the next writer overrides by accident.
 */
export const KEY_RECOVERY_FIELDS_NOT_IN_V1 = Object.freeze([
  'recoveryKeyId',
  'recoveredFrom',
  'previousMemberId',
  'supersedesMemberId',
  'escrowRef',
  'backupKeyId',
] as const);

/**
 * `station.channel-member-key/v1` — the member's identity key. The root of
 * the one-hop certification chain and the reason a member's history survives
 * losing a device: the device key that signed an old proposal was certified
 * by this key, and that certificate stays checkable after the device is gone.
 */
export interface ChannelMemberIdentityKey {
  schemaVersion: typeof CHANNEL_MEMBER_KEY_SCHEMA_VERSION;
  memberId: string;
  keyId: string;
  /** Base64 public key. No private material appears in any contract. */
  publicKey: string;
  algorithm: ChannelKeyAlgorithm;
  enrolledAt: string;
}

/**
 * `station.channel-device-certificate/v1` — the member identity key
 * certifying one device key. This is the record OQ-5 calls "the
 * certification chain", and it is a record type here because the proposal
 * schema's `author.keyId` is meaningless without it.
 */
export interface ChannelDeviceKeyCertificate {
  schemaVersion: typeof CHANNEL_DEVICE_CERTIFICATE_SCHEMA_VERSION;
  memberId: string;
  deviceId: string;
  deviceKeyId: string;
  devicePublicKey: string;
  algorithm: ChannelKeyAlgorithm;
  /** MUST be the member identity key's `keyId`. Never another device key. */
  issuerKeyId: string;
  issuedAt: string;
  /** `null` states "no expiry" explicitly; an absent key is not a statement. */
  expiresAt: string | null;
}

export type ChannelKeyRevocationReason =
  | 'device-lost'
  | 'device-retired'
  | 'member-departed'
  | 'compromise-suspected';

export const CHANNEL_KEY_REVOCATION_REASONS = [
  'device-lost',
  'device-retired',
  'member-departed',
  'compromise-suspected',
] as const satisfies readonly ChannelKeyRevocationReason[];

/**
 * `station.channel-key-revocation/v1` — a channel-log fact that a signing
 * key stops being acceptable from a defined instant. Committed, so it has a
 * coordinate, which is what makes "when did this key stop counting" answerable
 * (§3.7's shape applied to keys).
 *
 * Deliberately says nothing about pairing (§2.7). Revoking a signing key is
 * not unpairing a device, and neither implies the other.
 */
export interface ChannelKeyRevocation {
  schemaVersion: typeof CHANNEL_KEY_REVOCATION_SCHEMA_VERSION;
  channelId: string;
  memberId: string;
  revokedKeyId: string;
  reason: ChannelKeyRevocationReason;
}

/**
 * `station.channel-agent-authorization/v1` (§3.7, OQ-7) — the committed
 * grant an agent proposal's `onBehalfOf.authorizationId` refers to.
 *
 * A grant, not a claim: because it is in the log with a coordinate, any
 * member can evaluate authorization-at-commit-time without asking the
 * agent's owner, and revocation has an instant instead of a cache-refresh.
 */
export interface ChannelAgentAuthorizationGrant {
  schemaVersion: typeof CHANNEL_AGENT_AUTHORIZATION_SCHEMA_VERSION;
  authorizationId: string;
  channelId: string;
  ownerMemberId: string;
  /** The agent's own key — it signs with this, not with the owner's (§3.7). */
  agentKeyId: string;
  /**
   * Which proposal kinds this agent may author. Explicit allowlist, never
   * "all kinds": the same fail-closed opt-in shape as
   * `station.fleet-contribution/v1` (§9.3 point 1, `fleet-contribution.ts:66-80`),
   * where no value of the config contributes something nobody named.
   *
   * `agent-authorization` is refused as a capability — an agent that can
   * author grants can grant itself anything, which makes the whole record
   * self-authorizing.
   */
  capabilities: readonly ChannelProposalKind[];
  issuedAt: string;
  /** `null` states "no expiry" explicitly. */
  expiresAt: string | null;
}

export interface ChannelAgentAuthorizationRevocation {
  schemaVersion: typeof CHANNEL_AGENT_AUTHORIZATION_REVOCATION_SCHEMA_VERSION;
  authorizationId: string;
  channelId: string;
  ownerMemberId: string;
  reasonCode: string;
}

/**
 * A record as it sits in the log: the record plus where it was committed.
 *
 * **How these records reach the log, stated precisely.**
 * `CHANNEL_SEQUENCEABLE_SCHEMA_VERSIONS`
 * contains exactly one entry — the proposal — so a grant, a revocation, and a
 * key revocation are **proposal bodies**, committed as the `body` of a
 * proposal whose `kind` is `agent-authorization` (grants and their
 * revocations) or `membership-change` (key revocations). Their `coordinate`
 * is the coordinate of the sequencing envelope that committed the carrying
 * proposal.
 *
 * That is what makes OQ-7's guarantee true: "the authorization itself is a
 * committed log record" (§3.7). It is emphatically NOT a second sequenceable
 * record type — admitting one would reopen OQ-6's question about what may
 * enter committed history.
 */
export interface CommittedChannelRecord<T> {
  record: T;
  coordinate: ChannelCommitCoordinate;
  /** The home's clock at that commit — the ordering clock (§3.2). */
  committedAt: string;
}

/** The commit whose authorization/certification is being evaluated. */
export interface ChannelEvaluationInstant {
  coordinate: ChannelCommitCoordinate;
  committedAt: string;
}

export type ChannelCoordinateComparison =
  | { comparable: true; order: -1 | 0 | 1 }
  | { comparable: false; reason: 'different-channel' | 'malformed' };

function isCoordinate(value: unknown): value is ChannelCommitCoordinate {
  if (!isPlainJsonObject(value)) return false;
  return (
    typeof value.channelId === 'string' &&
    value.channelId.length > 0 &&
    typeof value.epoch === 'number' &&
    Number.isSafeInteger(value.epoch) &&
    typeof value.seq === 'number' &&
    Number.isSafeInteger(value.seq)
  );
}

/**
 * Order two coordinates in the same channel: epoch first, then sequence.
 *
 * **Three outcomes, not two.** A
 * `number | null` shape folds "not this channel's fact" together with "I
 * could not read this coordinate", and the arithmetic silently answered
 * "later" for a `NaN` or a stringified number: `a.epoch !== b.epoch` is true
 * and `a.epoch < b.epoch` is false, so the result was always `1`. Both
 * revocation loops read `1` as "committed after this commit — does not
 * apply", so a `compromise-suspected` revocation whose coordinate came back
 * from a store as `"3"` instead of `3` silently stopped breaking the chain.
 * Fail-open on the security-relevant input.
 *
 * `malformed` is now distinguishable, and both callers treat it as
 * disqualifying rather than ignorable.
 *
 * **Stated limit.** This assumes epochs of one unforked history. §3.4's
 * labeled-fork recovery can produce an epoch+1 that descends from a
 * *discarded* history, and two coordinates across such a divergence are not
 * ordered by this function in any meaningful sense. There is no fork
 * record to consult, so the limitation is named rather than papered over;
 * the fork-aware comparison belongs with the fork records, which is where
 * forks become producible.
 */
export function compareChannelCommitCoordinates(
  a: ChannelCommitCoordinate,
  b: ChannelCommitCoordinate,
): ChannelCoordinateComparison {
  if (!isCoordinate(a) || !isCoordinate(b)) {
    return { comparable: false, reason: 'malformed' };
  }
  if (a.channelId !== b.channelId) {
    return { comparable: false, reason: 'different-channel' };
  }
  if (a.epoch !== b.epoch) {
    return { comparable: true, order: a.epoch < b.epoch ? -1 : 1 };
  }
  if (a.seq !== b.seq) {
    return { comparable: true, order: a.seq < b.seq ? -1 : 1 };
  }
  return { comparable: true, order: 0 };
}

export type ChannelCertificationStatus = 'certified' | 'broken' | 'unknown';

export type ChannelCertificationBreakReason =
  | 'certificate-malformed'
  | 'coordinate-malformed'
  | 'member-mismatch'
  | 'issuer-not-member-key'
  | 'self-certification'
  | 'device-key-mismatch'
  | 'device-id-mismatch'
  | 'algorithm-mismatch'
  | 'certificate-expired'
  | 'key-revoked';

export type ChannelCertificationUnknownReason =
  /** No verifier was supplied. The honest answer for a well-formed chain. */
  | 'signature-unverified'
  /** A verifier was supplied and could not establish the certificate. */
  | 'certificate-signature-gap';

export type ChannelCertificationResult =
  | { status: 'certified' }
  | {
      status: 'broken';
      reason: ChannelCertificationBreakReason;
      message: string;
    }
  | {
      status: 'unknown';
      reason: ChannelCertificationUnknownReason;
      message: string;
    };

export interface ChannelCertificationInput {
  /** The `author` block of the proposal being evaluated. */
  author: ChannelAuthorRef;
  /**
   * The certificate **and the envelope carried alongside it**. Slice 1 has no
   * signer, so `dsseEnvelope` is absent and the result is never `certified`.
   */
  certificateCarriage: ChannelSignedRecord<ChannelDeviceKeyCertificate>;
  memberKey: ChannelMemberIdentityKey;
  /** The commit whose certification is in question — never "now". */
  at: ChannelEvaluationInstant;
  /** Committed revocations this reader holds. */
  revocations?: readonly CommittedChannelRecord<ChannelKeyRevocation>[];
  /** Supplied when a verifier exists. Absent, the result is never `certified`. */
  verifier?: ChannelAssuranceVerifier;
}

/**
 * Resolve whether a proposal's author key was certified by its member key at
 * the moment the proposal was committed.
 *
 * **Never returns `certified` without a verifier.** A structurally perfect
 * certificate with no checked signature is exactly the construction §1.4
 * correction 2 rejects: internally consistent, and evidence of nothing. The
 * structural checks below can only ever produce `broken` or fall through to
 * `unknown`.
 */
export function resolveChannelCertification(
  input: ChannelCertificationInput,
): ChannelCertificationResult {
  const { author, memberKey, at } = input;
  const certificate = input.certificateCarriage?.record;
  if (!isPlainJsonObject(certificate)) {
    return {
      status: 'broken',
      reason: 'certificate-malformed',
      message:
        'certificateCarriage.record: not a record — a carriage with nothing in it certifies nothing',
    };
  }

  if (certificate.memberId !== memberKey.memberId) {
    return {
      status: 'broken',
      reason: 'member-mismatch',
      message: `certificate.memberId ${JSON.stringify(certificate.memberId)} does not match the member key's ${JSON.stringify(memberKey.memberId)}`,
    };
  }
  if (author.memberId !== memberKey.memberId) {
    return {
      status: 'broken',
      reason: 'member-mismatch',
      message: `author.memberId ${JSON.stringify(author.memberId)} does not match the member key's ${JSON.stringify(memberKey.memberId)}`,
    };
  }
  if (certificate.issuerKeyId !== memberKey.keyId) {
    return {
      status: 'broken',
      reason: 'issuer-not-member-key',
      message: `certificate.issuerKeyId ${JSON.stringify(certificate.issuerKeyId)} is not the member identity key ${JSON.stringify(memberKey.keyId)} — the chain is exactly one hop (OQ-5); a device key certifying another device key is a delegation path v1 does not have`,
    };
  }
  if (certificate.deviceKeyId === memberKey.keyId) {
    return {
      status: 'broken',
      reason: 'self-certification',
      message:
        'certificate.deviceKeyId equals the member identity key — a key may not certify itself',
    };
  }
  if (author.keyId !== certificate.deviceKeyId) {
    return {
      status: 'broken',
      reason: 'device-key-mismatch',
      message: `author.keyId ${JSON.stringify(author.keyId)} is not the key this certificate certifies (${JSON.stringify(certificate.deviceKeyId)})`,
    };
  }
  if (author.deviceId !== certificate.deviceId) {
    return {
      status: 'broken',
      reason: 'device-id-mismatch',
      message: `author.deviceId ${JSON.stringify(author.deviceId)} is not the device this certificate certifies (${JSON.stringify(certificate.deviceId)})`,
    };
  }
  if (certificate.algorithm !== memberKey.algorithm) {
    return {
      status: 'broken',
      reason: 'algorithm-mismatch',
      message: `certificate.algorithm ${JSON.stringify(certificate.algorithm)} differs from the member key's ${JSON.stringify(memberKey.algorithm)}`,
    };
  }

  // Expiry is evaluated against the COMMIT's clock, not the reader's. A
  // certificate that expired last week does not invalidate what it certified
  // last year.
  if (
    certificate.expiresAt !== null &&
    certificate.expiresAt <= at.committedAt
  ) {
    return {
      status: 'broken',
      reason: 'certificate-expired',
      message: `certificate expired at ${certificate.expiresAt}, before the commit at ${at.committedAt}`,
    };
  }

  for (const revocation of input.revocations ?? []) {
    if (revocation.record.revokedKeyId !== certificate.deviceKeyId) continue;
    if (revocation.record.memberId !== memberKey.memberId) continue;
    const comparison = compareChannelCommitCoordinates(
      revocation.coordinate,
      at.coordinate,
    );
    if (!comparison.comparable) {
      // A revocation from ANOTHER channel is simply not this channel's fact.
      if (comparison.reason === 'different-channel') continue;
      // An UNREADABLE coordinate is a different thing entirely, and the
      // earlier code could not tell them apart — so a revocation whose epoch
      // came back from a store as a string was silently ignored. A revocation
      // we cannot place is a revocation we must not overlook.
      return {
        status: 'broken',
        reason: 'coordinate-malformed',
        message: `a revocation of ${certificate.deviceKeyId} carries an unreadable commit coordinate — an unplaceable revocation fails closed rather than being skipped`,
      };
    }
    // A revocation committed AFTER this commit does not reach back for it.
    if (comparison.order <= 0) {
      return {
        status: 'broken',
        reason: 'key-revoked',
        message: `device key ${certificate.deviceKeyId} was revoked (${revocation.record.reason}) at epoch ${revocation.coordinate.epoch} seq ${revocation.coordinate.seq}, at or before this commit`,
      };
    }
  }

  if (!input.verifier) {
    return {
      status: 'unknown',
      reason: 'signature-unverified',
      message:
        'the certification chain is structurally sound and NOT verified — a chain authored by the party you are checking proves only internal consistency (§1.4 correction 2). Signing lands in slice 3',
    };
  }

  const certificateAssurance = deriveChannelRecordAssurance(
    input.certificateCarriage,
    input.verifier,
  );
  if (certificateAssurance.kind !== 'level') {
    return {
      status: 'unknown',
      reason: 'certificate-signature-gap',
      message: `certificate signature could not be established: ${certificateAssurance.message}`,
    };
  }
  if (certificateAssurance.level === 'L0') {
    return {
      status: 'unknown',
      reason: 'signature-unverified',
      message:
        'certificate carries no DSSE envelope — an unsigned certificate certifies nothing',
    };
  }

  // The signature must be the MEMBER KEY'S. Without
  // this, `certified` meant "some key we did not name produced a signature we
  // did not attribute" — which is not what the one-hop chain claims, and it
  // is trivially satisfied by an attacker's own well-formed certificate. The
  // `issuerKeyId` check above is a SELF-ASSERTED field; this is the check
  // that makes it mean something.
  if (certificateAssurance.verifiedKeyId !== memberKey.keyId) {
    return {
      status: 'broken',
      reason: 'issuer-not-member-key',
      message: `the certificate's verified signature was produced by ${JSON.stringify(certificateAssurance.verifiedKeyId ?? null)}, not by the member identity key ${JSON.stringify(memberKey.keyId)} — a self-asserted issuerKeyId is not attribution`,
    };
  }

  return { status: 'certified' };
}

export type ChannelAuthorizationStatus =
  | 'authorized'
  | 'unauthorized'
  | 'unknown';

export type ChannelUnauthorizedReason =
  | 'agent-key-mismatch'
  | 'owner-mismatch'
  | 'grant-self-authorizing'
  | 'coordinate-malformed'
  | 'grant-not-in-log'
  | 'grant-not-yet-committed'
  | 'grant-expired'
  | 'capability-not-granted'
  | 'channel-mismatch'
  | 'revoked';

export type ChannelAuthorizationUnknownReason =
  /** No matching grant, and the reader does not hold the whole log. */
  | 'log-coverage-partial'
  /** Two grants share one `authorizationId`. */
  | 'grant-ambiguous';

export type ChannelAuthorizationResult =
  | { status: 'authorized'; grantCoordinate: ChannelCommitCoordinate }
  | {
      status: 'unauthorized';
      reason: ChannelUnauthorizedReason;
      message: string;
    }
  | {
      status: 'unknown';
      reason: ChannelAuthorizationUnknownReason;
      message: string;
      /** Named candidates when the failure is ambiguity, never a pick. */
      candidates?: readonly ChannelCommitCoordinate[];
    };

export interface ChannelAuthorizationInput {
  channelId: string;
  authorizationId: string;
  /**
   * The key that signed the proposal being evaluated, and the owner the
   * proposal's `onBehalfOf` names.
   *
   * **Required, and the reason is deliberate.** Without
   * them, this function answered "a grant with this id exists and carries
   * this capability" while its status said `authorized`. Authorization ids
   * are not secret — they are in the log — so any member device could author
   * `kind: 'agent-action'` quoting somebody else's grant and every reader
   * would compute `authorized`, with the proposal free to name a different
   * member as the authorizing party.
   */
  author: { keyId: string; claimedOwnerMemberId: string };
  /** The kind the agent proposal is asking to author. */
  kind: ChannelProposalKind;
  at: ChannelEvaluationInstant;
  grants: readonly CommittedChannelRecord<ChannelAgentAuthorizationGrant>[];
  revocations?: readonly CommittedChannelRecord<ChannelAgentAuthorizationRevocation>[];
  /**
   * Whether the caller holds the log from genesis. **This is load-bearing.**
   * With `complete-from-genesis`, a missing grant means unauthorized. With
   * `partial`, a missing grant means the reader cannot say — absence of
   * evidence is only evidence of absence when you hold all the evidence, and
   * §3.5's own honest limit ("detection is strong for members who stay
   * reasonably current and weak for members who were away") is the same
   * observation about a different mechanism.
   */
  logCoverage: 'complete-from-genesis' | 'partial';
}

/**
 * Evaluate an agent proposal's authorization **from the log alone, at the
 * coordinate the proposal was committed at** (§3.7, OQ-7).
 *
 * Says nothing about whether the log is trustworthy — see the module header.
 */
export function resolveAgentAuthorizationAtCommit(
  input: ChannelAuthorizationInput,
): ChannelAuthorizationResult {
  const matches = input.grants.filter(
    (entry) => entry.record.authorizationId === input.authorizationId,
  );

  if (matches.length === 0) {
    if (input.logCoverage === 'partial') {
      return {
        status: 'unknown',
        reason: 'log-coverage-partial',
        message: `no grant ${JSON.stringify(input.authorizationId)} in the segment held, and the reader does not hold the log from genesis — this is an honest gap, not an authorization failure`,
      };
    }
    return {
      status: 'unauthorized',
      reason: 'grant-not-in-log',
      message: `no committed grant ${JSON.stringify(input.authorizationId)} exists in the log`,
    };
  }

  if (matches.length > 1) {
    return {
      status: 'unknown',
      reason: 'grant-ambiguous',
      message: `authorizationId ${JSON.stringify(input.authorizationId)} names ${matches.length} committed grants — ambiguity renders as unavailable naming every candidate, never as a pick`,
      candidates: matches.map((entry) => entry.coordinate),
    };
  }

  const grant =
    matches[0] as CommittedChannelRecord<ChannelAgentAuthorizationGrant>;

  if (grant.record.channelId !== input.channelId) {
    return {
      status: 'unauthorized',
      reason: 'channel-mismatch',
      message: `grant ${JSON.stringify(input.authorizationId)} is scoped to channel ${JSON.stringify(grant.record.channelId)}, not ${JSON.stringify(input.channelId)}`,
    };
  }

  // The grant must be the one THIS author holds.
  if (grant.record.agentKeyId !== input.author.keyId) {
    return {
      status: 'unauthorized',
      reason: 'agent-key-mismatch',
      message: `grant ${JSON.stringify(input.authorizationId)} authorizes key ${JSON.stringify(grant.record.agentKeyId)}, not the signing key ${JSON.stringify(input.author.keyId)} — quoting somebody else's authorizationId is not authorization`,
    };
  }
  if (grant.record.ownerMemberId !== input.author.claimedOwnerMemberId) {
    return {
      status: 'unauthorized',
      reason: 'owner-mismatch',
      message: `the proposal attributes this action to ${JSON.stringify(input.author.claimedOwnerMemberId)} but grant ${JSON.stringify(input.authorizationId)} was issued by ${JSON.stringify(grant.record.ownerMemberId)} — attribution that disagrees with the grant is a claim, not a fact`,
    };
  }

  // The one decision-bearing invariant re-checked here rather than trusted
  // from the validator. Nothing forces a caller to
  // validate before resolving, and a grant that can mint grants makes
  // revocation meaningless — too costly to leave to a precondition.
  if (grant.record.capabilities.includes('agent-authorization')) {
    return {
      status: 'unauthorized',
      reason: 'grant-self-authorizing',
      message: `grant ${JSON.stringify(input.authorizationId)} carries the capability to author authorizations, which validateChannelAgentAuthorizationGrant refuses — a self-authorizing grant authorizes nothing`,
    };
  }

  const grantOrder = compareChannelCommitCoordinates(
    grant.coordinate,
    input.at.coordinate,
  );
  if (!grantOrder.comparable) {
    return {
      status: 'unauthorized',
      reason:
        grantOrder.reason === 'malformed'
          ? 'coordinate-malformed'
          : 'channel-mismatch',
      message: `grant ${JSON.stringify(input.authorizationId)} cannot be placed relative to this proposal (${grantOrder.reason}) — an unplaceable grant authorizes nothing`,
    };
  }
  if (grantOrder.order > 0) {
    return {
      status: 'unauthorized',
      reason: 'grant-not-yet-committed',
      message: `grant ${JSON.stringify(input.authorizationId)} was committed after this proposal's coordinate — an action is authorized by a grant that already existed, never by one that arrived later`,
    };
  }

  if (!grant.record.capabilities.includes(input.kind)) {
    return {
      status: 'unauthorized',
      reason: 'capability-not-granted',
      message: `grant ${JSON.stringify(input.authorizationId)} does not carry the capability ${JSON.stringify(input.kind)} (it carries: ${grant.record.capabilities.join(', ') || 'nothing'})`,
    };
  }

  if (
    grant.record.expiresAt !== null &&
    grant.record.expiresAt <= input.at.committedAt
  ) {
    return {
      status: 'unauthorized',
      reason: 'grant-expired',
      message: `grant ${JSON.stringify(input.authorizationId)} expired at ${grant.record.expiresAt}, before the commit at ${input.at.committedAt}`,
    };
  }

  for (const revocation of input.revocations ?? []) {
    if (revocation.record.authorizationId !== input.authorizationId) continue;
    if (revocation.record.channelId !== input.channelId) continue;
    const comparison = compareChannelCommitCoordinates(
      revocation.coordinate,
      input.at.coordinate,
    );
    if (!comparison.comparable) {
      if (comparison.reason === 'different-channel') continue;
      return {
        status: 'unauthorized',
        reason: 'coordinate-malformed',
        message: `a revocation of ${JSON.stringify(input.authorizationId)} carries an unreadable commit coordinate — an unplaceable revocation fails closed rather than being skipped`,
      };
    }
    if (comparison.order <= 0) {
      return {
        status: 'unauthorized',
        reason: 'revoked',
        message: `grant ${JSON.stringify(input.authorizationId)} was revoked at epoch ${revocation.coordinate.epoch} seq ${revocation.coordinate.seq}, at or before this commit (${revocation.record.reasonCode})`,
      };
    }
  }

  return { status: 'authorized', grantCoordinate: grant.coordinate };
}

// ---------------------------------------------------------------------------
// Validators. Same fail-closed shape as `channel-log.ts`: never throw, never
// cast an unverified value into the type, accumulate every violation.
// ---------------------------------------------------------------------------

export type ChannelIdentityDiagnosticCode =
  | 'schema-version-unknown'
  | 'record-invalid'
  /** A key-recovery/continuity field appeared. OQ-5 decided there is none. */
  | 'key-recovery-not-in-v1'
  /** A grant tried to include the power to author grants. */
  | 'self-authorizing-capability';

export interface ChannelIdentityDiagnostic {
  code: ChannelIdentityDiagnosticCode;
  message: string;
}

class IdentityDiagnosticCollector {
  readonly diagnostics: ChannelIdentityDiagnostic[] = [];

  push(message: string): void {
    this.diagnostics.push({ code: 'record-invalid', message });
  }

  pushCoded(code: ChannelIdentityDiagnosticCode, message: string): void {
    this.diagnostics.push({ code, message });
  }

  get length(): number {
    return this.diagnostics.length;
  }

  failure<T>(): ChannelValidationResult<T, ChannelIdentityDiagnostic> {
    return {
      ok: false,
      errors: this.diagnostics.map((diagnostic) => diagnostic.message),
      diagnostics: this.diagnostics,
    };
  }
}

const isPlainObject = isPlainJsonObject;

function requireNonEmptyString(
  value: unknown,
  fieldPath: string,
  errors: IdentityDiagnosticCollector,
): void {
  if (typeof value !== 'string' || value.length === 0) {
    errors.push(`${fieldPath}: must be a non-empty string`);
  }
}

function requireAlgorithm(
  value: unknown,
  fieldPath: string,
  errors: IdentityDiagnosticCollector,
): void {
  if (!(CHANNEL_KEY_ALGORITHMS as readonly unknown[]).includes(value)) {
    errors.push(
      `${fieldPath}: must be one of ${CHANNEL_KEY_ALGORITHMS.join(', ')} (got ${JSON.stringify(value)})`,
    );
  }
}

export function validateChannelMemberIdentityKey(
  value: unknown,
): ChannelValidationResult<
  ChannelMemberIdentityKey,
  ChannelIdentityDiagnostic
> {
  const errors = new IdentityDiagnosticCollector();

  if (!isPlainObject(value)) {
    errors.push('memberKey: must be an object');
    return errors.failure();
  }
  if (value.schemaVersion !== CHANNEL_MEMBER_KEY_SCHEMA_VERSION) {
    errors.pushCoded(
      'schema-version-unknown',
      `schemaVersion: unknown or absent (expected ${CHANNEL_MEMBER_KEY_SCHEMA_VERSION}, got ${JSON.stringify(value.schemaVersion)})`,
    );
    return errors.failure();
  }

  requireNonEmptyString(value.memberId, 'memberId', errors);
  requireNonEmptyString(value.keyId, 'keyId', errors);
  requireNonEmptyString(value.publicKey, 'publicKey', errors);
  requireAlgorithm(value.algorithm, 'algorithm', errors);
  requireNonEmptyString(value.enrolledAt, 'enrolledAt', errors);

  // OQ-5's "no recovery in v1", enforced rather than described.
  for (const field of KEY_RECOVERY_FIELDS_NOT_IN_V1) {
    if (field in value) {
      errors.pushCoded(
        'key-recovery-not-in-v1',
        `${field}: there is no key recovery in v1 (OQ-5). Losing every device means re-enrolment as a NEW member, and the log records that honestly rather than pretending continuity — recovery is a trust root (§10.4) and needs its own decision, not a field`,
      );
    }
  }

  if (errors.length > 0) return errors.failure();
  return { ok: true, record: value as unknown as ChannelMemberIdentityKey };
}

export function validateChannelDeviceKeyCertificate(
  value: unknown,
): ChannelValidationResult<
  ChannelDeviceKeyCertificate,
  ChannelIdentityDiagnostic
> {
  const errors = new IdentityDiagnosticCollector();

  if (!isPlainObject(value)) {
    errors.push('certificate: must be an object');
    return errors.failure();
  }
  if (value.schemaVersion !== CHANNEL_DEVICE_CERTIFICATE_SCHEMA_VERSION) {
    errors.pushCoded(
      'schema-version-unknown',
      `schemaVersion: unknown or absent (expected ${CHANNEL_DEVICE_CERTIFICATE_SCHEMA_VERSION}, got ${JSON.stringify(value.schemaVersion)})`,
    );
    return errors.failure();
  }

  requireNonEmptyString(value.memberId, 'memberId', errors);
  requireNonEmptyString(value.deviceId, 'deviceId', errors);
  requireNonEmptyString(value.deviceKeyId, 'deviceKeyId', errors);
  requireNonEmptyString(value.devicePublicKey, 'devicePublicKey', errors);
  requireAlgorithm(value.algorithm, 'algorithm', errors);
  requireNonEmptyString(value.issuerKeyId, 'issuerKeyId', errors);
  requireNonEmptyString(value.issuedAt, 'issuedAt', errors);

  if (
    value.expiresAt !== null &&
    (typeof value.expiresAt !== 'string' || value.expiresAt.length === 0)
  ) {
    errors.push(
      'expiresAt: must be a non-empty string, or null to state "no expiry" explicitly — an absent key is not a statement',
    );
  }

  for (const field of KEY_RECOVERY_FIELDS_NOT_IN_V1) {
    if (field in value) {
      errors.pushCoded(
        'key-recovery-not-in-v1',
        `${field}: there is no key recovery in v1 (OQ-5) — a certificate may not carry a recovery path`,
      );
    }
  }

  if (errors.length > 0) return errors.failure();
  return { ok: true, record: value as unknown as ChannelDeviceKeyCertificate };
}

export function validateChannelKeyRevocation(
  value: unknown,
): ChannelValidationResult<ChannelKeyRevocation, ChannelIdentityDiagnostic> {
  const errors = new IdentityDiagnosticCollector();

  if (!isPlainObject(value)) {
    errors.push('keyRevocation: must be an object');
    return errors.failure();
  }
  if (value.schemaVersion !== CHANNEL_KEY_REVOCATION_SCHEMA_VERSION) {
    errors.pushCoded(
      'schema-version-unknown',
      `schemaVersion: unknown or absent (expected ${CHANNEL_KEY_REVOCATION_SCHEMA_VERSION}, got ${JSON.stringify(value.schemaVersion)})`,
    );
    return errors.failure();
  }

  requireNonEmptyString(value.channelId, 'channelId', errors);
  requireNonEmptyString(value.memberId, 'memberId', errors);
  requireNonEmptyString(value.revokedKeyId, 'revokedKeyId', errors);
  if (
    !(CHANNEL_KEY_REVOCATION_REASONS as readonly unknown[]).includes(
      value.reason,
    )
  ) {
    errors.push(
      `reason: must be one of ${CHANNEL_KEY_REVOCATION_REASONS.join(', ')} (got ${JSON.stringify(value.reason)})`,
    );
  }

  if (errors.length > 0) return errors.failure();
  return { ok: true, record: value as unknown as ChannelKeyRevocation };
}

export function validateChannelAgentAuthorizationRevocation(
  value: unknown,
): ChannelValidationResult<
  ChannelAgentAuthorizationRevocation,
  ChannelIdentityDiagnostic
> {
  const errors = new IdentityDiagnosticCollector();

  if (!isPlainObject(value)) {
    errors.push('authorizationRevocation: must be an object');
    return errors.failure();
  }
  if (
    value.schemaVersion !==
    CHANNEL_AGENT_AUTHORIZATION_REVOCATION_SCHEMA_VERSION
  ) {
    errors.pushCoded(
      'schema-version-unknown',
      `schemaVersion: unknown or absent (expected ${CHANNEL_AGENT_AUTHORIZATION_REVOCATION_SCHEMA_VERSION}, got ${JSON.stringify(value.schemaVersion)})`,
    );
    return errors.failure();
  }

  requireNonEmptyString(value.authorizationId, 'authorizationId', errors);
  requireNonEmptyString(value.channelId, 'channelId', errors);
  requireNonEmptyString(value.ownerMemberId, 'ownerMemberId', errors);
  requireNonEmptyString(value.reasonCode, 'reasonCode', errors);

  if (errors.length > 0) return errors.failure();
  return {
    ok: true,
    record: value as unknown as ChannelAgentAuthorizationRevocation,
  };
}

export function validateChannelAgentAuthorizationGrant(
  value: unknown,
): ChannelValidationResult<
  ChannelAgentAuthorizationGrant,
  ChannelIdentityDiagnostic
> {
  const errors = new IdentityDiagnosticCollector();

  if (!isPlainObject(value)) {
    errors.push('grant: must be an object');
    return errors.failure();
  }
  if (value.schemaVersion !== CHANNEL_AGENT_AUTHORIZATION_SCHEMA_VERSION) {
    errors.pushCoded(
      'schema-version-unknown',
      `schemaVersion: unknown or absent (expected ${CHANNEL_AGENT_AUTHORIZATION_SCHEMA_VERSION}, got ${JSON.stringify(value.schemaVersion)})`,
    );
    return errors.failure();
  }

  requireNonEmptyString(value.authorizationId, 'authorizationId', errors);
  requireNonEmptyString(value.channelId, 'channelId', errors);
  requireNonEmptyString(value.ownerMemberId, 'ownerMemberId', errors);
  requireNonEmptyString(value.agentKeyId, 'agentKeyId', errors);
  requireNonEmptyString(value.issuedAt, 'issuedAt', errors);

  if (
    value.expiresAt !== null &&
    (typeof value.expiresAt !== 'string' || value.expiresAt.length === 0)
  ) {
    errors.push(
      'expiresAt: must be a non-empty string, or null to state "no expiry" explicitly',
    );
  }

  if (!Array.isArray(value.capabilities)) {
    errors.push(
      'capabilities: must be an array — an explicit allowlist, never an absent field meaning "everything"',
    );
  } else {
    if (value.capabilities.length === 0) {
      errors.push(
        'capabilities: must name at least one kind — an empty grant authorizes nothing and should not have been committed',
      );
    }
    value.capabilities.forEach((capability, index) => {
      if (!isChannelProposalKind(capability)) {
        errors.push(
          `capabilities[${index}]: ${JSON.stringify(capability)} is not a proposal kind`,
        );
        return;
      }
      if (capability === 'agent-authorization') {
        errors.pushCoded(
          'self-authorizing-capability',
          'capabilities: an agent may not be granted the power to author authorizations — a grant that can mint grants is self-authorizing, and revocation stops meaning anything',
        );
      }
    });
  }

  if (errors.length > 0) return errors.failure();
  return {
    ok: true,
    record: value as unknown as ChannelAgentAuthorizationGrant,
  };
}

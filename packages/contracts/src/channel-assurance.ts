/**
 * How much a channel record's authorship is worth,
 * **derived** and never stored (`docs/design/conversation-state.md` §2.3,
 * §3.5, §8.2).
 *
 * ## Why this module exists at all, and what it deliberately does not do
 *
 * Signing is **graded, not binary**:
 * single-Station surfaces ship honestly on digest chains plus a head anchor,
 * and the first channel with a second member is the hard line where real
 * signatures become a prerequisite. This module ships the record *shapes*
 * with the signing carriage already defined and **builds no
 * envelope, no key material, and no verifier**. Everything below is either a
 * shape or a total function over a shape.
 *
 * ## Consumed from the Hachure spec, not invented here
 *
 * `hachure-org/spec`'s `assurance.md` already owns this vocabulary, and the
 * one instruction that matters is that it defines a **derivation**, not a
 * label:
 *
 * > "All TrustBundles that do not carry a DSSE envelope are L0. This is the
 * > default; no annotation or flag is required."
 *
 * So `L0` / `L1` / `L2` are the spec's names, used verbatim
 * ({@link AssuranceLevel}), and there is **no `assuranceLevel` field on any
 * record here**. A producer cannot assert its own assurance; a reader
 * computes it with {@link deriveChannelRecordAssurance}. That asymmetry is
 * the entire point: a stored level is a claim the producer controls, and the
 * threat model here (§1.4 correction 2) is precisely a producer you cannot
 * take at its word.
 *
 * The spec's level boundary is a function of the *key*, not of the record:
 * L1 is an ephemeral key bound to an OIDC identity at signing time, L2 is a
 * long-lived key held in an org-controlled KMS/HSM. Only something holding
 * the certificate can say which, so that fact is an **input** to the
 * derivation ({@link ChannelAssuranceVerifier}), never a field on the record.
 *
 * ## The envelope is CARRIED ALONGSIDE the record, never embedded in it
 *
 * `assurance.md`'s "What gets signed" is explicit:
 *
 * > "Signing any of them does not change the record's schema; the DSSE
 * > envelope wraps the serialised record and is **carried alongside it, not
 * > embedded in it**."
 *
 * **This corrects the design doc.** §3.2's tables give the proposal, the
 * sequencing envelope, and the checkpoint each a `signature` field. An
 * embedded envelope is not just a spec divergence — it makes the signed
 * byte-string undefinable, because the record's own canonical form would
 * then have to contain its own signature. Two canonicalizations would
 * follow (one for the digest, one for what the signature covers), and
 * nothing would say which is which.
 *
 * {@link ChannelSignedRecord} is the carriage: `{ record, dsseEnvelope? }`.
 * The record's canonical bytes are exactly what a signer signs and
 * exactly what a digest covers — one byte-string, no ambiguity — and no
 * record type changes shape when signing arrives. Recorded as a finding
 * against the design doc rather than absorbed.
 *
 * ## Why an envelope present is not a level
 *
 * `assurance.md`'s consumer-policy section is explicit that "a signed record
 * with an unverifiable or expired certificate does not silently downgrade to
 * L0 — the verification failure is itself a transparency gap." A derivation
 * that read `envelope present -> L1` would report a level for a signature
 * nobody checked, which is the exact failure
 * `ReceiptChainStatus`'s three states exist to prevent
 * (`src-server/runtime/conversation/receipt-chain.ts:64`: "because 'we did
 * not check' must never render as 'it verified'").
 *
 * So {@link deriveChannelRecordAssurance} returns either a **level** or a
 * **named gap**, and where no verifier exists a carriage that
 * holds an envelope derives a gap. That is the honest answer, and it is
 * why this file can ship before the signing substrate does.
 *
 * ## Why the DSSE shape is declared structurally
 *
 * `@kontourai/surface` re-exports `DsseEnvelope`, `Signer`, `buildPaeBytes`,
 * `toDsseEnvelope`, and `parseDssePayload` from its `interop/in-toto`
 * module, and any signer MUST use those functions rather than hand-rolling
 * PAE encoding (surface's own `signing/sigstore.ts` header records what
 * double-PAE encoding cost the last time someone layered it themselves).
 *
 * What this *contracts* package must not do is take a dependency on a
 * sibling package's version, for the reason already recorded beside
 * `EmbeddedDispatchReceipt` in `fleet-routing-receipt.ts`: "a contracts
 * package that pins a sibling's version makes every consumer inherit that
 * pin" — and `@kontourai/station-contracts` is consumed by `src-ui`, where a
 * `node:crypto` import would not even build. {@link DsseEnvelopeShape} is
 * therefore the DSSE wire shape declared structurally, assignable to and
 * from surface's `DsseEnvelope`, with the DSSE protocol — not a sibling
 * release — as the thing that fixes it.
 * `__tests__/channel-dsse-surface-parity.test.ts` proves the two stay
 * mutually assignable and key-for-key identical, so a drift is a red test
 * rather than a later discovery.
 */

/**
 * The spec's three assurance levels, verbatim (`assurance.md`, "Assurance
 * levels"). Higher levels are a strict superset: an L2 record satisfies any
 * policy that accepts L1 or L0.
 *
 * These are *derived* values. Nothing in this arc persists one.
 */
export type AssuranceLevel = 'L0' | 'L1' | 'L2';

/**
 * A DSSE envelope (https://github.com/secure-systems-lab/dsse), declared
 * structurally so this package pins no sibling — see the module header.
 * Byte-for-byte the shape `@kontourai/surface`'s `interop/in-toto` module
 * produces.
 *
 * `payloadType` is widened to `string` relative to surface's literal
 * `'application/vnd.in-toto+json'` on purpose: a *reader* must be able to
 * hold an envelope whose payload type it does not accept and then refuse it
 * with a named reason, which a literal type would turn into an unparseable
 * value instead.
 */
export interface DsseEnvelopeShape {
  payloadType: string;
  /** Base64 of the serialised statement. */
  payload: string;
  signatures: readonly { keyid: string; sig: string }[];
}

/**
 * A record plus the envelope carried **alongside** it (see the module
 * header). Until the signing substrate lands nothing populates
 * `dsseEnvelope`; when one does, **no record type changes shape**.
 *
 * `record` keeps its own canonical form, so the bytes a signer signs, the
 * bytes a digest covers, and the bytes a reader validates are one thing.
 */
export interface ChannelSignedRecord<T> {
  record: T;
  dsseEnvelope?: DsseEnvelopeShape;
}

/**
 * Why a carriage has no derivable level. Every one of these is a *named gap*
 * in the delivery protocol's sense (`docs/strategy/multi-agent-delivery-protocol.md`
 * §6: "a missing fact renders as an explicit named gap") — never a silent
 * downgrade to L0.
 */
export type ChannelAssuranceGapCode =
  /** The value handed in is not a carriage at all. */
  | 'not-a-record'
  /** A `dsseEnvelope` key is present but is not a well-formed envelope. */
  | 'envelope-malformed'
  /**
   * A well-formed envelope is present and no verifier was supplied. The
   * honest answer for any signed record without a verifier, and the reason
   * this module can ship before the signing substrate.
   */
  | 'verification-unavailable'
  /** A verifier was supplied and rejected the envelope. */
  | 'verification-failed'
  /**
   * A verifier reported a key class this contract does not know. Refusing to
   * guess is the point: the alternative — a ternary whose default branch is the
   * *highest* level — is "a default that decides", deciding upward.
   */
  | 'unknown-key-class';

export type ChannelAssuranceOutcome =
  | {
      kind: 'level';
      level: AssuranceLevel;
      /**
       * Which key established the level, when one did. Present for L1/L2,
       * absent for L0 (nothing signed it).
       *
       * This is load-bearing rather than informational: without it, a caller
       * asking "was this certificate signed by THAT member key" can only
       * learn that *something* signed it — see
       * {@link resolveChannelCertification}, which refuses to say `certified`
       * unless the verifying key is the one it named.
       */
      verifiedKeyId?: string;
    }
  | { kind: 'gap'; code: ChannelAssuranceGapCode; message: string };

/**
 * The spec's L1/L2 boundary expressed as its actual input — an ephemeral
 * OIDC-bound key or a long-lived held key — so the level stays a derivation
 * over facts a certificate carries rather than a second enum somebody sets
 * by hand.
 */
export type ChannelSigningKeyClass = 'ephemeral-oidc' | 'held';

export type ChannelEnvelopeVerification =
  | {
      verified: true;
      keyClass: ChannelSigningKeyClass;
      /**
       * The key that actually produced the signature the verifier checked.
       * **Not** read from the envelope's self-declared `signatures[].keyid`,
       * which is unverified metadata anyone can write.
       */
      keyId: string;
    }
  | { verified: false; reason: string };

/**
 * Injected by the signing substrate. This module defines the seam and
 * supplies no
 * implementation; there is deliberately no default verifier, because a
 * default here would be a verifier nobody chose.
 */
export interface ChannelAssuranceVerifier {
  verify(envelope: DsseEnvelopeShape): ChannelEnvelopeVerification;
}

/**
 * A plain, JSON-shaped object: not an array, not `null`, and carrying either
 * `Object.prototype` or no prototype at all.
 *
 * The prototype check is not decoration. Every validator in this family
 * reads fields with ordinary property access, which walks the prototype
 * chain, while every digest reads *own* keys — so an object whose fields
 * live only on its prototype would validate and digest as `{}`. `JSON.parse`
 * never produces one, which is exactly why an object that has one did not
 * come from the wire.
 */
export function isPlainJsonObject(
  value: unknown,
): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

/**
 * Structural check only — this says nothing about whether the signature is
 * good, and callers must not read a `true` as any kind of assurance.
 */
export function isDsseEnvelopeShape(
  value: unknown,
): value is DsseEnvelopeShape {
  if (!isPlainJsonObject(value)) return false;
  if (typeof value.payloadType !== 'string' || value.payloadType.length === 0) {
    return false;
  }
  if (typeof value.payload !== 'string' || value.payload.length === 0) {
    return false;
  }
  if (!Array.isArray(value.signatures) || value.signatures.length === 0) {
    return false;
  }
  return value.signatures.every(
    (entry) =>
      isPlainJsonObject(entry) &&
      typeof entry.keyid === 'string' &&
      entry.keyid.length > 0 &&
      typeof entry.sig === 'string' &&
      entry.sig.length > 0,
  );
}

/**
 * Derive a carriage's assurance level, or name the gap that stops it being
 * derivable. Total, never throws, and reads **only** the `dsseEnvelope`
 * slot: anything the wrapped record happens to carry — including a property
 * literally named `assuranceLevel` — is ignored, because a producer does not
 * get to assert this about itself.
 *
 * @param carriage A {@link ChannelSignedRecord}. Non-objects are a named gap,
 *                 not a crash and not an L0.
 * @param verifier Supplied when a verifier exists. Absent, a signed carriage
 *                 derives `verification-unavailable` rather than a level.
 */
export function deriveChannelRecordAssurance(
  carriage: unknown,
  verifier?: ChannelAssuranceVerifier,
): ChannelAssuranceOutcome {
  if (!isPlainJsonObject(carriage)) {
    return {
      kind: 'gap',
      code: 'not-a-record',
      message: 'assurance: value is not a signed-record carriage',
    };
  }

  // Spec `assurance.md`: absence of a DSSE envelope IS L0, and requires no
  // annotation. This is the only branch that returns a level without a
  // verifier.
  if (carriage.dsseEnvelope === undefined) {
    return { kind: 'level', level: 'L0' };
  }

  if (!isDsseEnvelopeShape(carriage.dsseEnvelope)) {
    return {
      kind: 'gap',
      code: 'envelope-malformed',
      message:
        'assurance: dsseEnvelope is present but is not a well-formed DSSE envelope',
    };
  }

  if (!verifier) {
    return {
      kind: 'gap',
      code: 'verification-unavailable',
      message:
        'assurance: a DSSE envelope is present and no verifier was supplied — unchecked is not L0 and not signed',
    };
  }

  const verification = verifier.verify(carriage.dsseEnvelope);
  if (!verification.verified) {
    return {
      kind: 'gap',
      code: 'verification-failed',
      message: `assurance: DSSE envelope verification failed (${verification.reason})`,
    };
  }

  if (
    typeof verification.keyId !== 'string' ||
    verification.keyId.length === 0
  ) {
    return {
      kind: 'gap',
      code: 'verification-failed',
      message:
        'assurance: verifier reported success without naming the key that signed — an unattributed signature establishes nothing',
    };
  }

  // Exhaustive, deliberately not a ternary. An unrecognised key class is a
  // gap, never the highest level.
  switch (verification.keyClass) {
    case 'ephemeral-oidc':
      return {
        kind: 'level',
        level: 'L1',
        verifiedKeyId: verification.keyId,
      };
    case 'held':
      return { kind: 'level', level: 'L2', verifiedKeyId: verification.keyId };
    default:
      return {
        kind: 'gap',
        code: 'unknown-key-class',
        message: `assurance: verifier reported key class ${JSON.stringify(verification.keyClass)}, which this contract cannot map to an assurance level`,
      };
  }
}

/** Level ordering, for policy comparisons (`assurance.md`, "strict superset"). */
const ASSURANCE_LEVEL_ORDER: Readonly<Record<AssuranceLevel, number>> =
  Object.freeze({ L0: 0, L1: 1, L2: 2 });

function isAssuranceLevel(value: unknown): value is AssuranceLevel {
  return value === 'L0' || value === 'L1' || value === 'L2';
}

/**
 * Fail-closed policy check, in **both** arguments. A record with a *gap*
 * never satisfies any requirement — "we could not check" must not read as
 * "it is at least the floor" — and an unrecognised `required` satisfies
 * nothing either, because a requirement this contract cannot read is a
 * requirement it cannot claim to have met.
 */
export function assuranceSatisfies(
  outcome: ChannelAssuranceOutcome,
  required: AssuranceLevel,
): boolean {
  if (outcome.kind !== 'level') return false;
  // Belt-and-braces, and knowingly so: `ASSURANCE_LEVEL_ORDER[required]` is
  // already `undefined` for any unrecognised value and `n >= undefined` is
  // `false`, so removing this line changes no behaviour today — it is a
  // DECLARED NEGATIVE CONTROL (verified inert) rather than an
  // unproven guard. It stays because that fail-closed property is currently
  // emergent from NaN-comparison semantics rather than stated, and the
  // sibling `durabilitySatisfies` used `indexOf` (which returns `-1`, and
  // `n >= -1` is TRUE) and was genuinely fail-open. This line is what stops
  // a refactor reintroducing that bug here silently.
  if (!isAssuranceLevel(required)) return false;
  return (
    ASSURANCE_LEVEL_ORDER[outcome.level] >= ASSURANCE_LEVEL_ORDER[required]
  );
}

/**
 * The Station-owned routing-receipt envelope
 * (`docs/design/inference-fleet.md` §3.4, §4.5, §6.3, §10 OQ-3/OQ-4/OQ-8,
 * §11).
 *
 * **Why an envelope at all.** `DispatchReceipt` (`@kontourai/dispatch`) is
 * the authority on what was attempted and what it cost, and this envelope
 * embeds it verbatim so its `planDigest`/`requestDigest` stay checkable. But
 * §3.4 records two gaps that are boundary consequences rather than Dispatch
 * bugs, and neither closes at any Dispatch version:
 *
 * 1. **No `environmentId`, and no place for one.** `candidateId`/`runtimeId`
 *    are plan-local strings; fleet attribution needs the machine.
 * 2. **No exclusions channel.** `attempts[]` records only candidates that
 *    were *launched*, so "why not that machine" is unanswerable from a
 *    Dispatch receipt alone. Until Datum's
 *    `CapabilityRoleResult.exclusions` is composed in, Station carries its
 *    own — hence
 *    {@link FleetRoutingExclusion.source}, which says which producer an
 *    exclusion came from rather than letting the two blur.
 *
 * **The honesty constraint this file exists to enforce.** A remote Station's
 * capability claim is *peer-attested*: it is that Station's own manifest
 * assertion, relayed. Nothing here probes it. So {@link FleetCandidateEvidence}
 * carries `provenance` alongside `level`, every peer-attested record keeps
 * the peer's raw claim in {@link PeerAttestedClaim} separate from the level
 * routing actually used, and {@link FLEET_PEER_ATTESTED_EVIDENCE_LABEL} is
 * the one sentence every surface renders. A surface that prints a
 * peer-attested candidate the same way it prints a locally-observed one has
 * put a lie in the artifact this feature exists to sell (§8).
 *
 * **Receipted, never signed (§10 OQ-3).** No cryptographic signing exists
 * anywhere in the building-block layer, so v1 extends the same SHA-256
 * digest discipline: {@link FleetRoutingReceiptEnvelope.receiptId} is the
 * content digest of the envelope, {@link
 * FleetRoutingReceiptEnvelope.previousReceiptId} chains it to the previous
 * record, and {@link FleetRoutingReceiptEnvelope.signature} is reserved and
 * always `null`. External wording is "receipted", never "signed".
 *
 * **Local-only (§10 OQ-4).** These envelopes are written by the DECIDING
 * Station and never replicated to a peer (replication is deferred to
 * archive#741). Nothing here crosses the machine boundary, which is
 * also why it may carry a peer's `environmentId` and label without the
 * disclosure analysis §5.2 applies to the wire contracts.
 *
 * **Prompts never appear here.** Dispatch's own receipt discipline is
 * digests over canonicalized, secret-free plan/request objects; this
 * envelope adds no message content, no system prompt, and no completion
 * text. The absence is the contract — adding a content field is a visible
 * contract change, not an additive convenience.
 */

/**
 * The verbatim `DispatchReceipt` this envelope embeds, declared structurally
 * so `@kontourai/station-contracts` does not take a dependency on
 * `@kontourai/dispatch` (a contracts package that pins a sibling's version
 * makes every consumer inherit that pin).
 *
 * Structural, not a copy: the stored value IS the receipt object Dispatch
 * handed us, serialized as-is. A future Dispatch version that adds fields
 * still round-trips through this type — the extra fields ride along in the
 * JSON, and the digests stay checkable, which is the whole point of
 * embedding rather than projecting.
 */
export interface EmbeddedDispatchAttempt {
  candidateId: string;
  runtimeId: string;
  outcome: string;
  elapsedMs: number;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  estimatedCostUsd?: number;
  errorCode?: string;
  retryable?: boolean;
}

export interface EmbeddedDispatchReceipt {
  schemaVersion: number;
  planDigest: string;
  requestDigest: string;
  role: string;
  outcome: string;
  attempts: readonly EmbeddedDispatchAttempt[];
  totalElapsedMs: number;
  totalTokens: number;
  estimatedCostUsd: number;
}

export const FLEET_ROUTING_RECEIPT_SCHEMA_VERSION =
  'station.fleet-routing-receipt/v1' as const;

/**
 * Canonical JSON projection: object keys sorted at every depth.
 *
 * Lives on the CONTRACT rather than beside one writer because every digest in
 * this feature has to agree on it — the receipt's own `receiptId`, the serve
 * receipt's, the peer-claim digest inside {@link PeerAttestedClaim}, and any
 * later reader recomputing them. `JSON.stringify` alone is key-order
 * dependent, so two structurally identical claims serialized by different
 * code paths hash differently and read as "the peer changed its claim" when
 * nothing changed.
 *
 * **`__proto__` is copied as an own property, not assigned.**
 * `result[key] = ...` looks like a copy and is not:
 * for `key === '__proto__'` it hits `Object.prototype`'s accessor, which
 * *reassigns the result's prototype* instead of creating a property. The key
 * then vanishes from `JSON.stringify`, so two records differing only in a
 * `__proto__` member canonicalize to the same bytes and therefore to the same
 * digest — and the canonical object silently acquires an attacker-supplied
 * prototype.
 *
 * That is survivable where every input is machine-generated (a Dispatch
 * receipt has no attacker-controlled key names), and it is not survivable for
 * `station.channel-proposal/v1`, whose whole purpose is to carry a digest over
 * a record a hostile party authored. `Object.defineProperty` creates a real
 * own data property for every key including that one, so the digest sees what
 * the document actually contains. No existing record changes digest: the only
 * inputs whose bytes move are the ones that were being silently mangled.
 */
export function canonicalizeForDigest(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeForDigest);
  if (value && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      Object.defineProperty(result, key, {
        value: canonicalizeForDigest(source[key]),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return result;
  }
  return value;
}

/** Where a candidate's compute lives. */
export type FleetCandidateOrigin =
  /** A model connection on THIS Station. */
  | 'local'
  /** A model a paired Station contributed to the fleet. */
  | 'fleet';

/**
 * How the evidence behind a candidate's grade was obtained. This is the
 * distinction §3.4 requires the envelope to make and §8 warns the receipt
 * must not lose.
 */
export type FleetEvidenceProvenance =
  /**
   * THIS Station observed it, through the four-level connection-readiness
   * ladder (`connection-readiness-evidence.ts`) wired into
   * Dispatch grading. `confirmed` here means a real bounded chat turn
   * completed on this machine.
   */
  | 'local-observation'
  /**
   * The peer said so. Its `station.fleet-contribution/v1` manifest asserted
   * the model's availability and freshness; this Station relayed the claim
   * and never verified it. Slice 5's `consumer-verified` smoke is the first
   * thing that will be able to raise this — until then a peer-attested
   * candidate can never grade above `declared`, whatever the peer claims
   * (see {@link FleetCandidateEvidence.level}).
   */
  | 'peer-attested'
  /**
   * THIS Station ran a bounded one-turn completion against the peer THROUGH
   * THE FLEET PATH IT WILL ACTUALLY USE, and it completed (§4.3's
   * `consumer-verified`). This is the only fleet provenance that is
   * a first-hand observation rather than a relayed claim, and it is the only
   * one that proves the PATH rather than the peer: a model that works
   * locally on B but is unreachable through B's inference route is exactly
   * the failure a manifest cannot catch.
   *
   * It does NOT close the attestation gap. It says "this worked from here,
   * at this time", not "this peer is who it says it is" — that needs
   * archive#1392 and a signing story that does not exist (§4.3, §10 OQ-3).
   */
  | 'probe-verified';

/**
 * The one sentence every surface renders for a peer-attested candidate.
 * Declared here rather than written per-surface so the CLI and the web UI
 * cannot drift into two different honesty claims, and so a test can pin the
 * exact words that must appear.
 */
export const FLEET_PEER_ATTESTED_EVIDENCE_LABEL =
  'attested by peer, not verified' as const;

/** The mirror sentence for a candidate this Station observed itself. */
export const FLEET_LOCAL_EVIDENCE_LABEL = 'observed locally' as const;

/**
 * The sentence for a peer candidate this Station probed itself.
 *
 * Deliberately narrower than {@link FLEET_LOCAL_EVIDENCE_LABEL}: what was
 * observed is a completion over the fleet path, not the peer machine. A
 * reader must be able to tell a probed peer from a local model at a glance,
 * because they are not the same kind of thing however good the probe was.
 */
export const FLEET_PROBE_VERIFIED_EVIDENCE_LABEL =
  'verified from here by a bounded completion' as const;

/**
 * The three-state verdict of one consumer-run probe. `stale` is a state, not
 * an absence: a probe that has aged out is a claim about the past, and §4.3
 * is explicit that presenting one as a fact about now is the defect.
 */
export type ConsumerProbeStatus = 'passed' | 'failed' | 'stale';

/**
 * One bounded completion this Station ran against a peer.
 *
 * **Nothing from the completion is here.** The probe sends a fixed, content-
 * free prompt and records that a turn completed, how long it took, and which
 * model identity the peer echoed back — never the generated text, never a
 * digest of it. A probe record is evidence that the path works, and a path
 * that works is not a reason to start storing model output.
 */
export interface ConsumerProbeObservation {
  status: ConsumerProbeStatus;
  /** When THIS Station ran the probe. */
  observedAt: string;
  /**
   * When this observation stops being evidence about now. Mandatory, not
   * decorative (§4.3): past this instant the candidate falls back to its
   * peer-attested grade rather than continuing to claim a verification.
   */
  expiresAt: string;
  /** Wall-clock duration of the probe completion; `null` when it failed. */
  elapsedMs: number | null;
  /**
   * The `FleetInferenceServedModel.providerModel` the peer echoed. Proves
   * the peer served the model the manifest named rather than substituting
   * one — a substitution the completion text could not reveal.
   */
  servedProviderModel: string | null;
  /**
   * The peer's own `FleetInferenceRefusalCode`, or a transport failure name,
   * when `status === 'failed'`. `null` on a pass.
   */
  failureCode: string | null;
}

/**
 * Dispatch's three-level evidence ladder, mirrored rather than imported for
 * the same reason {@link EmbeddedDispatchReceipt} is structural.
 */
export type FleetEvidenceLevel = 'unavailable' | 'declared' | 'confirmed';

/**
 * The peer's raw claim, kept beside — never folded into — the level routing
 * used. Folding them is how "the peer says this model is available and its
 * catalog observation is fresh" silently becomes "we confirmed it".
 */
export interface PeerAttestedClaim {
  /** `FleetContributedModel.availability`, verbatim. */
  availability: string;
  /** `FleetContributedModel.freshness`, verbatim. */
  freshness: string;
  /** `FleetContributedModel.observedAt` — when the PEER observed it. */
  observedAt: string | null;
  /** The peer manifest's own `sourceObservedAt` (its oldest observation). */
  manifestSourceObservedAt: string | null;
  /** When THIS Station fetched the manifest carrying the claim. */
  fetchedAt: string;
  /**
   * SHA-256 over the canonicalized peer manifest record this claim came
   * from. Content-addressed, not signed (§10 OQ-3) — it detects a changed
   * claim, it does not attest to who made it.
   */
  digest: string;
}

export interface FleetCandidateEvidence {
  /**
   * The level ROUTING USED. For `peer-attested` provenance this is capped at
   * `declared` by {@link capFleetEvidenceLevel} no matter how healthy the
   * peer's own claim is: `confirmed` in this codebase means a bounded
   * completion was observed, and a relayed claim observes nothing on the peer.
   */
  level: FleetEvidenceLevel;
  provenance: FleetEvidenceProvenance;
  /**
   * {@link FLEET_PEER_ATTESTED_EVIDENCE_LABEL} or
   * {@link FLEET_LOCAL_EVIDENCE_LABEL}. Carried on the record rather than
   * derived at render time so every surface — and every later reader of a
   * stored receipt — says the same thing.
   */
  label: string;
  /**
   * Present for `peer-attested` AND `probe-verified` provenance; `null` for
   * local. A probe does not replace the peer's claim, it sits beside it —
   * losing the claim would make "we verified a machine that says nothing"
   * indistinguishable from "we verified a machine that says the same thing".
   */
  peerAttested: PeerAttestedClaim | null;
  /**
   * This Station's own probe observation, or `null` when none has
   * been taken. Carried even when the observation is `stale` or `failed`:
   * "we last probed this and it failed" is information an operator needs,
   * and dropping it would make a never-probed candidate look identical to a
   * recently-failed one — the silent-degradation class §4.5 bans.
   */
  probe: ConsumerProbeObservation | null;
}

/**
 * Caps a peer's attested claim at `declared` (§4.4 read honestly). Exported
 * because it is a rule, not an implementation detail: a later change that
 * wants a peer candidate to reach `confirmed` must delete this function and
 * be seen doing it.
 */
export function capFleetEvidenceLevel(
  level: FleetEvidenceLevel,
  provenance: FleetEvidenceProvenance,
): FleetEvidenceLevel {
  if (provenance !== 'peer-attested') return level;
  return level === 'confirmed' ? 'declared' : level;
}

/**
 * The level a candidate routes at once the consumer probe is taken
 * into account.
 *
 * **The cap is not deleted, and that is the point.** Raising a peer
 * above `declared` means "deleting that function in daylight"; what a
 * probe actually earns is narrower than that. `capFleetEvidenceLevel`
 * still binds every UNVERIFIED claim exactly as before — a peer that merely
 * asserts `available`/`live` is still capped at `declared`, forever. What a
 * fresh, passing probe changes is the PROVENANCE: the claim is no longer
 * unverified, because this Station observed a bounded completion over the
 * path it will use, which is the same standard `smoke-passed` meets locally.
 *
 * So the rule is: `confirmed` requires an observation, and this function is
 * the only place an observation can produce one. A caller cannot reach
 * `confirmed` by passing `provenance: 'probe-verified'` alone — it must
 * supply a probe that actually passed and has not expired.
 */
export function fleetEvidenceLevelWithProbe(
  attestedLevel: FleetEvidenceLevel,
  probe: ConsumerProbeObservation | null,
  /**
   * Evaluation instant, defaulting to now. Injectable because the honest
   * answer depends on WHEN the question is asked, and a receipt replayed
   * later must be able to ask it as of the replay.
   */
  now: number = Date.now(),
): {
  level: FleetEvidenceLevel;
  provenance: FleetEvidenceProvenance;
  label: string;
} {
  // Expiry is enforced HERE, not just by the live caller. The docblock
  // above states the rule as "passed AND
  // not expired", but `FleetProbeService.observe` also
  // stamps `status: 'stale'` on its way out. That is an invariant
  // maintained somewhere else, and this function is exported from a CONTRACTS
  // package whose values are stored verbatim in the routing receipt and read
  // back by two surfaces, the SDK, and any later replay path. A caller that
  // hands back a stored `ConsumerProbeObservation` — receipt replay, a
  // cross-process cache, a later admission policy — would otherwise be handed
  // `confirmed` from a pass that expired months ago, and the docblock would
  // have told them that could not happen.
  const unexpired = probe !== null && Date.parse(probe.expiresAt) > now;
  if (probe?.status === 'passed' && unexpired) {
    return {
      level: 'confirmed',
      provenance: 'probe-verified',
      label: FLEET_PROBE_VERIFIED_EVIDENCE_LABEL,
    };
  }
  // Everything else — no probe, a failed probe, an expired one, or a
  // `passed` record whose own `expiresAt` has gone by — routes on the peer's
  // own claim under the unchanged cap. A failed probe ALSO produces a
  // `probe-failed` exclusion and is withheld from the router; the grade below
  // is what the receipt records about it, not a routing decision.
  return {
    level: capFleetEvidenceLevel(attestedLevel, 'peer-attested'),
    provenance: 'peer-attested',
    label: FLEET_PEER_ATTESTED_EVIDENCE_LABEL,
  };
}

/**
 * The one clause every surface appends for a candidate carrying a probe
 * observation, or `null` when there is nothing to say.
 *
 * On the contract for exactly the reason
 * {@link FLEET_PEER_ATTESTED_EVIDENCE_LABEL} is: two
 * surfaces writing their own honesty wording is two places for it to drift.
 * The stale case is the one that would drift first and matter most — a
 * surface that rendered an expired probe without saying it had expired would
 * be presenting a claim about the past as a fact about now, which is the
 * precise defect §4.3 names.
 */
export function describeConsumerProbe(
  probe: ConsumerProbeObservation | null,
): string | null {
  if (!probe) return null;
  switch (probe.status) {
    case 'passed':
      return `probed from here ${probe.observedAt}, valid until ${probe.expiresAt}`;
    case 'failed':
      return `probe FAILED from here ${probe.observedAt} (${probe.failureCode ?? 'unknown'})`;
    case 'stale':
      return `last probed from here ${probe.observedAt}; that observation expired ${probe.expiresAt} and is not evidence about now`;
  }
}

/** One candidate the router considered, admitted or not. */
export interface FleetRoutingCandidate {
  /** Joins `EmbeddedDispatchAttempt.candidateId` — the plan-local id. */
  candidateId: string;
  runtimeId: string;
  origin: FleetCandidateOrigin;
  /**
   * The environment the compute belongs to. `null` for a local candidate:
   * §3.4 makes `environmentId` the join key, and a local candidate's own
   * environment id would add a value nobody routes on while inviting the
   * reading that local and fleet candidates are the same kind of thing.
   */
  environmentId: string | null;
  /**
   * The environment's display label AT DECISION TIME. Labels change; the id
   * is the join key (`known-environment.ts`). Stored so a receipt read six
   * months later still renders the name the operator saw.
   */
  environmentLabel: string | null;
  /** The contributed model's manifest id, or the local model id. */
  modelId: string | null;
  evidence: FleetCandidateEvidence;
  /** True when the candidate entered Dispatch's routable set. */
  admitted: boolean;
}

/**
 * Why a capability did NOT route. The first seven codes are §4.5's
 * consumer-side vocabulary verbatim; the rest are Station-side facts §4.5's
 * list does not cover and that would otherwise be silent omissions.
 *
 * Closed on purpose: §4.5 bans dropping an unverified capability from a
 * surface without a diagnostic, so every path that removes a candidate must
 * name itself with a code here, and adding a code is a visible decision.
 */
export type FleetRoutingExclusionCode =
  /** §4.5 — the environment is not answering. */
  | 'peer-unreachable'
  /** §4.5 — reachable, but our credential lacks `inference:invoke`. */
  | 'peer-scope-denied'
  /** §4.5 — the peer's last observation is past its freshness window. */
  | 'evidence-stale'
  /** §4.5 — a verification attempt ran and failed (only emittable once a probe has run). */
  | 'probe-failed'
  /** §4.5 — the peer previously contributed this and no longer does. */
  | 'capability-withdrawn'
  /** §4.5 — a hosted/remote contribution whose reference does not resolve ON THE PEER. */
  | 'reference-unresolvable'
  /** §4.5 — present and healthy, but below the policy's `minimumEvidence`. */
  | 'below-minimum-evidence'
  /**
   * The peer is reachable and authorized but is not offering this — its
   * manifest `participation` is `disabled`, `nothing-contributed`, or
   * `contributed-unavailable`. Distinct from `capability-withdrawn`, which
   * is about a specific model this Station had already admitted.
   */
  | 'not-contributed'
  /**
   * The peer's handshake does not advertise `fleetInference`, so it does not
   * understand the `inference:invoke` token (§3.3 point 2). Routing to it
   * would mint a request its route table cannot authorize.
   */
  | 'peer-protocol-unsupported'
  /**
   * The peer answered, but could not say what it contributes (its own
   * `contribution-unavailable`). Unknown, not empty — a consumer must retry
   * rather than forget this peer.
   */
  | 'peer-contribution-unavailable'
  /**
   * The peer contributed this model AFTER the candidate set for this agent's
   * Dispatch model was resolved. Dispatch's runtime registry is fixed at
   * model construction, so a newly-offered model becomes routable on the
   * next agent rebuild. Named rather than omitted: "your new contribution is
   * invisible" and "your new contribution was rejected" are different
   * sentences, and only one of them is true.
   */
  | 'not-in-resolved-set'
  /**
   * This Station could not complete a fleet resolution at all — the peer
   * consultation itself threw, or the re-grade pass failed — so what the
   * fleet currently offers is UNKNOWN.
   *
   * It is not `peer-unreachable`: that names a specific peer that did not
   * answer, and this names a failure on THIS side that says nothing about
   * any peer. Without this code the failure path would silently drop
   * every fleet candidate with no diagnostic at all — §4.5's first banned
   * behavior. The
   * exhaustiveness map below is what forces it to be a decision.
   */
  | 'resolution-failed';

/**
 * Where each code in the vocabulary came from — and, structurally, the
 * exhaustiveness tripwire.
 *
 * Modelled on `FLEET_INFERENCE_REFUSAL_STATUS`: a runtime `Record`
 * keyed by the union type, so adding a member to
 * {@link FleetRoutingExclusionCode} stops this file typechecking until
 * somebody decides what the new code IS. That matters more here than for a
 * status map, because the whole §4.5 contract is "every path that removes a
 * capability names itself with a code" — a vocabulary that can grow without
 * a decision is a vocabulary a future edit can quietly route around.
 *
 * `design` = §4.5's consumer-side vocabulary, verbatim. `station` = a fact
 * about this implementation that §4.5's list does not cover and that would
 * otherwise be a silent omission. Surfaces do not branch on this; it exists
 * so the provenance of each code survives contact with the next reader.
 */
export type FleetExclusionCodeOrigin = 'design' | 'station';

export const FLEET_ROUTING_EXCLUSION_CODES: Readonly<
  Record<FleetRoutingExclusionCode, FleetExclusionCodeOrigin>
> = {
  'peer-unreachable': 'design',
  'peer-scope-denied': 'design',
  'evidence-stale': 'design',
  'probe-failed': 'design',
  'capability-withdrawn': 'design',
  'reference-unresolvable': 'design',
  'below-minimum-evidence': 'design',
  'not-contributed': 'station',
  'peer-protocol-unsupported': 'station',
  'peer-contribution-unavailable': 'station',
  'not-in-resolved-set': 'station',
  'resolution-failed': 'station',
};

/** Which producer decided an exclusion (§3.4 — `datum` is reserved for a future Datum integration). */
export type FleetExclusionSource = 'station' | 'datum';

export interface FleetRoutingExclusion {
  /** The plan-local candidate id when one exists; `null` for a peer never admitted. */
  candidateId: string | null;
  environmentId: string | null;
  environmentLabel: string | null;
  modelId: string | null;
  code: FleetRoutingExclusionCode;
  /** One sentence, safe to render verbatim; never an upstream error string. */
  message: string;
  source: FleetExclusionSource;
}

/**
 * §6.3's general constraint channel. Built now, deliberately empty in v1:
 * fleet inference moves token generation only, so a binding constraint is
 * usually irrelevant to it — but building the channel here stops archive#1425
 * and archive#1123 from each inventing their own, and claiming binding-aware
 * inference routing as a v1 feature would be overselling it.
 */
export interface FleetRoutingConstraint {
  kind: string;
  value: string;
  /** Whether the constraint actually removed anything from the considered set. */
  applied: boolean;
}

/**
 * Whether the routed path could stream (§2.7). Recorded because "the UI must
 * not silently switch a streaming conversation to a non-streaming one" is a
 * design requirement, and a receipt that cannot answer it cannot enforce it.
 */
export interface FleetRoutingStreamCapability {
  capable: boolean;
  /** Why. Rendered verbatim; the reason is the product here, not the boolean. */
  reason: string;
}

/**
 * A routing failure as a NAMED state (§4.5's second banned behavior). A
 * fleet turn that did not run on the fleet must say so; the banned shape is
 * a silent fall back to a local or hosted candidate with nothing in the
 * receipt.
 */
export type FleetRoutingFailureCode =
  /**
   * Every candidate was excluded — nothing was eligible to try.
   *
   * Load-bearing invariant (archive#1556): this code asserts that an
   * EXCLUSION happened, and §4.5 requires every exclusion to be named. It is
   * therefore only emittable alongside a non-empty `exclusions` list. A
   * receipt that claims exclusion while listing none sends an operator to
   * inspect eligibility rules that were never involved, which is the exact
   * defect this code exists to prevent — see
   * {@link FLEET_ROUTING_FAILURE_CODES}.
   */
  | 'no-eligible-candidates'
  /** Dispatch tried fleet candidates and every attempt failed. */
  | 'fleet-attempts-failed'
  /**
   * Candidates WERE attempted and none produced a completion. Dispatch's
   * `exhausted` outcome on a local-only plan lands here: the candidate cleared
   * this agent's routing policy, was dispatched, and the model failed. That is
   * the opposite fact from `no-eligible-candidates`, and conflating the two
   * is the defect archive#1556 fixed.
   *
   * It does NOT assert that no fleet candidate was attempted. The distinction
   * from `fleet-attempts-failed` is drawn against the DECIDING Station's
   * replica of the candidate list, which is designed to be able to diverge
   * from Dispatch's own set (`docs/design/inference-fleet.md`, the L-3
   * tripwire). An attempt on a candidate the replica does not carry would make
   * that negative false, so neither this code nor its message states it.
   */
  | 'attempts-failed'
  /**
   * Routing ended without a completion, nothing was attempted, and no
   * exclusion was recorded to say why.
   *
   * This is a receipt that cannot explain itself, and saying so is the only
   * honest answer available: the alternatives are claiming an exclusion that
   * was never recorded, or claiming an attempt that never happened. Reachable
   * when Dispatch's own eligibility predicate and this Station's replica of it
   * disagree (`docs/design/inference-fleet.md`, the L-3 divergence tripwire).
   */
  | 'unexplained-no-attempt'
  /** Dispatch's budget stopped the run. */
  | 'budget-exceeded'
  /** The run was aborted. */
  | 'aborted'
  /**
   * The turn succeeded, but on a LOCAL candidate after a fleet candidate was
   * attempted and failed. This is the secondary dispatch §4.5 forbids doing silently;
   * naming it is what makes it permissible.
   */
  | 'fell-back-to-local';

export interface FleetRoutingFailure {
  code: FleetRoutingFailureCode;
  message: string;
}

/**
 * What each failure code ASSERTS about the turn, as data rather than as
 * prose a reader has to infer from the message (archive#1556).
 *
 * The `Record<FleetRoutingFailureCode, …>` is the closed-set tripwire, the
 * same device {@link FLEET_ROUTING_EXCLUSION_CODES} uses: adding a union
 * member stops this file typechecking until somebody classifies it, so a new
 * code cannot arrive without a decision about what it claims.
 *
 * `claimsExclusion` is the one a consumer can check: a code with it set says
 * the routing policy removed something, which §4.5 requires to appear as a
 * named exclusion. `deriveFleetRoutingFailure` never emits such a code with
 * an empty exclusion list, and `fleet-routing-envelope.test.ts` asserts that
 * invariant directly over the builder.
 *
 * `attemptsMade` says a candidate was actually dispatched — the fact an
 * operator needs to decide whether to look at eligibility rules or at the
 * model, rather than being told "no" for a turn whose local model had
 * been dispatched and had failed.
 */
export interface FleetRoutingFailureCodeSemantics {
  /** The code asserts a candidate was removed by policy before any attempt. */
  claimsExclusion: boolean;
  /** The code asserts at least one candidate was dispatched. */
  attemptsMade: boolean;
}

export const FLEET_ROUTING_FAILURE_CODES: Readonly<
  Record<FleetRoutingFailureCode, FleetRoutingFailureCodeSemantics>
> = {
  'no-eligible-candidates': { claimsExclusion: true, attemptsMade: false },
  'fleet-attempts-failed': { claimsExclusion: false, attemptsMade: true },
  'attempts-failed': { claimsExclusion: false, attemptsMade: true },
  'unexplained-no-attempt': { claimsExclusion: false, attemptsMade: false },
  'budget-exceeded': { claimsExclusion: false, attemptsMade: false },
  aborted: { claimsExclusion: false, attemptsMade: false },
  'fell-back-to-local': { claimsExclusion: false, attemptsMade: true },
};

/** Where the turn actually ran. `null` when nothing ran. */
export interface FleetRoutingSelection {
  candidateId: string;
  origin: FleetCandidateOrigin;
  environmentId: string | null;
  environmentLabel: string | null;
  modelId: string | null;
  evidence: FleetCandidateEvidence;
}

export interface FleetRoutingReceiptEnvelope {
  schemaVersion: typeof FLEET_ROUTING_RECEIPT_SCHEMA_VERSION;
  /**
   * SHA-256 over the canonicalized envelope with `receiptId` itself removed.
   * Content-addressed: two identical decisions produce the same id, and any
   * edit to a stored record breaks it. Not a signature (§10 OQ-3).
   */
  receiptId: string;
  /**
   * The previous envelope's `receiptId` in this Station's log, or `null` for
   * the first record. This is the hash chain: it makes a DELETED record
   * detectable, which a per-record digest alone cannot do.
   */
  previousReceiptId: string | null;
  recordedAt: string;
  /** The DECIDING Station's environment id — whose log this is. */
  environmentId: string;
  /** The agent whose turn this was. Never the prompt, never the content. */
  agentName: string;
  /** The verbatim `DispatchReceipt`, embedded unchanged (§3.4). */
  dispatch: EmbeddedDispatchReceipt;
  candidates: FleetRoutingCandidate[];
  exclusions: FleetRoutingExclusion[];
  constraints: FleetRoutingConstraint[];
  stream: FleetRoutingStreamCapability;
  selection: FleetRoutingSelection | null;
  /** `null` only when the turn ran on a fleet candidate as intended. */
  failure: FleetRoutingFailure | null;
  /**
   * v1 is scoped to non-interactive work (§10 OQ-8). Recorded on every
   * envelope so a later interactive mode is a visible change in the data,
   * not an unremarked widening.
   */
  interactivity: 'non-interactive';
  /**
   * Reserved for a real signature (§10 OQ-3). Always `null` in v1 — the
   * field exists so adding signing later is additive, and so a reader can
   * see that nothing here is signed rather than having to infer it.
   */
  signature: null;
}

/**
 * The bounded read shape the receipt surfaces consume
 * (`GET /monitoring/fleet-routing-receipts`).
 *
 * `chainIntact` is not decoration. A log whose chain does not verify is a
 * log that has been edited or truncated, and a surface that renders its rows
 * without saying so is presenting tampered provenance as provenance. Three
 * states, because "we did not check" must never render as "it verified".
 */
export type FleetReceiptChainStatus = 'intact' | 'broken' | 'unknown';

export interface FleetRoutingReceiptPage {
  schemaVersion: typeof FLEET_ROUTING_RECEIPT_SCHEMA_VERSION;
  /** Newest first. */
  receipts: FleetRoutingReceiptEnvelope[];
  /** How many records the log holds in total, when countable. */
  totalRecords: number | null;
  chain: {
    status: FleetReceiptChainStatus;
    /** The record where verification failed, when it did. */
    brokenAtReceiptId: string | null;
    message: string;
  };
}

export const FLEET_SERVE_RECEIPT_SCHEMA_VERSION =
  'station.fleet-serve-receipt/v1' as const;

/**
 * The SERVING Station's own record of what it served and to whom (§3.4,
 * "Both sides record").
 *
 * The reason this exists at all: a consumer-authored record of a producer's
 * behavior is a claim, not evidence — past reviews in this repo have flagged
 * exactly that provenance shape. The routing envelope above is A's account
 * of the decision; this is B's account of the work.
 *
 * **Peer identity is a fingerprint, not a credential.** The serving Station
 * knows the caller only by the bearer credential presented, and this record
 * stores `SHA-256(credential)` rather than the credential — enough to say
 * "the same peer as last time" and to correlate with a revocation, never
 * enough to replay. It is not an environment id: nothing in the request
 * carries one, and inventing one from the connection would be asserting an
 * identity this Station did not verify.
 *
 * **No prompt, no completion.** `promptDigest` is a SHA-256 over the
 * canonicalized request messages; `completionCharacters` is a length. Same
 * discipline as Dispatch's own receipt, for the same reason: this file sits
 * on the serving operator's disk and must not become a transcript of other
 * people's conversations.
 */
export interface FleetServeReceipt {
  schemaVersion: typeof FLEET_SERVE_RECEIPT_SCHEMA_VERSION;
  receiptId: string;
  previousReceiptId: string | null;
  recordedAt: string;
  /** `SHA-256(bearer credential)`, or `null` when none was presented. */
  peerFingerprint: string | null;
  /** The contributed model id the caller asked for, as sent. */
  requestedModelId: string | null;
  promptDigest: string;
  outcome: 'served' | 'refused';
  /** The `FleetInferenceRefusalCode` when `outcome` is `refused`. */
  refusalCode: string | null;
  completionCharacters: number | null;
  elapsedMs: number | null;
  signature: null;
}

/**
 * The bounded read shape for the SERVING side (security review, M-2). Same
 * envelope-plus-chain-verdict shape as {@link FleetRoutingReceiptPage},
 * deliberately: two receipt surfaces that reported integrity differently
 * would teach readers that the verdict is decorative.
 */
export interface FleetServeReceiptPage {
  schemaVersion: typeof FLEET_SERVE_RECEIPT_SCHEMA_VERSION;
  receipts: FleetServeReceipt[];
  totalRecords: number | null;
  chain: {
    status: FleetReceiptChainStatus;
    brokenAtReceiptId: string | null;
    message: string;
  };
}

/** Bounds the read route and every surface built on it. */
export const FLEET_ROUTING_RECEIPT_READ_LIMITS = {
  defaultLimit: 20,
  maxLimit: 100,
  /**
   * Records scanned from the tail of the log in one read. A receipt log is
   * append-only and unbounded; a read route that parses the whole file is a
   * denial of the Station's own UI once the file is large.
   */
  maxScannedRecords: 500,
} as const;

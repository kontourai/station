/**
 * archive#1398 — the CONSUMING half of fleet inference
 * (`docs/design/inference-fleet.md` §3.1, §4.4, §4.5, §11 slice 3).
 *
 * Station A's side. This module answers one question — *which paired
 * Stations' contributed models may this Station route to right now, and for
 * every one it may not, why* — and it answers the second half as loudly as
 * the first. §4.5's first banned behavior is dropping an unverified
 * capability with no diagnostic; the reference mesh's stale-status filter
 * does exactly that (a node simply stops appearing), and this module's
 * return shape makes that shape unrepresentable: every peer and every model
 * it looked at leaves either a candidate or a named
 * {@link FleetRoutingExclusion}.
 *
 * **What is verified here, precisely: nothing about the peer.** A remote
 * Station's capability claim is its own manifest assertion, relayed. This
 * module authenticates the peer (its credential, its transport identity) and
 * relays what the peer says about itself. That is why every candidate it
 * produces carries `provenance: 'peer-attested'` and is capped at `declared`
 * by `capFleetEvidenceLevel` — `confirmed` in this codebase means a bounded
 * completion was observed, and slice 5's `consumer-verified` smoke is the
 * first thing that will observe one. A future edit that wants a peer to
 * reach `confirmed` has to delete that cap and be seen doing it.
 *
 * **Three gates, in order, each with its own exclusion code.**
 * 1. Does our credential for this peer carry `inference:invoke`? (Not a
 *    request we should send at all — `peer-scope-denied`.)
 * 2. Does the peer's public handshake advertise `fleetInference`? (§3.3
 *    point 2: it does not understand the token, so a request would be
 *    refused rather than degraded — `peer-protocol-unsupported`.)
 * 3. What does its authenticated manifest actually offer?
 *    (`not-contributed` / `peer-contribution-unavailable` / per-model codes.)
 *
 * **The router must not key on `participation` alone** — slice 1 recorded
 * this as a consequence for slice 3 and it is honored below: `contributing`
 * means "at least one model projected", not "every model is healthy", so
 * admission reads per-model `availability`/`freshness`/`locality` and the
 * connection-scoped diagnostics too.
 */

import { createHash } from 'node:crypto';
import type { PublicStationHandshake } from '@kontourai/station-contracts/environment-security';
import {
  PAIRING_SCOPE_INFERENCE_INVOKE,
  PUBLIC_STATION_HANDSHAKE_PATH,
  pairingScopeIncludes,
} from '@kontourai/station-contracts/environment-security';
import type {
  FleetContributedModel,
  FleetContributionManifest,
} from '@kontourai/station-contracts/fleet-contribution';
import { FLEET_INFERENCE_ROUTE_PREFIX } from '@kontourai/station-contracts/fleet-inference';
import type {
  ConsumerProbeObservation,
  FleetCandidateEvidence,
  FleetEvidenceLevel,
  FleetRoutingExclusion,
} from '@kontourai/station-contracts/fleet-routing-receipt';
import {
  canonicalizeForDigest,
  capFleetEvidenceLevel,
  FLEET_PEER_ATTESTED_EVIDENCE_LABEL,
  fleetEvidenceLevelWithProbe,
} from '@kontourai/station-contracts/fleet-routing-receipt';
import type {
  FleetProbeService,
  FleetProbeTarget,
} from './fleet-probe-service.js';

/**
 * Wall-clock ceiling on one peer interaction (handshake or manifest fetch).
 * A peer that has gone away must degrade this Station's routing decision in
 * bounded time, not stall the turn that is waiting for the decision —
 * `peer-unreachable` after 5s is a usable answer, a hung turn is not.
 */
export const FLEET_PEER_REQUEST_TIMEOUT_MS = 5_000;

/** Peers consulted in one resolution. Bounds a pathological credential store. */
export const FLEET_MAX_PEERS = 16;

/** Contributed models admitted from one peer in one resolution. */
export const FLEET_MAX_MODELS_PER_PEER = 32;

/**
 * The outbound peer record this module needs. Declared structurally rather
 * than importing `PeerCredentialStore` so the service is constructible in a
 * test with no filesystem, and so the secret-bearing store stays behind the
 * one accessor its own docblock requires callers to gate.
 */
export interface FleetPeerCredential {
  environmentId: string;
  apiBase: string;
  scope: string;
  label: string | null;
  credential: string;
}

export interface FleetPeerCredentialSource {
  listFleetPeers(): FleetPeerCredential[];
}

/** One routable fleet candidate: a peer's contributed model we may address. */
export interface FleetCandidate {
  environmentId: string;
  environmentLabel: string | null;
  apiBase: string;
  credential: string;
  /** `FleetContributedModel.id` — the id the serve route addresses. */
  modelId: string;
  displayName: string;
  evidence: FleetCandidateEvidence;
}

export interface FleetCandidateResolution {
  candidates: FleetCandidate[];
  exclusions: FleetRoutingExclusion[];
  resolvedAt: string;
}

interface FleetCandidateServiceOptions {
  peers: FleetPeerCredentialSource;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  timeoutMs?: number;
  /**
   * archive#1398. OPTIONAL, and its absence is the pre-slice-5
   * behavior exactly: every candidate stays `peer-attested` under the
   * unchanged cap. A consuming Station that has not opted into probing is
   * not silently downgraded, and `probe-failed` simply stays unreachable
   * for it.
   */
  probes?: FleetProbeService;
}

/**
 * Content address of a peer's claim.
 *
 * Canonicalized first (security review, L-6): `JSON.stringify` alone is
 * key-order dependent, so the same claim serialized by two code paths — or by
 * a peer whose JSON writer orders fields differently between versions —
 * hashes differently and reads as "the peer changed its claim" when nothing
 * changed. The digest exists to detect a CHANGED claim; a digest that also
 * fires on an unchanged one is worse than none, because it trains readers to
 * ignore it.
 */
function digestOf(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalizeForDigest(value)) ?? 'null')
    .digest('hex');
}

/**
 * Maps a peer's own availability/freshness claim onto Dispatch's ladder,
 * BEFORE the peer-attested cap is applied.
 *
 * The mapping is deliberately written as if it could reach `confirmed`, so
 * `capFleetEvidenceLevel` is visible as a decision rather than hidden inside
 * a lookup table that merely never emits the top value. `available` +
 * `live` is the strongest thing a manifest can say, and it is still only a
 * claim.
 *
 * - `availability: 'stale'` — the peer itself says this record is stale.
 *   Nothing to route on.
 * - `freshness: 'stale-snapshot'` — the peer served this from its stale
 *   snapshot (`refresh-unavailable` territory). §4.5's `evidence-stale` is
 *   exactly this case, so it grades `unavailable` and is excluded by name
 *   rather than routed on and hoped about.
 * - `freshness: 'configured'` — the entry comes from that Station's
 *   configuration, not from an observed catalog: a self-report of a
 *   self-report, worth `declared` and no more.
 * - `freshness: 'cached' | 'live'` — an observed catalog entry. `live` is
 *   the only input the pre-cap mapping grades `confirmed`, and the cap then
 *   takes it back down, because nothing on THIS Station observed it.
 */
export function peerAttestedLevelFromManifestModel(
  model: Pick<FleetContributedModel, 'availability' | 'freshness'>,
): FleetEvidenceLevel {
  if (model.availability !== 'available') return 'unavailable';
  switch (model.freshness) {
    case 'live':
      return 'confirmed';
    case 'cached':
    case 'configured':
      return 'declared';
    case 'stale-snapshot':
      return 'unavailable';
    default:
      // Defensive: a peer running a newer contract could send a freshness
      // value this build has never seen. Unknown is not "fine" — fail closed.
      return 'unavailable';
  }
}

/**
 * Builds the evidence record for one peer-attested candidate. The peer's raw
 * claim is preserved in `peerAttested` beside the capped `level` routing
 * actually used — folding them is how "the peer says this is available" turns
 * into "we confirmed it" (`fleet-routing-receipt.ts` module docblock).
 */
export function peerAttestedEvidence(
  model: FleetContributedModel,
  manifest: FleetContributionManifest,
  fetchedAt: string,
): FleetCandidateEvidence {
  const claimed = peerAttestedLevelFromManifestModel(model);
  return {
    level: capFleetEvidenceLevel(claimed, 'peer-attested'),
    provenance: 'peer-attested',
    label: FLEET_PEER_ATTESTED_EVIDENCE_LABEL,
    // Never probed by construction — this function is the PRE-probe grade,
    // and `withProbeObservation` below is the only thing that may raise it.
    probe: null,
    peerAttested: {
      availability: model.availability,
      freshness: model.freshness,
      observedAt: model.observedAt,
      manifestSourceObservedAt: manifest.sourceObservedAt,
      fetchedAt,
      digest: digestOf(model),
    },
  };
}

/**
 * Folds this Station's own probe observation into a peer-attested grade
 * (archive#1398).
 *
 * The peer's raw claim survives untouched in `peerAttested` — a probe adds a
 * first-hand observation, it does not replace what the peer said. Both are on
 * the record because "we verified a machine that claims nothing" and "we
 * verified a machine that claims the same thing" are different situations,
 * and a receipt read months later must still be able to tell them apart.
 */
export function withProbeObservation(
  evidence: FleetCandidateEvidence,
  probe: ConsumerProbeObservation | null,
): FleetCandidateEvidence {
  const graded = fleetEvidenceLevelWithProbe(
    // The PRE-cap claim, recovered from the peer's own record: the incoming
    // `evidence.level` has already been capped, and re-grading from a capped
    // value would silently lower a candidate whose peer claimed `live`.
    evidence.peerAttested
      ? peerAttestedLevelFromManifestModel({
          availability: evidence.peerAttested
            .availability as FleetContributedModel['availability'],
          freshness: evidence.peerAttested
            .freshness as FleetContributedModel['freshness'],
        })
      : evidence.level,
    probe,
  );
  return { ...evidence, ...graded, probe };
}

export class FleetCandidateService {
  readonly #peers: FleetPeerCredentialSource;
  readonly #fetch: typeof fetch;
  readonly #now: () => Date;
  readonly #timeoutMs: number;
  readonly #probes: FleetProbeService | undefined;

  constructor(options: FleetCandidateServiceOptions) {
    this.#peers = options.peers;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#now = options.now ?? (() => new Date());
    this.#timeoutMs = options.timeoutMs ?? FLEET_PEER_REQUEST_TIMEOUT_MS;
    this.#probes = options.probes;
  }

  /**
   * Consults every paired peer and returns the routable candidates plus a
   * named exclusion for every capability that did not make it. Never throws:
   * a resolution that fails is a resolution that admits nothing and says why,
   * because the caller is a model-construction path and a thrown error there
   * takes down the whole turn rather than degrading the fleet half of it.
   */
  async resolve(): Promise<FleetCandidateResolution> {
    const resolvedAt = this.#now().toISOString();
    const candidates: FleetCandidate[] = [];
    const exclusions: FleetRoutingExclusion[] = [];

    let peers: FleetPeerCredential[];
    try {
      peers = this.#peers.listFleetPeers().slice(0, FLEET_MAX_PEERS);
    } catch {
      return {
        candidates,
        exclusions: [
          {
            candidateId: null,
            environmentId: null,
            environmentLabel: null,
            modelId: null,
            // Not `peer-unreachable`: nothing was asked of any peer. This is
            // a failure on THIS side, and the vocabulary now has a code that
            // says so (security review, H-1(c)/L-2).
            code: 'resolution-failed',
            message:
              'This Station could not read its own peer credentials, so no fleet candidate could be considered. That is unknown, not empty.',
            source: 'station',
          },
        ],
        resolvedAt,
      };
    }

    const results = await Promise.all(
      peers.map((peer) => this.#resolvePeer(peer, resolvedAt)),
    );
    for (const result of results) {
      candidates.push(...result.candidates);
      exclusions.push(...result.exclusions);
    }
    return { candidates, exclusions, resolvedAt };
  }

  async #resolvePeer(
    peer: FleetPeerCredential,
    resolvedAt: string,
  ): Promise<{
    candidates: FleetCandidate[];
    exclusions: FleetRoutingExclusion[];
  }> {
    const exclude = (
      code: FleetRoutingExclusion['code'],
      message: string,
      modelId: string | null = null,
    ): FleetRoutingExclusion => ({
      candidateId: null,
      environmentId: peer.environmentId,
      environmentLabel: peer.label,
      modelId,
      code,
      message,
      source: 'station',
    });

    // Gate 1 — our own credential. Checked before any request leaves this
    // machine: sending a call we know will be refused teaches nothing and
    // costs the peer a request.
    if (!pairingScopeIncludes(peer.scope, PAIRING_SCOPE_INFERENCE_INVOKE)) {
      return {
        candidates: [],
        exclusions: [
          exclude(
            'peer-scope-denied',
            `This Station's credential for ${peer.label ?? peer.environmentId} does not carry ${PAIRING_SCOPE_INFERENCE_INVOKE}. Mint an inference-preset grant on that Station to route to it.`,
          ),
        ],
      };
    }

    // Gate 2 — the peer's protocol support (§3.3 point 2).
    const handshake = await this.#fetchHandshake(peer);
    if (handshake.kind === 'unreachable') {
      return {
        candidates: [],
        exclusions: [
          exclude(
            'peer-unreachable',
            `${peer.label ?? peer.environmentId} is not answering, so what it contributes is unknown rather than empty.`,
          ),
        ],
      };
    }
    if (!handshake.handshake.capabilities?.fleetInference) {
      return {
        candidates: [],
        exclusions: [
          exclude(
            'peer-protocol-unsupported',
            `${peer.label ?? peer.environmentId} does not advertise fleet inference support, so it cannot authorize an inference:invoke request. Upgrade that Station.`,
          ),
        ],
      };
    }

    // Gate 3 — what it actually offers.
    const manifestResult = await this.#fetchManifest(peer);
    if (manifestResult.kind === 'unreachable') {
      return {
        candidates: [],
        exclusions: [
          exclude(
            'peer-unreachable',
            `${peer.label ?? peer.environmentId} is not answering, so what it contributes is unknown rather than empty.`,
          ),
        ],
      };
    }
    if (manifestResult.kind === 'denied') {
      return {
        candidates: [],
        exclusions: [
          exclude(
            'peer-scope-denied',
            `${peer.label ?? peer.environmentId} refused this Station's credential. It was likely revoked, or paired before fleet inference existed.`,
          ),
        ],
      };
    }
    if (manifestResult.kind === 'unavailable') {
      return {
        candidates: [],
        exclusions: [
          exclude(
            'peer-contribution-unavailable',
            `${peer.label ?? peer.environmentId} could not say what it contributes. That is unknown, not empty — retry rather than treating this peer as offering nothing.`,
          ),
        ],
      };
    }

    const manifest = manifestResult.manifest;
    if (manifest.participation !== 'contributing') {
      // The three non-contributing states are three different sentences, and
      // slice 1 built `participation` precisely so `models: []` is never the
      // signal. Say which empty it is.
      const reason =
        manifest.participation === 'disabled'
          ? 'has fleet contribution turned off'
          : manifest.participation === 'nothing-contributed'
            ? 'has fleet contribution on but no connection marked as contributed'
            : 'has marked connections that currently yield no launchable model';
      return {
        candidates: [],
        exclusions: [
          exclude(
            manifest.participation === 'contributed-unavailable'
              ? 'peer-contribution-unavailable'
              : 'not-contributed',
            `${peer.label ?? peer.environmentId} ${reason}.`,
          ),
        ],
      };
    }

    const candidates: FleetCandidate[] = [];
    const exclusions: FleetRoutingExclusion[] = [];
    for (const model of manifest.models.slice(0, FLEET_MAX_MODELS_PER_PEER)) {
      // §4.1: a non-local contribution is a reference claim, not a claim
      // about compute on that machine. The peer offers it and flags it; this
      // Station declines to route on it in v1 and says which sentence that
      // is — "the reference does not resolve there" is not "the model is
      // down".
      if (model.locality !== 'local') {
        exclusions.push(
          exclude(
            'reference-unresolvable',
            `${model.displayName} on ${peer.label ?? peer.environmentId} is a reference to compute that Station does not run itself, so this Station will not route inference to it.`,
            model.id,
          ),
        );
        continue;
      }
      const attested = peerAttestedEvidence(model, manifest, resolvedAt);
      if (attested.level === 'unavailable') {
        exclusions.push(
          exclude(
            'evidence-stale',
            `${model.displayName} on ${peer.label ?? peer.environmentId} is attested as '${model.availability}' with '${model.freshness}' evidence, which is not enough to route on.`,
            model.id,
          ),
        );
        continue;
      }

      // archive#1398. `observe` NEVER performs I/O: it answers from
      // the probe cache and schedules a refresh when there is nothing fresh,
      // so the FIRST resolution behaves exactly as it did before slice 5 and
      // the upgrade lands on a later window. Ordering matters — the peer's
      // own claim is evaluated first (above), because a probe of a model the
      // peer says is unavailable would spend a completion to learn what the
      // peer already told us.
      const target: FleetProbeTarget = {
        environmentId: peer.environmentId,
        environmentLabel: peer.label,
        apiBase: peer.apiBase,
        credential: peer.credential,
        modelId: model.id,
        displayName: model.displayName,
        providerModel: model.providerModel,
      };
      const probe = this.#probes?.observe(target) ?? null;
      const probeExclusion = this.#probes?.exclusionFor(target, probe) ?? null;
      if (probeExclusion) {
        // A FRESH failed probe is first-hand evidence about the path this
        // Station would actually use, which outranks the peer's own claim
        // that the model is fine. It is withheld from the router AND named,
        // never dropped (§4.5's first banned behavior).
        exclusions.push(probeExclusion);
        continue;
      }

      candidates.push({
        environmentId: peer.environmentId,
        environmentLabel: peer.label,
        apiBase: peer.apiBase,
        credential: peer.credential,
        modelId: model.id,
        displayName: model.displayName,
        evidence: withProbeObservation(attested, probe),
      });
    }
    return { candidates, exclusions };
  }

  async #fetchHandshake(
    peer: FleetPeerCredential,
  ): Promise<
    { kind: 'ok'; handshake: PublicStationHandshake } | { kind: 'unreachable' }
  > {
    const response = await this.#request(
      `${peer.apiBase}${PUBLIC_STATION_HANDSHAKE_PATH}`,
    );
    if (!response?.ok) return { kind: 'unreachable' };
    try {
      return {
        kind: 'ok',
        handshake: (await response.json()) as PublicStationHandshake,
      };
    } catch {
      return { kind: 'unreachable' };
    }
  }

  async #fetchManifest(
    peer: FleetPeerCredential,
  ): Promise<
    | { kind: 'ok'; manifest: FleetContributionManifest }
    | { kind: 'unreachable' }
    | { kind: 'denied' }
    | { kind: 'unavailable' }
  > {
    const response = await this.#request(
      `${peer.apiBase}${FLEET_INFERENCE_ROUTE_PREFIX}/manifest`,
      { Authorization: `Bearer ${peer.credential}` },
    );
    if (!response) return { kind: 'unreachable' };
    if (response.status === 401 || response.status === 403) {
      return { kind: 'denied' };
    }
    if (!response.ok) return { kind: 'unavailable' };
    try {
      const payload = (await response.json()) as {
        manifest?: FleetContributionManifest;
      };
      if (!payload?.manifest || !Array.isArray(payload.manifest.models)) {
        return { kind: 'unavailable' };
      }
      return { kind: 'ok', manifest: payload.manifest };
    } catch {
      return { kind: 'unavailable' };
    }
  }

  /** `undefined` for any transport failure — never a throw into the turn. */
  async #request(
    url: string,
    headers?: Record<string, string>,
  ): Promise<Response | undefined> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      return await this.#fetch(url, {
        method: 'GET',
        signal: controller.signal,
        ...(headers ? { headers } : {}),
      });
    } catch {
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  }
}

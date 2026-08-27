/**
 * station#1398 slice 5 — the CONSUMER-VERIFIED probe
 * (`docs/design/inference-fleet.md` §4.3, §4.5, §10 OQ-6, §11 slice 5).
 *
 * Slices 3 and 4 relay a peer's claim and say so: every fleet candidate is
 * `peer-attested` and capped at `declared`, because nothing on this Station
 * had observed anything. This module is the first thing that observes
 * something — a bounded one-turn completion run against the peer THROUGH THE
 * FLEET PATH THIS STATION WILL ACTUALLY USE (§4.3's second honesty
 * constraint: "A is entitled to demand its own smoke", and it is "the only
 * one that proves the *path*, not just the peer").
 *
 * ### Three properties that are contract, not implementation detail
 *
 * 1. **Never on a hot path.** A turn must never wait for a probe. `observe()`
 *    is synchronous and answers only from cache; when the cache is missing or
 *    expired it SCHEDULES a refresh and returns the pre-probe answer
 *    (peer-attested, exactly as before slice 5). The upgrade lands on a later
 *    resolution window, the same way station#1431's evidence TTL works. A
 *    design where the first fleet turn pays for a probe would make the
 *    feature's own verification its worst latency case.
 * 2. **Bounded in every dimension.** One in-flight probe per candidate
 *    ({@link FleetProbeService.#inFlight}), a ceiling on concurrent probes
 *    across all candidates, a wall-clock timeout, a fixed content-free
 *    prompt, and `maxOutputTokens: 1`. §10 OQ-6 records that the consumer's
 *    own smoke counts against budget; the smallest completion that still
 *    proves the path is the honest way to spend it.
 * 3. **Nothing from the completion is recorded.** The observation carries
 *    that a turn completed, how long it took, and which provider model the
 *    peer echoed — never the generated text and never a digest of it. A
 *    working path is not a reason to start storing model output.
 *
 * ### What a probe does and does not earn
 *
 * A fresh PASS raises the candidate to `provenance: 'probe-verified'` and
 * `level: 'confirmed'` via `fleetEvidenceLevelWithProbe`. The peer-attested
 * cap is NOT deleted — it still binds every unverified claim, which is the
 * whole point: what changed is that this claim is no longer unverified.
 *
 * A fresh FAILURE produces a `probe-failed` exclusion (declared in slice 3
 * and unreachable until now) and withholds the candidate from the router. A
 * failed probe is stronger evidence than the peer's own claim: this Station
 * tried the real path and it did not work.
 *
 * An EXPIRED observation degrades to exactly the pre-probe state — the
 * peer's capped claim — with the stale observation still attached so a
 * surface can say "last probed at T, passed, now stale" rather than making a
 * never-probed candidate indistinguishable from a recently-probed one. §4.3:
 * "A level without freshness is a claim about the past presented as a fact
 * about now." A stale FAILURE likewise does not exclude: it is not evidence
 * about now either, and excluding on it would be the mirror-image over-claim.
 */

import type {
  FleetInferenceCompletionRequest,
  FleetInferenceCompletionResponse,
  FleetInferenceRefusal,
} from '@kontourai/station-contracts/fleet-inference';
import { FLEET_INFERENCE_ROUTE_PREFIX } from '@kontourai/station-contracts/fleet-inference';
import type {
  ConsumerProbeObservation,
  FleetRoutingExclusion,
} from '@kontourai/station-contracts/fleet-routing-receipt';
import {
  fleetProbeDeferrals,
  fleetProbeFailures,
  fleetProbeObservations,
} from '../../telemetry/metrics.js';
import { createLogger, type Logger } from '../../utils/logger.js';

/**
 * How long one passing probe stands as evidence about now.
 *
 * Deliberately the same order as the connection-readiness smoke window this
 * ladder already uses locally: a `consumer-verified` grade should not outlive
 * a local `smoke-passed` grade, or the fleet half of the ladder would be more
 * generous to a machine we do not control than to one we do.
 */
export const FLEET_PROBE_TTL_MS = 15 * 60 * 1000;

/**
 * How long a FAILED probe suppresses the candidate before it is retried.
 *
 * Shorter than the pass window on purpose. A pass ages into "unknown"; a
 * failure ages into "worth trying again" — a peer that was rebooting should
 * not be excluded for a quarter of an hour, and re-probing is cheap because
 * a failing peer usually fails fast.
 */
export const FLEET_PROBE_FAILURE_TTL_MS = 2 * 60 * 1000;

/**
 * Upper bound for a consecutive failed probe window.
 *
 * Failure suppression must slow repeated provider calls without turning one
 * unhealthy peer into a permanent exclusion. It therefore caps at the same
 * evidence lifetime as a passing probe.
 */
export const FLEET_PROBE_MAX_FAILURE_TTL_MS = FLEET_PROBE_TTL_MS;

/** Wall-clock ceiling on one probe completion. */
export const FLEET_PROBE_TIMEOUT_MS = 20_000;

/** Probes in flight across all candidates at once. */
export const FLEET_PROBE_MAX_CONCURRENT = 2;

/**
 * Observations retained across all peers and models.
 *
 * Bounded because "bounded in every dimension" has to include the parts that
 * grow slowly. One resolution can only reach
 * `FLEET_MAX_PEERS * FLEET_MAX_MODELS_PER_PEER` (512) distinct keys, so this
 * ceiling never evicts a live working set — but a long-lived Station whose
 * peers rename or re-key models over months would otherwise accumulate an
 * entry per identity that ever existed. Eviction is oldest-first and costs
 * nothing but a re-probe.
 */
export const FLEET_PROBE_MAX_OBSERVATIONS = 1024;

/**
 * The probe prompt. Fixed, content-free, and never derived from the turn
 * being routed: a probe that carried real user content would leak that
 * content to a machine the router had not yet decided to trust, which is the
 * exact ordering mistake a verification step must not make.
 */
export const FLEET_PROBE_PROMPT = 'ping' as const;

/** One candidate this service can probe. Structural — no credential store. */
export interface FleetProbeTarget {
  environmentId: string;
  environmentLabel: string | null;
  apiBase: string;
  credential: string;
  /** `FleetContributedModel.id` — what the serve route addresses. */
  modelId: string;
  displayName: string;
  /** The provider-native id the peer's manifest claimed for this model. */
  providerModel: string | null;
}

interface FleetProbeServiceOptions {
  fetchImpl?: typeof fetch;
  /** Wall clock used only for truthful receipt timestamps. */
  now?: () => Date;
  /** Monotonic clock used only for cache admission and expiry. */
  monotonicNow?: () => number;
  timeoutMs?: number;
  passTtlMs?: number;
  failureTtlMs?: number;
  maxFailureTtlMs?: number;
  maxConcurrent?: number;
  maxObservations?: number;
  logger?: Logger;
  /**
   * Test seam ONLY for making the scheduled refresh observable. Production
   * never awaits a probe (property 1 above); a test that could not await one
   * would have to sleep, which is how a suite becomes load-dependent.
   */
  onRefreshSettled?: (key: string) => void;
}

interface ProbeCacheEntry {
  observation: ConsumerProbeObservation;
  /** Process-local monotonic deadline; never reconstructed from wall time. */
  freshUntilMonotonicMs: number;
  /** Consecutive failed observations for exactly this cache key. */
  failureStreak: number;
}

class FleetProbeTimingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FleetProbeTimingError';
  }
}

function invalidTimingConfiguration(): FleetProbeTimingError {
  return new FleetProbeTimingError(
    'Fleet probe timing configuration is invalid.',
  );
}

function requirePositiveDuration(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw invalidTimingConfiguration();
  }
  return value;
}

function requireNonNegativeLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw invalidTimingConfiguration();
  }
  return value;
}

function requirePositiveLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw invalidTimingConfiguration();
  }
  return value;
}

class FleetProbeInterruptedError extends Error {
  constructor() {
    super('Fleet probe was interrupted before a result was available.');
    this.name = 'FleetProbeInterruptedError';
  }
}

function probeKey(environmentId: string, modelId: string): string {
  // The `\u0000` ESCAPE, never a literal NUL byte — a literal control
  // character makes the whole source file `data` to file(1) and invisible to
  // `git grep -I`, which is how a file silently opts out of the repo's own
  // content scanners (station#1398 security review, M-5).
  return `${environmentId}\u0000${modelId}`;
}

const moduleLogger = createLogger({ name: 'fleet-probe-service' });

export class FleetProbeService {
  readonly #fetch: typeof fetch;
  readonly #now: () => Date;
  readonly #monotonicNow: () => number;
  readonly #timeoutMs: number;
  readonly #passTtlMs: number;
  readonly #failureTtlMs: number;
  readonly #maxFailureTtlMs: number;
  readonly #maxConcurrent: number;
  readonly #maxObservations: number;
  readonly #logger: Logger;
  readonly #onRefreshSettled: ((key: string) => void) | undefined;
  readonly #observations = new Map<string, ProbeCacheEntry>();
  readonly #inFlight = new Map<string, Promise<ConsumerProbeObservation>>();
  #lastMonotonicNow: number | undefined;

  constructor(options: FleetProbeServiceOptions = {}) {
    this.#fetch = options.fetchImpl ?? fetch;
    this.#now = options.now ?? (() => new Date());
    this.#monotonicNow = options.monotonicNow ?? (() => performance.now());
    this.#timeoutMs = requirePositiveDuration(
      options.timeoutMs ?? FLEET_PROBE_TIMEOUT_MS,
    );
    this.#passTtlMs = requirePositiveDuration(
      options.passTtlMs ?? FLEET_PROBE_TTL_MS,
    );
    this.#failureTtlMs = requirePositiveDuration(
      options.failureTtlMs ?? FLEET_PROBE_FAILURE_TTL_MS,
    );
    this.#maxFailureTtlMs = requirePositiveDuration(
      options.maxFailureTtlMs ?? FLEET_PROBE_MAX_FAILURE_TTL_MS,
    );
    if (this.#maxFailureTtlMs < this.#failureTtlMs) {
      throw invalidTimingConfiguration();
    }
    this.#maxConcurrent = requireNonNegativeLimit(
      options.maxConcurrent ?? FLEET_PROBE_MAX_CONCURRENT,
    );
    this.#maxObservations = requirePositiveLimit(
      options.maxObservations ?? FLEET_PROBE_MAX_OBSERVATIONS,
    );
    this.#logger = options.logger ?? moduleLogger;
    this.#onRefreshSettled = options.onRefreshSettled;
  }

  /**
   * The cached verdict for one candidate, and a scheduled refresh when there
   * is nothing fresh to answer with. NEVER performs I/O on this call path.
   *
   * Returns `null` when this candidate has never been probed — distinct from
   * a `stale` observation, which says a probe DID run and has aged out.
   */
  observe(target: FleetProbeTarget): ConsumerProbeObservation | null {
    const key = probeKey(target.environmentId, target.modelId);
    const cached = this.#observations.get(key);
    const fresh =
      cached !== undefined &&
      this.#readMonotonicNow() < cached.freshUntilMonotonicMs;
    if (!fresh) this.#scheduleRefresh(key, target);
    if (cached === undefined) return null;
    if (fresh) return cached.observation;
    // Expired: report the observation as `stale` rather than dropping it, so
    // a surface can distinguish "never probed" from "probed, aged out".
    return { ...cached.observation, status: 'stale' };
  }

  /**
   * The `probe-failed` exclusion for a candidate whose most recent probe
   * failed and has not yet aged out. `null` in every other case — including a
   * STALE failure, which is not evidence about now (module docblock).
   *
   * This is what finally makes slice 3's `probe-failed` code reachable.
   */
  exclusionFor(
    target: FleetProbeTarget,
    observation: ConsumerProbeObservation | null,
  ): FleetRoutingExclusion | null {
    if (observation?.status !== 'failed') return null;
    const where = target.environmentLabel ?? target.environmentId;
    return {
      candidateId: null,
      environmentId: target.environmentId,
      environmentLabel: target.environmentLabel,
      modelId: target.modelId,
      code: 'probe-failed',
      message: `This Station's own bounded completion against ${where} for ${target.displayName} failed (${observation.failureCode ?? 'unknown'}) at ${observation.observedAt}, so it is not routable even though ${where} still offers it.`,
      source: 'station',
    };
  }

  /**
   * Runs one probe now and records it. Exposed for an explicit operator- or
   * test-driven verification; the routing path never calls this directly.
   */
  refresh(target: FleetProbeTarget): Promise<ConsumerProbeObservation> {
    const key = probeKey(target.environmentId, target.modelId);
    const existing = this.#inFlight.get(key);
    if (existing) return existing;

    const refresh = this.#refreshAndStore(key, target);
    this.#inFlight.set(key, refresh);
    void refresh.then(
      () => this.#releaseInFlight(key, refresh),
      () => this.#releaseInFlight(key, refresh),
    );
    return refresh;
  }

  async #refreshAndStore(
    key: string,
    target: FleetProbeTarget,
  ): Promise<ConsumerProbeObservation> {
    const prior = this.#observations.get(key);
    const nextFailureStreak =
      prior?.observation.status === 'failed' ? prior.failureStreak + 1 : 1;
    const failureTtlMs = this.#failureTtlFor(nextFailureStreak);
    const startedAt = this.#readWallClockNow();
    const startedMonotonicMs = this.#readMonotonicNow();
    const observation = await this.#runProbe({
      target,
      startedAt,
      startedMonotonicMs,
      failureTtlMs,
    });
    const ttlMs =
      observation.status === 'failed' ? failureTtlMs : this.#passTtlMs;
    const freshUntilMonotonicMs = startedMonotonicMs + ttlMs;
    if (!Number.isFinite(freshUntilMonotonicMs)) {
      throw invalidTimingConfiguration();
    }
    // Delete BEFORE the size check, not just before the set. `Map.set` on a
    // present key keeps its original insertion position, so without this a
    // re-probe of an existing entry counts as growth and evicts an unrelated
    // candidate that had done nothing wrong — the map ends up smaller than
    // its ceiling AND missing a live observation, which is the opposite of
    // what a bounded cache is for.
    this.#observations.delete(key);
    if (this.#observations.size >= this.#maxObservations) {
      const oldest = this.#observations.keys().next().value;
      if (oldest !== undefined) this.#observations.delete(oldest);
    }
    this.#observations.set(key, {
      observation,
      freshUntilMonotonicMs,
      failureStreak: observation.status === 'failed' ? nextFailureStreak : 0,
    });
    return observation;
  }

  #releaseInFlight(
    key: string,
    refresh: Promise<ConsumerProbeObservation>,
  ): void {
    if (this.#inFlight.get(key) === refresh) this.#inFlight.delete(key);
  }

  #failureTtlFor(streak: number): number {
    // The cap bounds both calls to an unhealthy peer and numeric growth if a
    // long-lived process observes many consecutive failures for one key.
    const exponent = Math.min(streak - 1, 52);
    return Math.min(this.#maxFailureTtlMs, this.#failureTtlMs * 2 ** exponent);
  }

  #readWallClockNow(): Date {
    const now = this.#now();
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
      throw invalidTimingConfiguration();
    }
    return now;
  }

  #readMonotonicNow(): number {
    const now = this.#monotonicNow();
    if (!Number.isFinite(now) || now < 0) {
      throw invalidTimingConfiguration();
    }
    if (this.#lastMonotonicNow !== undefined && now < this.#lastMonotonicNow) {
      throw new FleetProbeTimingError(
        'Fleet probe monotonic clock moved backwards.',
      );
    }
    this.#lastMonotonicNow = now;
    return now;
  }

  #scheduleRefresh(key: string, target: FleetProbeTarget): void {
    // Already being probed — not backpressure, and counting it would drown
    // the signal below in the normal case.
    if (this.#inFlight.has(key)) return;
    if (this.#inFlight.size >= this.#maxConcurrent) {
      // Finding 4. Every other bound in this feature is counted, and this one
      // is the bound an operator actually collides with: with
      // FLEET_PROBE_MAX_CONCURRENT at 2 and a wide fleet, most candidates are
      // skipped on any given pass. "Why is nothing getting verified" has to be
      // answerable, and a silent `return` makes deferral indistinguishable
      // from a probe that ran and found nothing.
      fleetProbeDeferrals.add(1, { reason: 'concurrency-limit' });
      return;
    }
    // Detached on purpose. The `catch` is not decorative: an unhandled
    // rejection escaping a fire-and-forget probe would crash the server for a
    // verification that is by design allowed to fail.
    void this.refresh(target)
      .catch((error: unknown) => {
        this.#logger.warn(
          `[fleet-probe] Probe of ${target.environmentLabel ?? target.environmentId} for ${target.displayName} could not be recorded.`,
          { error: error instanceof Error ? error.message : String(error) },
        );
      })
      .finally(() => {
        this.#onRefreshSettled?.(key);
      });
  }

  async #runProbe({
    target,
    startedAt,
    startedMonotonicMs,
    failureTtlMs,
  }: {
    target: FleetProbeTarget;
    startedAt: Date;
    startedMonotonicMs: number;
    failureTtlMs: number;
  }): Promise<ConsumerProbeObservation> {
    const observedAt = startedAt.toISOString();
    const failed = (failureCode: string): ConsumerProbeObservation => {
      fleetProbeFailures.add(1, { code: failureCode });
      return {
        status: 'failed',
        observedAt,
        expiresAt: new Date(startedAt.getTime() + failureTtlMs).toISOString(),
        elapsedMs: null,
        servedProviderModel: null,
        failureCode,
      };
    };

    const body: FleetInferenceCompletionRequest = {
      model: target.modelId,
      messages: [{ role: 'user', content: FLEET_PROBE_PROMPT }],
      // The smallest completion that still proves a turn ran end to end.
      maxOutputTokens: 1,
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      const response = await this.#fetch(
        `${target.apiBase.replace(/\/+$/, '')}${FLEET_INFERENCE_ROUTE_PREFIX}/completions`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${target.credential}`,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        },
      );
      // Finding 3: a peer that ANSWERED is never reported as unreachable.
      // Everything below this line happened after a response arrived, so the
      // outer catch's `peer-unreachable` would be false about the one fact an
      // operator reads the message for.
      if (!response.ok) {
        // The peer's OWN refusal code is what the operator needs — "the peer
        // said model-not-contributed" and "the peer timed out" are different
        // problems with different fixes, and collapsing them into
        // "probe failed" is the vagueness §4.5 exists to prevent.
        const refusal = (await response
          .json()
          .catch(() => null)) as FleetInferenceRefusal | null;
        return failed(refusal?.code ?? `http-${response.status}`);
      }
      let completion: FleetInferenceCompletionResponse;
      try {
        completion =
          (await response.json()) as FleetInferenceCompletionResponse;
      } catch {
        // A 200 with a body this Station cannot parse. Distinct from
        // unreachable (the peer answered) and from a refusal (it did not say
        // no) — it is a peer whose response contract this build does not
        // understand, which is an upgrade or corruption question, not a
        // liveness one.
        return failed('peer-response-unreadable');
      }
      const elapsedMs = this.#readMonotonicNow() - startedMonotonicMs;
      fleetProbeObservations.add(1, { status: 'passed' });
      return {
        status: 'passed',
        observedAt,
        expiresAt: new Date(
          startedAt.getTime() + this.#passTtlMs,
        ).toISOString(),
        elapsedMs,
        // Recorded so a substitution is visible: a peer that served a
        // different model than its manifest named is a discrepancy the
        // completion text could never reveal.
        servedProviderModel: completion.model?.providerModel ?? null,
        failureCode: null,
      };
    } catch (error) {
      // A broken timing invariant is a local configuration fault, not a
      // statement about the peer. It must escape without a failure metric or
      // cache entry so the caller can repair the service deterministically.
      if (error instanceof FleetProbeTimingError) throw error;
      // Only transport reaches here now: the request never completed. A
      // response that arrived and then disappointed us is classified above,
      // where the fact that it arrived is still known.
      if (error instanceof Error && error.name === 'AbortError') {
        if (controller.signal.aborted) return failed('probe-timeout');
        // A caller-side interruption has no provider outcome. Caching it as
        // `failed` would suppress the next honest observation with a value
        // that never described the peer at all.
        throw new FleetProbeInterruptedError();
      }
      return failed('peer-unreachable');
    } finally {
      clearTimeout(timer);
    }
  }
}

import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { LanguageModelV3 } from '@ai-sdk/provider';
import type {
  CapabilityEvidence,
  DispatchReceipt,
  DispatchRuntimePlan,
  EvidenceLevel,
  ExecutionCandidate,
  StructuredToolsFidelity,
} from '@kontourai/dispatch';
import { executionPlanDigest } from '@kontourai/dispatch';
import { createAiSdkDispatchModel } from '@kontourai/dispatch/ai-sdk';
import type { AgentSpec } from '@kontourai/station-contracts/agent';
import type {
  FleetRoutingCandidate,
  FleetRoutingExclusion,
} from '@kontourai/station-contracts/fleet-routing-receipt';
import {
  FLEET_LOCAL_EVIDENCE_LABEL,
  FLEET_PEER_ATTESTED_EVIDENCE_LABEL,
} from '@kontourai/station-contracts/fleet-routing-receipt';
import type {
  ConnectionEvidenceFreshness,
  ConnectionEvidenceLevel,
  ConnectionReadinessEvidence,
} from '@kontourai/station-contracts/tool';
import type { FleetCandidate } from '../../services/inference/fleet-candidate-service.js';
import {
  fleetRoutingCandidatesTotal,
  fleetRoutingCorrelationEvents,
  fleetRoutingExclusionsTotal,
  fleetRoutingReceiptFailures,
  fleetRoutingReceiptsTotal,
  modelDispatchReceipts,
} from '../../telemetry/metrics.js';
import { createLogger, type Logger } from '../../utils/logger.js';
import { createAiSdkManagedModel } from '../frameworks/framework-model-factory.js';
import {
  type ResolvedManagedModelBinding,
  resolveManagedModelBinding,
} from '../plugins/runtime-provider-resolution.js';
import type {
  AgentCreationConfig,
  DispatchEvidenceSource,
  DispatchFleetRouting,
} from '../types.js';
import {
  type AuthorizedFleetDispatchBegin,
  type AuthorizedTurnCorrelation,
  currentAuthorizedTurnCorrelation,
} from './authorized-turn-correlation.js';
import { createFleetInferenceModel } from './fleet-inference-model.js';
import { buildFleetRoutingEnvelope } from './fleet-routing-envelope.js';

interface DispatchCandidateConfig {
  modelConnectionId?: string | null;
  modelId?: string | null;
  estimatedUsdPer1kTokens?: number;
}

interface DispatchPolicyConfig {
  requiredCapabilities?: string[];
  minimumEvidence?: EvidenceLevel;
  /**
   * Dispatch 0.5.0's second eligibility axis (station#1398 slice 5.5). The
   * whole `policy` object is handed to the engine verbatim, so this reached
   * `eligible()` whether or not Station declared it; declaring it is what
   * makes it validated at config-read time and replicated by
   * {@link isAdmitted} instead of silently diverging.
   *
   * `'unavailable'` is excluded on purpose — it is a real fidelity VALUE but
   * not a meaningful minimum (every candidate clears it), and Dispatch's own
   * type excludes it from this field for the same reason.
   */
  minimumStructuredToolsFidelity?: Exclude<
    StructuredToolsFidelity,
    'unavailable'
  >;
  retryRuntimeFailures?: boolean;
}

/**
 * The agent's fleet opt-in (station#1398 slice 3). Default OFF in every
 * direction, symmetric with the serving side's opt-in
 * (`fleet-contribution.ts`): a Station never routes an agent's turn to
 * another machine because a peer credential happens to exist.
 *
 * `order` decides where fleet candidates sit in the plan. `'after-local'` is
 * the default because the local model is the one whose latency, cost, and
 * privacy the operator already accepted; `'before-local'` is what an
 * operator picks when the whole point is "use the workstation's GPU". It is
 * a knob rather than a policy because both readings are legitimate and the
 * receipt records which one produced the decision either way.
 */
interface DispatchFleetConfig {
  enabled?: boolean;
  order?: 'after-local' | 'before-local';
}

interface DispatchModelConfig {
  enabled: true;
  candidates?: DispatchCandidateConfig[];
  budget?: Partial<DispatchRuntimePlan['budget']>;
  policy?: DispatchPolicyConfig;
  fleet?: DispatchFleetConfig;
}

/** Identifies the evidence producer in every derived `CapabilityEvidence.source` (SF-4). */
const EVIDENCE_SOURCE_ID = 'station:connection-readiness/v1';

/**
 * TTL for re-grading Dispatch candidate evidence (#1431).
 *
 * `@kontourai/dispatch/ai-sdk`'s `createAiSdkDispatchModel` accepts `plan` as
 * either a static object or a function resolved per invocation
 * (`(request) => DispatchRuntimePlan | Promise<DispatchRuntimePlan>`).
 * `createConfiguredDispatchModel` uses the function form and re-grades
 * candidate evidence behind this TTL instead of baking a grade into a static
 * plan for the lifetime of the built agent model (the #1426 follow-up this
 * closes): within the window a Dispatch invocation reuses the last grade;
 * once the window elapses, the next invocation re-resolves live evidence
 * through the same batched `fetchReadinessEvidenceMap` path (one
 * `listConnections()` call per window — #1426 SF-5 — never one per request).
 *
 * This bounds both directions of #1431's staleness bug within one TTL
 * window instead of "until the next agent rebuild": an evidence over-claim
 * (a smoke result that has gone stale) stops being asserted, and an
 * evidence under-claim (an operator who just ran a smoke) starts being
 * honored, without needing an unrelated rebuild trigger.
 *
 * 60s: short enough that an operator who runs a smoke and waits sees it take
 * effect on their very next turn in the common case, long enough that a
 * multi-turn conversation or a burst of dispatch calls still gets the SF-5
 * batching benefit instead of degrading back to a `listConnections()` call
 * per request.
 */
export const DISPATCH_EVIDENCE_TTL_MS = 60_000;

/**
 * Fallback logger (fix round 3, M-1b) for the ONE warning that must never go
 * silent: `warnIfPolicyNeedsEvidenceSource` below. That warning is gated on
 * "did this call path wire an evidence source" — which correlates almost
 * perfectly with "did this call path wire a logger," since both are threaded
 * from the same `AgentCreationConfig`/`RuntimeContext` source. Gating the
 * warning on `config.logger` therefore fired it exactly where it couldn't
 * matter (a wired path, which by construction also has a source and so never
 * needs the warning) and stayed silent exactly where it had to fire (an
 * unwired path). Module-scope logger, same pattern as every other
 * server-side module that logs without an injected logger
 * (`routes/system/auth.ts`, `domain/config-loader.ts`, etc.).
 */
const moduleLogger = createLogger({ name: 'dispatch-model-policy' });

const UNAVAILABLE_EVIDENCE: CapabilityEvidence = {
  level: 'unavailable',
  capabilities: [],
  structuredToolsFidelity: 'unavailable',
  source: EVIDENCE_SOURCE_ID,
};

/**
 * Maps Station's four-level connection evidence ladder
 * (`packages/contracts/src/tool.ts` `ConnectionEvidenceLevel`, computed by
 * `connection-readiness-evidence.ts`) onto Dispatch's three-level
 * `EvidenceLevel` (`@kontourai/dispatch` 0.2.0: `unavailable | declared |
 * confirmed`). station#1426 (slice 0 of the inference-fleet design, #1398):
 * a Dispatch candidate must never claim more than the connection has
 * actually earned.
 *
 * - `discovered` (nothing checked beyond the connection existing) has
 *   earned nothing — `unavailable`, the same rank Dispatch itself uses for
 *   "no evidence supplied."
 * - `prerequisite-ready` and `catalog-ready` are both still self-reported:
 *   required setup is satisfied, or a catalog lists the model, but neither
 *   proves a real chat turn ever completed. Station's own copy for
 *   `catalog-ready` says as much ("Run an explicit smoke to prove a
 *   complete chat turn."). Both map to `declared`.
 * - `smoke-passed` is the only level backed by a real bounded completion
 *   (`ConnectionSmokeEvidence`, `turnLimit: 1`) — the only one that earns
 *   `confirmed`.
 */
const CONNECTION_EVIDENCE_LEVEL_MAP: Record<
  ConnectionEvidenceLevel,
  EvidenceLevel
> = {
  discovered: 'unavailable',
  'prerequisite-ready': 'declared',
  'catalog-ready': 'declared',
  'smoke-passed': 'confirmed',
};

/** One-rank defensive downgrade applied when the source evidence is not fresh. */
const EVIDENCE_LEVEL_STALE_DOWNGRADE: Record<EvidenceLevel, EvidenceLevel> = {
  confirmed: 'declared',
  declared: 'unavailable',
  unavailable: 'unavailable',
};

const EVIDENCE_RANK: Record<EvidenceLevel, number> = {
  unavailable: 0,
  declared: 1,
  confirmed: 2,
};

/**
 * Dispatch 0.5.0's second eligibility axis, mirrored (station#1398 slice
 * 5.5). `engine.js`'s `fidelityRank`, verbatim.
 */
const FIDELITY_RANK: Record<StructuredToolsFidelity, number> = {
  unavailable: 0,
  prompted: 1,
  native: 2,
};

/**
 * Derives the Dispatch evidence level for one connection.
 *
 * Fails closed to `unavailable` for a `level` outside the known union —
 * defensive only: the type system already excludes this, but a value at
 * this module boundary can still arrive untyped (`any`) from an evidence
 * source this module doesn't control.
 *
 * ### The freshness downgrade is a defensive floor, not the primary
 * honesty mechanism (fix round, SF-1)
 *
 * Given how `connection-readiness-evidence.ts` computes evidence today, the
 * one-rank downgrade below can only actually fire for a stale `catalog-ready`
 * on an **agent-kind** connection:
 * - `smoke-passed` cannot itself be stale. `deriveConnectionReadinessEvidence`
 *   only assigns `level: 'smoke-passed'` when
 *   `smoke.status === 'passed' && smoke.freshness === 'fresh'` — once the
 *   smoke goes stale, the *level* itself reverts to the base level upstream;
 *   this function never sees a `{ level: 'smoke-passed', freshness: 'stale' }`
 *   pair from that producer.
 * - `discovered`/`prerequisite-ready` always report `freshness: 'fresh'`
 *   (the same function's final `freshness` field only varies for
 *   `smoke-passed` or `catalog-ready`).
 * - `catalog-ready` freshness only varies for **agent-kind** connections,
 *   whose `runtimeCatalog.fetchedAt` feeds a five-minute catalog window;
 *   model-kind connections never set that field, so their `catalog-ready`
 *   freshness is always `'fresh'`.
 *
 * The branch stays as a defensive floor in case that upstream invariant
 * ever changes (a future evidence source, or an upstream fix that lets
 * `catalog-ready` go stale on a model connection too) — this function must
 * not silently start reporting a level its caller can no longer trust.
 */
export function mapConnectionEvidenceToDispatchLevel(evidence: {
  level: ConnectionEvidenceLevel;
  freshness: ConnectionEvidenceFreshness;
}): EvidenceLevel {
  const mapped = CONNECTION_EVIDENCE_LEVEL_MAP[evidence.level];
  if (!mapped) return 'unavailable';
  return evidence.freshness === 'fresh'
    ? mapped
    : EVIDENCE_LEVEL_STALE_DOWNGRADE[mapped];
}

/**
 * The `toolSurface` marker `launchable-model-inventory.ts`'s `groupModels()`
 * writes when a model's grouped `supportsTools` unanimously resolves `true`.
 * Kept as a named constant here (rather than a bare string literal) because
 * it is the exact string this module checks for — a typo in either place
 * would silently break the derivation below without either file's own tests
 * noticing.
 */
const TOOL_SURFACE_TOOL_CALLS = 'tool-calls';

/**
 * Derives the candidate's capability strings from its Dispatch evidence
 * level plus (station#1430) the candidate's own model tool-surface. A
 * candidate with no live evidence (`level === 'unavailable'`) asserts no
 * capabilities at all — an unearned capability claim on top of an unearned
 * evidence level would be the same self-assertion defect twice over.
 * `abort`/`usage` are mechanical guarantees of the AI SDK wrapper every
 * candidate is built through (`createAiSdkManagedModel`), so once a
 * connection has earned any live evidence they hold.
 *
 * `structured-tools` is derived only when `toolSurface` is a defined array
 * containing `'tool-calls'` — the exact shape
 * `launchable-model-inventory.ts`'s `groupModels()` writes when a provider
 * adapter's `supportsTools` unanimously resolved `true` for this model
 * (station#1430 closed the producer gap #1426 found: bedrock/ollama/openai-
 * compat/anthropic/google now set `supportsTools` only where their own
 * catalog API genuinely reports it, leaving it `undefined` — "unknown" —
 * everywhere else). `toolSurface: null` (unknown) and `toolSurface: []`
 * (known: does not support tools) both correctly fall through to no
 * `structured-tools` claim; only an affirmative signal derives it. A
 * candidate with no wired tool-surface source (`toolSurface` argument
 * omitted entirely) behaves exactly as this function did before #1430 —
 * `abort`/`usage` only — so every call site that hasn't been updated to pass
 * one keeps its prior, honest behavior rather than silently regressing.
 */
export function deriveDispatchCapabilities(
  level: EvidenceLevel,
  toolSurface?: readonly string[] | null,
): readonly string[] {
  if (level === 'unavailable') return [];
  return toolSurface?.includes(TOOL_SURFACE_TOOL_CALLS)
    ? ['abort', 'usage', 'structured-tools']
    : ['abort', 'usage'];
}

const STRUCTURED_TOOLS_CAPABILITY = 'structured-tools';

/**
 * Dispatch 0.5.0's companion to the `structured-tools` capability string
 * (station#1398 slice 5.5).
 *
 * ### Why this exists at all, and why it takes the capability LIST
 *
 * 0.5.0's `eligible()` refuses any candidate whose evidence is
 * self-inconsistent on this axis: a `capabilities` list naming
 * `structured-tools` alongside an absent (therefore `'unavailable'`)
 * `structuredToolsFidelity` is ineligible for EVERY plan — including one
 * with no policy at all. That is exactly the shape station#1430's derivation
 * produced, so at 0.2.0→0.5.0 every Station candidate whose model catalog
 * genuinely reported native tool calling would have silently stopped
 * routing. The conformance tripwire's R3-a hardening is what caught it.
 *
 * Deriving from the already-derived capability list — rather than
 * re-deriving from `(level, toolSurface)` — makes the consistency
 * structural. Two functions reading the same inputs can drift; a function
 * reading the other's output cannot.
 *
 * ### Why `'native'` and not `'prompted'`
 *
 * The only signal behind `structured-tools` is a provider's own catalog
 * reporting native tool calling (today: Ollama's `/api/show` `capabilities`
 * containing `tools`; every other adapter deliberately leaves
 * `supportsTools` unset per station#1430). Station never emulates tool use
 * through prompt scaffolding, so `'prompted'` would name a mechanism that
 * does not exist here. It would also be actively harmful rather than merely
 * conservative: Dispatch defaults `minimumStructuredToolsFidelity` to
 * `'native'` whenever `structured-tools` is required, so claiming
 * `'prompted'` would make every `requiredCapabilities: ['structured-tools']`
 * policy exclude every Station candidate.
 *
 * This adds no claim the capability string did not already make — the
 * STRENGTH of that claim is carried by `evidence.level`, which is graded by
 * the connection-readiness ladder and is what a policy's `minimumEvidence`
 * gates on.
 */
export function deriveStructuredToolsFidelity(
  capabilities: readonly string[],
): StructuredToolsFidelity {
  return capabilities.includes(STRUCTURED_TOOLS_CAPABILITY)
    ? 'native'
    : 'unavailable';
}

/**
 * One candidate's `CapabilityEvidence` capability half, derived once so the
 * capability list and its fidelity can never be written out of step.
 */
function capabilityShape(
  level: EvidenceLevel,
  toolSurface?: readonly string[] | null,
): Pick<CapabilityEvidence, 'capabilities' | 'structuredToolsFidelity'> {
  const capabilities = deriveDispatchCapabilities(level, toolSurface);
  return {
    capabilities,
    structuredToolsFidelity: deriveStructuredToolsFidelity(capabilities),
  };
}

/**
 * Derives one candidate's `CapabilityEvidence` from its connection's
 * readiness evidence, or the honest `unavailable` floor when there is none
 * (connection unknown to the evidence source, or the source itself
 * unavailable — see `fetchReadinessEvidenceMap`). `toolSurface` (station#1430)
 * is this candidate's own bound model's `LaunchableModelRecord.toolSurface`,
 * resolved by `fetchModelToolSurfaceList` — omitted (not just empty) when no
 * tool-surface source is wired at all.
 */
export function candidateEvidenceFromReadiness(
  readiness: ConnectionReadinessEvidence | undefined,
  toolSurface?: readonly string[] | null,
): CapabilityEvidence {
  if (!readiness) return UNAVAILABLE_EVIDENCE;
  const level = mapConnectionEvidenceToDispatchLevel(readiness);
  return {
    level,
    ...capabilityShape(level, toolSurface),
    source: EVIDENCE_SOURCE_ID,
  };
}

/**
 * Resolves live per-candidate tool-surface evidence for `structured-tools`
 * derivation (station#1430), mirroring `fetchReadinessEvidenceMap`'s
 * contract one level down:
 *
 * - No source wired, or no bindings requested → a defined, all-`null` array
 *   (cacheable — "nothing to derive from," not a failure).
 * - `source.getModelToolSurface` absent (an older/test `DispatchEvidenceSource`
 *   that predates this method) → the same defined, all-`null` array. This is
 *   the ONLY thing that keeps every pre-#1430 `DispatchEvidenceSource` test
 *   double a valid, unchanged fixture: the optional method's absence must
 *   read identically to "this source has nothing to say about tool surface,"
 *   never a crash.
 * - A malformed response (wrong length) or a thrown lookup failure →
 *   `undefined`, distinct from the above, so `createTtlCachedCandidateResolver`
 *   does not cache a failure for the TTL window (same MB-1 discipline as
 *   `fetchReadinessEvidenceMap`).
 */
export async function fetchModelToolSurfaceList(
  source: DispatchEvidenceSource | undefined,
  bindings: readonly { connectionId: string; modelId: string }[],
  logger: Logger | undefined,
  agentName: string,
): Promise<ReadonlyArray<readonly string[] | null> | undefined> {
  if (!source?.getModelToolSurface || bindings.length === 0) {
    return bindings.map(() => null);
  }
  try {
    const result = await source.getModelToolSurface(bindings);
    if (result.length !== bindings.length) {
      throw new Error(
        `Model tool-surface source returned ${result.length} entries for ${bindings.length} candidates.`,
      );
    }
    return result;
  } catch (error) {
    logger?.warn(
      `[dispatch] Model tool-surface lookup failed for agent '${agentName}'; no candidate will derive the 'structured-tools' capability for this turn.`,
      { error: error instanceof Error ? error.message : String(error) },
    );
    return undefined;
  }
}

/**
 * Resolves live readiness evidence for every candidate connection in ONE
 * batched call (fix round, SF-5) — the earlier per-candidate design drove
 * one full `ConnectionService.listConnections()` discovery pass (including
 * health probes) per Dispatch candidate. A candidate set is small and
 * bounded, so this resolves once per call instead of once per candidate.
 * station#1431: the caller (`createTtlCachedCandidateResolver`) invokes this
 * once per `DISPATCH_EVIDENCE_TTL_MS` window over the life of the built
 * Dispatch model, not once per Dispatch invocation and not once for the
 * model's entire lifetime — SF-5's batching guarantee (one call per
 * resolution, covering every candidate connection) is unchanged either way.
 *
 * Never throws (fix round, SF-2): a concurrent connection-inventory
 * invalidation (`ConnectionService`'s "Model inventory generation is
 * obsolete." race) or any other lookup failure degrades every candidate to
 * `unavailable` — an evidence lookup that can't complete must never fail
 * model construction, only leave the model ungraded.
 *
 * Returns `undefined` on a lookup failure, distinct from the `new Map()` it
 * returns for a legitimately-empty result (no source wired, or no
 * connection ids requested) — station#1431 review round (MB-1). The two
 * outcomes look identical to a naive caller ("nothing came back"), but they
 * must not be treated identically by `createTtlCachedCandidateResolver`: a
 * legitimately empty map is a valid grade worth caching for the TTL window;
 * a failed lookup is not — caching a transient failure would turn one
 * "Model inventory generation is obsolete." race into every candidate
 * reading `unavailable` for a full TTL window even after the source
 * recovers on the very next call.
 */
export async function fetchReadinessEvidenceMap(
  source: DispatchEvidenceSource | undefined,
  connectionIds: readonly string[],
  logger: Logger | undefined,
  agentName: string,
): Promise<ReadonlyMap<string, ConnectionReadinessEvidence> | undefined> {
  const uniqueIds = [...new Set(connectionIds)];
  if (!source || uniqueIds.length === 0) return new Map();
  try {
    return await source.getConnectionReadinessEvidence(uniqueIds);
  } catch (error) {
    logger?.warn(
      `[dispatch] Connection readiness evidence lookup failed for agent '${agentName}'; every candidate will grade as 'unavailable' for this Dispatch model.`,
      { error: error instanceof Error ? error.message : String(error) },
    );
    return undefined;
  }
}

/**
 * Defensive loud path (fix round, MB-2/M-1b): a Dispatch policy that
 * actually depends on live evidence (a `minimumEvidence` above the default
 * `'unavailable'`, or any `requiredCapabilities`) is silently inert on a
 * call path with no `dispatchEvidenceSource` wired — every candidate grades
 * `unavailable` and the policy excludes them all. That outcome is correct
 * and honest, but silent; this makes it audible to whoever operates the
 * agent.
 *
 * Falls back to `moduleLogger` when `config.logger` is absent (fix round 3,
 * M-1b) — deliberately, not merely defensively: this is precisely the case
 * this warning exists for. An `AgentCreationConfig` with no
 * `dispatchEvidenceSource` wired is, in this codebase today, also one with
 * no `logger` wired (both come from the same threading), so gating the
 * warning on `config.logger` made it fire only where a source (and
 * therefore no problem) was already present, and stay silent on every call
 * path that actually needed it.
 */
function warnIfPolicyNeedsEvidenceSource(
  spec: AgentSpec,
  config: AgentCreationConfig,
  policy: DispatchPolicyConfig | undefined,
): void {
  if (!policy || config.dispatchEvidenceSource) return;
  const minimumEvidence = policy.minimumEvidence ?? 'unavailable';
  const requiredCapabilities = policy.requiredCapabilities ?? [];
  const needsEvidence =
    minimumEvidence !== 'unavailable' || requiredCapabilities.length > 0;
  if (!needsEvidence) return;
  (config.logger ?? moduleLogger).warn(
    `[dispatch] Agent '${spec.name}' configures a Dispatch policy (minimumEvidence='${minimumEvidence}', requiredCapabilities=${JSON.stringify(requiredCapabilities)}) but this call path has no live connection-evidence source wired. Every candidate will grade as 'unavailable' and the policy will exclude them all.`,
  );
}

/** True when two capability lists name the same strings in the same order (`deriveDispatchCapabilities` always emits a fixed order, so this needn't sort). */
function capabilitiesEqual(
  a: readonly string[],
  b: readonly string[],
): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/**
 * Legibility (fix round, SF-3): Dispatch's own eligibility filter
 * (`@kontourai/dispatch`'s engine) is silent about WHY a candidate didn't
 * make it into the routable set — a caller only ever sees
 * `'no-eligible-candidates'` on the terminal receipt. This replicates that
 * filter's read-only predicate purely to log the reason, naming the
 * connection id and the derived level vs. the required one, so an operator
 * can see why a model stopped routing.
 *
 * Change feed, not a per-window repeat (station#1431 review round, SF-2):
 * with evidence re-graded every TTL window instead of once at agent
 * (re)build, logging every excluded candidate on every resolution would
 * repeat an identical line ~1,440 times/day per persistently-excluded
 * candidate (`24h / DISPATCH_EVIDENCE_TTL_MS`). `previousCandidates` is the
 * grade this same candidate set carried into the previous successfully
 * cached window (`undefined` on the very first resolution, or if every
 * resolution so far has failed — see `createTtlCachedCandidateResolver`). A
 * candidate that stays excluded is logged only when this is the first
 * resolution for it, or its `(level, capabilities)` differs from that
 * previous grade — an unchanged repeatedly-excluded candidate produces
 * exactly one line, not one per window, while an actual change (including a
 * transient failure dip) still surfaces immediately, with the prior level
 * named so the log line reads as a change-feed entry rather than a bare
 * repeat.
 *
 * Recovery is also named, not just decline (station#1431 review round,
 * R-1): a candidate that WAS excluded (below `minimum`, or missing a
 * required capability) last window and now clears both gates gets its own
 * `'admitted'` line naming the prior level — logging only exclusions would
 * make an excluded→admitted transition invisible (nothing in the exclusion
 * branch fires once a candidate is no longer excluded), and by extension
 * would make a transient failure dip's own recovery invisible too: the dip
 * attempt never writes `cache` (see `createTtlCachedCandidateResolver`), so
 * the window where evidence returns to its pre-dip level is diffed against
 * that same pre-dip grade and would otherwise look unchanged. The admitted
 * line fires exactly once per transition — the following window's
 * `previousCandidates` reflects the now-admitted grade, so an unchanged
 * still-admitted candidate stays silent.
 */
function logExcludedCandidates(
  logger: Logger | undefined,
  agentName: string,
  candidates: readonly GradedDispatchCandidate[],
  policy: DispatchPolicyConfig | undefined,
  bindings: readonly ResolvedManagedModelBinding[],
  previousCandidates: readonly GradedDispatchCandidate[] | undefined,
): void {
  if (!logger) return;
  const minimum = policy?.minimumEvidence ?? 'unavailable';
  const required = policy?.requiredCapabilities ?? [];
  const previousById = new Map(
    (previousCandidates ?? []).map((candidate) => [candidate.id, candidate]),
  );
  // station#1398 slice 5.5: this used to keep its OWN copy of the
  // eligibility predicate, which meant the 0.5.0 fidelity clauses would have
  // had to be added in two places to stay honest. There is now exactly one
  // replica (`admissionOf`), and both message-producing call sites read it.
  const isExcluded = (evidence: CapabilityEvidence): boolean =>
    !isAdmitted(evidence, policy);

  candidates.forEach((candidate, index) => {
    const previous = previousById.get(candidate.id);
    const connectionId = bindings[index]?.providerConnection.id ?? 'unknown';

    if (isExcluded(candidate.evidence)) {
      const unchangedSincePreviousWindow =
        previous !== undefined &&
        previous.evidence.level === candidate.evidence.level &&
        capabilitiesEqual(
          previous.evidence.capabilities,
          candidate.evidence.capabilities,
        );
      if (unchangedSincePreviousWindow) return;

      const changeSuffix = previous
        ? ` (was '${previous.evidence.level}')`
        : '';
      // station#1430 review, L-1 message priority — now decided once, inside
      // `admissionOf`, instead of re-derived here (station#1398 slice 5.5).
      const { refusal } = admissionOf(candidate.evidence, policy);
      if (refusal === 'missing-capabilities') {
        const missing = required.filter(
          (capability) => !candidate.evidence.capabilities.includes(capability),
        );
        logger.info(
          `[dispatch] Candidate '${candidate.id}' excluded from routing for agent '${agentName}': connection '${connectionId}' is missing required capabilities [${missing.join(', ')}] (has [${candidate.evidence.capabilities.join(', ')}])${changeSuffix}.`,
        );
        return;
      }
      if (refusal === 'fidelity-below-minimum') {
        logger.info(
          `[dispatch] Candidate '${candidate.id}' excluded from routing for agent '${agentName}': connection '${connectionId}' offers '${candidate.evidence.structuredToolsFidelity ?? 'unavailable'}' structured-tool support, policy requires at least '${structuredToolsFidelityFloor(policy)}'${changeSuffix}.`,
        );
        return;
      }
      if (refusal === 'fidelity-inconsistent') {
        logger.info(
          `[dispatch] Candidate '${candidate.id}' excluded from routing for agent '${agentName}': connection '${connectionId}' reported capabilities [${candidate.evidence.capabilities.join(', ')}] alongside structured-tool support '${candidate.evidence.structuredToolsFidelity ?? 'unavailable'}', which the router refuses as self-inconsistent evidence${changeSuffix}.`,
        );
        return;
      }
      logger.info(
        `[dispatch] Candidate '${candidate.id}' excluded from routing for agent '${agentName}': connection '${connectionId}' evidence is '${candidate.evidence.level}', policy requires at least '${minimum}'${changeSuffix}.`,
      );
      return;
    }

    // R-1: not excluded now — name the recovery when it WAS excluded last
    // window, so the change feed covers admission as well as exclusion.
    if (previous && isExcluded(previous.evidence)) {
      logger.info(
        `[dispatch] Candidate '${candidate.id}' admitted for agent '${agentName}': connection '${connectionId}' evidence is '${candidate.evidence.level}' (was '${previous.evidence.level}').`,
      );
    }
  });
}

/** The evidence-independent half of one candidate's plan entry (#1431). */
interface DispatchCandidateShell {
  id: string;
  runtimeId: string;
  estimatedUsdPer1kTokens?: number;
}

/** Identifies the producer of every fleet candidate's `CapabilityEvidence`. */
const FLEET_EVIDENCE_SOURCE_ID = 'station:peer-fleet-manifest/v1';

/**
 * One fleet candidate's plan entry. Fixed at model construction because
 * Dispatch's runtime registry is (`createAiSdkDispatchModel` takes `models`
 * once); the GRADE behind it is re-resolved every TTL window like every
 * local candidate's, and a contribution that appears after this set was
 * built is reported as `not-in-resolved-set` rather than silently ignored.
 */
interface FleetCandidateShell extends DispatchCandidateShell {
  environmentId: string;
  environmentLabel: string | null;
  modelId: string;
  displayName: string;
}

/** What the envelope needs about one resolution, kept beside the plan. */
interface FleetRoutingSnapshot {
  candidates: FleetRoutingCandidate[];
  exclusions: FleetRoutingExclusion[];
}

/** A routing snapshot plus the exact authorized turn that produced it. */
interface PendingFleetRouting {
  routing: FleetRoutingSnapshot;
  correlation?: AuthorizedFleetDispatchBegin;
}

interface ResolvedPlanCandidates {
  candidates: GradedDispatchCandidate[];
  /** `null` when this agent did not opt into fleet routing. */
  routing: FleetRoutingSnapshot | null;
}

interface FleetPlanContext {
  routing: DispatchFleetRouting;
  shells: FleetCandidateShell[];
  order: 'after-local' | 'before-local';
}

/**
 * Binds Dispatch's otherwise content-only plan identity to one authorized
 * Station turn. Dispatch exposes only `planDigest` to its receipt callback,
 * and identical concurrent prompts legitimately share that digest. Qualifying
 * the opaque candidate ids with the server-minted correlation makes the
 * receipt's digest unique *because of the already-authorized coordinate*;
 * the callback never guesses a session from a digest, timestamp, name, or
 * array position.
 *
 * Runtime ids remain unchanged: they identify the installed model instance,
 * not one invocation. Every envelope-side candidate and exclusion is cloned
 * with the same qualified ids, so the embedded Dispatch receipt continues to
 * join selection to the exact candidate it actually invoked.
 */
function bindRoutingToAuthorizedTurn(
  resolved: ResolvedPlanCandidates,
  correlation: AuthorizedTurnCorrelation,
): ResolvedPlanCandidates {
  if (!resolved.routing) return resolved;

  const qualifiedIds = new Map<string, string>();
  const qualify = (candidateId: string): string => {
    const existing = qualifiedIds.get(candidateId);
    if (existing) return existing;
    const qualified = `${candidateId}:turn:${correlation.correlationId}`;
    qualifiedIds.set(candidateId, qualified);
    return qualified;
  };

  // Include all considered records first: withdrawn/refused candidates are
  // deliberately absent from Dispatch's executable candidates but still
  // appear in exclusions and must retain the same exact identity there.
  for (const candidate of resolved.routing.candidates) {
    qualify(candidate.candidateId);
  }
  for (const candidate of resolved.candidates) qualify(candidate.id);

  return {
    candidates: resolved.candidates.map((candidate) => ({
      ...candidate,
      id: qualify(candidate.id),
    })),
    routing: {
      candidates: resolved.routing.candidates.map((candidate) => ({
        ...candidate,
        candidateId: qualify(candidate.candidateId),
      })),
      exclusions: resolved.routing.exclusions.map((exclusion) => ({
        ...exclusion,
        ...(exclusion.candidateId
          ? { candidateId: qualify(exclusion.candidateId) }
          : {}),
      })),
    },
  };
}

/**
 * Composite key for one contributed model on one peer.
 *
 * The separator is written as the `\\u0000` ESCAPE, never as a literal NUL
 * byte (security review, M-5). A literal control character makes the whole
 * source file `data` to file(1) and invisible to `git grep -I`, which is how
 * the repo's own zero-tolerance content gates skip it — a source file that
 * silently opts out of the scanners is a place things hide.
 * `scripts/rename-inventory.mjs` now fails on any such byte. NUL remains the
 * right separator (it cannot occur in an environment id or a model id, so
 * the key stays unambiguous); only its spelling was wrong.
 */
function fleetKey(environmentId: string, modelId: string): string {
  return `${environmentId}\u0000${modelId}`;
}

/**
 * Dispatch's own eligibility predicate, replicated read-only so the receipt
 * can record `admitted` per candidate and name every exclusion. Dispatch
 * reports only `'no-eligible-candidates'` on the terminal receipt, which is
 * the gap §3.4 records: exclusion reasoning has no channel there at any
 * version.
 */
function isAdmitted(
  evidence: CapabilityEvidence,
  policy: DispatchPolicyConfig | undefined,
): boolean {
  return admissionOf(evidence, policy).admitted;
}

/**
 * Why a candidate did not clear the replicated predicate. Named so the two
 * message-producing call sites (`logExcludedCandidates` and
 * `withPolicyExclusions`) branch on a decision rather than each
 * re-deriving one from the evidence — the drift that station#1430's L-1
 * review round already had to correct once.
 */
type AdmissionRefusal =
  | 'evidence-level'
  | 'missing-capabilities'
  | 'fidelity-below-minimum'
  | 'fidelity-inconsistent';

interface AdmissionVerdict {
  admitted: boolean;
  refusal: AdmissionRefusal | null;
}

/**
 * Dispatch's own eligibility predicate, replicated read-only. Dispatch
 * reports only `'no-eligible-candidates'` on the terminal receipt, which is
 * the gap §3.4 records: exclusion reasoning has no channel there at any
 * version.
 *
 * **This is a REPLICA and must track the engine, version by version.** It is
 * `engine.js`'s `eligible()` at @kontourai/dispatch 0.5.0, condition for
 * condition and in the same order. The 0.2.0 → 0.5.0 bump added the whole
 * `structuredToolsFidelity` half below, and nothing but the conformance
 * tripwire (`dispatch-model-policy.test.ts` S-1, hardening R3-a) would have
 * told us: a divergence here does not throw, it produces an operator-facing
 * log line and a receipt `admitted` flag that disagree with what the router
 * actually did.
 *
 * The refusal reasons are ordered the way an operator needs them, which is
 * not the order the engine evaluates them: the ROOT cause first. An
 * insufficient evidence level also mechanically fails every capability
 * requirement (`deriveDispatchCapabilities` returns `[]` at `unavailable`),
 * so reporting the capability is true and useless.
 */
function admissionOf(
  evidence: CapabilityEvidence,
  policy: DispatchPolicyConfig | undefined,
): AdmissionVerdict {
  const minimum = policy?.minimumEvidence ?? 'unavailable';
  const required = policy?.requiredCapabilities ?? [];
  const fidelity = evidence.structuredToolsFidelity ?? 'unavailable';
  const claimsStructuredTools = evidence.capabilities.includes(
    STRUCTURED_TOOLS_CAPABILITY,
  );
  // Dispatch's default: requiring the capability requires NATIVE fidelity
  // unless the policy names a lower bar.
  const minimumFidelity =
    policy?.minimumStructuredToolsFidelity ??
    (required.includes(STRUCTURED_TOOLS_CAPABILITY) ? 'native' : undefined);

  // --- `eligible()` at 0.5.0, clause for clause. Nothing else decides
  // admission; the reason below is only how the refusal gets WORDED.
  const levelClears = EVIDENCE_RANK[evidence.level] >= EVIDENCE_RANK[minimum];
  const capabilitiesClear = required.every((capability) =>
    evidence.capabilities.includes(capability),
  );
  const fidelityIsKnown = fidelity in FIDELITY_RANK;
  // Consistency cuts BOTH ways in the engine: a candidate claiming
  // `structured-tools` without a real fidelity is refused, and so is one
  // carrying a fidelity it never claimed the capability for.
  const fidelityIsConsistent = claimsStructuredTools
    ? fidelity === 'prompted' || fidelity === 'native'
    : fidelity === 'unavailable';
  const fidelityClearsMinimum =
    minimumFidelity === undefined ||
    FIDELITY_RANK[fidelity] >= FIDELITY_RANK[minimumFidelity];

  if (
    levelClears &&
    capabilitiesClear &&
    fidelityIsKnown &&
    fidelityIsConsistent &&
    fidelityClearsMinimum
  ) {
    return { admitted: true, refusal: null };
  }

  // --- Reason, ordered by ROOT cause rather than by the engine's evaluation
  // order (station#1430 review, L-1). An insufficient evidence level ALSO
  // mechanically fails every capability requirement — `deriveDispatchCapabilities`
  // returns `[]` at `unavailable` — so naming the capability would be true
  // and useless. `level === 'unavailable'` is checked explicitly, not just
  // by rank: the default `minimumEvidence` is itself `'unavailable'`, so an
  // ungraded candidate clears that bar by rank (`0 >= 0`) while being unable
  // to have derived any capability at all.
  if (!levelClears || evidence.level === 'unavailable') {
    return { admitted: false, refusal: 'evidence-level' };
  }
  if (!capabilitiesClear) {
    return { admitted: false, refusal: 'missing-capabilities' };
  }
  // Station derives capabilities and fidelity from one place
  // (`capabilityShape`), so an inconsistency here means the evidence was
  // built outside that path — a Station defect, not an operator-actionable
  // state, which is exactly why it gets its own words instead of being
  // absorbed into a misleading "missing capabilities".
  if (!fidelityIsKnown || !fidelityIsConsistent) {
    return { admitted: false, refusal: 'fidelity-inconsistent' };
  }
  return { admitted: false, refusal: 'fidelity-below-minimum' };
}

/**
 * The structured-tool fidelity floor a policy actually imposes, including
 * Dispatch's implicit `'native'` default. Named so an operator-facing
 * message can state the bar the router applied rather than the (often
 * absent) field the config declared.
 */
function structuredToolsFidelityFloor(
  policy: DispatchPolicyConfig | undefined,
): StructuredToolsFidelity {
  return (
    policy?.minimumStructuredToolsFidelity ??
    (policy?.requiredCapabilities?.includes(STRUCTURED_TOOLS_CAPABILITY)
      ? 'native'
      : 'unavailable')
  );
}

/**
 * Builds the fleet half of a plan's candidate shells and the AI SDK models
 * behind them. One shell per contributed model on one peer.
 */
function buildFleetCandidateShells(
  candidates: readonly FleetCandidate[],
): FleetCandidateShell[] {
  return candidates.map((candidate, index) => ({
    id: `fleet-candidate-${index}`,
    runtimeId: `fleet-runtime-${index}`,
    environmentId: candidate.environmentId,
    environmentLabel: candidate.environmentLabel,
    modelId: candidate.modelId,
    displayName: candidate.displayName,
  }));
}

/**
 * `ExecutionCandidate` with `evidence` narrowed to required — every
 * candidate this module builds is always graded (§`candidateEvidenceFromReadiness`
 * never omits it), so downstream helpers like `logExcludedCandidates` can
 * rely on it being present instead of re-checking `undefined`.
 */
type GradedDispatchCandidate = ExecutionCandidate & {
  evidence: CapabilityEvidence;
};

/**
 * Derives every candidate's shell: id, runtimeId, and estimated cost. Split
 * out from evidence grading (#1431) so the TTL-cached resolver below only
 * has to redo the part that can actually change between calls.
 */
function buildDispatchCandidateShells(
  bindings: readonly ResolvedManagedModelBinding[],
  configured: readonly DispatchCandidateConfig[],
): readonly DispatchCandidateShell[] {
  return bindings.map((_binding, index) => {
    const estimatedUsdPer1kTokens =
      index === 0 ? undefined : configured[index - 1]?.estimatedUsdPer1kTokens;
    return {
      id: `candidate-${index}`,
      runtimeId: `runtime-${index}`,
      ...(estimatedUsdPer1kTokens !== undefined
        ? { estimatedUsdPer1kTokens }
        : {}),
    };
  });
}

/**
 * Grades one set of candidate shells against a freshly-resolved evidence
 * map, producing the full `ExecutionCandidate[]` for a Dispatch plan.
 */
function gradeDispatchCandidates(
  shells: readonly DispatchCandidateShell[],
  bindings: readonly ResolvedManagedModelBinding[],
  evidenceByConnection: ReadonlyMap<string, ConnectionReadinessEvidence>,
  toolSurfaceByIndex: ReadonlyArray<readonly string[] | null>,
): GradedDispatchCandidate[] {
  return shells.map((shell, index) => ({
    ...shell,
    evidence: candidateEvidenceFromReadiness(
      evidenceByConnection.get(bindings[index]!.providerConnection.id),
      toolSurfaceByIndex[index] ?? null,
    ),
  }));
}

/**
 * Builds the lazy, TTL-cached candidate resolver passed to
 * `createAiSdkDispatchModel` as the function form of `plan` (#1431).
 *
 * `@kontourai/dispatch/ai-sdk` awaits `options.plan(request)` on every
 * invocation when `plan` is a function, so this closure runs once per
 * Dispatch call. Within `DISPATCH_EVIDENCE_TTL_MS` of the last successful
 * resolution it returns the cached candidates (no evidence-source call at
 * all); once the window elapses it re-resolves through
 * `fetchReadinessEvidenceMap` — still ONE batched call across every
 * candidate connection (#1426 SF-5), just repeated per TTL window instead
 * of once for the life of the built model.
 *
 * The outer try/catch is the lazy path's own fail-soft floor (#1431): it is
 * deliberately redundant with `fetchReadinessEvidenceMap`'s internal
 * catch — a per-request resolver must never let ANY failure during
 * re-grading reject the plan promise and break the turn, whether that
 * failure originates in the evidence source itself (already handled inside
 * `fetchReadinessEvidenceMap`) or in this function's own bookkeeping. On
 * any throw, every candidate grades `unavailable` for that call.
 *
 * MB-1 (station#1431 review round): a *failed* resolution — whether from
 * this catch, or from `fetchReadinessEvidenceMap` itself returning
 * `undefined` on a caught source rejection — is deliberately NOT cached.
 * `fetchReadinessEvidenceMap`'s own error handling already swallows the
 * rejection into a return value, so without this distinction the resolver's
 * try-block below would complete normally, grade everything `unavailable`,
 * and cache THAT for the full TTL — turning one transient "Model inventory
 * generation is obsolete." race into every candidate reading `unavailable`
 * for up to 60s even after the source recovers on its very next call. Only
 * a defined (possibly legitimately empty) evidence map is cached; the next
 * call after a failure retries the source rather than replaying the
 * failure for the rest of the window.
 *
 * SF-1 (station#1431 review round): concurrent invocations that both land
 * past the TTL share ONE in-flight resolution instead of each starting
 * their own — without this, N callers racing in after expiry would each
 * independently call `fetchReadinessEvidenceMap`, stampeding
 * `listConnections()` (health probes and all) N times instead of once.
 * `inFlight` holds the shared promise for the duration of one resolution
 * attempt; concurrent callers reuse it, and it is cleared in `finally` so
 * the next genuinely-new resolution starts a fresh attempt.
 */
function createTtlCachedCandidateResolver(
  spec: AgentSpec,
  config: AgentCreationConfig,
  policy: DispatchPolicyConfig | undefined,
  bindings: readonly ResolvedManagedModelBinding[],
  shells: readonly DispatchCandidateShell[],
  fleet: FleetPlanContext | null,
): () => Promise<ResolvedPlanCandidates> {
  const connectionIds = bindings.map(
    (binding) => binding.providerConnection.id,
  );
  const toolSurfaceBindings = bindings.map((binding) => ({
    connectionId: binding.providerConnection.id,
    modelId: binding.modelId,
  }));
  let cache: {
    resolved: ResolvedPlanCandidates;
    expiresAt: number;
  } | null = null;
  let inFlight: Promise<ResolvedPlanCandidates> | null = null;

  return function resolveDispatchCandidates(): Promise<ResolvedPlanCandidates> {
    const now = Date.now();
    if (cache && now < cache.expiresAt) {
      return Promise.resolve(cache.resolved);
    }
    if (inFlight) return inFlight;

    // SF-2: the grade this candidate set carried into the previous
    // successfully cached window, snapshotted before this attempt can
    // possibly overwrite `cache` — the change-feed diff base for
    // `logExcludedCandidates`. `undefined` on the first-ever resolution, or
    // if every resolution so far has failed (a failure never writes
    // `cache`, so the last real grade — if any — is still what's held).
    const previousCandidates = cache?.resolved.candidates;

    inFlight = (async () => {
      try {
        const [evidenceByConnection, toolSurfaceByIndex] = await Promise.all([
          fetchReadinessEvidenceMap(
            config.dispatchEvidenceSource,
            connectionIds,
            config.logger,
            spec.name,
          ),
          fetchModelToolSurfaceList(
            config.dispatchEvidenceSource,
            toolSurfaceBindings,
            config.logger,
            spec.name,
          ),
        ]);
        const localCandidates = gradeDispatchCandidates(
          shells,
          bindings,
          evidenceByConnection ?? new Map(),
          toolSurfaceByIndex ?? bindings.map(() => null),
        );
        logExcludedCandidates(
          config.logger,
          spec.name,
          localCandidates,
          policy,
          bindings,
          previousCandidates,
        );

        const fleetResolved = fleet
          ? await resolveFleetPlanHalf(fleet, policy)
          : null;
        // Withdrawn shells are deliberately absent from `planCandidates`
        // (security review, M-3): offering Dispatch a candidate whose peer has
        // stopped contributing spends an attempt to earn a
        // `model-not-contributed` refusal. They are still fully present in the
        // receipt as `admitted: false` with a `capability-withdrawn`
        // exclusion, which is the difference between not routing to something
        // and hiding it.
        const candidates = fleetResolved
          ? fleet!.order === 'before-local'
            ? [...fleetResolved.planCandidates, ...localCandidates]
            : [...localCandidates, ...fleetResolved.planCandidates]
          : localCandidates;

        const routing = fleetResolved
          ? {
              candidates: mergeRoutingCandidateRecords(
                localRoutingRecords(localCandidates, bindings, policy),
                fleetResolved.records,
                fleet!.order,
              ),
              exclusions: fleetResolved.exclusions,
            }
          : null;
        const resolved: ResolvedPlanCandidates = withPolicyExclusions(
          { candidates, routing },
          policy,
        );

        // MB-1: only a defined result FROM BOTH sources — success, even if
        // legitimately empty — earns a cached grade. `undefined` from
        // either means that lookup failed; do not pin that failure for a
        // full TTL window (station#1430: a tool-surface lookup failure must
        // not get frozen in any more than a readiness-evidence one does).
        if (evidenceByConnection && toolSurfaceByIndex) {
          cache = { resolved, expiresAt: now + DISPATCH_EVIDENCE_TTL_MS };
        }
        return resolved;
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        config.logger?.warn(
          `[dispatch] Candidate evidence re-grade failed for agent '${spec.name}'; every candidate will grade as 'unavailable' for this turn.`,
          { error: reason },
        );
        // Security review, H-1(c): this path used to drop the whole fleet half
        // and return `routing: null` — every fleet capability removed from the
        // turn with no diagnostic anywhere, which is §4.5's first banned
        // behavior occurring inside the module whose docblock claims the shape
        // is unrepresentable. The failure is now a NAMED exclusion per known
        // peer model, and a routing snapshot still exists so an envelope is
        // still written for the turn.
        const failedLocal = shells.map((shell) => ({
          ...shell,
          evidence: UNAVAILABLE_EVIDENCE,
        }));
        return {
          candidates: failedLocal,
          routing: fleet
            ? {
                candidates: [
                  ...localRoutingRecords(failedLocal, bindings, policy),
                  ...fleet.shells.map(
                    (shell): FleetRoutingCandidate => ({
                      candidateId: shell.id,
                      runtimeId: shell.runtimeId,
                      origin: 'fleet',
                      environmentId: shell.environmentId,
                      environmentLabel: shell.environmentLabel,
                      modelId: shell.modelId,
                      evidence: {
                        level: 'unavailable',
                        provenance: 'peer-attested',
                        label: FLEET_PEER_ATTESTED_EVIDENCE_LABEL,
                        peerAttested: null,
                        probe: null,
                      },
                      admitted: false,
                    }),
                  ),
                ],
                exclusions: fleetResolutionFailedExclusions(fleet, reason),
              }
            : null,
        };
      } finally {
        inFlight = null;
      }
    })();

    return inFlight;
  };
}

interface FleetResolvedHalf {
  /**
   * The fleet candidates OFFERED to Dispatch. Withdrawn shells are absent
   * (security review, M-3) — see {@link records} for the full considered set.
   */
  planCandidates: GradedDispatchCandidate[];
  /**
   * Every fleet shell, admitted or not, as receipt records. The considered set
   * the envelope publishes is this, not {@link planCandidates}: "not offered
   * to the router" and "not shown to the operator" are different things, and
   * only the first is ever correct.
   */
  records: FleetRoutingCandidate[];
  exclusions: FleetRoutingExclusion[];
}

/**
 * The named exclusion for a fleet resolution this Station could not complete
 * (security review, H-1(c)). One per known peer model, because the operator's
 * question is "why is my workstation not being used" and the answer is about
 * this Station, not about that peer — plus a fleet-scoped record when the
 * candidate set is empty so the failure is never invisible.
 */
function fleetResolutionFailedExclusions(
  fleet: FleetPlanContext,
  reason: string,
): FleetRoutingExclusion[] {
  const detail = `This Station could not complete a fleet resolution for this turn (${reason}), so what the fleet currently offers is unknown, not empty.`;
  if (fleet.shells.length === 0) {
    return [
      {
        candidateId: null,
        environmentId: null,
        environmentLabel: null,
        modelId: null,
        code: 'resolution-failed',
        message: detail,
        source: 'station',
      },
    ];
  }
  return fleet.shells.map((shell) => ({
    candidateId: shell.id,
    environmentId: shell.environmentId,
    environmentLabel: shell.environmentLabel,
    modelId: shell.modelId,
    code: 'resolution-failed',
    message: detail,
    source: 'station',
  }));
}

/**
 * Re-resolves every peer's manifest for this TTL window and re-grades the
 * fixed fleet shells against it (#1431's requirement, applied to the fleet
 * half: a peer's grade must re-resolve rather than stay frozen at model
 * construction, or routing on it is not honest).
 *
 * Three outcomes per shell, and none of them is silence:
 *  - still offered → graded from the peer's live claim, capped peer-attested,
 *    and offered to Dispatch;
 *  - no longer offered → recorded `admitted: false` with a
 *    `capability-withdrawn` exclusion and WITHHELD from the router. Both
 *    halves matter: a peer that stops contributing must not simply disappear
 *    from the surface (§4.5's first banned behavior), and it must not be
 *    handed to Dispatch either, which would spend a budgeted attempt to earn
 *    a `model-not-contributed` refusal (security review, M-3);
 *  - offered but never in the built set → `not-in-resolved-set`, so "your new
 *    contribution is invisible until the next rebuild" is a sentence the
 *    operator can read rather than a mystery.
 */
async function resolveFleetPlanHalf(
  fleet: FleetPlanContext,
  policy: DispatchPolicyConfig | undefined,
): Promise<FleetResolvedHalf> {
  const resolution = await fleet.routing.resolveCandidates();
  const liveByKey = new Map(
    resolution.candidates.map((candidate) => [
      fleetKey(candidate.environmentId, candidate.modelId),
      candidate,
    ]),
  );
  const exclusions: FleetRoutingExclusion[] = [...resolution.exclusions];
  const planCandidates: GradedDispatchCandidate[] = [];
  const records: FleetRoutingCandidate[] = [];
  const seen = new Set<string>();

  for (const shell of fleet.shells) {
    const key = fleetKey(shell.environmentId, shell.modelId);
    seen.add(key);
    const live = liveByKey.get(key);

    if (!live) {
      exclusions.push({
        candidateId: shell.id,
        environmentId: shell.environmentId,
        environmentLabel: shell.environmentLabel,
        modelId: shell.modelId,
        code: 'capability-withdrawn',
        message: `${shell.environmentLabel ?? shell.environmentId} no longer contributes ${shell.displayName}, so it is not routable for this agent.`,
        source: 'station',
      });
      records.push({
        candidateId: shell.id,
        runtimeId: shell.runtimeId,
        origin: 'fleet',
        environmentId: shell.environmentId,
        environmentLabel: shell.environmentLabel,
        modelId: shell.modelId,
        evidence: {
          // The peer's last claim is gone, so nothing may be asserted about
          // it. Still labeled peer-attested: the provenance of a claim does
          // not change when the claim disappears.
          level: 'unavailable',
          provenance: 'peer-attested',
          label: FLEET_PEER_ATTESTED_EVIDENCE_LABEL,
          peerAttested: null,
          // A withdrawn contribution keeps NO probe record either: a probe
          // is evidence about a capability that is on offer, and this one is
          // not. Reporting a past pass here would read as "we verified this"
          // for something the peer has stopped contributing.
          probe: null,
        },
        // Not `isAdmitted(...)`: with the default `minimumEvidence` of
        // `unavailable`, that predicate returns TRUE for an unavailable grade,
        // so a withdrawn candidate used to render `admitted: true` beside its
        // own `capability-withdrawn` exclusion — one envelope stating both
        // that it routed and that it could not (security review, M-3).
        // Withdrawal is a fact about the candidate set, decided before policy
        // gets a say.
        admitted: false,
      });
      continue;
    }

    // station#1430 review, M-2: deliberately no `toolSurface` argument here
    // — a fleet candidate never derives `structured-tools`, on purpose, not
    // merely because no wire currently carries a peer's tool-surface claim.
    // `FleetContributedModel.toolSurface` (station#1430) is the PEER's own
    // self-report; `peer-attested` evidence is already capped at `declared`
    // in `fleet-candidate-service.ts` for the identical reason (this
    // module's own `FleetCandidateEvidence.level` docblock: a peer's claim
    // must never silently become "confirmed" the way a real local
    // observation does). A capability claim is the same shape of over-trust
    // as an evidence level: even if a future slice threads the peer's
    // `toolSurface` through `FleetCandidate.evidence`, it must be surfaced
    // as an attested claim on the receipt (like `peerAttested` already is),
    // never fed into `deriveDispatchCapabilities` as if this Station had
    // observed it — a `requiredCapabilities: ['structured-tools']` policy
    // routing to an unverified peer claim is exactly the false confidence
    // §4.5 rules out.
    const evidence: CapabilityEvidence = {
      level: live.evidence.level,
      // station#1398 slice 5.5: `capabilityShape` with no tool surface, so
      // this necessarily yields `structuredToolsFidelity: 'unavailable'` —
      // the M-2 refusal above, restated on Dispatch 0.5.0's second axis. A
      // peer's self-reported tool surface must not become an asserted
      // fidelity any more than it may become an asserted capability.
      ...capabilityShape(live.evidence.level),
      source: FLEET_EVIDENCE_SOURCE_ID,
    };
    planCandidates.push({
      id: shell.id,
      runtimeId: shell.runtimeId,
      evidence,
    });
    records.push({
      candidateId: shell.id,
      runtimeId: shell.runtimeId,
      origin: 'fleet',
      environmentId: shell.environmentId,
      environmentLabel: shell.environmentLabel,
      modelId: shell.modelId,
      evidence: live.evidence,
      admitted: isAdmitted(evidence, policy),
    });
  }

  for (const candidate of resolution.candidates) {
    const key = fleetKey(candidate.environmentId, candidate.modelId);
    if (seen.has(key)) continue;
    exclusions.push({
      candidateId: null,
      environmentId: candidate.environmentId,
      environmentLabel: candidate.environmentLabel,
      modelId: candidate.modelId,
      code: 'not-in-resolved-set',
      message: `${candidate.environmentLabel ?? candidate.environmentId} began contributing ${candidate.displayName} after this agent's candidate set was built. It becomes routable when the agent is next rebuilt.`,
      source: 'station',
    });
  }

  return { planCandidates, records, exclusions };
}

/**
 * The receipt records for this Station's own candidates. They carry
 * `provenance: 'local-observation'` because they came from station#1426's
 * connection-readiness ladder — a real observation on this machine — while
 * fleet records carry the peer's raw claim beside the capped level routing
 * used. Collapsing the two is the defect §8 names.
 */
function localRoutingRecords(
  localCandidates: readonly GradedDispatchCandidate[],
  bindings: readonly ResolvedManagedModelBinding[],
  policy: DispatchPolicyConfig | undefined,
): FleetRoutingCandidate[] {
  return localCandidates.map(
    (candidate, index): FleetRoutingCandidate => ({
      candidateId: candidate.id,
      runtimeId: candidate.runtimeId,
      origin: 'local',
      environmentId: null,
      environmentLabel: null,
      modelId: bindings[index]?.modelId ?? null,
      evidence: {
        level: candidate.evidence.level,
        provenance: 'local-observation',
        label: FLEET_LOCAL_EVIDENCE_LABEL,
        peerAttested: null,
        // A local candidate is graded by the connection-readiness ladder,
        // which already includes a real local smoke. The fleet probe is a
        // peer-path concept and stating it here would invent a second, less
        // informative verification story for the same model.
        probe: null,
      },
      admitted: isAdmitted(candidate.evidence, policy),
    }),
  );
}

/** Considered-set order mirrors plan order, so the receipt reads as the plan did. */
function mergeRoutingCandidateRecords(
  localRecords: FleetRoutingCandidate[],
  fleetRecords: FleetRoutingCandidate[],
  order: FleetPlanContext['order'],
): FleetRoutingCandidate[] {
  return order === 'before-local'
    ? [...fleetRecords, ...localRecords]
    : [...localRecords, ...fleetRecords];
}

/**
 * Adds a `below-minimum-evidence` exclusion for every candidate the policy
 * kept out of the routable set. This is the §4.5 case the design singles out
 * as "the one that will be tempting to hide, and the one users most need to
 * see": the difference between "you have no GPU model" and "you have one and
 * I refused to trust it yet".
 *
 * station#1430 review, L-1: the "missing capabilities" vs. "evidence too
 * low" message choice reads `realCapabilitiesById`, the candidate's ACTUAL
 * graded `evidence.capabilities` from `resolved.candidates` — never a
 * recompute from `evidence.level` alone. Before #1430, `deriveDispatchCapabilities`
 * was a pure function of `level`, so recomputing from the receipt record's
 * `level` field alone was equivalent to reading the real value and
 * `capabilityListOf` was a harmless indirection. Once `structured-tools` can
 * depend on `toolSurface` too, that equivalence broke: a candidate whose
 * evidence level is genuinely too low for the policy but whose toolSurface
 * WOULD have earned `structured-tools` at a sufficient level recomputed to
 * `['abort', 'usage']` (no `toolSurface` argument) — which could make
 * `structured-tools` show up in `missing` and print "missing required
 * capabilities [structured-tools]" for a candidate that was excluded by
 * evidence level, not by any missing capability. Reading the real,
 * already-graded list instead removes the discrepancy: `missing` reflects
 * exactly what `isAdmitted` actually checked.
 */
function withPolicyExclusions(
  resolved: ResolvedPlanCandidates,
  policy: DispatchPolicyConfig | undefined,
): ResolvedPlanCandidates {
  if (!resolved.routing) return resolved;
  const minimum = policy?.minimumEvidence ?? 'unavailable';
  const required = policy?.requiredCapabilities ?? [];
  const exclusions = [...resolved.routing.exclusions];
  // station#1398 slice 5.5: the whole graded evidence, not just its
  // capability list. The message choice now goes through the ONE replica of
  // the engine predicate (`admissionOf`), which needs the fidelity axis too.
  const realEvidenceById = new Map(
    resolved.candidates.map((candidate) => [candidate.id, candidate.evidence]),
  );
  for (const candidate of resolved.routing.candidates) {
    if (candidate.admitted) continue;
    // A fleet candidate already carrying a more specific exclusion (withdrawn,
    // unreachable) keeps it; adding "below minimum evidence" on top would
    // report a policy decision where the real answer is that nothing was
    // offered to decide about.
    if (
      exclusions.some(
        (exclusion) => exclusion.candidateId === candidate.candidateId,
      )
    ) {
      continue;
    }
    // Defensive floor only: every routing record that has no graded plan
    // candidate behind it (a withdrawn fleet shell) already carries a more
    // specific exclusion and was skipped above.
    const evidence =
      realEvidenceById.get(candidate.candidateId) ?? UNAVAILABLE_EVIDENCE;
    const missing = required.filter(
      (capability) => !evidence.capabilities.includes(capability),
    );
    // station#1430 review, L-1 message priority: the evidence-level message
    // takes precedence whenever the level itself is the binding constraint
    // (`isAdmitted`'s FIRST condition) — a candidate whose level is too low
    // ALSO trivially fails any capability requirement (an insufficient
    // level never earns `structured-tools` either, per
    // `deriveDispatchCapabilities`), so `missing.length > 0` alone can't
    // distinguish "excluded by level" from "excluded by capability." Both
    // messages would be true; only one names the ROOT cause the operator
    // needs to act on. The missing-capabilities message is reserved for
    // when the level genuinely clears the bar and a capability is still
    // absent — the only case it can't be explained by level alone.
    //
    // `level === 'unavailable'` is checked explicitly, not just the rank
    // comparison: a policy's default `minimumEvidence` is itself
    // `'unavailable'`, so an `'unavailable'` candidate technically clears a
    // default-minimum policy by rank (`0 >= 0`) even though
    // `deriveDispatchCapabilities('unavailable', ...)` is UNCONDITIONALLY
    // `[]` — no live evidence mechanically means no derivable capability,
    // never a capability the candidate merely lacks. Without this, the LOW
    // this comment fixes: a bare `requiredCapabilities` policy (no explicit
    // `minimumEvidence`) against a merely-discovered candidate printed
    // "missing required capabilities" instead of naming the real reason —
    // there is no live evidence at all.
    const { refusal } = admissionOf(evidence, policy);
    const levelMessage = `This candidate's evidence is '${candidate.evidence.level}' (${candidate.evidence.label}); this agent's policy requires at least '${minimum}'.`;
    exclusions.push({
      candidateId: candidate.candidateId,
      environmentId: candidate.environmentId,
      environmentLabel: candidate.environmentLabel,
      modelId: candidate.modelId,
      code: 'below-minimum-evidence',
      message:
        refusal === 'missing-capabilities' && missing.length > 0
          ? `This candidate is missing required capabilities [${missing.join(', ')}], so this agent's policy will not route to it.`
          : refusal === 'fidelity-below-minimum'
            ? `This candidate offers '${evidence.structuredToolsFidelity ?? 'unavailable'}' structured-tool support; this agent's policy requires at least '${structuredToolsFidelityFloor(policy)}'.`
            : refusal === 'fidelity-inconsistent'
              ? `This candidate reported capabilities [${evidence.capabilities.join(', ')}] alongside '${evidence.structuredToolsFidelity ?? 'unavailable'}' structured-tool support; the router refuses self-inconsistent evidence rather than guessing which half is true.`
              : levelMessage,
      source: 'station',
    });
  }
  return { ...resolved, routing: { ...resolved.routing, exclusions } };
}

/** Returns null unless the agent explicitly opts into Dispatch. */
export async function createConfiguredDispatchModel(
  spec: AgentSpec,
  config: AgentCreationConfig,
  primary: ResolvedManagedModelBinding,
): Promise<LanguageModelV3 | null> {
  const dispatch = readDispatchConfig(spec.execution?.modelOptions?.dispatch);
  if (!dispatch) return null;

  warnIfPolicyNeedsEvidenceSource(spec, config, dispatch.policy);

  const configured = dispatch.candidates ?? [];
  const bindings = [primary];
  for (const candidate of configured) {
    bindings.push(
      await resolveManagedModelBinding(
        {
          ...spec,
          model: candidate.modelId ?? undefined,
          execution: {
            ...spec.execution,
            modelConnectionId: candidate.modelConnectionId,
            modelId: candidate.modelId,
          },
        } as AgentSpec,
        config,
      ),
    );
  }

  const shells = buildDispatchCandidateShells(bindings, configured);

  const models: Record<string, LanguageModelV3> = {};
  bindings.forEach((binding, index) => {
    models[shells[index]!.runtimeId] = createAiSdkManagedModel({
      providerConnection: binding.providerConnection,
      modelId: binding.modelId,
      spec,
      appConfig: config.appConfig,
    });
  });

  const fleet = await buildFleetPlanContext(spec, config, dispatch, models);

  const resolveDispatchCandidates = createTtlCachedCandidateResolver(
    spec,
    config,
    dispatch.policy,
    bindings,
    shells,
    fleet,
  );

  /**
   * Routing snapshots awaiting their receipt, keyed by the plan digest
   * Dispatch will stamp on that receipt (security review, H-1(a)).
   *
   * This used to be a single `lastRouting` variable, which is a correctness
   * bug the moment two turns overlap — and turns overlap routinely: one built
   * Dispatch model serves every invocation of its agent. `plan()` runs per
   * invocation, `onReceipt` fires when that invocation finishes, and nothing
   * orders them. Two turns straddling a TTL boundary resolve DIFFERENT
   * candidate sets, and last-write-wins pairs turn A's verbatim
   * `DispatchReceipt` with turn B's candidates and exclusions: a receipt that
   * is internally consistent, individually plausible, and false about which
   * machines were considered. Exactly the artifact §8 warns this feature must
   * not produce.
   *
   * `planDigest` is the correct key because Dispatch derives it from the plan
   * this closure returned (`executionPlanDigest` over the same
   * `{...plan, request}` the engine dispatches) and stamps that same value on
   * the receipt, so the join is the engine's own identity for the decision
   * rather than an ordering assumption of ours.
   */
  const pendingRouting = new Map<string, PendingFleetRouting>();
  let missingCorrelationLogged = false;

  return createAiSdkDispatchModel({
    id: 'station-dispatch',
    capabilities: {
      structuredTools: true,
      streaming: false,
      abort: true,
      usage: true,
    },
    models,
    plan: async (request) => {
      const resolved = await resolveDispatchCandidates();
      const turnCorrelation = fleet
        ? currentAuthorizedTurnCorrelation()
        : undefined;
      // Direct /chat, scheduled work without an account, and malformed relay
      // context may still execute a fleet-routed model. Preserve its
      // authoritative routing receipt, but do not let a future Action adapter
      // invent a session join from any weaker signal.
      if (fleet && !turnCorrelation) {
        fleetRoutingCorrelationEvents.add(1, {
          phase: 'plan',
          outcome: 'missing-context',
        });
        if (!missingCorrelationLogged) {
          missingCorrelationLogged = true;
          (config.logger ?? moduleLogger).warn(
            `[dispatch] Fleet routing operation correlation unavailable for agent '${spec.name}'; the routing receipt will still be written, but no turn/action observer will run.`,
            { reason: 'missing-authorized-turn-context' },
          );
        }
      }
      const invocationResolved =
        turnCorrelation && resolved.routing
          ? bindRoutingToAuthorizedTurn(resolved, turnCorrelation)
          : resolved;
      const runtimePlan = {
        schemaVersion: 1 as const,
        role: 'station-agent',
        candidates: invocationResolved.candidates,
        budget: {
          maxAttempts:
            dispatch.budget?.maxAttempts ??
            invocationResolved.candidates.length,
          ...dispatch.budget,
        },
        ...(dispatch.policy ? { policy: dispatch.policy } : {}),
      };
      if (fleet && invocationResolved.routing) {
        const planDigest = executionPlanDigest({ ...runtimePlan, request });
        const correlation = turnCorrelation
          ? {
              ...turnCorrelation,
              planDigest,
            }
          : undefined;
        const remembered = rememberRouting(
          pendingRouting,
          planDigest,
          invocationResolved.routing,
          correlation,
          config.logger ?? moduleLogger,
          spec.name,
        );
        if (correlation && remembered) {
          await observeFleetCorrelation(
            fleet.routing,
            'begin',
            correlation,
            config.logger ?? moduleLogger,
            spec.name,
          );
        }
      }
      return runtimePlan;
    },
    onReceipt: async (receipt) => {
      await persistDispatchReceipt(config, receipt);
      // An agent that never opted into fleet routing has nothing to receipt
      // here; that is the ONLY silent return on this path.
      if (!fleet) return;
      // Deliberately NOT deleted on read (security review round 2, M-1).
      // `planDigest` is pure content — `executionPlanDigest` hashes the
      // canonicalized plan plus the request digest, with no nonce and no
      // timestamp — so two genuinely concurrent turns that are identical
      // (same agent, same prompt, same grades) share ONE digest,
      // deterministically. That is the common case for scheduled jobs,
      // retries, and fan-out, not a curiosity. Deleting on first read gave
      // the first receipt its envelope and the second `routing-snapshot-lost`
      // with no envelope at all — worse for that case than the last-write
      // code this map replaced. The 32-entry FIFO eviction is what reclaims;
      // it is bounded, and it is loud when it fires.
      const pending = pendingRouting.get(receipt.planDigest);
      try {
        if (!pending) {
          // Security review, H-1(b): this case used to `return` above the
          // try/catch, so a fleet-enabled turn could go entirely unreceipted
          // with nothing on any channel. There is no honest envelope to write
          // — the considered set for this plan is genuinely unknown — so the
          // loss itself is what gets reported.
          fleetRoutingReceiptFailures.add(1, {
            reason: 'routing-snapshot-lost',
          });
          (config.logger ?? moduleLogger).error(
            `[dispatch] Fleet routing receipt SKIPPED for agent '${spec.name}': no routing snapshot for plan digest ${receipt.planDigest}. The turn completed (${receipt.outcome}) and this routing decision is NOT receipted.`,
          );
          return;
        }
        const sealed = await fleet.routing.appendReceipt(
          buildFleetRoutingEnvelope(
            {
              environmentId: fleet.routing.environmentId,
              agentName: spec.name,
              candidates: pending.routing.candidates,
              exclusions: pending.routing.exclusions,
            },
            receipt,
            new Date().toISOString(),
          ),
        );
        fleetRoutingReceiptsTotal.add(1, { outcome: receipt.outcome });
        fleetRoutingCandidatesTotal.add(
          pending.routing.candidates.filter(
            (candidate) => candidate.origin === 'fleet',
          ).length,
        );
        for (const exclusion of pending.routing.exclusions) {
          fleetRoutingExclusionsTotal.add(1, { code: exclusion.code });
        }
        if (pending.correlation) {
          await observeFleetCorrelation(
            fleet.routing,
            'settle',
            {
              ...pending.correlation,
              receiptId: sealed.receiptId,
              outcome: receipt.outcome,
            },
            config.logger ?? moduleLogger,
            spec.name,
          );
        }
      } catch (error) {
        // The turn already happened; failing it now would trade a recorded
        // outcome for an unrecorded one. But an unwritten receipt is the
        // whole differentiator going missing, so it is loud.
        fleetRoutingReceiptFailures.add(1, { reason: 'write-failed' });
        (config.logger ?? moduleLogger).error(
          `[dispatch] Fleet routing receipt could not be written for agent '${spec.name}'. The turn completed, but this routing decision is NOT receipted.`,
          { error: error instanceof Error ? error.message : String(error) },
        );
      } finally {
        // A correlated plan digest is unique to one authorized turn, so it
        // has no legitimate later receipt to share its snapshot with. Keeping
        // completed entries consumed the 32-slot FIFO forever and eventually
        // evicted a live turn. Legacy uncorrelated entries deliberately keep
        // their established same-digest sharing behavior for retries/fan-out.
        if (
          pending?.correlation &&
          pendingRouting.get(receipt.planDigest) === pending
        ) {
          pendingRouting.delete(receipt.planDigest);
        }
      }
    },
  });
}

/**
 * Plans held awaiting a receipt. Dispatch fires `onReceipt` for every
 * invocation that reaches the engine, so entries are normally short-lived —
 * but an invocation that throws BEFORE dispatching (the ai-sdk wrapper's
 * unavailable-runtime guard, an aborted request) never produces one, so the
 * map needs a ceiling or a long-lived agent leaks a snapshot per such failure.
 * Comfortably above any realistic concurrent-turn count for one agent.
 */
const MAX_PENDING_ROUTING_SNAPSHOTS = 32;

/** Observer writes are progress projection, never a provider/receipt gate. */
export const FLEET_ROUTING_OBSERVER_TIMEOUT_MS = 250;

/**
 * Records one plan's routing snapshot, evicting the oldest if the map is at
 * its ceiling.
 *
 * An eviction is LOUD and counted: it means some earlier turn's receipt will
 * arrive to find nothing, and silently discarding provenance is the failure
 * this whole review round is about. It is not merely a memory guard.
 */
function rememberRouting(
  pending: Map<string, PendingFleetRouting>,
  planDigest: string,
  routing: FleetRoutingSnapshot,
  correlation: AuthorizedFleetDispatchBegin | undefined,
  logger: Logger,
  agentName: string,
): boolean {
  // First write wins for a digest. A colliding plan is BY DEFINITION the same
  // plan — same candidates, same budget, same policy, same request — so the
  // held snapshot already describes it. The one thing that can differ is an
  // exclusion outside the plan (a peer that was never a candidate becoming
  // unreachable between the two resolutions); keeping the earlier snapshot
  // means the turn whose receipt is already pending is described by the
  // resolution it actually ran under. Recorded as a known imprecision rather
  // than hidden: the alternative, overwriting, moves the same imprecision
  // onto the older turn instead.
  if (pending.has(planDigest)) return false;
  if (pending.size >= MAX_PENDING_ROUTING_SNAPSHOTS) {
    const oldest = pending.keys().next().value;
    if (oldest !== undefined) {
      pending.delete(oldest);
      fleetRoutingReceiptFailures.add(1, { reason: 'snapshot-evicted' });
      logger.error(
        `[dispatch] Fleet routing snapshot evicted for agent '${agentName}': more than ${MAX_PENDING_ROUTING_SNAPSHOTS} plans are awaiting a receipt. The turn behind plan digest ${oldest} will NOT be receipted.`,
      );
    }
  }
  pending.set(planDigest, { routing, ...(correlation ? { correlation } : {}) });
  return true;
}

/**
 * Observer failures are intentionally isolated from Dispatch. A routing
 * receipt is the source of truth; the Action layer will consume these
 * callbacks as progress/custody projection and must not turn a completed
 * model invocation into a different result merely because its own write was
 * unavailable.
 */
async function observeFleetCorrelation(
  routing: DispatchFleetRouting,
  phase: 'begin' | 'settle',
  input:
    | AuthorizedFleetDispatchBegin
    | (AuthorizedFleetDispatchBegin & {
        receiptId: string;
        outcome: DispatchReceipt['outcome'];
      }),
  logger: Logger,
  agentName: string,
): Promise<void> {
  const observer = routing.observer;
  if (!observer) return;
  try {
    const observation =
      phase === 'begin'
        ? observer.begin(input as AuthorizedFleetDispatchBegin)
        : observer.settle(
            input as AuthorizedFleetDispatchBegin & {
              receiptId: string;
              outcome: DispatchReceipt['outcome'];
            },
          );
    const observed = await observeWithinDeadline(observation);
    if (!observed) {
      fleetRoutingCorrelationEvents.add(1, {
        phase,
        outcome: 'observer-timeout',
      });
      logger.warn(
        `[dispatch] Fleet routing observer ${phase} timed out for agent '${agentName}'; the Dispatch result and routing receipt remain authoritative.`,
        { reason: 'fleet-correlation-observer-timeout' },
      );
      return;
    }
    fleetRoutingCorrelationEvents.add(1, { phase, outcome: 'observed' });
  } catch {
    fleetRoutingCorrelationEvents.add(1, { phase, outcome: 'observer-failed' });
    logger.warn(
      `[dispatch] Fleet routing observer ${phase} failed for agent '${agentName}'; the Dispatch result and routing receipt remain authoritative.`,
      { reason: 'fleet-correlation-observer-failed' },
    );
  }
}

/**
 * Bounds a non-authoritative observer without cancelling its work: the
 * observer owns no provider effect, and a late resolve/reject must not turn
 * a completed routing receipt into a different turn result.
 */
async function observeWithinDeadline(
  observation: void | Promise<void>,
): Promise<boolean> {
  const completion = Promise.resolve(observation).then(
    () => true,
    (error) => Promise.reject(error),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), FLEET_ROUTING_OBSERVER_TIMEOUT_MS);
  });
  try {
    return await Promise.race([completion, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
    void completion.catch(() => undefined);
  }
}

/**
 * Resolves the fleet half of the plan once, at model construction, and
 * registers one AI SDK model per contributed peer model.
 *
 * `null` — no fleet routing — for three different reasons, and the noisy one
 * matters: an agent that asked for fleet routing on a call path with no
 * `fleetRouting` wiring gets a warning rather than silent local-only
 * behavior, the same shape as `warnIfPolicyNeedsEvidenceSource`. Silently
 * serving local-only routing to an agent that asked to use the fleet is the
 * "degrades silently" failure §3.1 rules out in its second sentence.
 */
async function buildFleetPlanContext(
  spec: AgentSpec,
  config: AgentCreationConfig,
  dispatch: DispatchModelConfig,
  models: Record<string, LanguageModelV3>,
): Promise<FleetPlanContext | null> {
  if (dispatch.fleet?.enabled !== true) return null;
  if (!config.fleetRouting) {
    (config.logger ?? moduleLogger).warn(
      `[dispatch] Agent '${spec.name}' opted into fleet routing, but this call path has no fleet routing wired. The turn will use local candidates only, and no routing receipt will be written.`,
    );
    return null;
  }

  const resolution = await config.fleetRouting.resolveCandidates();
  const shells = buildFleetCandidateShells(resolution.candidates);
  resolution.candidates.forEach((candidate, index) => {
    models[shells[index]!.runtimeId] = createFleetInferenceModel({
      environmentId: candidate.environmentId,
      environmentLabel: candidate.environmentLabel,
      apiBase: candidate.apiBase,
      credential: candidate.credential,
      modelId: candidate.modelId,
    });
  });
  return {
    routing: config.fleetRouting,
    shells,
    order: dispatch.fleet.order ?? 'after-local',
  };
}

function readDispatchConfig(value: unknown): DispatchModelConfig | null {
  if (!isRecord(value) || value.enabled !== true) return null;
  if (value.candidates !== undefined && !Array.isArray(value.candidates)) {
    throw new Error(
      'execution.modelOptions.dispatch.candidates must be an array.',
    );
  }
  for (const candidate of value.candidates ?? []) {
    if (!isRecord(candidate)) {
      throw new Error(
        'execution.modelOptions.dispatch candidates must be objects.',
      );
    }
    assertOptionalString(candidate.modelConnectionId, 'modelConnectionId');
    assertOptionalString(candidate.modelId, 'modelId');
    assertOptionalNonNegativeNumber(
      candidate.estimatedUsdPer1kTokens,
      'estimatedUsdPer1kTokens',
    );
  }
  if (value.budget !== undefined) {
    if (!isRecord(value.budget)) {
      throw new Error(
        'execution.modelOptions.dispatch.budget must be an object.',
      );
    }
    if (
      value.budget.maxAttempts !== undefined &&
      (typeof value.budget.maxAttempts !== 'number' ||
        !Number.isInteger(value.budget.maxAttempts) ||
        value.budget.maxAttempts < 1)
    ) {
      throw new Error(
        'Dispatch budget maxAttempts must be a positive integer.',
      );
    }
    for (const field of ['maxElapsedMs', 'maxTotalTokens', 'maxCostUsd']) {
      assertOptionalNonNegativeNumber(value.budget[field], field);
    }
  }
  if (value.fleet !== undefined) {
    if (!isRecord(value.fleet)) {
      throw new Error(
        'execution.modelOptions.dispatch.fleet must be an object.',
      );
    }
    if (
      value.fleet.enabled !== undefined &&
      typeof value.fleet.enabled !== 'boolean'
    ) {
      throw new Error('Dispatch fleet enabled must be boolean.');
    }
    if (
      value.fleet.order !== undefined &&
      !['after-local', 'before-local'].includes(value.fleet.order as string)
    ) {
      throw new Error(
        "Dispatch fleet order must be 'after-local' or 'before-local'.",
      );
    }
  }
  if (value.policy !== undefined) {
    if (!isRecord(value.policy)) {
      throw new Error(
        'execution.modelOptions.dispatch.policy must be an object.',
      );
    }
    if (
      value.policy.retryRuntimeFailures !== undefined &&
      typeof value.policy.retryRuntimeFailures !== 'boolean'
    ) {
      throw new Error('Dispatch policy retryRuntimeFailures must be boolean.');
    }
    if (
      value.policy.minimumEvidence !== undefined &&
      !['unavailable', 'declared', 'confirmed'].includes(
        value.policy.minimumEvidence as string,
      )
    ) {
      throw new Error('Dispatch policy minimumEvidence is invalid.');
    }
    // station#1398 slice 5.5. `policy` is handed to the engine verbatim, so
    // an unvalidated value here reaches `eligible()` and silently excludes
    // every candidate (an unknown fidelity fails `fidelityRank` lookup).
    // Validating it is what turns a typo into a config error instead of an
    // agent that mysteriously stops routing.
    if (
      value.policy.minimumStructuredToolsFidelity !== undefined &&
      !['prompted', 'native'].includes(
        value.policy.minimumStructuredToolsFidelity as string,
      )
    ) {
      throw new Error(
        "Dispatch policy minimumStructuredToolsFidelity must be 'prompted' or 'native'.",
      );
    }
    if (
      value.policy.requiredCapabilities !== undefined &&
      (!Array.isArray(value.policy.requiredCapabilities) ||
        value.policy.requiredCapabilities.some(
          (capability) =>
            typeof capability !== 'string' || capability.length === 0,
        ))
    ) {
      throw new Error(
        'Dispatch policy requiredCapabilities must contain non-empty strings.',
      );
    }
  }
  return value as unknown as DispatchModelConfig;
}

function assertOptionalString(value: unknown, field: string): void {
  if (
    value !== undefined &&
    value !== null &&
    (typeof value !== 'string' || value.trim().length === 0)
  ) {
    throw new Error(`Dispatch candidate ${field} must be a non-empty string.`);
  }
}

function assertOptionalNonNegativeNumber(value: unknown, field: string): void {
  if (
    value !== undefined &&
    (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
  ) {
    throw new Error(`Dispatch ${field} must be a non-negative number.`);
  }
}

async function persistDispatchReceipt(
  config: AgentCreationConfig,
  receipt: DispatchReceipt,
): Promise<void> {
  const directory = join(config.projectHomeDir, 'monitoring');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await appendFile(
    join(directory, 'model-dispatch-receipts.ndjson'),
    `${JSON.stringify(receipt)}\n`,
    { encoding: 'utf8', mode: 0o600 },
  );
  modelDispatchReceipts.add(1, {
    outcome: receipt.outcome,
    attempts: receipt.attempts.length,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

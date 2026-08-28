/**
 * Station-as-contributor opt-in and the
 * contributed-subset manifest (`docs/design/inference-fleet.md` §3.1, §4.2,
 * §11).
 *
 * An operator marks specific LOCAL model connections as contributed to their
 * own fleet. This module owns the persisted opt-in shape
 * ({@link FleetContributionConfig}, an `AppConfig` field registered in
 * `settings-registry.ts`) and the wire shape of the projection a paired
 * consumer reads ({@link FleetContributionManifest}).
 *
 * Three design decisions are load-bearing and were made against the design
 * doc rather than for convenience:
 *
 * 1. **The manifest is a projection of `station.model-inventory/v2`, not a
 *    second capability manifest** (§2.3: "the capability manifest at join is
 *    already specified. Do not invent a second one"). Every per-model field
 *    below is copied verbatim from a {@link LaunchableModelRecord} — none is
 *    computed, defaulted, or asserted here.
 * 2. **`toolSurface` is carried, and genuinely OPTIONAL on the wire
 *    (archive#1430 closed the producer gap this point used to explain and
 *    corrected the field to actually be optional
 *    in the type, not just in prose).** Before archive#1430, the source record's
 *    `toolSurface` was `null` for every model connection because no provider
 *    populated `supportsTools`, so the column was omitted rather than shipped
 *    as a placeholder that reads as an observation. Now that at least one
 *    adapter (Ollama, via its own `/api/show` capabilities) can genuinely
 *    report it, the field is copied through verbatim like every other
 *    capability column — `null` still means "unknown," `[]` still means
 *    "known: no tool support," exactly the meaning `launchable-model-
 *    inventory.ts` already gives it. This is additive: a peer running a
 *    pre-1430 build simply omits the key from its manifest JSON, so
 *    {@link FleetContributedModel.toolSurface} is typed `?:` — a consumer
 *    reading a peer's manifest must handle the key being absent, not assume
 *    every field this Station's own projection happens to always set is
 *    always present on the wire. v1 still contributes MODELS only (§10
 *    OQ-5) — this does not reopen that decision; it only stops hiding a
 *    genuine fact about a contributed model. `supportsVision` remains
 *    carried the same way it always was: it has a real source
 *    (`bedrock-llm-provider.ts` derives it from the model's declared input
 *    modalities) and `null` there honestly means "unknown," not "no" — it
 *    predates the peer-facing manifest, so it stayed required rather than
 *    being retrofitted optional; a future field-addition tripwire (mirroring
 *    the manifest's code-vocabulary one) is worth considering so the next
 *    additive field doesn't need a review round to catch the same class of
 *    mistake.
 * 3. **No `environmentId`.** A manifest fetched from a peer is attributed by
 *    the consumer to the environment it authenticated to. A self-asserted
 *    identity field inside the body adds nothing that the transport identity
 *    does not already establish, and can only ever disagree with it.
 *
 * Nothing here reaches the public, unauthenticated handshake: whether this
 * Station currently contributes anything is a runtime fact and must stay
 * behind authentication (§3.3 point 3, §5.2 rule 1). The handshake carries
 * only the static `fleetInference` protocol-support flag
 * ({@link StationCapabilityFlags}).
 */

import type {
  ModelInventoryAvailability,
  ModelInventoryDiagnosticCode,
  ModelInventoryFreshness,
  ModelInventoryLocality,
  ModelInventoryModelIdentity,
} from './model-inventory.js';

export const FLEET_CONTRIBUTION_MANIFEST_SCHEMA_VERSION =
  'station.fleet-contribution/v1' as const;

/**
 * Diagnostics that are about the manifest as a whole rather than one
 * connection use this in place of a connection id — same convention as
 * `station:model-inventory` in `launchable-model-inventory.ts`.
 */
export const FLEET_CONTRIBUTION_DIAGNOSTIC_ID = 'station:fleet-contribution';

/**
 * The persisted opt-in (`AppConfig.fleetContribution`). **Default off in
 * every direction**: an absent field, an absent `enabled`, `enabled: false`,
 * and an empty/absent `connectionIds` all contribute nothing. There is no
 * value of this object that contributes a connection the operator did not
 * name — the allowlist is explicit, never "all local connections".
 */
export interface FleetContributionConfig {
  /**
   * Master opt-in for this Station. Absent or anything other than `true`
   * means off — see {@link isFleetContributionEnabled}, which every caller
   * must use instead of a truthy check.
   */
  enabled?: boolean;
  /**
   * Ids of the local MODEL connections offered to the fleet. An id that no
   * longer resolves is reported as a named diagnostic, never dropped.
   */
  connectionIds?: string[];
}

/**
 * What this Station is doing about fleet contribution right now.
 *
 * Three of the four states carry an empty `models` array, so the array is
 * never the signal — this field plus `diagnostics` always name WHICH empty
 * it is. "Off", "on but nothing marked", and "on, marked, and currently
 * yielding nothing" are three different sentences to an operator and three
 * different routing decisions to a consumer; collapsing them into `[]` is
 * the silent-degradation class §4.5 bans.
 */
export type FleetContributionParticipation =
  /** Opt-in on, at least one contributed model is projected. */
  | 'contributing'
  /** Opt-in off. Nothing is offered regardless of what is marked. */
  | 'disabled'
  /** Opt-in on, but no connection is marked as contributed. */
  | 'nothing-contributed'
  /**
   * Opt-in on and connections are marked, but none currently yields a
   * launchable model. The diagnostics say why, per connection.
   */
  | 'contributed-unavailable';

/**
 * One contributed model. Every field is copied verbatim from the source
 * {@link LaunchableModelRecord}; see the module docblock for what is
 * deliberately absent and why.
 */
export interface FleetContributedModel {
  /** The source record's id — the join key the serve route addresses. */
  id: string;
  /** The local model connection that launches it. */
  connectionId: string;
  /** Exact provider-native model id used at invocation time. */
  providerModel: string;
  model: ModelInventoryModelIdentity;
  /** Explicit selectors reported for the same provider-native model id. */
  aliases: string[];
  displayName: string;
  /**
   * `local` is the only value that makes this a claim about THIS machine
   * (§4.1). `remote`/`unknown` are carried through unchanged and flagged
   * with `contribution-not-local` rather than filtered out.
   */
  locality: ModelInventoryLocality;
  availability: ModelInventoryAvailability;
  freshness: ModelInventoryFreshness;
  /** When the underlying catalog observation was made; `null` if unknown. */
  observedAt: string | null;
  effectiveContextTokens: number | null;
  /**
   * `null` is unknown, `[]` is known-empty (station#1430) — copied verbatim
   * from the source `LaunchableModelRecord.toolSurface`, see the module
   * docblock. OPTIONAL (station#1430 review, M-1), not just nullable: this
   * is a v1 peer-facing wire field, and v1 predates it — a peer running an
   * older build simply omits the key rather than sending `null`. A consumer
   * must treat an absent key and an explicit `null` identically (both mean
   * "unknown"); do not assume the key is present just because this Station's
   * own projection (`fleet-contribution-manifest.ts`) always sets it.
   */
  toolSurface?: string[] | null;
  /** `null` is unknown, not "no" — see the module docblock. */
  supportsVision: boolean | null;
}

/**
 * The source-inventory codes this manifest version carries onto the wire,
 * frozen as explicit literals rather than re-exported from
 * {@link ModelInventoryDiagnosticCode}.
 *
 * `station.model-inventory/v2` is an INTERNAL contract that may grow a code
 * at any time; `station.fleet-contribution/v1` is a peer-facing one that may
 * not grow silently. Aliasing the two would let an internal addition widen
 * the wire enum with no version decision and no consumer able to name the
 * new value. {@link FLEET_CARRIED_INVENTORY_DIAGNOSTIC_CODES} is the runtime
 * mirror, and the assertion below fails to typecheck the moment the
 * inventory gains a code that this version has not decided about.
 */
export type FleetCarriedInventoryDiagnosticCode =
  | 'disabled'
  | 'not-ready'
  | 'catalog-unavailable'
  | 'stale-catalog'
  | 'refresh-unavailable'
  | 'discovery-limited';

export const FLEET_CARRIED_INVENTORY_DIAGNOSTIC_CODES: readonly FleetCarriedInventoryDiagnosticCode[] =
  [
    'catalog-unavailable',
    'disabled',
    'discovery-limited',
    'not-ready',
    'refresh-unavailable',
    'stale-catalog',
  ];

/**
 * Compile-time forcing function: if `station.model-inventory/v2` gains a
 * diagnostic code, this assignment stops typechecking and whoever added it
 * must decide whether the new code crosses the machine boundary (add it here
 * and to the runtime mirror) or does not (map it at the projection). Keep
 * this assignment — it is the version gate, not dead code.
 */
const _assertCarriedCodesCoverInventory: ModelInventoryDiagnosticCode extends FleetCarriedInventoryDiagnosticCode
  ? true
  : false = true;
void _assertCarriedCodesCoverInventory;

export type FleetContributionDiagnosticCode =
  /**
   * Carried through from the source inventory for a contributed connection,
   * so "why is my contributed connection missing" is answered with the same
   * code and message the Connections surface already shows locally.
   */
  | FleetCarriedInventoryDiagnosticCode
  /**
   * The source inventory produced a diagnostic code this manifest version
   * does not know how to name. Emitted instead of dropping it (never a
   * silent omission) and instead of passing it through (never a silent
   * widening of the wire enum). In-repo this is unreachable — the assertion
   * above fails first — so it exists for a mixed-version read, not a
   * mixed-version write.
   */
  | 'inventory-diagnostic-unrecognized'
  /** The opt-in is off for this Station. */
  | 'contribution-disabled'
  /** The opt-in is on, but no connection is marked as contributed. */
  | 'contribution-empty'
  /** A marked id matches no connection this Station knows about. */
  | 'contribution-unknown-connection'
  /**
   * A marked id resolves to something other than a model connection. v1
   * contributes model connections only (§10 OQ-5).
   */
  | 'contribution-unsupported-connection'
  /**
   * A contributed model's locality is not `local`: this Station holds a
   * reference to something it does not execute itself, which is an
   * auth-by-reference claim rather than a local-capability claim (§4.1).
   */
  | 'contribution-not-local'
  /**
   * The local model inventory could not be read at all. Contribution state
   * is UNKNOWN, which is not the same as empty.
   */
  | 'inventory-unavailable'
  /**
   * The source inventory hit its bounded record/response limits, so a
   * contributed connection may be missing from this projection for a reason
   * unrelated to its own health.
   */
  | 'inventory-truncated';

export interface FleetContributionDiagnostic {
  /** A connection id, or {@link FLEET_CONTRIBUTION_DIAGNOSTIC_ID}. */
  connectionId: string;
  code: FleetContributionDiagnosticCode;
  message: string;
}

export interface FleetContributionManifest {
  schemaVersion: typeof FLEET_CONTRIBUTION_MANIFEST_SCHEMA_VERSION;
  /**
   * Wall-clock time this projection was produced. **Not an observation
   * age** — deliberately NOT called `observedAt`, because every sibling
   * `observedAt` in this stack (the inventory envelope's, and
   * {@link FleetContributedModel.observedAt}) means "when the underlying
   * fact was observed". A consumer that learned that meaning and computed
   * staleness from a field named `observedAt` here would always read
   * roughly `now` and conclude the manifest is fresh no matter how old its
   * evidence is. Use {@link FleetContributionManifest.sourceObservedAt}
   * for age.
   */
  projectedAt: string;
  /**
   * The source inventory's own `observedAt` (its oldest published
   * observation), or `null` when no inventory could be read. **This is the
   * freshness field** (§4.3): a fresh projection of a stale inventory is a
   * stale claim, and the two timestamps must stay separable to say so.
   */
  sourceObservedAt: string | null;
  participation: FleetContributionParticipation;
  models: FleetContributedModel[];
  diagnostics: FleetContributionDiagnostic[];
}

/**
 * The single fail-closed read of the opt-in. `enabled` must be exactly
 * `true`; an earlier config carrying a string `"true"`, a `1`, or any other
 * truthy stand-in is OFF, because a default that decides must not decide on
 * coercion (docs/guides/code-quality.md, "a default that decides").
 */
export function isFleetContributionEnabled(
  config: FleetContributionConfig | undefined,
): boolean {
  return config?.enabled === true;
}

/**
 * The connection ids the operator has MARKED for contribution — deduplicated
 * and sorted, with non-string and empty entries dropped.
 *
 * Deliberately independent of {@link isFleetContributionEnabled}: this
 * answers "what is marked", which is exactly what a disabled Station needs
 * in order to say "you marked 2 connections but the opt-in is off" instead
 * of showing nothing. Callers that need "what is actually offered" must
 * check the opt-in themselves — the projection in
 * `fleet-contribution-manifest.ts` is the only supported way to do that.
 */
export function declaredContributionConnectionIds(
  config: FleetContributionConfig | undefined,
): string[] {
  const ids = config?.connectionIds;
  if (!Array.isArray(ids)) return [];
  return [
    ...new Set(
      ids.filter((id): id is string => typeof id === 'string' && id.length > 0),
    ),
  ].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

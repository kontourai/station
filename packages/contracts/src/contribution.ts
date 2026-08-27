/**
 * station#1500 slice 2.5 of epic #1425 — the SCOPED contribution contract
 * (`docs/design/portable-project-identity.md` §4.2, §4.3, §9 OQ-11).
 *
 * > **contribution = (Station, scope) → named resources**
 *
 * What one Station offers, in one shared space. `fleet-contribution.ts` already
 * ships the degenerate, global instance of this contract — your own fleet is a
 * single implicit trust scope, so the scope dimension collapses to a constant
 * and needs no field. This module widens the same contract along two axes at
 * once: the scope becomes explicit (`fleet` | `project`), and the resource axis
 * grows from "model connections" to **execution for a named repo**, **agents**,
 * and **inference**.
 *
 * It reuses the fleet contract's four decisions VERBATIM rather than
 * paraphrasing them (§4.2), and each one is a derivation here, not a label:
 *
 * 1. **Default off in every direction, allowlist-only.** An absent field, an
 *    absent `enabled`, `enabled: false`, an absent axis, and an empty axis list
 *    all contribute nothing. There is no value of {@link ContributionConfig}
 *    that contributes a resource the operator did not name — the projection
 *    builder iterates the DECLARED ids and asks about each, so an observed
 *    resource that nobody declared is unreachable by construction, not merely
 *    filtered. {@link isContributionEnabled} is the single fail-closed read and
 *    requires `enabled === true`; a `"true"`, a `1`, or any other truthy
 *    stand-in is OFF, because a default that decides must not decide on
 *    coercion (`docs/guides/code-quality.md`).
 * 2. **Four-state participation; the empty array is never the signal.**
 *    {@link ContributionParticipation} keeps the fleet's four words with the
 *    fleet's meanings. Three of the four carry empty resource lists, so the
 *    lists cannot be the signal — `participation` plus `diagnostics` always name
 *    WHICH empty it is. Here the fourth state earns its keep on the new axis
 *    exactly as §4.2 predicted: a Station that offers execution for repo X whose
 *    binding for X is gone is *offering something it cannot currently serve*,
 *    which is a different sentence from "offers nothing" and a different routing
 *    decision from both.
 * 3. **Two clocks, kept separable.** {@link ContributionProjection.projectedAt}
 *    is when the projection was produced and is deliberately not named
 *    `observedAt`; {@link ContributionProjection.sourceObservedAt} is the
 *    freshness field, because a fresh projection of stale inventory is a stale
 *    claim. {@link contributionFreshness} is the reader that makes the split
 *    load-bearing rather than decorative: it computes from `sourceObservedAt`
 *    ONLY, and a projection with no observation behind it is `unknown` — never
 *    `fresh` (§6.1: "a stale answer is `unknown`, not satisfied").
 * 4. **No self-asserted identity in the wire body.** There is no `stationId`,
 *    `environmentId`, or `memberId` field, and
 *    {@link isWellFormedContributionProjection} REFUSES a body that carries one.
 *    Attribution is the reader's, from the transport it authenticated to; a
 *    self-asserted identity adds nothing the transport does not already
 *    establish and can only ever disagree with it. Refusing at the read is what
 *    makes this a rule rather than an omission: a peer running a
 *    differently-shaped build cannot smuggle one in.
 *
 * ## §11's open question, and the answer this module records
 *
 * §11 flagged that whether the fleet's four decisions "survive contact with a
 * non-model resource axis — execution for a repo has a *binding* behind it,
 * which a model connection does not" was unproven until this slice. All four
 * survive. The one that had to WIDEN rather than carry over unchanged is
 * decision 3's clock: a model connection's observation is the inventory's single
 * `observedAt`, while execution's observation is a PER-BINDING `verifiedAt`, one
 * per repo. So `sourceObservedAt` is derived as the OLDEST observation across
 * every axis (`oldestObservation`), and the per-repo timestamp is additionally
 * carried on {@link ContributedExecution.verifiedAt} because §6.1's routing
 * constraint asks about one repo, not about the projection as a whole. Nothing
 * was dropped and no decision was relaxed; one scalar became a scalar plus a
 * per-resource column, and the aggregate stays honest by taking the OLDEST
 * rather than the newest — a projection is only as fresh as its stalest source.
 *
 * ## What is deliberately NOT here
 *
 * **§4.4's requirements/compliance machinery.** No capability floors, no
 * offer-acceptance states (`accepted-live`/`accepted-degraded`/`not-accepted`/
 * `attested-unverified`), no enforcement point, no `requirements` field
 * anywhere. §4.4 is sketched direction pending §9 OQ-12, whose three
 * sub-questions (the requirements vocabulary's bounds, the enforcement point and
 * cadence, and partial-acceptance UX) are all unanswered. Shipping the shape
 * before the decision would mint exactly the kind of field that reads as a
 * contract and is not one. {@link CONTRIBUTION_PROJECTION_FIELDS} pins the wire
 * body to an exact key set — not a floor — so that exclusion is checked rather
 * than merely intended, in both directions.
 *
 * **Occupancy and liveness.** §7 point 4: a contribution projection says whether
 * a Station offers and can serve a resource; it does not report how busy that
 * Station's tree is. Live session counts are a work-pattern signal about a
 * person. There is no field for one here, and the projection builder's input
 * types carry no session or occupancy shape to put in one.
 *
 * **Paths.** §4.2: the execution entry is "presence and freshness, never a
 * path". §3.5's binding store never leaves the machine, and §4.3's privacy
 * property and consent property are the same property. So
 * {@link ContributedExecution} has no path field, and the builder's input
 * observation type (`contribution-projection.ts`) has no field that could hold
 * one — including the resolver's own `reason`, whose prose embeds the declared
 * path. The messages in `diagnostics[]` are derived from the repo id and the
 * resolution state, never carried through from a local record.
 *
 * ## Relationship to `station.fleet-contribution/v1` (the slice-2.5 decision)
 *
 * The shipped fleet schema id is **kept alongside, not aliased**, and
 * `fleet-contribution.ts` is byte-unchanged by this slice. §4.2 explicitly left
 * that call to this slice ("whether the shipped schema id is aliased or kept
 * alongside is a slice-2.5 decision, not a design fork"). Three reasons:
 *
 * - The two wire BODIES differ. `FleetContributionManifest.models[]` carries the
 *   full `LaunchableModelRecord` projection — locality, availability, freshness,
 *   context window, tool surface, vision. This projection's `inference[]` is
 *   `{ id, connectionId }`, because a scoped contribution names WHAT IS OFFERED,
 *   and the capability detail belongs to the model-inventory contract that a
 *   consumer reads separately. Declaring one schema id over two different bodies
 *   would be a false claim of wire compatibility — the exact
 *   label-without-a-derivation defect this arc keeps finding.
 * - An alias would change what an existing fleet consumer reads today. The hard
 *   requirement on this slice is that `fleetContribution` consumers see zero
 *   behavior change; a schema id is the first thing such a consumer branches on.
 * - Nothing yet reads this projection. Slice 6 owns the authenticated route and
 *   the first consumer, and that is the point at which a migration (or a
 *   deliberate second id) can be made against a real reader instead of against
 *   an argument. Minting an alias now would be a compatibility claim with no
 *   consumer to check it.
 *
 * What IS unified is the CONSENT: {@link resolveScopedContribution} treats
 * `AppConfig.fleetContribution` as the sole authority for the `fleet` scope and
 * refuses a shadowing `contribution["fleet"]` entry by name. One writable home
 * per scope, so the fleet's opt-in cannot acquire a second, drifting copy — the
 * defect §5 calls "much worse at this layer".
 */

import type { FleetContributionConfig } from './fleet-contribution.js';

/**
 * The projection's wire version. Deliberately NOT an alias of
 * `station.fleet-contribution/v1` — see the module docblock.
 */
export const CONTRIBUTION_PROJECTION_SCHEMA_VERSION =
  'station.contribution/v1' as const;

/**
 * Diagnostics about the projection as a whole rather than about one named
 * resource use this in place of a resource id — the same convention
 * `fleet-contribution.ts` and `launchable-model-inventory.ts` already use.
 */
export const CONTRIBUTION_DIAGNOSTIC_ID = 'station:contribution';

// ---------------------------------------------------------------------------
// Scope (§4.2) — one schema, several trust boundaries.
// ---------------------------------------------------------------------------

/**
 * The trust boundary a contribution is made within.
 *
 * `{ kind: 'channel', channelId }` is the third row of §4.2's table and is
 * deliberately absent until #1392 ships channels: a member of the union with no
 * producer and no store to key it by is a claim about a capability that does not
 * exist. The DISCRIMINANT is what §9 OQ-11 requires to be present from v1 —
 * "adding a scope to a shipped, consumed projection later is a wire change
 * across every peer" — and adding a third member to a discriminated union is
 * additive in a way that adding the discriminant itself is not.
 */
export type ContributionScope =
  /** Your own machines; one implicit owner. The shipped `fleetContribution`. */
  | { kind: 'fleet' }
  /** A project's members, joined on the manifest's portable `id` (§3.2). */
  | { kind: 'project'; projectId: string };

/** The `AppConfig.contribution` key for the fleet scope. */
export const FLEET_CONTRIBUTION_SCOPE_KEY = 'fleet';

/** The `AppConfig.contribution` key prefix for a project scope. */
export const PROJECT_CONTRIBUTION_SCOPE_KEY_PREFIX = 'project:';

/**
 * The map key a scope is stored under in `AppConfig.contribution`
 * (`"fleet"` / `"project:prj_7f3a…"`), per §4.2's illustrative config.
 */
export function contributionScopeKey(scope: ContributionScope): string {
  return scope.kind === 'fleet'
    ? FLEET_CONTRIBUTION_SCOPE_KEY
    : `${PROJECT_CONTRIBUTION_SCOPE_KEY_PREFIX}${scope.projectId}`;
}

/**
 * The inverse, FAIL-CLOSED: a key this version cannot name yields `undefined`
 * rather than a guessed scope.
 *
 * This matters more than it looks. The config map is operator-editable JSON and
 * will one day hold `channel:…` keys written by a newer Station. Parsing an
 * unknown key "as a project" would attach one space's consent to a different
 * space — offering resources to people the operator never named, which is the
 * one failure mode §4.6's default-to-nothing exists to prevent. An unparseable
 * key therefore contributes NOTHING and is never merged.
 *
 * **Where the operator is TOLD** (station#1503 review, L7): at the write, in
 * `src-server/routes/system/config.ts`, which refuses a `PUT /config/app`
 * carrying a key this function cannot name. An earlier version of this docblock
 * claimed such a key "is reported as an ignored key" when nothing enumerated
 * the map and nothing reported — a reader-without-a-producer claim, the same
 * shape this arc keeps finding. The refusal is now real; this sentence names
 * where it lives so the next reader can check it.
 */
export function parseContributionScopeKey(
  key: string,
): ContributionScope | undefined {
  if (key === FLEET_CONTRIBUTION_SCOPE_KEY) return { kind: 'fleet' };
  if (!key.startsWith(PROJECT_CONTRIBUTION_SCOPE_KEY_PREFIX)) return undefined;
  const projectId = key.slice(PROJECT_CONTRIBUTION_SCOPE_KEY_PREFIX.length);
  if (projectId.length === 0) return undefined;
  return { kind: 'project', projectId };
}

// ---------------------------------------------------------------------------
// The persisted offer (§4.2) — `AppConfig.contribution`, keyed by scope key.
// ---------------------------------------------------------------------------

/** The three resource kinds in scope for v1 (§4.2). */
export type ContributionResourceAxis = 'execution' | 'agents' | 'inference';

export const CONTRIBUTION_RESOURCE_AXES = [
  'execution',
  'agents',
  'inference',
  // `as const satisfies` and NOT a `readonly ContributionResourceAxis[]`
  // annotation — the annotation widens every element to the full union, which
  // makes the exhaustiveness proof below `Exclude<X, X> extends never`, i.e.
  // VACUOUSLY true, and dropping a member from this array stays green. The same
  // trap `RESOURCE_RESOLUTION_STATES` records having been hit for real.
] as const satisfies readonly ContributionResourceAxis[];

type _AxesAreExhaustive =
  Exclude<
    ContributionResourceAxis,
    (typeof CONTRIBUTION_RESOURCE_AXES)[number]
  > extends never
    ? true
    : never;
const _axesAreExhaustive: _AxesAreExhaustive = true;
void _axesAreExhaustive;

/**
 * The persisted offer for ONE scope. **Default off in every direction**: an
 * absent object, an absent `enabled`, `enabled: false`, an absent axis, and an
 * empty axis list all contribute nothing.
 *
 * Each axis is an object wrapping its list rather than a bare array, matching
 * §4.2's config sketch — so an axis can later carry an axis-scoped option
 * without becoming a second shape at that point. It carries no such option
 * today, and none is invented here.
 */
export interface ContributionConfig {
  /**
   * Master opt-in for this scope. Absent or anything other than `true` means
   * off — see {@link isContributionEnabled}, which every caller must use
   * instead of a truthy check.
   */
  enabled?: boolean;
  /**
   * Repo resource ids (§3.2 — a git resource's id IS its canonical remote) this
   * Station offers to run work in. Naming a repo here is the consent §4.3 keeps
   * strictly separate from having it checked out: "having a checkout is not
   * consent to have work routed into it."
   */
  execution?: { repoIds?: string[] };
  /** Agent slugs this Station makes available in this space. */
  agents?: { slugs?: string[] };
  /** Local model connection ids, exactly as the fleet instance already does. */
  inference?: { connectionIds?: string[] };
}

/**
 * The single fail-closed read of the opt-in — `enabled` must be exactly `true`.
 * Byte-identical in behaviour to `isFleetContributionEnabled`, deliberately: two
 * readers of one decision are two chances to disagree, and the fleet's is the
 * one that shipped.
 */
export function isContributionEnabled(
  config: ContributionConfig | undefined,
): boolean {
  return config?.enabled === true;
}

/**
 * The ids the operator has MARKED on one axis — deduplicated and sorted, with
 * non-string and empty entries dropped.
 *
 * Deliberately independent of {@link isContributionEnabled}, for the reason
 * `declaredContributionConnectionIds` records: this answers "what is marked",
 * which is exactly what a disabled Station needs in order to say "you marked 2
 * repos but the opt-in is off" instead of showing nothing. Callers that need
 * "what is actually offered" must go through the projection builder.
 */
export function declaredContributionIds(
  config: ContributionConfig | undefined,
  axis: ContributionResourceAxis,
): string[] {
  const raw =
    axis === 'execution'
      ? config?.execution?.repoIds
      : axis === 'agents'
        ? config?.agents?.slugs
        : config?.inference?.connectionIds;
  if (!Array.isArray(raw)) return [];
  return [
    ...new Set(
      raw.filter((id): id is string => typeof id === 'string' && id.length > 0),
    ),
  ].sort(compareText);
}

/** Every axis's declared ids, in one read. */
export function declaredContributionTotal(
  config: ContributionConfig | undefined,
): number {
  return CONTRIBUTION_RESOURCE_AXES.reduce(
    (total, axis) => total + declaredContributionIds(config, axis).length,
    0,
  );
}

// ---------------------------------------------------------------------------
// Reading the offer for one scope — ONE writable home per scope.
// ---------------------------------------------------------------------------

/** The `AppConfig` fields {@link resolveScopedContribution} reads. */
export interface ContributionConfigSource {
  /** The scoped map, keyed by {@link contributionScopeKey}. */
  contribution?: Record<string, ContributionConfig>;
  /** The shipped fleet opt-in — the sole authority for the `fleet` scope. */
  fleetContribution?: FleetContributionConfig;
}

/**
 * Where the offer for a scope came from. `absent` is the default-off state and
 * is a real answer, not a gap: a scope nobody has configured contributes
 * nothing, which is §4.6's "the contribution question defaults to nothing".
 */
export type ContributionConfigOrigin =
  | 'fleet-contribution'
  | 'contribution-map'
  | 'absent';

export interface ScopedContributionSelection {
  scope: ContributionScope;
  config: ContributionConfig;
  origin: ContributionConfigOrigin;
  /**
   * Named refusals — today, a `contribution["fleet"]` entry that was ignored.
   * Never silently dropped: an operator who wrote consent in a place that is not
   * the authority must be told it is not in effect, or they will believe they
   * offered something they did not.
   */
  diagnostics: ContributionDiagnostic[];
}

/**
 * The offer in effect for one scope, from ONE authority.
 *
 * The `fleet` scope reads `AppConfig.fleetContribution` and nothing else. A
 * `contribution["fleet"]` entry is REFUSED rather than merged or preferred:
 *
 * - Merging would let one consent be edited in two places and drift, which is
 *   the second-writable-copy defect §5 names as the worst one at this layer.
 * - Preferring the new map would silently retire a shipped, operator-visible
 *   setting — and, worse, a Station upgrading with a stale `contribution.fleet`
 *   entry would start offering connections its `fleetContribution` no longer
 *   names.
 * - Refusing contributes strictly LESS than either alternative, which is the
 *   only direction decision 1 permits an ambiguity to be resolved in.
 */
export function resolveScopedContribution(
  source: ContributionConfigSource | undefined,
  scope: ContributionScope,
): ScopedContributionSelection {
  const key = contributionScopeKey(scope);
  const mapped = source?.contribution?.[key];

  if (scope.kind === 'fleet') {
    const diagnostics: ContributionDiagnostic[] = [];
    if (mapped !== undefined) {
      diagnostics.push({
        axis: 'scope',
        resourceId: CONTRIBUTION_DIAGNOSTIC_ID,
        code: 'contribution-scope-shadowed',
        message: `A contribution entry is stored under the "${FLEET_CONTRIBUTION_SCOPE_KEY}" scope key and is NOT in effect. Fleet contribution is configured by the "fleetContribution" setting, which is its one writable home; move the entry there or remove it.`,
      });
    }
    return {
      scope,
      config: fleetContributionAsScopedConfig(source?.fleetContribution),
      origin:
        source?.fleetContribution === undefined
          ? 'absent'
          : 'fleet-contribution',
      diagnostics,
    };
  }

  return {
    scope,
    config: mapped ?? {},
    origin: mapped === undefined ? 'absent' : 'contribution-map',
    diagnostics: [],
  };
}

/**
 * The shipped {@link FleetContributionConfig} as an instance of the generalized
 * shape — §4.2's "the shipped `fleetContribution` is the degenerate, global
 * instance of this same contract", as a function rather than as prose.
 *
 * A PROJECTION, never a migration: nothing writes the result back, and
 * `fleetContribution` stays the file of record. `connectionIds` lands on the
 * `inference` axis because that is the axis it always was; the fleet contributes
 * MODELS only (§10 OQ-5 of `inference-fleet.md`), so `execution` and `agents`
 * are absent rather than empty-listed — absent is the axis's own default-off
 * state, and an empty list would read as "the operator considered this axis and
 * named nothing", which is a claim about an operator who was never offered the
 * choice.
 */
export function fleetContributionAsScopedConfig(
  config: FleetContributionConfig | undefined,
): ContributionConfig {
  if (config === undefined) return {};
  return {
    ...(config.enabled === undefined ? {} : { enabled: config.enabled }),
    ...(config.connectionIds === undefined
      ? {}
      : { inference: { connectionIds: config.connectionIds } }),
  };
}

// ---------------------------------------------------------------------------
// Participation (§4.2 decision 2) — the empty list is never the signal.
// ---------------------------------------------------------------------------

/**
 * What this Station is doing about contribution IN THIS SCOPE right now.
 *
 * The fleet's four words with the fleet's meanings. Three of the four carry
 * empty resource lists, so the lists are never the signal — this field plus
 * `diagnostics` always name WHICH empty it is. "Off", "on but nothing named",
 * and "on, named, and currently serving nothing" are three different sentences
 * to an operator and three different routing decisions to a consumer.
 */
export type ContributionParticipation =
  /** Opt-in on, and at least one named resource can currently be served. */
  | 'contributing'
  /** Opt-in off. Nothing is offered regardless of what is named. */
  | 'disabled'
  /** Opt-in on, but no resource is named on any axis. */
  | 'nothing-contributed'
  /**
   * Opt-in on and resources are named, but none can currently be served — a
   * repo whose binding is gone, an agent that no longer exists, a connection
   * that yields no model, or an axis whose source could not be read at all. The
   * diagnostics say which, per resource. §4.2: this is "offering something it
   * cannot currently serve", which is neither "offers nothing" nor "serving".
   *
   * **ACCEPTED COLLAPSE, recorded rather than glossed** (station#1503 review,
   * L9): "the agent is definitely gone" and "I could not read my own agent
   * registry" both land here. They are different sentences, and the four-state
   * enum exists precisely because different sentences deserve different states
   * — so this is a real tension, not a non-issue. It is accepted because the
   * collapse is FAIL-CLOSED (both mean "do not route work here"), because the
   * distinction IS carried, in `diagnostics[]` as
   * `contribution-unavailable-resource` vs `contribution-source-unreadable`,
   * and because a fifth state would have to be named before any consumer exists
   * to route on it. If slice 6's router ever needs to retry an unreadable
   * source and not a dead one, that is the moment to split — from a consumer's
   * need, not from symmetry.
   */
  | 'contributed-unavailable';

export const CONTRIBUTION_PARTICIPATIONS = [
  'contributing',
  'disabled',
  'nothing-contributed',
  'contributed-unavailable',
  // See CONTRIBUTION_RESOURCE_AXES for why this is `as const satisfies`.
] as const satisfies readonly ContributionParticipation[];

type _ParticipationsAreExhaustive =
  Exclude<
    ContributionParticipation,
    (typeof CONTRIBUTION_PARTICIPATIONS)[number]
  > extends never
    ? true
    : never;
const _participationsAreExhaustive: _ParticipationsAreExhaustive = true;
void _participationsAreExhaustive;

// ---------------------------------------------------------------------------
// The projected resources (§4.2).
// ---------------------------------------------------------------------------

/**
 * One offered repo. §4.2: "The binding attestation is not a separate wire type.
 * It is the `execution[]` entry of this projection — `{ repoId, bound,
 * verifiedAt }`, presence and freshness, NEVER A PATH."
 *
 * An entry with `bound: false` is present ON PURPOSE — it is the difference
 * between "nobody offered this repo" and "your desktop offered it and its
 * checkout is gone" (§6.1's named rejection). Omitting it would make the list
 * the signal again.
 */
export interface ContributedExecution {
  /** The manifest resource id (§3.2) — for a git resource, its canonical remote. */
  repoId: string;
  /**
   * DERIVED from the resolver's state: `true` iff the resource resolved `bound`,
   * i.e. a live check passed just now. Every other resolution state — `stale`,
   * `drifted`, `missing`, `unbound`, `ambiguous`, `unresolvable`,
   * `not-portable` — is `false`, and the reason is a diagnostic. The local
   * repair vocabulary deliberately does not cross the wire: it is a fact about
   * this operator's machine, and §3.5's binding store never leaves it.
   */
  bound: boolean;
  /**
   * The binding's own observation timestamp (epoch ms), or `null` when there is
   * no observation to report. **Never `Date.now()` and never `projectedAt`** —
   * a projection clock standing in for an observation clock is decision 3's
   * failure mode.
   *
   * **This is what §6.1's per-resource constraint computes `maxAgeMs` from**,
   * NOT {@link ContributionProjection.sourceObservedAt} — settled at
   * station#1503's review after two docblocks here disagreed. The constraint
   * asks about one repo; the projection-level clock is the oldest across every
   * axis and can be `null` because an unrelated axis could not be observed. See
   * {@link foldSourceObservedAt}.
   */
  verifiedAt: number | null;
}

/** One offered agent, named by the slug the operator declared. */
export interface ContributedAgent {
  slug: string;
}

/**
 * One offered model. `{ id, connectionId }` per §4.2's projection sketch — what
 * is offered, not what it can do. Capability columns stay in
 * `station.model-inventory/v2` and its fleet projection; duplicating them here
 * would fork the capability contract at a second version boundary.
 */
export interface ContributedInference {
  /**
   * The launchable model RECORD's id, as `station.model-inventory/v2` mints it
   * — unique per Station, which is why it can be addressed on its own.
   *
   * **The join key is the record id, not a bare model name** (station#1503
   * review, L11). If a caller supplied provider-native model names instead, two
   * connections serving the same model would emit two entries sharing this
   * field and a consumer addressing one could reach either. The builder does
   * NOT de-duplicate that case — both entries are true, and dropping one would
   * hide a real offer — so the obligation sits on the producer, and it is
   * stated on the builder's input type as well as here.
   */
  id: string;
  /** The local model connection that launches it. */
  connectionId: string;
}

// ---------------------------------------------------------------------------
// Diagnostics — a named absence, never a shorter list.
// ---------------------------------------------------------------------------

export type ContributionDiagnosticCode =
  /** The opt-in is off for this scope. */
  | 'contribution-disabled'
  /** The opt-in is on, but no resource is named on any axis. */
  | 'contribution-empty'
  /** A named resource does not exist on this Station at all. */
  | 'contribution-unknown-resource'
  /** A named resource exists but cannot currently be served. */
  | 'contribution-unavailable-resource'
  /**
   * An axis's source could not be read, so what this Station contributes on it
   * is UNKNOWN rather than empty — the distinction `inventory-unavailable`
   * draws in the fleet manifest, generalized to three axes.
   */
  | 'contribution-source-unreadable'
  /**
   * Consent was found under a scope key whose authority is elsewhere (today:
   * `contribution["fleet"]`, whose authority is `AppConfig.fleetContribution`).
   * Reported, never merged — see {@link resolveScopedContribution}.
   */
  | 'contribution-scope-shadowed';

export interface ContributionDiagnostic {
  /**
   * Which axis the diagnostic belongs to, or `scope` for one about the offer as
   * a whole. Carried because a repo id, an agent slug, and a connection id share
   * one string namespace here and a bare `resourceId` could not say which map a
   * reader should look in.
   */
  axis: ContributionResourceAxis | 'scope';
  /** A resource id, or {@link CONTRIBUTION_DIAGNOSTIC_ID}. */
  resourceId: string;
  code: ContributionDiagnosticCode;
  /**
   * Human-readable, derived from the id and the state. **Never carries a local
   * path**, and never the resolver's own `reason` prose, which embeds one.
   */
  message: string;
}

// ---------------------------------------------------------------------------
// The projection (§4.2).
// ---------------------------------------------------------------------------

export interface ContributionProjection {
  schemaVersion: typeof CONTRIBUTION_PROJECTION_SCHEMA_VERSION;
  /** WHICH space this offer is made in. Present from v1 (§9 OQ-11). */
  scope: ContributionScope;
  /**
   * Wall-clock time this projection was produced. **Not an observation age** —
   * deliberately NOT called `observedAt`, because every sibling `observedAt` in
   * this stack means "when the underlying fact was observed". A consumer that
   * computed staleness from a field named `observedAt` here would always read
   * roughly `now` and conclude the projection is fresh no matter how old its
   * evidence is. Use {@link ContributionProjection.sourceObservedAt}.
   */
  projectedAt: string;
  /**
   * The OLDEST observation behind this projection, or `null` when nothing
   * observable stands behind it — including when an axis contributed something
   * it cannot say WHEN it observed, which is the stalest source there is (see
   * {@link foldSourceObservedAt}). **This is the whole-projection freshness
   * field** (§4.2 decision 3): a fresh projection of a stale source is a stale
   * claim, and the two timestamps must stay separable to say so.
   *
   * §6.1's per-resource constraint does NOT read this — it reads the repo's own
   * {@link ContributedExecution.verifiedAt}. This one answers "how fresh is this
   * body", which an unrelated unobservable axis may legitimately make unknown.
   */
  sourceObservedAt: string | null;
  participation: ContributionParticipation;
  execution: ContributedExecution[];
  agents: ContributedAgent[];
  inference: ContributedInference[];
  diagnostics: ContributionDiagnostic[];
}

/**
 * The projection's key set, as data. **An exact set, not a floor** — the
 * honesty bar's "assert that the enumerated count equals the real count, and
 * prefer an exact set to a floor" applied to a wire body.
 *
 * It is what makes two of this module's claims checkable rather than merely
 * documented, in BOTH directions: that no self-asserted identity field exists
 * (decision 4), and that none of §4.4's requirements/compliance machinery landed
 * here while OQ-12 is open. A field added to {@link ContributionProjection}
 * without a decision recorded here fails this module's own test.
 */
export const CONTRIBUTION_PROJECTION_FIELDS = [
  'schemaVersion',
  'scope',
  'projectedAt',
  'sourceObservedAt',
  'participation',
  'execution',
  'agents',
  'inference',
  'diagnostics',
] as const satisfies readonly (keyof ContributionProjection)[];

type _ProjectionFieldsAreExhaustive =
  Exclude<
    keyof ContributionProjection,
    (typeof CONTRIBUTION_PROJECTION_FIELDS)[number]
  > extends never
    ? true
    : never;
const _projectionFieldsAreExhaustive: _ProjectionFieldsAreExhaustive = true;
void _projectionFieldsAreExhaustive;

/**
 * Keys that assert an identity the BODY has no standing to assert (decision 4).
 * A projection carrying one is refused outright rather than sanitized: a peer
 * that sends it disagrees with this contract about who attributes what, and
 * quietly stripping the field would leave that disagreement unreported.
 *
 * **This list has independent power, and that took a fault injection to
 * establish.** The first revision checked it inside a boolean predicate that
 * ALSO enforced the exact key set — so deleting the whole identity check left
 * every test green, because an identity field is an unknown field too. A
 * guardrail whose rejection path is unreachable is decoration, and a named
 * constant that computes nothing beyond what a neighbouring check already
 * computes is the label-without-a-derivation defect wearing a guard's clothes.
 * {@link contributionProjectionRefusal} is the fix: it returns the REASON, this
 * list is consulted first, and "carries a self-asserted identity" is a
 * different, testable sentence from "carries a field this version does not
 * know". A consumer needs that difference too — one is a peer disagreeing about
 * attribution, the other is a peer running a newer build.
 */
export const FORBIDDEN_CONTRIBUTION_IDENTITY_FIELDS = [
  'stationId',
  'environmentId',
  'memberId',
  'hostname',
  'host',
] as const;

// ---------------------------------------------------------------------------
// Readers.
// ---------------------------------------------------------------------------

/**
 * How a consumer must treat this projection's age.
 *
 * Three-valued on purpose. §6.1: "A stale answer is `unknown`, not satisfied" —
 * a two-valued reader would have to fold "no observation stands behind this" into
 * either `fresh` (a fabricated claim) or `stale` (a claim that something WAS
 * observed, once). Neither is true, so `unknown` is its own answer.
 */
export type ContributionFreshness = 'fresh' | 'stale' | 'unknown';

export interface ContributionFreshnessOptions {
  /** The consumer's own bound. §3.6: `stale` is relative to who is asking. */
  maxAgeMs: number;
  /** Epoch ms. Supplied, never read from the clock here, so this stays pure. */
  now: number;
}

/**
 * Freshness from `sourceObservedAt` ONLY — the reader that makes decision 3's
 * two-clock split load-bearing rather than decorative.
 *
 * `projectedAt` is never consulted, and that is the whole point: a projection
 * built one millisecond ago over a binding verified last week is a STALE claim,
 * and a reader that looked at the projection clock would call it fresh. The
 * fail-closed cases — no observation, an unparseable timestamp, an observation
 * in the future, a non-finite bound — are `unknown`, never `fresh`.
 */
export function contributionFreshness(
  projection: Pick<ContributionProjection, 'sourceObservedAt'>,
  options: ContributionFreshnessOptions,
): ContributionFreshness {
  const observed = projection.sourceObservedAt;
  if (typeof observed !== 'string' || observed.length === 0) return 'unknown';
  const observedMs = Date.parse(observed);
  if (!Number.isFinite(observedMs)) return 'unknown';
  if (!Number.isFinite(options.now) || !Number.isFinite(options.maxAgeMs)) {
    return 'unknown';
  }
  const age = options.now - observedMs;
  // A negative age means the source claims to have been observed in the reader's
  // future — clock skew, or a fabricated timestamp. Both mean "I cannot compute
  // an age from this", and calling it `fresh` would let a wrong clock satisfy
  // every constraint forever.
  if (age < 0) return 'unknown';
  return age <= options.maxAgeMs ? 'fresh' : 'stale';
}

/**
 * One axis's contribution to the projection's freshness (station#1503 review,
 * M3).
 *
 * `contributed` is what makes this more than a nullable timestamp. An axis that
 * put NOTHING in the body has no bearing on how fresh the body is; an axis that
 * put something in and cannot say when it observed it is the STALEST possible
 * source, and folding it in as "no candidate" silently upgrades the aggregate.
 */
export interface ContributionSourceClock {
  /** Did this axis actually project an entry into the body? */
  contributed: boolean;
  /** When this axis's source was observed, or `null` when nothing observed it. */
  observedAt: string | null;
}

/**
 * The projection's `sourceObservedAt`, folded in ONE place.
 *
 * ## The rule, and the defect it closes
 *
 * An axis that CONTRIBUTED but carries no observation makes the aggregate
 * `null` — not "skipped". Review found the original fold reading `fresh` for a
 * projection that offered a repo on the compat branch (`verifiedAt: null`,
 * never verified in its life) alongside an inference axis observed 60 seconds
 * ago: the unobserved axis dropped out of the comparison and the observed one
 * spoke for the whole body. That contradicts this module's own two sentences —
 * "a projection with no observation behind it is `unknown` — never `fresh`",
 * and "only as fresh as its stalest source". **An axis standing on zero
 * observations IS the stalest source.** It is not mitigated by anything: the
 * `agents` axis has no clock at all and always reports `null`, so any
 * projection offering an agent was affected.
 *
 * `null` here reads as `unknown` through {@link contributionFreshness}, which
 * is fail-closed: §6.1's "a stale answer is `unknown`, not satisfied".
 *
 * ## This is the WHOLE-PROJECTION clock, not the per-resource one
 *
 * Deliberately stated because two docblocks in this module disagreed about it
 * (review M3) and slice 6 mints the reader that settles it:
 *
 * - **Per-resource** (§6.1's `project-contribution` constraint, which asks
 *   about ONE repo): the answer is {@link ContributedExecution.verifiedAt},
 *   that repo's own binding observation. It must be, because this aggregate can
 *   legitimately be dragged to `null` by an unrelated axis — an unobservable
 *   agent list would otherwise veto a repo whose binding was verified seconds
 *   ago, which is a different claim from the one the constraint makes.
 * - **Whole-projection** (how fresh is this body as a whole):
 *   {@link ContributionProjection.sourceObservedAt}, this fold.
 *
 * Neither substitutes for the other, and a consumer that wants the first must
 * not read the second.
 */
export function foldSourceObservedAt(
  clocks: readonly ContributionSourceClock[],
): string | null {
  const contributing = clocks.filter((clock) => clock.contributed);
  if (contributing.length === 0) return null;
  // The rule. One unobserved contributing axis is enough.
  if (contributing.some((clock) => clock.observedAt === null)) return null;
  return oldestObservation(contributing.map((clock) => clock.observedAt));
}

/**
 * The oldest of a set of observations, as an ISO string — `null` when none is
 * observable. Exported because the projection builder and any future
 * multi-source consumer must fold this the same way; two foldings of "how fresh
 * is this" is how two readers come to disagree about the same body.
 *
 * Unparseable entries are DROPPED from the comparison rather than treated as
 * old or as new: a value that is not a timestamp is not evidence of an
 * observation at any time. When every candidate is unparseable the answer is
 * `null`, which {@link contributionFreshness} reads as `unknown`.
 */
export function oldestObservation(
  candidates: readonly (string | null | undefined)[],
): string | null {
  let oldestMs = Number.POSITIVE_INFINITY;
  let oldest: string | null = null;
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || candidate.length === 0) continue;
    const ms = Date.parse(candidate);
    if (!Number.isFinite(ms)) continue;
    if (ms < oldestMs) {
      oldestMs = ms;
      oldest = candidate;
    }
  }
  return oldest;
}

/**
 * Runtime backstop for {@link ContributionProjection}, in the same style and for
 * the same reason as `isWellFormedResolution`: the union makes an in-repo
 * TypeScript producer's mistakes compile errors, so what is left for a predicate
 * is exactly the values that arrive WITHOUT a compiler — a body read off the
 * wire from a peer, a JS caller, a build against an older version of this
 * package. That population is this contract's whole reason to exist.
 *
 * Rejects, specifically:
 * - a `schemaVersion` other than this version's — never cast, never treated as
 *   absent (§2.5's `KnownEnvironment` lesson);
 * - a scope outside the union, or a `project` scope with an empty `projectId`;
 * - a `participation` outside the four states;
 * - a non-array resource list, or a malformed entry in one;
 * - **any self-asserted identity field** (decision 4);
 * - **any key this version has not decided about**, which is what keeps §4.4's
 *   machinery from arriving through a peer while OQ-12 is open.
 */
export function isWellFormedContributionProjection(
  value: unknown,
): value is ContributionProjection {
  return contributionProjectionRefusal(value) === undefined;
}

/**
 * WHY a body was refused, or `undefined` when it is well formed — the reason
 * {@link isWellFormedContributionProjection} reduces to a boolean.
 *
 * Two audiences make this worth having as its own function rather than as a
 * comment:
 *
 * - A CONSUMER. "This peer asserts an identity the body has no standing to
 *   assert" and "this peer sent a field this version does not know" are
 *   different events with different responses — the first is a disagreement
 *   about attribution, the second is a version skew. A boolean tells a user
 *   only that something is wrong, which is the blank-cell failure the honesty
 *   bar forbids.
 * - THIS MODULE'S OWN GUARDRAILS. See
 *   {@link FORBIDDEN_CONTRIBUTION_IDENTITY_FIELDS}: inside a boolean predicate
 *   the identity check was provably unreachable behind the exact-key-set check,
 *   and deleting it changed no test. Returning the reason is what gives each
 *   check a distinguishable effect, so each can be proven to do its own job.
 *
 * The reason names FIELDS and SHAPES, never values: a malformed body may carry
 * a peer's data, and a refusal message is the wrong place to widen what it
 * discloses.
 */
export function contributionProjectionRefusal(
  value: unknown,
): string | undefined {
  if (!isPlainObject(value)) {
    return `it is ${value === null ? 'null' : typeof value}, not an object`;
  }
  if (value.schemaVersion !== CONTRIBUTION_PROJECTION_SCHEMA_VERSION) {
    return `its schemaVersion is not ${CONTRIBUTION_PROJECTION_SCHEMA_VERSION}`;
  }
  // FIRST, and before the key-set check that would otherwise subsume it:
  // decision 4 is a statement about authority, not about vocabulary.
  const identity = FORBIDDEN_CONTRIBUTION_IDENTITY_FIELDS.filter(
    (field) => field in value,
  );
  if (identity.length > 0) {
    return `it carries a self-asserted identity field (${identity.join(', ')}); attribution comes from the transport the reader authenticated to, never from the body`;
  }
  const allowed = new Set<string>(CONTRIBUTION_PROJECTION_FIELDS);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    return `it carries ${unknown.length} field(s) this version does not know (${unknown.join(', ')})`;
  }
  const missing = CONTRIBUTION_PROJECTION_FIELDS.filter(
    (key) => !(key in value),
  );
  if (missing.length > 0) {
    return `it is missing required field(s) (${missing.join(', ')})`;
  }

  if (!isWellFormedContributionScope(value.scope))
    return 'its scope is not one this version can name';
  if (typeof value.projectedAt !== 'string' || value.projectedAt.length === 0) {
    return 'its projectedAt is not a non-empty string';
  }
  if (value.sourceObservedAt !== null) {
    if (
      typeof value.sourceObservedAt !== 'string' ||
      value.sourceObservedAt.length === 0
    ) {
      return 'its sourceObservedAt is neither null nor a non-empty string';
    }
  }
  if (
    typeof value.participation !== 'string' ||
    !(CONTRIBUTION_PARTICIPATIONS as readonly string[]).includes(
      value.participation,
    )
  ) {
    return 'its participation is not one of the four states';
  }

  if (!Array.isArray(value.execution)) return 'its execution is not an array';
  for (const entry of value.execution) {
    if (!isPlainObject(entry)) return 'an execution entry is not an object';
    if (typeof entry.repoId !== 'string' || entry.repoId.length === 0) {
      return 'an execution entry names no repoId';
    }
    if (typeof entry.bound !== 'boolean') {
      return "an execution entry's bound is not a boolean";
    }
    if (entry.verifiedAt !== null && typeof entry.verifiedAt !== 'number') {
      return "an execution entry's verifiedAt is neither null nor a number";
    }
  }

  if (!Array.isArray(value.agents)) return 'its agents is not an array';
  for (const entry of value.agents) {
    if (!isPlainObject(entry)) return 'an agent entry is not an object';
    if (typeof entry.slug !== 'string' || entry.slug.length === 0) {
      return 'an agent entry names no slug';
    }
  }

  if (!Array.isArray(value.inference)) return 'its inference is not an array';
  for (const entry of value.inference) {
    if (!isPlainObject(entry)) return 'an inference entry is not an object';
    if (typeof entry.id !== 'string' || entry.id.length === 0) {
      return 'an inference entry names no id';
    }
    if (
      typeof entry.connectionId !== 'string' ||
      entry.connectionId.length === 0
    ) {
      return 'an inference entry names no connectionId';
    }
  }

  if (!Array.isArray(value.diagnostics)) {
    return 'its diagnostics is not an array';
  }
  for (const entry of value.diagnostics) {
    if (!isPlainObject(entry)) return 'a diagnostic is not an object';
    if (typeof entry.resourceId !== 'string' || entry.resourceId.length === 0) {
      return 'a diagnostic names no resourceId';
    }
    if (typeof entry.code !== 'string' || entry.code.length === 0) {
      return 'a diagnostic carries no code';
    }
    if (typeof entry.message !== 'string' || entry.message.length === 0) {
      return 'a diagnostic carries no message';
    }
    if (
      entry.axis !== 'scope' &&
      !(CONTRIBUTION_RESOURCE_AXES as readonly string[]).includes(
        entry.axis as string,
      )
    ) {
      return 'a diagnostic names an axis this version does not know';
    }
  }

  return undefined;
}

export function isWellFormedContributionScope(
  value: unknown,
): value is ContributionScope {
  if (!isPlainObject(value)) return false;
  if (value.kind === 'fleet') return Object.keys(value).length === 1;
  if (value.kind !== 'project') return false;
  if (typeof value.projectId !== 'string' || value.projectId.length === 0) {
    return false;
  }
  return Object.keys(value).length === 2;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

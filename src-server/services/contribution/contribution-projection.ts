/**
 * station#1500 slice 2.5 of epic #1425 — the scoped contribution projection
 * builder (`docs/design/portable-project-identity.md` §4.2).
 *
 * Turns one scope's persisted offer plus what this Station can observe about the
 * named resources into a `station.contribution/v1` projection. It is a PURE
 * function, exactly as `fleet-contribution-manifest.ts` is: the caller performs
 * the observations, so nothing here can invent a resource the Station did not
 * observe, and nothing here needs a clock, a filesystem, or a store.
 *
 * The rule this module exists to enforce is the fleet's, generalized: **a named
 * resource that cannot currently be served produces a named diagnostic, never a
 * shorter list.** Silently dropping it is the degradation §4.5 of
 * `inference-fleet.md` bans, and on the execution axis it is worse than on the
 * inference one — the difference between "nobody could take this work" and "your
 * desktop was supposed to take it and its checkout is gone" (§6.1).
 *
 * ## Two things are impossible here BY CONSTRUCTION, not by review
 *
 * 1. **A resource the operator did not name cannot be projected.** The builder
 *    iterates `declaredContributionIds(config, axis)` and looks each id up in
 *    the observations. An observation for an id nobody declared is never read.
 *    Filtering the other way round — iterate observations, drop the undeclared —
 *    would put the allowlist one `if` away from being lost, and that `if` is
 *    exactly what decision 1 says must not exist.
 * 2. **A local path cannot reach the wire.** {@link ExecutionObservation} has no
 *    field that can hold one — not a path, and deliberately not the resolver's
 *    own `reason`, whose prose embeds the declared path verbatim ("The binding
 *    for X points at "/Users/…""). Diagnostic messages are DERIVED here from the
 *    repo id and the resolution state. §4.2: the execution entry is "presence
 *    and freshness, never a path", and §3.5's binding store never leaves the
 *    machine.
 *
 * ## No OpenTelemetry instrument, and why that is the honest choice here
 *
 * `AGENTS.md` requires instrumentation for a new feature, and station#1686
 * records the counter-defect: an instrument nobody can read from a real Station
 * is not evidence. This slice ships **no consumer and no route** by its own
 * acceptance criteria, so a counter here could only ever record zero — and the
 * first thing it would do when slice 6 arrives is attribute a peer's read to
 * whatever happened to call the builder. The projection itself is the durable,
 * readable record: `participation` plus `diagnostics[]` say what was offered and
 * what could not be served, per resource, in the body a consumer already reads.
 * Slice 6 owns the route, and the route is where a request/outcome counter has a
 * subject to count and a surface to be read from
 * (`projectResolutionRouteRequests` is the shape it should copy).
 */

import type {
  ContributedAgent,
  ContributedExecution,
  ContributedInference,
  ContributionConfig,
  ContributionDiagnostic,
  ContributionParticipation,
  ContributionProjection,
  ContributionResourceAxis,
  ContributionScope,
} from '@kontourai/station-contracts/contribution';
import {
  CONTRIBUTION_DIAGNOSTIC_ID,
  CONTRIBUTION_PROJECTION_SCHEMA_VERSION,
  declaredContributionIds,
  declaredContributionTotal,
  foldSourceObservedAt,
  isContributionEnabled,
  oldestObservation,
} from '@kontourai/station-contracts/contribution';
import type { ResourceResolution } from '@kontourai/station-contracts/project-identity';

/**
 * What the caller observed about ONE declared repo.
 *
 * `state` is the resolver's own answer (`project-resource-resolver.ts`) and
 * `verifiedAt` the binding's recorded observation, or `null` when there is none
 * — the compat branch has no binding row and therefore nothing to report, which
 * is a named absence rather than a synthesized `Date.now()`.
 *
 * There is no `path`, no `reason`, and no `declaredPath` slot, and that absence
 * is the guarantee — see the module docblock.
 */
export interface ExecutionObservation {
  state: ResourceResolution;
  verifiedAt: number | null;
}

/** What the caller observed about ONE declared agent slug. */
export interface AgentObservation {
  /**
   * Whether the agent resolves on this Station right now. An agent that does not
   * is named as unavailable, never dropped.
   */
  available: boolean;
}

/** What the caller observed about ONE declared model connection. */
export interface InferenceObservation {
  /**
   * The launchable model RECORD ids this connection currently yields — the ids
   * `station.model-inventory/v2` mints, which are unique per Station, NOT
   * provider-native model names (station#1503 review, L11). A caller that
   * supplied bare names would make two connections serving the same model emit
   * two entries sharing `ContributedInference.id`, which that field documents
   * as the key a consumer addresses. Nothing here de-duplicates: both entries
   * are true, and dropping one would hide a real offer.
   *
   * Empty means the connection exists and yields nothing right now —
   * `contribution-unavailable-resource`, which is a different fact from the
   * connection not existing.
   */
  modelIds: string[];
}

/**
 * One axis's observations, or a named reason the axis could not be observed at
 * all.
 *
 * The unreadable arm is not an optional convenience: a Station that cannot read
 * its own agent registry contributes an UNKNOWN set, and reporting that as an
 * empty offer is the same lie `inventory-unavailable` exists to prevent in the
 * fleet manifest.
 */
export type ContributionAxisSource<T> =
  | {
      readable: true;
      /**
       * When the axis's underlying source was observed, ISO-8601 — or `null`
       * ONLY when the caller genuinely cannot say.
       *
       * **`null` is decisive, not inert** (station#1503 delta review, N1). A
       * contributing axis that reports `null` makes the whole projection's
       * `sourceObservedAt` null, which reads as `unknown` and, per §6.1, as
       * NOT SATISFIED. That is the correct fail-closed rule — but it means a
       * caller must not report `null` for a fact it just observed.
       *
       * An earlier revision of this docblock said `agents` "is read live and
       * honestly reports `null`". That was true when the fold merely DROPPED
       * nulls, and it became a defect the moment the fold started counting
       * them: a live read has an observation time — **the instant of the
       * read** — and reporting `null` for it asserts "nothing observed this"
       * about something observed a millisecond ago. Under the old guidance
       * every Station offering a single agent would have published
       * `sourceObservedAt: null` forever, making decision 3's whole-projection
       * clock dead on arrival for exactly the Stations that contribute most.
       *
       * So: **pass the read timestamp.** `agents` should report the moment its
       * registry was read; `inference` reports the model inventory's own
       * `observedAt`; `execution` is the exception that needs nothing here,
       * because its clock is PER-BINDING and the builder derives the axis
       * value from the projected `verifiedAt`s (and reports `null` if any
       * projected repo has never been verified — the same rule one level
       * down).
       *
       * Reserve `null` for a source that truly carries no observation: a
       * cached answer of unknown age, or a reader that cannot date what it
       * returned.
       */
      observedAt: string | null;
      /** Keyed by declared id. An id absent from this map was not found here. */
      observed: Record<string, T>;
    }
  | { readable: false; reason: string };

export interface ContributionProjectionInput {
  scope: ContributionScope;
  /** Wall-clock time this projection is being produced (never an age). */
  projectedAt: string;
  /**
   * The offer in effect for {@link ContributionProjectionInput.scope}, from
   * `resolveScopedContribution`. `undefined` is the default-off state.
   */
  config: ContributionConfig | undefined;
  execution: ContributionAxisSource<ExecutionObservation>;
  agents: ContributionAxisSource<AgentObservation>;
  inference: ContributionAxisSource<InferenceObservation>;
  /**
   * Diagnostics the CALLER already derived — today, `resolveScopedContribution`'s
   * shadowed-scope refusal. Carried through so a projection is the single place
   * a reader learns everything that was refused, rather than one thing here and
   * another somewhere the reader has to know to look.
   */
  configDiagnostics?: readonly ContributionDiagnostic[];
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortDiagnostics(
  diagnostics: ContributionDiagnostic[],
): ContributionDiagnostic[] {
  return [
    ...new Map(
      diagnostics.map((item) => [
        // `JSON.stringify` over the tuple, NOT a delimiter join. Two reasons,
        // and the first is why this line was rewritten (review B1): the
        // original used raw NUL bytes as separators, which made this file
        // BINARY to git — 532 lines of it never rendered in the pull request,
        // `grep`/`git grep -I` skipped it entirely, and the repo's own
        // control-character gate (`npm run rename:inventory`, built after
        // station#1398 for exactly this hazard) failed. `scripts/
        // rename-inventory.mjs` says it plainly: a literal control character
        // "makes the file binary to git grep and file(1), so it silently opts
        // out of this gate and every other text scanner in the repo."
        //
        // The second reason is correctness, and it is why this is not simply
        // the escaped form the fleet manifest uses: a delimiter join is
        // collision-free only for data that cannot contain the delimiter, and
        // `message` is free text. `JSON.stringify` escapes its own quotes, so
        // the encoding is injective for any tuple of strings and there is no
        // delimiter to reason about — and it is plain ASCII, so the file stays
        // text.
        JSON.stringify([item.axis, item.resourceId, item.code, item.message]),
        item,
      ]),
    ).values(),
  ].sort(
    (left, right) =>
      compareText(left.axis, right.axis) ||
      compareText(left.resourceId, right.resourceId) ||
      compareText(left.code, right.code) ||
      compareText(left.message, right.message),
  );
}

/**
 * The sentence a `bound: false` execution entry gets, derived from the state
 * alone. Deliberately NOT the resolver's `reason` — see the module docblock.
 *
 * Every state is named. There is no `default:` arm: a state added to
 * `ResourceResolution` must be classified deliberately rather than acquiring a
 * generic sentence that says nothing to the operator whose repo it is about.
 */
function executionUnavailableMessage(
  repoId: string,
  state: ResourceResolution,
): string {
  const offered = `This Station offers execution for "${repoId}"`;
  switch (state) {
    case 'bound':
      // Unreachable through `projectExecution`, which only calls this for a
      // non-`bound` state. Named rather than left to a `default:` so the switch
      // stays exhaustive over the union.
      return `${offered} and it resolves here.`;
    case 'unbound':
      return `${offered}, but nothing here records a location for it, so it cannot currently be served.`;
    case 'missing':
      return `${offered}, but the location recorded for it is gone, so it cannot currently be served.`;
    case 'drifted':
      return `${offered}, but the recorded location holds a different repository, so it cannot currently be served.`;
    case 'stale':
      return `${offered}, but its checkout could not be verified just now, so it cannot currently be served.`;
    case 'ambiguous':
      return `${offered}, but this project's resources do not name it unambiguously, so it cannot currently be served.`;
    case 'unresolvable':
      return `${offered}, but access to it was denied on this Station, so it cannot currently be served.`;
    case 'not-portable':
      return `${offered}, but it is a local-only resource with no portable identity, so it cannot be served to anyone else.`;
  }
}

interface AxisProjection<T> {
  entries: T[];
  diagnostics: ContributionDiagnostic[];
  /** Entries that can currently be SERVED — what `contributing` is derived from. */
  serviceable: number;
  /** This axis's own observation clock, or `null`. */
  observedAt: string | null;
}

function unreadableAxis<T>(
  axis: ContributionResourceAxis,
  declared: string[],
  reason: string,
): AxisProjection<T> {
  return {
    entries: [],
    diagnostics:
      declared.length === 0
        ? []
        : [
            {
              axis,
              resourceId: CONTRIBUTION_DIAGNOSTIC_ID,
              code: 'contribution-source-unreadable',
              message: `This Station could not read the source for its ${axis} contribution (${reason}), so what it currently offers on that axis is unknown rather than empty. ${declared.length} named ${declared.length === 1 ? 'resource is' : 'resources are'} affected.`,
            },
          ],
    serviceable: 0,
    observedAt: null,
  };
}

function projectExecution(
  config: ContributionConfig | undefined,
  source: ContributionAxisSource<ExecutionObservation>,
): AxisProjection<ContributedExecution> {
  const declared = declaredContributionIds(config, 'execution');
  if (!source.readable) {
    return unreadableAxis('execution', declared, source.reason);
  }

  const entries: ContributedExecution[] = [];
  const diagnostics: ContributionDiagnostic[] = [];
  let serviceable = 0;

  for (const repoId of declared) {
    const observation = source.observed[repoId];
    if (observation === undefined) {
      // Named, never dropped: the operator offered a repo this project does not
      // declare (or that this Station cannot see at all), and a shorter list
      // would report that as "offered nothing".
      diagnostics.push({
        axis: 'execution',
        resourceId: repoId,
        code: 'contribution-unknown-resource',
        message: `This Station offers execution for "${repoId}", but no resource by that name is known here.`,
      });
      continue;
    }
    const bound = observation.state === 'bound';
    entries.push({
      repoId,
      bound,
      // An observation, never a stand-in. `verifiedAt` is the binding's own
      // recorded timestamp; the compat branch has none and says so with `null`.
      verifiedAt:
        typeof observation.verifiedAt === 'number' &&
        Number.isFinite(observation.verifiedAt)
          ? observation.verifiedAt
          : null,
    });
    if (bound) {
      serviceable += 1;
      continue;
    }
    diagnostics.push({
      axis: 'execution',
      resourceId: repoId,
      code: 'contribution-unavailable-resource',
      message: executionUnavailableMessage(repoId, observation.state),
    });
  }

  return {
    entries,
    diagnostics,
    serviceable,
    // DERIVED, because execution's clock is per-binding: a projection is only as
    // fresh as its stalest source, so the axis reports the OLDEST verification
    // among the repos it actually projected.
    //
    // An entry with NO `verifiedAt` makes the whole axis unobserved (`null`),
    // rather than dropping out of the comparison (station#1503 review, M3). A
    // repo offered on the compat branch has never been verified in its life;
    // letting a sibling repo's recent verification speak for it upgrades an
    // unobserved claim to a fresh one. Same rule, one level down, as
    // `foldSourceObservedAt`.
    observedAt: entries.some((entry) => entry.verifiedAt === null)
      ? null
      : oldestObservation(
          entries.map((entry) =>
            entry.verifiedAt === null
              ? null
              : new Date(entry.verifiedAt).toISOString(),
          ),
        ),
  };
}

function projectAgents(
  config: ContributionConfig | undefined,
  source: ContributionAxisSource<AgentObservation>,
): AxisProjection<ContributedAgent> {
  const declared = declaredContributionIds(config, 'agents');
  if (!source.readable) {
    return unreadableAxis('agents', declared, source.reason);
  }

  const entries: ContributedAgent[] = [];
  const diagnostics: ContributionDiagnostic[] = [];

  for (const slug of declared) {
    const observation = source.observed[slug];
    if (observation === undefined) {
      diagnostics.push({
        axis: 'agents',
        resourceId: slug,
        code: 'contribution-unknown-resource',
        message: `This Station offers agent "${slug}", but no agent by that name exists here.`,
      });
      continue;
    }
    if (!observation.available) {
      diagnostics.push({
        axis: 'agents',
        resourceId: slug,
        code: 'contribution-unavailable-resource',
        message: `This Station offers agent "${slug}", but it cannot currently be run here.`,
      });
      continue;
    }
    entries.push({ slug });
  }

  return {
    entries,
    diagnostics,
    serviceable: entries.length,
    // Agent availability is read live and carries no observation timestamp. That
    // is reported as `null` — an honest "there is no clock behind this" — rather
    // than as `projectedAt`, which would be decision 3's exact failure: a
    // projection clock standing in for an observation clock.
    observedAt: source.observedAt,
  };
}

function projectInference(
  config: ContributionConfig | undefined,
  source: ContributionAxisSource<InferenceObservation>,
): AxisProjection<ContributedInference> {
  const declared = declaredContributionIds(config, 'inference');
  if (!source.readable) {
    return unreadableAxis('inference', declared, source.reason);
  }

  const entries: ContributedInference[] = [];
  const diagnostics: ContributionDiagnostic[] = [];

  for (const connectionId of declared) {
    const observation = source.observed[connectionId];
    if (observation === undefined) {
      diagnostics.push({
        axis: 'inference',
        resourceId: connectionId,
        code: 'contribution-unknown-resource',
        message: `This Station offers inference on connection "${connectionId}", but no such connection exists here.`,
      });
      continue;
    }
    const modelIds = (
      Array.isArray(observation.modelIds) ? observation.modelIds : []
    ).filter((id): id is string => typeof id === 'string' && id.length > 0);
    if (modelIds.length === 0) {
      diagnostics.push({
        axis: 'inference',
        resourceId: connectionId,
        code: 'contribution-unavailable-resource',
        message: `This Station offers inference on connection "${connectionId}", but it currently yields no launchable model.`,
      });
      continue;
    }
    for (const id of modelIds) entries.push({ id, connectionId });
  }

  return {
    entries,
    diagnostics,
    serviceable: entries.length,
    observedAt: source.observedAt,
  };
}

function projection(options: {
  scope: ContributionScope;
  projectedAt: string;
  sourceObservedAt: string | null;
  participation: ContributionParticipation;
  execution?: ContributedExecution[];
  agents?: ContributedAgent[];
  inference?: ContributedInference[];
  diagnostics: ContributionDiagnostic[];
}): ContributionProjection {
  return {
    schemaVersion: CONTRIBUTION_PROJECTION_SCHEMA_VERSION,
    scope: options.scope,
    projectedAt: options.projectedAt,
    sourceObservedAt: options.sourceObservedAt,
    participation: options.participation,
    execution: [...(options.execution ?? [])].sort((left, right) =>
      compareText(left.repoId, right.repoId),
    ),
    agents: [...(options.agents ?? [])].sort((left, right) =>
      compareText(left.slug, right.slug),
    ),
    inference: [...(options.inference ?? [])].sort(
      (left, right) =>
        compareText(left.connectionId, right.connectionId) ||
        compareText(left.id, right.id),
    ),
    diagnostics: sortDiagnostics(options.diagnostics),
  };
}

/**
 * §4.2's projection for ONE scope.
 *
 * The four participation states are derived, in this order — every branch below
 * carries a diagnostic naming WHICH empty it is, because three of the four carry
 * empty lists and the lists are therefore never the signal:
 *
 * 1. `disabled` — the opt-in is not exactly `true`. Nothing is offered no matter
 *    what is named, and the diagnostic says how many named resources are being
 *    withheld so an operator can tell "off" from "off and empty".
 * 2. `nothing-contributed` — on, and no resource is named on ANY axis.
 * 3. `contributing` — on, named, and at least one named resource can currently
 *    be SERVED. Not "at least one entry exists": an `execution[]` entry with
 *    `bound: false` is present by design and is precisely the thing that cannot
 *    be served, so counting entries instead of serviceable ones would report a
 *    Station with three dead checkouts as contributing.
 * 4. `contributed-unavailable` — on, named, and nothing can currently be served.
 */
export function projectContribution(
  input: ContributionProjectionInput,
): ContributionProjection {
  const configDiagnostics = [...(input.configDiagnostics ?? [])];
  const declaredTotal = declaredContributionTotal(input.config);

  if (!isContributionEnabled(input.config)) {
    return projection({
      scope: input.scope,
      projectedAt: input.projectedAt,
      // Nothing was observed, because nothing was consulted. `null` here is not
      // a degraded reading — it is the truthful statement that a disabled
      // Station's offer stands on no observation at all.
      sourceObservedAt: null,
      participation: 'disabled',
      diagnostics: [
        ...configDiagnostics,
        {
          axis: 'scope',
          resourceId: CONTRIBUTION_DIAGNOSTIC_ID,
          code: 'contribution-disabled',
          message:
            declaredTotal > 0
              ? `Contribution is turned off for this scope. ${declaredTotal} named ${declaredTotal === 1 ? 'resource is' : 'resources are'} not being offered.`
              : 'Contribution is turned off for this scope. Nothing is offered here.',
        },
      ],
    });
  }

  if (declaredTotal === 0) {
    return projection({
      scope: input.scope,
      projectedAt: input.projectedAt,
      sourceObservedAt: null,
      participation: 'nothing-contributed',
      diagnostics: [
        ...configDiagnostics,
        {
          axis: 'scope',
          resourceId: CONTRIBUTION_DIAGNOSTIC_ID,
          code: 'contribution-empty',
          message:
            'Contribution is turned on for this scope, but no repo, agent, or model connection is named. Nothing is offered until one is.',
        },
      ],
    });
  }

  const execution = projectExecution(input.config, input.execution);
  const agents = projectAgents(input.config, input.agents);
  const inference = projectInference(input.config, input.inference);
  const serviceable =
    execution.serviceable + agents.serviceable + inference.serviceable;

  return projection({
    scope: input.scope,
    projectedAt: input.projectedAt,
    // The OLDEST observation across every axis that CONTRIBUTED — and `null`
    // when a contributing axis cannot say when it observed (§4.2 decision 3,
    // station#1503 review M3). The `contributed` flag is what stops an axis
    // that put nothing in the body from voting, and what stops one that put
    // something in without a clock from silently abstaining.
    sourceObservedAt: foldSourceObservedAt([
      {
        contributed: execution.entries.length > 0,
        observedAt: execution.observedAt,
      },
      { contributed: agents.entries.length > 0, observedAt: agents.observedAt },
      {
        contributed: inference.entries.length > 0,
        observedAt: inference.observedAt,
      },
    ]),
    participation: serviceable > 0 ? 'contributing' : 'contributed-unavailable',
    execution: execution.entries,
    agents: agents.entries,
    inference: inference.entries,
    diagnostics: [
      ...configDiagnostics,
      ...execution.diagnostics,
      ...agents.diagnostics,
      ...inference.diagnostics,
    ],
  });
}

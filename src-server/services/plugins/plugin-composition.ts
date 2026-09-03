import { createHash } from 'node:crypto';
import { isCanonicalPluginId } from '@kontourai/station-contracts/plugin';

const ID = /^[a-z0-9](?:[a-z0-9._-]{0,94}[a-z0-9])?$/;
const SCOPE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const MAX_CONTRIBUTIONS = 64;
const MAX_REQUIREMENTS = 16;
const MAX_CONFIGURATION_BYTES = 64 * 1024;
const MAX_CONFIGURATION_DEPTH = 24;
const MAX_CONFIGURATION_NODES = 8_192;
const DEFAULT_DISPOSER_TIMEOUT_MS = 1_000;
const MAX_DISPOSER_TIMEOUT_MS = 30_000;

/** These authorities are fixed Station machinery, never composition slots. */
export const FIXED_COMPOSITION_AUTHORITIES = Object.freeze([
  'station.identity',
  'station.authorization',
  'station.evidence-admission',
  'station.receipts',
  'station.event-store',
] as const);

const fixedAuthorities = new Set<string>(FIXED_COMPOSITION_AUTHORITIES);

export type PluginCompositionScope =
  | { readonly kind: 'project'; readonly projectId: string }
  | {
      readonly kind: 'agent';
      readonly agentId: string;
      readonly projectId?: string;
    };

export type PluginCompositionJson =
  | null
  | boolean
  | number
  | string
  | PluginCompositionJson[]
  | { [key: string]: PluginCompositionJson };

export interface PluginCompositionRequirement {
  readonly capability: string;
  /** Exact version for this first tracer; range negotiation is a later seam. */
  readonly version: string;
  /** Optional exact local provider when a profile has multiple implementations. */
  readonly instanceId?: string;
  /** If present, must equal the profile scope. Session inheritance is absent. */
  readonly scope?: PluginCompositionScope;
}

export interface PluginCompositionContribution {
  readonly instanceId: string;
  readonly pluginId: string;
  readonly contributionId: string;
  readonly implementationId: string;
  readonly capability: string;
  readonly version: string;
  readonly configuration: PluginCompositionJson;
  readonly isolation: 'profile';
  readonly requires: readonly PluginCompositionRequirement[];
}

export interface PluginCompositionProfile {
  readonly profileId: string;
  readonly scope: PluginCompositionScope;
  readonly contributions: readonly PluginCompositionContribution[];
  /** Required when more than one contribution provides a capability. */
  readonly selections?: Readonly<Record<string, string>>;
}

export type PluginCompositionInspectionStatus =
  | 'active'
  | 'pending'
  | 'failed'
  | 'shadowed';

export type PluginCompositionInspectionReason =
  | 'staging'
  | 'missing-dependency'
  | 'incompatible-version'
  | 'cross-scope-dependency'
  | 'ambiguous-provider'
  | 'invalid-selection'
  | 'dependency-cycle'
  | 'fixed-authority'
  | 'invalid-contribution'
  | 'authorization-unavailable'
  | 'authorization-denied'
  | 'implementation-unavailable'
  | 'activation-failed'
  | 'activation-aborted'
  | 'rollback-failed'
  | 'disposer-failed'
  | 'disposer-timeout';

export interface PluginCompositionInspectionEntry {
  readonly instanceIdentity: string;
  readonly instanceId: string;
  readonly pluginId: string;
  readonly contributionId: string;
  readonly capability: string;
  readonly version: string;
  readonly configurationDigest: string;
  readonly status: PluginCompositionInspectionStatus;
  readonly reason?: PluginCompositionInspectionReason;
  readonly generation?: number;
}

export interface PluginCompositionInspection {
  readonly scope: PluginCompositionScope;
  readonly generation: number;
  readonly active: readonly PluginCompositionInspectionEntry[];
  readonly pending: readonly PluginCompositionInspectionEntry[];
  readonly failed: readonly PluginCompositionInspectionEntry[];
  readonly shadowed: readonly PluginCompositionInspectionEntry[];
}

export type PluginCompositionApplyResult =
  | {
      readonly kind: 'activated';
      readonly generation: number;
      readonly liveFences: readonly PluginCompositionInspectionEntry[];
      readonly inspection: PluginCompositionInspection;
    }
  | {
      readonly kind: 'pending' | 'refused' | 'failed';
      readonly inspection: PluginCompositionInspection;
    };

export type PluginCompositionAuthorization =
  | { readonly kind: 'granted' }
  | { readonly kind: 'denied' }
  | { readonly kind: 'unavailable' };

export interface PluginCompositionAuthorizer {
  authorize(input: {
    readonly profileId: string;
    readonly scope: PluginCompositionScope;
    readonly contribution: PluginCompositionContribution;
    readonly instanceIdentity: string;
  }): PluginCompositionAuthorization | Promise<PluginCompositionAuthorization>;
}

export interface StagedPluginCompositionContribution {
  /** Must reverse every resource acquired by stage; called exactly once. */
  dispose(): void | Promise<void>;
}

export interface PluginCompositionFactory {
  /** Stages an isolated instance which is not visible until generation commit. */
  stage(input: {
    readonly profileId: string;
    readonly scope: PluginCompositionScope;
    readonly contribution: PluginCompositionContribution;
    readonly instanceIdentity: string;
    readonly configuration: PluginCompositionJson;
    readonly dependencies: readonly {
      capability: string;
      instanceIdentity: string;
    }[];
  }): Promise<StagedPluginCompositionContribution>;
}

interface NormalizedContribution {
  declaration: PluginCompositionContribution;
  configuration: PluginCompositionJson;
  configurationDigest: string;
  instanceIdentity: string;
}

interface ActiveContribution extends NormalizedContribution {
  handle: StagedPluginCompositionContribution;
}

interface ActiveGeneration {
  generation: number;
  profileId: string;
  scope: PluginCompositionScope;
  /** Dependency order; disposal is always the reverse. */
  contributions: ActiveContribution[];
}

interface PlannedComposition {
  selected: NormalizedContribution[];
  shadowed: PluginCompositionInspectionEntry[];
}

function scopeKey(scope: PluginCompositionScope): string {
  return scope.kind === 'project'
    ? `project:${scope.projectId}`
    : `agent:${scope.projectId ?? '-'}:${scope.agentId}`;
}

function validScope(scope: PluginCompositionScope): boolean {
  return scope.kind === 'project'
    ? SCOPE_ID.test(scope.projectId)
    : scope.kind === 'agent' &&
        SCOPE_ID.test(scope.agentId) &&
        (scope.projectId === undefined || SCOPE_ID.test(scope.projectId));
}

function sameScope(
  left: PluginCompositionScope,
  right: PluginCompositionScope,
): boolean {
  return scopeKey(left) === scopeKey(right);
}

function canonicalConfiguration(
  value: unknown,
  depth = 0,
  budget = { nodes: 0 },
): PluginCompositionJson | undefined {
  if (
    depth > MAX_CONFIGURATION_DEPTH ||
    ++budget.nodes > MAX_CONFIGURATION_NODES
  ) {
    return undefined;
  }
  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'string'
  ) {
    return value;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  if (Array.isArray(value)) {
    const output: PluginCompositionJson[] = [];
    for (const item of value) {
      const normalized = canonicalConfiguration(item, depth + 1, budget);
      if (normalized === undefined) return undefined;
      output.push(normalized);
    }
    return output;
  }
  if (typeof value !== 'object' || value === null) return undefined;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    if (Object.getOwnPropertySymbols(value).length > 0) return undefined;
    const names = Object.getOwnPropertyNames(value);
    const keys = Object.keys(value);
    if (names.length !== keys.length) return undefined;
    const output: Record<string, PluginCompositionJson> = Object.create(null);
    for (const key of keys.sort()) {
      if (key === '__proto__' || key === 'prototype' || key === 'constructor') {
        return undefined;
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !('value' in descriptor)) return undefined;
      const normalized = canonicalConfiguration(
        descriptor.value,
        depth + 1,
        budget,
      );
      if (normalized === undefined) return undefined;
      output[key] = normalized;
    }
    return output;
  } catch {
    return undefined;
  }
}

function normalizeContribution(
  profile: PluginCompositionProfile,
  contribution: PluginCompositionContribution,
): NormalizedContribution | undefined {
  if (
    !ID.test(contribution.instanceId) ||
    !isCanonicalPluginId(contribution.pluginId) ||
    !ID.test(contribution.contributionId) ||
    !ID.test(contribution.implementationId) ||
    !ID.test(contribution.capability) ||
    !ID.test(contribution.version) ||
    contribution.isolation !== 'profile' ||
    !Array.isArray(contribution.requires) ||
    contribution.requires.length > MAX_REQUIREMENTS ||
    contribution.requires.some(
      (requirement) =>
        !ID.test(requirement.capability) ||
        !ID.test(requirement.version) ||
        (requirement.instanceId !== undefined &&
          !ID.test(requirement.instanceId)) ||
        (requirement.scope !== undefined && !validScope(requirement.scope)),
    )
  ) {
    return undefined;
  }
  const configuration = canonicalConfiguration(contribution.configuration);
  if (configuration === undefined) return undefined;
  const serialized = JSON.stringify(configuration);
  if (Buffer.byteLength(serialized) > MAX_CONFIGURATION_BYTES) return undefined;
  const configurationDigest = createHash('sha256')
    .update(serialized)
    .digest('hex');
  const instanceIdentity = `plugin-instance:${createHash('sha256')
    .update(
      JSON.stringify([
        profile.profileId,
        scopeKey(profile.scope),
        contribution.pluginId,
        contribution.contributionId,
        contribution.instanceId,
      ]),
    )
    .digest('hex')}`;
  return {
    declaration: structuredClone(contribution),
    configuration,
    configurationDigest,
    instanceIdentity,
  };
}

function entry(
  contribution: NormalizedContribution,
  status: PluginCompositionInspectionStatus,
  reason?: PluginCompositionInspectionReason,
  generation?: number,
): PluginCompositionInspectionEntry {
  return {
    instanceIdentity: contribution.instanceIdentity,
    instanceId: contribution.declaration.instanceId,
    pluginId: contribution.declaration.pluginId,
    contributionId: contribution.declaration.contributionId,
    capability: contribution.declaration.capability,
    version: contribution.declaration.version,
    configurationDigest: contribution.configurationDigest,
    status,
    ...(reason ? { reason } : {}),
    ...(generation === undefined ? {} : { generation }),
  };
}

function invalidEntry(
  profile: PluginCompositionProfile,
  contribution: PluginCompositionContribution,
  reason: PluginCompositionInspectionReason,
): PluginCompositionInspectionEntry {
  const seed = JSON.stringify([
    profile.profileId,
    scopeKey(profile.scope),
    contribution.pluginId,
    contribution.contributionId,
    contribution.instanceId,
  ]);
  return {
    instanceIdentity: `plugin-instance:${createHash('sha256').update(seed).digest('hex')}`,
    instanceId: String(contribution.instanceId),
    pluginId: String(contribution.pluginId),
    contributionId: String(contribution.contributionId),
    capability: String(contribution.capability),
    version: String(contribution.version),
    configurationDigest: '',
    status: 'failed',
    reason,
  };
}

function activeEntries(
  generation: ActiveGeneration | undefined,
): PluginCompositionInspectionEntry[] {
  return (generation?.contributions ?? []).map((contribution) =>
    entry(contribution, 'active', undefined, generation?.generation),
  );
}

function topologicalOrder(
  selected: readonly NormalizedContribution[],
  providers: ReadonlyMap<string, NormalizedContribution>,
): NormalizedContribution[] | undefined {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const ordered: NormalizedContribution[] = [];
  const visit = (candidate: NormalizedContribution): boolean => {
    const id = candidate.declaration.instanceId;
    if (visited.has(id)) return true;
    if (visiting.has(id)) return false;
    visiting.add(id);
    for (const requirement of candidate.declaration.requires) {
      const provider = providers.get(requirement.capability);
      if (provider && !visit(provider)) return false;
    }
    visiting.delete(id);
    visited.add(id);
    ordered.push(candidate);
    return true;
  };
  for (const candidate of selected) {
    if (!visit(candidate)) return undefined;
  }
  return ordered;
}

function cloneInspection(
  inspection: PluginCompositionInspection,
): PluginCompositionInspection {
  return structuredClone(inspection);
}

export interface PluginCompositionModule {
  apply(
    profile: PluginCompositionProfile,
  ): Promise<PluginCompositionApplyResult>;
  inspect(scope: PluginCompositionScope): PluginCompositionInspection;
}

export function createPluginCompositionModule(options: {
  readonly factories: ReadonlyMap<string, PluginCompositionFactory>;
  readonly authorizer: PluginCompositionAuthorizer;
  readonly disposerTimeoutMs?: number;
}): PluginCompositionModule {
  const disposerTimeoutMs =
    options.disposerTimeoutMs ?? DEFAULT_DISPOSER_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(disposerTimeoutMs) ||
    disposerTimeoutMs < 1 ||
    disposerTimeoutMs > MAX_DISPOSER_TIMEOUT_MS
  ) {
    throw new Error('Invalid plugin composition disposer timeout');
  }
  const factories = new Map(options.factories);
  const active = new Map<string, ActiveGeneration>();
  const attempts = new Map<string, PluginCompositionInspectionEntry[]>();
  const applyChains = new Map<string, Promise<void>>();

  const inspect = (
    scope: PluginCompositionScope,
  ): PluginCompositionInspection => {
    const key = scopeKey(scope);
    const generation = active.get(key);
    const latest = attempts.get(key) ?? [];
    return cloneInspection({
      scope,
      generation: generation?.generation ?? 0,
      active: activeEntries(generation),
      pending: latest.filter((candidate) => candidate.status === 'pending'),
      failed: latest.filter((candidate) => candidate.status === 'failed'),
      shadowed: latest.filter((candidate) => candidate.status === 'shadowed'),
    });
  };

  const recordAttempt = (
    scope: PluginCompositionScope,
    entries: PluginCompositionInspectionEntry[],
  ) => {
    const key = scopeKey(scope);
    attempts.set(
      key,
      entries.map((candidate) => structuredClone(candidate)),
    );
  };

  const disposeOne = async (
    contribution: ActiveContribution,
  ): Promise<'disposed' | 'failed' | 'timed-out'> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const operation = Promise.resolve()
      .then(() => contribution.handle.dispose())
      .then(
        () => 'disposed' as const,
        () => 'failed' as const,
      );
    const timeout = new Promise<'timed-out'>((resolve) => {
      timer = setTimeout(() => resolve('timed-out'), disposerTimeoutMs);
    });
    const result = await Promise.race([operation, timeout]);
    if (timer) clearTimeout(timer);
    return result;
  };

  const disposeReverse = async (
    contributions: readonly ActiveContribution[],
    phase: 'rollback' | 'retire',
  ): Promise<PluginCompositionInspectionEntry[]> => {
    const failures: PluginCompositionInspectionEntry[] = [];
    for (const contribution of [...contributions].reverse()) {
      const outcome = await disposeOne(contribution);
      if (outcome === 'disposed') continue;
      failures.push(
        entry(
          contribution,
          'failed',
          outcome === 'timed-out'
            ? 'disposer-timeout'
            : phase === 'rollback'
              ? 'rollback-failed'
              : 'disposer-failed',
        ),
      );
    }
    return failures;
  };

  const plan = (
    profile: PluginCompositionProfile,
  ):
    | { kind: 'ready'; plan: PlannedComposition }
    | {
        kind: 'pending' | 'refused';
        entries: PluginCompositionInspectionEntry[];
      } => {
    if (
      !ID.test(profile.profileId) ||
      !validScope(profile.scope) ||
      !Array.isArray(profile.contributions) ||
      profile.contributions.length > MAX_CONTRIBUTIONS
    ) {
      return { kind: 'refused', entries: [] };
    }
    const normalized: NormalizedContribution[] = [];
    const invalid: PluginCompositionInspectionEntry[] = [];
    const instanceIds = new Set<string>();
    for (const contribution of profile.contributions) {
      const candidate = normalizeContribution(profile, contribution);
      if (!candidate || instanceIds.has(contribution.instanceId)) {
        invalid.push(
          invalidEntry(profile, contribution, 'invalid-contribution'),
        );
        continue;
      }
      instanceIds.add(contribution.instanceId);
      if (fixedAuthorities.has(candidate.declaration.capability)) {
        invalid.push(entry(candidate, 'failed', 'fixed-authority'));
        continue;
      }
      normalized.push(candidate);
    }
    if (invalid.length > 0) return { kind: 'refused', entries: invalid };

    const byCapability = new Map<string, NormalizedContribution[]>();
    for (const contribution of normalized) {
      const candidates =
        byCapability.get(contribution.declaration.capability) ?? [];
      candidates.push(contribution);
      byCapability.set(contribution.declaration.capability, candidates);
    }
    const providers = new Map<string, NormalizedContribution>();
    const shadowed: PluginCompositionInspectionEntry[] = [];
    const selectionFailures: PluginCompositionInspectionEntry[] = [];
    for (const [capability, candidates] of byCapability) {
      const selectedId = profile.selections?.[capability];
      const selected =
        candidates.length === 1 && selectedId === undefined
          ? candidates[0]
          : candidates.find(
              (candidate) => candidate.declaration.instanceId === selectedId,
            );
      if (!selected) {
        selectionFailures.push(
          ...candidates.map((candidate) =>
            entry(
              candidate,
              'failed',
              selectedId === undefined
                ? 'ambiguous-provider'
                : 'invalid-selection',
            ),
          ),
        );
        continue;
      }
      providers.set(capability, selected);
      for (const candidate of candidates) {
        if (candidate !== selected) {
          shadowed.push(entry(candidate, 'shadowed'));
        }
      }
    }
    for (const [capability] of Object.entries(profile.selections ?? {})) {
      if (!byCapability.has(capability)) {
        return {
          kind: 'refused',
          entries: normalized.map((candidate) =>
            entry(candidate, 'failed', 'invalid-selection'),
          ),
        };
      }
    }
    if (selectionFailures.length > 0) {
      return {
        kind: 'refused',
        entries: [...selectionFailures, ...shadowed],
      };
    }

    const dependencyFailures: PluginCompositionInspectionEntry[] = [];
    for (const contribution of providers.values()) {
      for (const requirement of contribution.declaration.requires) {
        if (requirement.scope && !sameScope(requirement.scope, profile.scope)) {
          dependencyFailures.push(
            entry(contribution, 'failed', 'cross-scope-dependency'),
          );
          break;
        }
        const provider = providers.get(requirement.capability);
        if (!provider) {
          dependencyFailures.push(
            entry(contribution, 'pending', 'missing-dependency'),
          );
          break;
        }
        if (
          provider.declaration.version !== requirement.version ||
          (requirement.instanceId !== undefined &&
            provider.declaration.instanceId !== requirement.instanceId)
        ) {
          dependencyFailures.push(
            entry(contribution, 'failed', 'incompatible-version'),
          );
          break;
        }
      }
    }
    if (dependencyFailures.length > 0) {
      return {
        kind: dependencyFailures.some(
          (candidate) => candidate.status === 'failed',
        )
          ? 'refused'
          : 'pending',
        entries: [...dependencyFailures, ...shadowed],
      };
    }
    const selected = [...providers.values()];
    const ordered = topologicalOrder(selected, providers);
    if (!ordered) {
      return {
        kind: 'refused',
        entries: [
          ...selected.map((candidate) =>
            entry(candidate, 'failed', 'dependency-cycle'),
          ),
          ...shadowed,
        ],
      };
    }
    return { kind: 'ready', plan: { selected: ordered, shadowed } };
  };

  const applyNow = async (
    profile: PluginCompositionProfile,
  ): Promise<PluginCompositionApplyResult> => {
    const key = scopeKey(profile.scope);
    const previous = active.get(key);
    const planned = plan(profile);
    if (planned.kind !== 'ready') {
      recordAttempt(profile.scope, planned.entries);
      return { kind: planned.kind, inspection: inspect(profile.scope) };
    }
    const pending = planned.plan.selected.map((candidate) =>
      entry(candidate, 'pending', 'staging'),
    );
    recordAttempt(profile.scope, [...pending, ...planned.plan.shadowed]);

    const staged: ActiveContribution[] = [];
    for (let index = 0; index < planned.plan.selected.length; index += 1) {
      const contribution = planned.plan.selected[index];
      let authorization: PluginCompositionAuthorization;
      try {
        authorization = await options.authorizer.authorize({
          profileId: profile.profileId,
          scope: structuredClone(profile.scope),
          contribution: structuredClone(contribution.declaration),
          instanceIdentity: contribution.instanceIdentity,
        });
      } catch {
        authorization = { kind: 'unavailable' };
      }
      const reason =
        authorization.kind === 'denied'
          ? 'authorization-denied'
          : authorization.kind === 'unavailable'
            ? 'authorization-unavailable'
            : undefined;
      const factory = factories.get(contribution.declaration.implementationId);
      if (reason || !factory) {
        const rollback = await disposeReverse(staged, 'rollback');
        const blocked = planned.plan.selected
          .slice(index + 1)
          .map((candidate) =>
            entry(candidate, 'pending', 'activation-aborted'),
          );
        recordAttempt(profile.scope, [
          entry(
            contribution,
            reason === 'authorization-unavailable' ? 'pending' : 'failed',
            reason ?? 'implementation-unavailable',
          ),
          ...blocked,
          ...rollback,
          ...planned.plan.shadowed,
        ]);
        return {
          kind: reason === 'authorization-unavailable' ? 'pending' : 'failed',
          inspection: inspect(profile.scope),
        };
      }
      try {
        const dependencies = contribution.declaration.requires.map(
          (requirement) => ({
            capability: requirement.capability,
            instanceIdentity: planned.plan.selected.find(
              (candidate) =>
                candidate.declaration.capability === requirement.capability,
            )!.instanceIdentity,
          }),
        );
        const handle = await factory.stage({
          profileId: profile.profileId,
          scope: structuredClone(profile.scope),
          contribution: structuredClone(contribution.declaration),
          instanceIdentity: contribution.instanceIdentity,
          configuration: structuredClone(contribution.configuration),
          dependencies,
        });
        if (!handle || typeof handle.dispose !== 'function') {
          throw new Error('invalid staged contribution');
        }
        staged.push({ ...contribution, handle });
      } catch {
        const rollback = await disposeReverse(staged, 'rollback');
        const blocked = planned.plan.selected
          .slice(index + 1)
          .map((candidate) =>
            entry(candidate, 'pending', 'activation-aborted'),
          );
        recordAttempt(profile.scope, [
          entry(contribution, 'failed', 'activation-failed'),
          ...blocked,
          ...rollback,
          ...planned.plan.shadowed,
        ]);
        return { kind: 'failed', inspection: inspect(profile.scope) };
      }
    }

    const generation = (previous?.generation ?? 0) + 1;
    active.set(key, {
      generation,
      profileId: profile.profileId,
      scope: structuredClone(profile.scope),
      contributions: staged,
    });
    const retirementFailures = previous
      ? await disposeReverse(previous.contributions, 'retire')
      : [];
    recordAttempt(profile.scope, [
      ...planned.plan.shadowed.map((candidate) => ({
        ...candidate,
        generation,
      })),
      ...retirementFailures,
    ]);
    return {
      kind: 'activated',
      generation,
      liveFences: retirementFailures,
      inspection: inspect(profile.scope),
    };
  };

  return Object.freeze({
    apply(profile: PluginCompositionProfile) {
      let snapshot: PluginCompositionProfile;
      try {
        snapshot = structuredClone(profile);
      } catch {
        return Promise.resolve({
          kind: 'refused' as const,
          inspection: {
            scope: profile.scope,
            generation: 0,
            active: [],
            pending: [],
            failed: [],
            shadowed: [],
          },
        });
      }
      const key = scopeKey(snapshot.scope);
      const prior = applyChains.get(key) ?? Promise.resolve();
      const operation = prior.then(() => applyNow(snapshot));
      applyChains.set(
        key,
        operation.then(
          () => undefined,
          () => undefined,
        ),
      );
      return operation;
    },
    inspect,
  });
}

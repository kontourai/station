import { createHash } from 'node:crypto';
import { isCanonicalPluginId } from '@kontourai/station-contracts/plugin';

const ID = /^[a-z0-9](?:[a-z0-9._-]{0,94}[a-z0-9])?$/;
const SCOPE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const MAX_CONTRIBUTIONS = 64;
const MAX_DISPOSAL_FENCES_PER_SCOPE = MAX_CONTRIBUTIONS;
const MAX_REQUIREMENTS = 16;
const MAX_CONFIGURATION_BYTES = 64 * 1024;
const MAX_CONFIGURATION_DEPTH = 24;
const MAX_CONFIGURATION_NODES = 8_192;
const DEFAULT_DISPOSER_TIMEOUT_MS = 1_000;
const MAX_DISPOSER_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETAINED_SCOPES = 256;
const MAX_RETAINED_SCOPES = 1_024;

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

const INVALID_SCOPE: PluginCompositionScope = {
  kind: 'project',
  projectId: 'invalid',
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
  | 'scope-capacity'
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
  | 'authorization-release-pending'
  | 'authorization-release-failed'
  | 'implementation-unavailable'
  | 'activation-failed'
  | 'activation-aborted'
  | 'staged-resource-conflict'
  | 'staged-resource-ambiguous'
  | 'rollback-failed'
  | 'disposer-failed'
  | 'disposer-timeout';

export interface PluginCompositionInspectionEntry {
  readonly instanceIdentity: string;
  readonly occurrenceIdentity?: string;
  readonly instanceId: string;
  readonly pluginId: string;
  readonly contributionId: string;
  readonly implementationId: string;
  readonly installationGeneration?: string;
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
  /** Scope-owned cleanup with no selected contribution to attribute it to. */
  readonly scopeLifecycle?: readonly PluginCompositionScopeLifecycleEntry[];
}

export interface PluginCompositionScopeLifecycleEntry {
  readonly generation: number;
  readonly status: 'pending' | 'failed';
  readonly reason: PluginCompositionInspectionReason;
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

export interface PluginCompositionOccurrenceLease {
  readonly occurrenceIdentity: string;
  readonly instanceIdentity: string;
  readonly generation: number;
  /** False synchronously before rollback or retirement disposal begins. */
  isCurrent(): boolean;
}

export interface PluginCompositionInstalledContributionBinding {
  readonly instanceIdentity: string;
  readonly pluginId: string;
  readonly contributionId: string;
  readonly implementationId: string;
  readonly installationGeneration: string;
  readonly factory: PluginCompositionFactory;
}

export interface PluginCompositionAuthorizationLease {
  readonly bindings: readonly PluginCompositionInstalledContributionBinding[];
  /** Reads the exact whole-plan authorization/install snapshot held by this lease. */
  isCurrent(): boolean;
  /** Releases the whole-plan snapshot after publication or rollback. */
  release(): void | Promise<void>;
}

export type PluginCompositionAuthorization =
  | {
      readonly kind: 'granted';
      readonly lease: PluginCompositionAuthorizationLease;
    }
  | { readonly kind: 'denied' }
  | { readonly kind: 'unavailable' };

export interface PluginCompositionAuthorizer {
  authorize(input: {
    readonly profileId: string;
    readonly scope: PluginCompositionScope;
    readonly contributions: readonly {
      readonly contribution: PluginCompositionContribution;
      readonly instanceIdentity: string;
      readonly configurationDigest: string;
    }[];
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
    readonly occurrence: PluginCompositionOccurrenceLease;
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
  binding: PluginCompositionInstalledContributionBinding;
  occurrence: PluginCompositionOccurrence;
}

interface PluginCompositionOccurrence {
  readonly lease: PluginCompositionOccurrenceLease;
  fence(): void;
  dispose(): void | Promise<void>;
  releaseClaim(): void;
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
    ? JSON.stringify(['project', scope.projectId])
    : JSON.stringify(['agent', scope.projectId ?? null, scope.agentId]);
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

interface ConfigurationBudget {
  nodes: number;
  bytes: number;
  exceededBytes: boolean;
  /** Bounded topology validation after byte refusal; no sorting/copying/scalar scan. */
  validateOnly?: boolean;
}

function consumeConfigurationBytes(
  budget: ConfigurationBudget,
  bytes: number,
): boolean {
  if (budget.validateOnly) return true;
  if (bytes > MAX_CONFIGURATION_BYTES - budget.bytes) {
    budget.exceededBytes = true;
    return false;
  }
  budget.bytes += bytes;
  return true;
}

/** Exact well-formed JSON string bytes, without allocating its escaped form. */
function consumeConfigurationString(
  value: string,
  budget: ConfigurationBudget,
): boolean {
  if (budget.validateOnly) return true;
  // UTF-16 length is a lower bound on escaped UTF-8 bytes. Reject huge inputs
  // in constant work before scanning, sorting keys, or serializing anything.
  if (value.length > MAX_CONFIGURATION_BYTES - budget.bytes - 2) {
    budget.exceededBytes = true;
    return false;
  }
  if (!consumeConfigurationBytes(budget, 2)) return false;
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    let bytes: number;
    if (
      unit === 34 ||
      unit === 92 ||
      unit === 8 ||
      unit === 9 ||
      unit === 10 ||
      unit === 12 ||
      unit === 13
    )
      bytes = 2;
    else if (unit < 32) bytes = 6;
    else if (unit < 128) bytes = 1;
    else if (unit < 2048) bytes = 2;
    else if (unit >= 0xd800 && unit <= 0xdfff) {
      const next = value.charCodeAt(index + 1);
      if (unit <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
        bytes = 4;
        index++;
      } else bytes = 6; // JSON.stringify escapes lone surrogates.
    } else bytes = 3;
    if (!consumeConfigurationBytes(budget, bytes)) return false;
  }
  return true;
}

function canonicalConfiguration(
  value: unknown,
  depth = 0,
  budget: ConfigurationBudget = { nodes: 0, bytes: 0, exceededBytes: false },
): PluginCompositionJson | undefined {
  if (
    depth > MAX_CONFIGURATION_DEPTH ||
    ++budget.nodes > MAX_CONFIGURATION_NODES
  ) {
    return undefined;
  }
  if (value === null)
    return consumeConfigurationBytes(budget, 4) ? value : undefined;
  if (typeof value === 'boolean')
    return consumeConfigurationBytes(budget, value ? 4 : 5) ? value : undefined;
  if (typeof value === 'string')
    return consumeConfigurationString(value, budget) ? value : undefined;
  if (typeof value === 'number') {
    return Number.isFinite(value) &&
      consumeConfigurationBytes(budget, String(value).length)
      ? value
      : undefined;
  }
  if (Array.isArray(value)) {
    try {
      const length = value.length;
      if (
        !Number.isSafeInteger(length) ||
        length < 0 ||
        length > MAX_CONFIGURATION_NODES - budget.nodes
      )
        return undefined;
      const ownKeys = Reflect.ownKeys(value);
      if (
        ownKeys.length > MAX_CONFIGURATION_NODES - budget.nodes + 1 ||
        ownKeys.some((key) => typeof key !== 'string')
      ) {
        return undefined;
      }
      const keys = ownKeys.filter((key) => key !== 'length');
      if (
        keys.length !== length ||
        keys.some(
          (key, index) =>
            typeof key !== 'string' ||
            key.length !== String(index).length ||
            key !== String(index),
        ) ||
        !consumeConfigurationBytes(budget, 2 + Math.max(0, length - 1))
      ) {
        return undefined;
      }
      const output: PluginCompositionJson[] = [];
      for (const key of keys as string[]) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (
          !descriptor ||
          !('value' in descriptor) ||
          descriptor.enumerable !== true
        ) {
          return undefined;
        }
        const normalized = canonicalConfiguration(
          descriptor.value,
          depth + 1,
          budget,
        );
        if (normalized === undefined) return undefined;
        if (!budget.validateOnly) output.push(normalized);
      }
      return output;
    } catch {
      return undefined;
    }
  }
  if (typeof value !== 'object' || value === null) return undefined;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    const names = Reflect.ownKeys(value);
    if (names.length > MAX_CONFIGURATION_NODES - budget.nodes) return undefined;
    if (names.some((key) => typeof key !== 'string')) return undefined;
    const keys = names as string[];
    if (!consumeConfigurationBytes(budget, 2 + Math.max(0, keys.length - 1)))
      return undefined;
    // Account for every key before sorting. A tiny object can still carry an
    // enormous key, and a bounded number of long keys can exceed the total.
    for (const key of keys) {
      if (
        !consumeConfigurationString(key, budget) ||
        !consumeConfigurationBytes(budget, 1)
      )
        return undefined;
    }
    const output: Record<string, PluginCompositionJson> | undefined =
      budget.validateOnly ? undefined : Object.create(null);
    for (const key of budget.validateOnly ? keys : keys.sort()) {
      if (key === '__proto__' || key === 'prototype' || key === 'constructor') {
        return undefined;
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        !descriptor ||
        !('value' in descriptor) ||
        descriptor.enumerable !== true
      )
        return undefined;
      const normalized = canonicalConfiguration(
        descriptor.value,
        depth + 1,
        budget,
      );
      if (normalized === undefined) return undefined;
      if (output) output[key] = normalized;
    }
    return output ?? null;
  } catch {
    return undefined;
  }
}

function dataRecord(
  value: unknown,
  allowedKeys?: ReadonlySet<string>,
): Record<string, unknown> | undefined {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return;
    if (Object.getOwnPropertySymbols(value).length > 0) return;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const output: Record<string, unknown> = Object.create(null);
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (
        (allowedKeys && !allowedKeys.has(key)) ||
        !('value' in descriptor) ||
        descriptor.enumerable !== true
      ) {
        return;
      }
      output[key] = descriptor.value;
    }
    return output;
  } catch {
    return;
  }
}

function dataArray<T>(
  value: unknown,
  limit: number,
  snapshot: (entry: unknown) => T | undefined,
): T[] | undefined {
  try {
    if (!Array.isArray(value) || value.length > limit) return;
    if (Object.getOwnPropertySymbols(value).length > 0) return;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Object.keys(descriptors).filter((key) => key !== 'length');
    if (
      keys.length !== value.length ||
      keys.some((key, index) => key !== String(index))
    ) {
      return;
    }
    const output: T[] = [];
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (
        !descriptor ||
        !('value' in descriptor) ||
        descriptor.enumerable !== true
      ) {
        return;
      }
      const entry = snapshot(descriptor.value);
      if (entry === undefined) return;
      output.push(entry);
    }
    return output;
  } catch {
    return;
  }
}

const PROJECT_SCOPE_KEYS = new Set(['kind', 'projectId']);
const AGENT_SCOPE_KEYS = new Set(['kind', 'agentId', 'projectId']);
const REQUIREMENT_KEYS = new Set([
  'capability',
  'version',
  'instanceId',
  'scope',
]);
const CONTRIBUTION_KEYS = new Set([
  'instanceId',
  'pluginId',
  'contributionId',
  'implementationId',
  'capability',
  'version',
  'configuration',
  'isolation',
  'requires',
]);
const PROFILE_KEYS = new Set([
  'profileId',
  'scope',
  'contributions',
  'selections',
]);
// Invalid config must not be retained/copied, but its safe declaration still
// belongs in whole-plan refusal diagnostics alongside independent selections.
const invalidConfigurationSnapshots =
  new WeakSet<PluginCompositionContribution>();

function snapshotScope(value: unknown): PluginCompositionScope | undefined {
  const initial = dataRecord(value);
  if (!initial) return;
  const allowed =
    initial.kind === 'project'
      ? PROJECT_SCOPE_KEYS
      : initial.kind === 'agent'
        ? AGENT_SCOPE_KEYS
        : undefined;
  if (!allowed) return;
  const record = dataRecord(value, allowed);
  if (!record) return;
  if (
    (record.kind === 'project' && typeof record.projectId !== 'string') ||
    (record.kind === 'agent' &&
      (typeof record.agentId !== 'string' ||
        (record.projectId !== undefined &&
          typeof record.projectId !== 'string')))
  ) {
    return;
  }
  const scope =
    record.kind === 'project'
      ? { kind: 'project' as const, projectId: record.projectId as string }
      : {
          kind: 'agent' as const,
          agentId: record.agentId as string,
          ...(record.projectId === undefined
            ? {}
            : { projectId: record.projectId as string }),
        };
  return validScope(scope) ? scope : undefined;
}

function snapshotRequirement(
  value: unknown,
): PluginCompositionRequirement | undefined {
  const record = dataRecord(value, REQUIREMENT_KEYS);
  if (!record) return;
  if (
    typeof record.capability !== 'string' ||
    typeof record.version !== 'string' ||
    (record.instanceId !== undefined && typeof record.instanceId !== 'string')
  ) {
    return;
  }
  const scope =
    record.scope === undefined ? undefined : snapshotScope(record.scope);
  if (record.scope !== undefined && !scope) return;
  return {
    capability: record.capability as string,
    version: record.version as string,
    ...(record.instanceId === undefined
      ? {}
      : { instanceId: record.instanceId as string }),
    ...(scope ? { scope } : {}),
  };
}

function snapshotContribution(
  value: unknown,
): PluginCompositionContribution | undefined {
  const record = dataRecord(value, CONTRIBUTION_KEYS);
  if (!record) return;
  if (
    typeof record.instanceId !== 'string' ||
    typeof record.pluginId !== 'string' ||
    typeof record.contributionId !== 'string' ||
    typeof record.implementationId !== 'string' ||
    typeof record.capability !== 'string' ||
    typeof record.version !== 'string' ||
    record.isolation !== 'profile'
  ) {
    return;
  }
  const configurationBudget = { nodes: 0, bytes: 0, exceededBytes: false };
  const configuration = canonicalConfiguration(
    record.configuration,
    0,
    configurationBudget,
  );
  const requires = dataArray(
    record.requires,
    MAX_REQUIREMENTS,
    snapshotRequirement,
  );
  if (
    !requires ||
    (configuration === undefined && !configurationBudget.exceededBytes)
  )
    return;
  if (
    configuration === undefined &&
    canonicalConfiguration(record.configuration, 0, {
      nodes: 0,
      bytes: 0,
      exceededBytes: false,
      validateOnly: true,
    }) === undefined
  )
    return;
  const snapshot: PluginCompositionContribution = {
    instanceId: record.instanceId as string,
    pluginId: record.pluginId as string,
    contributionId: record.contributionId as string,
    implementationId: record.implementationId as string,
    capability: record.capability as string,
    version: record.version as string,
    configuration: configuration ?? null,
    isolation: record.isolation as 'profile',
    requires,
  };
  if (configuration === undefined) invalidConfigurationSnapshots.add(snapshot);
  return snapshot;
}

function snapshotProfile(value: unknown): PluginCompositionProfile | undefined {
  const record = dataRecord(value, PROFILE_KEYS);
  if (!record || typeof record.profileId !== 'string') return;
  const scope = snapshotScope(record.scope);
  const contributions = dataArray(
    record.contributions,
    MAX_CONTRIBUTIONS,
    snapshotContribution,
  );
  if (!scope || !contributions) return;
  let selections: Record<string, string> | undefined;
  if (record.selections !== undefined) {
    const selected = dataRecord(record.selections);
    if (
      !selected ||
      Object.entries(selected).some(
        ([capability, instanceId]) =>
          !ID.test(capability) ||
          typeof instanceId !== 'string' ||
          !ID.test(instanceId),
      )
    ) {
      return;
    }
    selections = Object.fromEntries(
      Object.entries(selected).map(([key, selectedId]) => [
        key,
        selectedId as string,
      ]),
    );
  }
  return {
    profileId: record.profileId,
    scope,
    contributions,
    ...(selections ? { selections } : {}),
  };
}

function normalizeContribution(
  profile: PluginCompositionProfile,
  contribution: PluginCompositionContribution,
): NormalizedContribution | undefined {
  if (invalidConfigurationSnapshots.has(contribution)) return undefined;
  if (
    typeof contribution.instanceId !== 'string' ||
    typeof contribution.pluginId !== 'string' ||
    typeof contribution.contributionId !== 'string' ||
    typeof contribution.implementationId !== 'string' ||
    typeof contribution.capability !== 'string' ||
    typeof contribution.version !== 'string' ||
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
        typeof requirement.capability !== 'string' ||
        typeof requirement.version !== 'string' ||
        (requirement.instanceId !== undefined &&
          typeof requirement.instanceId !== 'string') ||
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
  context?: {
    readonly binding?: PluginCompositionInstalledContributionBinding;
    readonly occurrence?: PluginCompositionOccurrenceLease;
  },
): PluginCompositionInspectionEntry {
  return {
    instanceIdentity: contribution.instanceIdentity,
    ...(context?.occurrence
      ? { occurrenceIdentity: context.occurrence.occurrenceIdentity }
      : {}),
    instanceId: contribution.declaration.instanceId,
    pluginId: contribution.declaration.pluginId,
    contributionId: contribution.declaration.contributionId,
    implementationId: contribution.declaration.implementationId,
    ...(context?.binding
      ? {
          installationGeneration: context.binding.installationGeneration,
        }
      : {}),
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
    implementationId: String(contribution.implementationId),
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
    entry(contribution, 'active', undefined, generation?.generation, {
      binding: contribution.binding,
      occurrence: contribution.occurrence.lease,
    }),
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
  /** Pending retains lifecycle/disposal obligations; retired has no cleanup debt. */
  retire(scope: PluginCompositionScope): Promise<{
    readonly kind: 'retired' | 'refused' | 'pending';
    readonly liveFences: readonly PluginCompositionInspectionEntry[];
    readonly inspection: PluginCompositionInspection;
  }>;
}

interface PluginCompositionDisposalFence {
  entry: PluginCompositionInspectionEntry;
}

type ValidatedPlanAuthorization =
  | { readonly kind: 'denied' | 'unavailable' }
  | {
      readonly kind: 'granted';
      readonly lease: PluginCompositionAuthorizationLease;
      readonly bindings: ReadonlyMap<
        string,
        PluginCompositionInstalledContributionBinding
      >;
    };

const AUTHORIZATION_RESULT_KEYS = new Set(['kind']);
const GRANTED_AUTHORIZATION_RESULT_KEYS = new Set(['kind', 'lease']);
const AUTHORIZATION_LEASE_KEYS = new Set(['bindings', 'isCurrent', 'release']);
const AUTHORIZATION_BINDING_KEYS = new Set([
  'instanceIdentity',
  'pluginId',
  'contributionId',
  'implementationId',
  'installationGeneration',
  'factory',
]);
const FACTORY_KEYS = new Set(['stage']);
const STAGED_HANDLE_KEYS = new Set(['dispose']);

function snapshotFactory(value: unknown): PluginCompositionFactory | undefined {
  const record = dataRecord(value, FACTORY_KEYS);
  if (!record || typeof record.stage !== 'function') return;
  return Object.freeze({
    stage: (input: Parameters<PluginCompositionFactory['stage']>[0]) =>
      Reflect.apply(record.stage as PluginCompositionFactory['stage'], value, [
        input,
      ]),
  });
}

function snapshotAuthorizationBinding(
  value: unknown,
): PluginCompositionInstalledContributionBinding | undefined {
  const record = dataRecord(value, AUTHORIZATION_BINDING_KEYS);
  if (!record) return;
  const factory = snapshotFactory(record.factory);
  if (
    typeof record.instanceIdentity !== 'string' ||
    !record.instanceIdentity.startsWith('plugin-instance:') ||
    typeof record.pluginId !== 'string' ||
    !isCanonicalPluginId(record.pluginId) ||
    typeof record.contributionId !== 'string' ||
    !ID.test(record.contributionId) ||
    typeof record.implementationId !== 'string' ||
    !ID.test(record.implementationId) ||
    typeof record.installationGeneration !== 'string' ||
    record.installationGeneration.length < 1 ||
    record.installationGeneration.length > 512 ||
    !factory
  ) {
    return;
  }
  return Object.freeze({
    instanceIdentity: record.instanceIdentity,
    pluginId: record.pluginId,
    contributionId: record.contributionId,
    implementationId: record.implementationId,
    installationGeneration: record.installationGeneration,
    factory,
  });
}

function validatePlanAuthorization(
  value: unknown,
  selected: readonly NormalizedContribution[],
): ValidatedPlanAuthorization | undefined {
  const initial = dataRecord(value);
  if (!initial) return;
  if (initial.kind === 'denied' || initial.kind === 'unavailable') {
    const terminal = dataRecord(value, AUTHORIZATION_RESULT_KEYS);
    return terminal ? { kind: initial.kind } : undefined;
  }
  if (initial.kind !== 'granted') return;
  const granted = dataRecord(value, GRANTED_AUTHORIZATION_RESULT_KEYS);
  if (!granted) return;
  const rawLease = granted.lease;
  const lease = dataRecord(rawLease, AUTHORIZATION_LEASE_KEYS);
  if (
    !lease ||
    typeof lease.isCurrent !== 'function' ||
    typeof lease.release !== 'function'
  ) {
    return;
  }
  const bindings = dataArray(
    lease.bindings,
    MAX_CONTRIBUTIONS,
    snapshotAuthorizationBinding,
  );
  if (!bindings) return;
  const byIdentity = new Map<
    string,
    PluginCompositionInstalledContributionBinding
  >();
  for (const binding of bindings) {
    if (byIdentity.has(binding.instanceIdentity)) return;
    const expected = selected.find(
      (candidate) => candidate.instanceIdentity === binding.instanceIdentity,
    );
    if (
      !expected ||
      binding.pluginId !== expected.declaration.pluginId ||
      binding.contributionId !== expected.declaration.contributionId ||
      binding.implementationId !== expected.declaration.implementationId
    ) {
      return;
    }
    byIdentity.set(binding.instanceIdentity, binding);
  }
  return {
    kind: 'granted',
    lease: Object.freeze({
      bindings,
      isCurrent: () =>
        Reflect.apply(lease.isCurrent as () => boolean, rawLease, []),
      release: () =>
        Reflect.apply(
          lease.release as () => void | Promise<void>,
          rawLease,
          [],
        ),
    }),
    bindings: byIdentity,
  };
}

async function outcomeWithin<T>(
  operation: Promise<T>,
  timeoutMs: number,
): Promise<
  { kind: 'settled'; value: T } | { kind: 'rejected' } | { kind: 'timed-out' }
> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const settled = operation.then(
    (value) => ({ kind: 'settled' as const, value }),
    () => ({ kind: 'rejected' as const }),
  );
  const timeout = new Promise<{ kind: 'timed-out' }>((resolve) => {
    timer = setTimeout(() => resolve({ kind: 'timed-out' }), timeoutMs);
  });
  const outcome = await Promise.race([settled, timeout]);
  if (timer) clearTimeout(timer);
  return outcome;
}

function recognizableAuthorizationRelease(
  value: unknown,
): (() => void | Promise<void>) | undefined {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return;
    const kind = Object.getOwnPropertyDescriptor(value, 'kind');
    const lease = Object.getOwnPropertyDescriptor(value, 'lease');
    if (
      !kind ||
      !('value' in kind) ||
      kind.enumerable !== true ||
      kind.value !== 'granted' ||
      !lease ||
      !('value' in lease) ||
      lease.enumerable !== true
    )
      return;
    const rawLease = lease.value;
    if (!rawLease || typeof rawLease !== 'object' || Array.isArray(rawLease))
      return;
    const leasePrototype = Object.getPrototypeOf(rawLease);
    if (leasePrototype !== Object.prototype && leasePrototype !== null) return;
    const release = Object.getOwnPropertyDescriptor(rawLease, 'release');
    if (
      !release ||
      !('value' in release) ||
      release.enumerable !== true ||
      typeof release.value !== 'function'
    )
      return;
    return () => Reflect.apply(release.value, rawLease, []);
  } catch {
    return;
  }
}

function snapshotStagedHandle(value: unknown):
  | {
      readonly handle: StagedPluginCompositionContribution;
      readonly identity: object;
      readonly disposer: object;
      readonly exact: boolean;
    }
  | undefined {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return;
    const symbols = Object.getOwnPropertySymbols(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const dispose = descriptors.dispose;
    if (
      !dispose ||
      !('value' in dispose) ||
      dispose.enumerable !== true ||
      typeof dispose.value !== 'function'
    )
      return;
    const names = Object.keys(descriptors);
    return {
      handle: Object.freeze({
        dispose: () =>
          Reflect.apply(
            dispose.value as StagedPluginCompositionContribution['dispose'],
            value,
            [],
          ),
      }),
      identity: value,
      disposer: dispose.value as object,
      exact:
        symbols.length === 0 &&
        names.length === STAGED_HANDLE_KEYS.size &&
        names.every((key) => STAGED_HANDLE_KEYS.has(key)),
    };
  } catch {
    return;
  }
}

function captureAuthorizer(options: {
  readonly authorizer: PluginCompositionAuthorizer;
}): PluginCompositionAuthorizer['authorize'] {
  try {
    const slot = Object.getOwnPropertyDescriptor(options, 'authorizer');
    const receiver = slot && 'value' in slot ? slot.value : undefined;
    if (
      receiver &&
      (typeof receiver === 'object' || typeof receiver === 'function')
    ) {
      // Prototype methods retain their original receiver (including private
      // state). Never execute an accessor or enumerate unrelated host fields.
      let owner = receiver;
      for (let depth = 0; owner && depth < 24; depth++) {
        const method = Object.getOwnPropertyDescriptor(owner, 'authorize');
        if (method) {
          if ('value' in method && typeof method.value === 'function') {
            const callable = method.value;
            return (input) => Reflect.apply(callable, receiver, [input]);
          }
          break;
        }
        owner = Object.getPrototypeOf(owner);
      }
    }
  } catch {
    /* Invalid host capability; no authority is admitted. */
  }
  throw new Error('Invalid plugin composition authorizer');
}

export function createPluginCompositionModule(options: {
  readonly authorizer: PluginCompositionAuthorizer;
  readonly disposerTimeoutMs?: number;
  readonly maxRetainedScopes?: number;
}): PluginCompositionModule {
  const disposerTimeoutMs =
    options.disposerTimeoutMs ?? DEFAULT_DISPOSER_TIMEOUT_MS;
  const maxRetainedScopes =
    options.maxRetainedScopes ?? DEFAULT_MAX_RETAINED_SCOPES;
  if (
    !Number.isSafeInteger(disposerTimeoutMs) ||
    disposerTimeoutMs < 1 ||
    disposerTimeoutMs > MAX_DISPOSER_TIMEOUT_MS ||
    !Number.isSafeInteger(maxRetainedScopes) ||
    maxRetainedScopes < 1 ||
    maxRetainedScopes > MAX_RETAINED_SCOPES
  ) {
    throw new Error('Invalid plugin composition limits');
  }
  const authorize = captureAuthorizer(options);
  const active = new Map<string, ActiveGeneration>();
  const attempts = new Map<string, PluginCompositionInspectionEntry[]>();
  const applyChains = new Map<string, Promise<void>>();
  // A deadline releases the queue, not ownership of still-running host work.
  // Hold one scope admission fence until late authorization/staging settles.
  const pendingLifecycle = new Map<
    string,
    {
      entries: PluginCompositionInspectionEntry[];
      scopeLifecycle?: PluginCompositionScopeLifecycleEntry;
    }
  >();
  const retainPendingLifecycle = (
    key: string,
    entries: PluginCompositionInspectionEntry[],
    generation: number,
    reason: PluginCompositionInspectionReason,
  ) =>
    pendingLifecycle.set(key, {
      entries,
      ...(entries.length === 0
        ? { scopeLifecycle: { generation, status: 'pending' as const, reason } }
        : {}),
    });
  // Actual lease-release operations outlive bounded responses. Tokens prevent
  // one continuation from clearing another cleanup obligation for this scope.
  const releaseDebts = new Map<
    string,
    Map<
      symbol,
      {
        entries: PluginCompositionInspectionEntry[];
        release: () => void | Promise<void>;
        operation?: Promise<void>;
        scopeLifecycle?: PluginCompositionScopeLifecycleEntry;
      }
    >
  >();
  const releaseEntries = (key: string) =>
    structuredClone(
      [...(releaseDebts.get(key)?.values() ?? [])].flatMap(
        (debt) => debt.entries,
      ),
    );
  // Disputed or unrecognizable object/function returns cannot be safely
  // cleaned by this module. Retain the actual raw value/capability, not
  // merely a diagnostic, until a separate recovery authority can prove cleanup.
  // At most one unclaimable return is reached per plan; it closes admission.
  const unclaimedResources = new Map<
    string,
    {
      resource: object;
      staged?: NonNullable<ReturnType<typeof snapshotStagedHandle>>;
      entry: PluginCompositionInspectionEntry;
    }
  >();
  const unclaimedEntries = (key: string) => {
    const resource = unclaimedResources.get(key);
    return resource ? [structuredClone(resource.entry)] : [];
  };
  const hasLifecycleDebt = (key: string) =>
    pendingLifecycle.has(key) ||
    releaseDebts.has(key) ||
    unclaimedResources.has(key);
  const disposalFences = new Map<
    string,
    Map<string, PluginCompositionDisposalFence>
  >();
  let activationSequence = 0;
  const claimedHandles = new WeakMap<object, string>();
  const claimedDisposers = new WeakMap<object, string>();
  // A's active claim may retire while B still owns a disputed resource using
  // the same function. This reservation belongs to B's unresolved custody,
  // not to A, and prevents fresh handles from adopting that cleanup authority.
  const disputedDisposers = new WeakSet<object>();

  const fenceKey = (generation: number, instanceIdentity: string) =>
    `${generation}:${instanceIdentity}`;
  const fenceEntries = (key: string) =>
    [...(disposalFences.get(key)?.values() ?? [])].map((fence) =>
      structuredClone(fence.entry),
    );
  const retainedScopeKeys = () =>
    new Set([
      ...active.keys(),
      ...attempts.keys(),
      ...applyChains.keys(),
      ...disposalFences.keys(),
      ...pendingLifecycle.keys(),
      ...releaseDebts.keys(),
      ...unclaimedResources.keys(),
    ]);
  const ownAuthorizationRelease = (
    key: string,
    selected: readonly NormalizedContribution[],
    release: () => void | Promise<void>,
    generation: number,
  ) => {
    const token = Symbol('authorization-release');
    let operation: Promise<void> | undefined;
    let bounded: Promise<void> | undefined;
    const debt: {
      entries: PluginCompositionInspectionEntry[];
      release: () => void | Promise<void>;
      operation?: Promise<void>;
      scopeLifecycle?: PluginCompositionScopeLifecycleEntry;
    } = { entries: [], release };
    // Acquisition owns the lease even if rollback disposal fails before
    // release can start. Keep the actual capability strongly reachable now;
    // staging/rollback markers describe the visible phase until start().
    const acquired = releaseDebts.get(key) ?? new Map();
    acquired.set(token, debt);
    releaseDebts.set(key, acquired);
    const project = (failed: boolean) => {
      const debts = releaseDebts.get(key) ?? new Map();
      debt.entries = selected.map((candidate) =>
        entry(
          candidate,
          failed ? 'failed' : 'pending',
          failed
            ? 'authorization-release-failed'
            : 'authorization-release-pending',
          generation,
        ),
      );
      if (selected.length === 0) {
        debt.scopeLifecycle = {
          generation,
          status: failed ? 'failed' : 'pending',
          reason: failed
            ? 'authorization-release-failed'
            : 'authorization-release-pending',
        };
      }
      debts.set(token, debt);
      releaseDebts.set(key, debts);
    };
    const start = () => {
      if (!operation) {
        project(false);
        operation = Promise.resolve()
          .then(debt.release)
          .then(
            () => {
              const debts = releaseDebts.get(key);
              debts?.delete(token);
              if (debts?.size === 0) releaseDebts.delete(key);
            },
            (error) => {
              project(true);
              throw error;
            },
          );
        debt.operation = operation;
        // Late failures are consumed even after the bounded caller returned.
        void operation.catch(() => {});
      }
      return operation;
    };
    return {
      start,
      within: () => {
        bounded ??= outcomeWithin(start(), disposerTimeoutMs).then(() => {});
        return bounded;
      },
    };
  };
  const enqueueScope = <T>(key: string, work: () => Promise<T>): Promise<T> => {
    const prior = applyChains.get(key) ?? Promise.resolve();
    const operation = prior.then(work);
    const settled = operation.then(
      () => undefined,
      () => undefined,
    );
    applyChains.set(key, settled);
    // Complete this operation's admission bookkeeping before its caller can
    // act on a retirement receipt and immediately reuse the freed capacity.
    // A queued successor owns the map entry and must not be removed here.
    return operation.finally(() => {
      if (applyChains.get(key) === settled) applyChains.delete(key);
    });
  };

  const nextActivationSequence = () => {
    activationSequence += 1;
    return activationSequence;
  };

  const createOccurrenceLease = (
    contribution: NormalizedContribution,
    key: string,
    generation: number,
    sequence: number,
  ) => {
    let current = true;
    const occurrenceIdentity = `plugin-occurrence:${createHash('sha256')
      .update(
        JSON.stringify([
          key,
          generation,
          sequence,
          contribution.instanceIdentity,
          contribution.configurationDigest,
        ]),
      )
      .digest('hex')}`;
    return {
      lease: Object.freeze({
        occurrenceIdentity,
        instanceIdentity: contribution.instanceIdentity,
        generation,
        isCurrent: () => current,
      }),
      fence: () => {
        current = false;
      },
    };
  };

  const claimOccurrence = (
    leaseControl: ReturnType<typeof createOccurrenceLease>,
    rawHandle: unknown,
  ):
    | {
        kind: 'claimed';
        occurrence: PluginCompositionOccurrence;
        exact: boolean;
      }
    | { kind: 'borrowed' | 'no-resource' }
    | { kind: 'ambiguous'; resource: object }
    | {
        kind: 'conflict';
        staged: NonNullable<ReturnType<typeof snapshotStagedHandle>>;
      } => {
    if (
      rawHandle === null ||
      (typeof rawHandle !== 'object' && typeof rawHandle !== 'function')
    ) {
      leaseControl.fence();
      return { kind: 'no-resource' };
    }
    if (claimedHandles.has(rawHandle)) {
      leaseControl.fence();
      return { kind: 'borrowed' };
    }
    const staged = snapshotStagedHandle(rawHandle);
    if (!staged) {
      leaseControl.fence();
      // An opaque object/function may be a resource despite lacking a safely
      // recognizable disposer. Never invoke it or mistake validation failure
      // for proof that nothing was returned.
      return { kind: 'ambiguous', resource: rawHandle };
    }
    if (
      claimedDisposers.has(staged.disposer) ||
      disputedDisposers.has(staged.disposer)
    ) {
      leaseControl.fence();
      return { kind: 'conflict', staged };
    }
    claimedHandles.set(staged.identity, leaseControl.lease.occurrenceIdentity);
    claimedDisposers.set(
      staged.disposer,
      leaseControl.lease.occurrenceIdentity,
    );
    let disposed = false;
    const occurrence: PluginCompositionOccurrence = {
      lease: leaseControl.lease,
      fence: leaseControl.fence,
      dispose: () => {
        if (disposed) return;
        disposed = true;
        return staged.handle.dispose();
      },
      releaseClaim: () => {
        if (
          claimedHandles.get(staged.identity) ===
          leaseControl.lease.occurrenceIdentity
        ) {
          claimedHandles.delete(staged.identity);
        }
        if (
          claimedDisposers.get(staged.disposer) ===
          leaseControl.lease.occurrenceIdentity
        ) {
          claimedDisposers.delete(staged.disposer);
        }
      },
    };
    return { kind: 'claimed', occurrence, exact: staged.exact };
  };

  const fenceAll = (contributions: readonly ActiveContribution[]) => {
    for (const contribution of contributions) contribution.occurrence.fence();
  };

  const inspect = (
    scope: PluginCompositionScope,
  ): PluginCompositionInspection => {
    const safeScope = snapshotScope(scope);
    if (!safeScope) {
      return {
        scope: INVALID_SCOPE,
        generation: 0,
        active: [],
        pending: [],
        failed: [],
        shadowed: [],
      };
    }
    const key = scopeKey(safeScope);
    const generation = active.get(key);
    const latest = [...(attempts.get(key) ?? [])];
    for (const pending of [
      ...(pendingLifecycle.get(key)?.entries ?? []),
      ...releaseEntries(key),
      ...unclaimedEntries(key),
    ]) {
      if (
        !latest.some(
          (candidate) =>
            candidate.instanceIdentity === pending.instanceIdentity &&
            candidate.status === pending.status &&
            candidate.reason === pending.reason,
        )
      ) {
        latest.push(pending);
      }
    }
    const failed = latest.filter((candidate) => candidate.status === 'failed');
    for (const fence of fenceEntries(key)) {
      if (
        !failed.some(
          (candidate) =>
            candidate.instanceIdentity === fence.instanceIdentity &&
            candidate.generation === fence.generation &&
            candidate.reason === fence.reason,
        )
      ) {
        failed.push(fence);
      }
    }
    const scopeLifecycle = [
      pendingLifecycle.get(key)?.scopeLifecycle,
      ...[...(releaseDebts.get(key)?.values() ?? [])].map(
        (debt) => debt.scopeLifecycle,
      ),
    ].filter(
      (diagnostic): diagnostic is PluginCompositionScopeLifecycleEntry =>
        diagnostic !== undefined,
    );
    return cloneInspection({
      scope: safeScope,
      generation: generation?.generation ?? 0,
      active: activeEntries(generation),
      pending: latest.filter((candidate) => candidate.status === 'pending'),
      failed,
      shadowed: latest.filter((candidate) => candidate.status === 'shadowed'),
      ...(scopeLifecycle.length > 0 ? { scopeLifecycle } : {}),
    });
  };

  const recordAttempt = (
    scope: PluginCompositionScope,
    entries: PluginCompositionInspectionEntry[],
  ) => {
    const key = scopeKey(scope);
    attempts.set(
      key,
      entries
        .filter((candidate) => candidate.reason !== 'disposer-timeout')
        .map((candidate) => structuredClone(candidate)),
    );
  };

  const disposeOne = async (
    contribution: ActiveContribution,
    key: string,
    generation: number,
    phase: 'rollback' | 'retire',
    settlements?: Promise<'disposed' | 'failed'>[],
  ): Promise<'disposed' | 'failed' | 'timed-out'> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const operation = Promise.resolve()
      .then(() => contribution.occurrence.dispose())
      .then(
        () => {
          contribution.occurrence.releaseClaim();
          return 'disposed' as const;
        },
        () => 'failed' as const,
      );
    settlements?.push(operation);
    const timeout = new Promise<'timed-out'>((resolve) => {
      timer = setTimeout(() => resolve('timed-out'), disposerTimeoutMs);
    });
    const result = await Promise.race([operation, timeout]);
    if (timer) clearTimeout(timer);
    if (result !== 'disposed') {
      const reason =
        result === 'timed-out'
          ? 'disposer-timeout'
          : phase === 'rollback'
            ? 'rollback-failed'
            : 'disposer-failed';
      const fences = disposalFences.get(key) ?? new Map();
      const id = fenceKey(generation, contribution.instanceIdentity);
      fences.set(id, {
        entry: entry(contribution, 'failed', reason, generation, {
          binding: contribution.binding,
          occurrence: contribution.occurrence.lease,
        }),
      });
      disposalFences.set(key, fences);
      if (result === 'timed-out') {
        void operation.then((lateResult) => {
          const current = disposalFences.get(key)?.get(id);
          if (!current) return;
          if (lateResult === 'disposed') {
            const retained = disposalFences.get(key);
            retained?.delete(id);
            if (retained?.size === 0) disposalFences.delete(key);
          } else {
            current.entry = entry(
              contribution,
              'failed',
              phase === 'rollback' ? 'rollback-failed' : 'disposer-failed',
              generation,
              {
                binding: contribution.binding,
                occurrence: contribution.occurrence.lease,
              },
            );
          }
        });
      }
    }
    return result;
  };

  const disposeReverse = async (
    contributions: readonly ActiveContribution[],
    phase: 'rollback' | 'retire',
    key: string,
    generation: number,
    settlements?: Promise<'disposed' | 'failed'>[],
  ): Promise<PluginCompositionInspectionEntry[]> => {
    fenceAll(contributions);
    const failures: PluginCompositionInspectionEntry[] = [];
    for (const contribution of [...contributions].reverse()) {
      const outcome = await disposeOne(
        contribution,
        key,
        generation,
        phase,
        settlements,
      );
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
          generation,
          {
            binding: contribution.binding,
            occurrence: contribution.occurrence.lease,
          },
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
    if (!ID.test(profile.profileId)) {
      return {
        kind: 'refused',
        entries: profile.contributions.map((contribution) =>
          invalidEntry(profile, contribution, 'invalid-contribution'),
        ),
      };
    }
    if (
      !validScope(profile.scope) ||
      !Array.isArray(profile.contributions) ||
      profile.contributions.length > MAX_CONTRIBUTIONS
    ) {
      return { kind: 'refused', entries: [] };
    }
    const normalized: NormalizedContribution[] = [];
    const invalid: PluginCompositionInspectionEntry[] = [];
    const instanceIds = new Set<string>();
    const contributionIds = new Set<string>();
    for (const contribution of profile.contributions) {
      const candidate = normalizeContribution(profile, contribution);
      const contributionIdentity = `${contribution.pluginId}:${contribution.contributionId}`;
      if (
        !candidate ||
        instanceIds.has(contribution.instanceId) ||
        contributionIds.has(contributionIdentity)
      ) {
        invalid.push(
          invalidEntry(profile, contribution, 'invalid-contribution'),
        );
        continue;
      }
      instanceIds.add(contribution.instanceId);
      contributionIds.add(contributionIdentity);
      if (fixedAuthorities.has(candidate.declaration.capability)) {
        invalid.push(entry(candidate, 'failed', 'fixed-authority'));
        continue;
      }
      normalized.push(candidate);
    }
    if (invalid.length > 0)
      return {
        kind: 'refused',
        entries: [
          ...invalid,
          ...normalized.map((candidate) =>
            entry(candidate, 'pending', 'activation-aborted'),
          ),
        ],
      };

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
      const selectedId =
        profile.selections && Object.hasOwn(profile.selections, capability)
          ? profile.selections[capability]
          : undefined;
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
      const failedIdentities = new Set(
        selectionFailures.map((candidate) => candidate.instanceIdentity),
      );
      return {
        kind: 'refused',
        entries: [
          ...selectionFailures,
          ...[...providers.values()]
            .filter(
              (candidate) => !failedIdentities.has(candidate.instanceIdentity),
            )
            .map((candidate) =>
              entry(candidate, 'pending', 'activation-aborted'),
            ),
          ...shadowed,
        ],
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
      const blockedIdentities = new Set(
        dependencyFailures.map((candidate) => candidate.instanceIdentity),
      );
      return {
        kind: dependencyFailures.some(
          (candidate) => candidate.status === 'failed',
        )
          ? 'refused'
          : 'pending',
        entries: [
          ...dependencyFailures,
          ...[...providers.values()]
            .filter(
              (candidate) => !blockedIdentities.has(candidate.instanceIdentity),
            )
            .map((candidate) =>
              entry(candidate, 'pending', 'activation-aborted'),
            ),
          ...shadowed,
        ],
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
    if (hasLifecycleDebt(key)) {
      return { kind: 'pending', inspection: inspect(profile.scope) };
    }
    const previous = active.get(key);
    const nextGeneration = (previous?.generation ?? 0) + 1;
    const planned = plan(profile);
    if (planned.kind !== 'ready') {
      recordAttempt(profile.scope, planned.entries);
      return { kind: planned.kind, inspection: inspect(profile.scope) };
    }
    const unsafeIdentityFences = fenceEntries(key).filter((fence) =>
      planned.plan.selected.some(
        (candidate) => candidate.instanceIdentity === fence.instanceIdentity,
      ),
    );
    const retainedFenceCount = disposalFences.get(key)?.size ?? 0;
    const potentialNewFences = Math.max(
      previous?.contributions.length ?? 0,
      planned.plan.selected.length,
    );
    if (
      unsafeIdentityFences.length > 0 ||
      retainedFenceCount + potentialNewFences > MAX_DISPOSAL_FENCES_PER_SCOPE
    ) {
      recordAttempt(profile.scope, [
        ...planned.plan.selected.map((candidate) =>
          entry(candidate, 'pending', 'activation-aborted'),
        ),
        ...planned.plan.shadowed,
      ]);
      return { kind: 'failed', inspection: inspect(profile.scope) };
    }
    const pending = planned.plan.selected.map((candidate) =>
      entry(candidate, 'pending', 'staging'),
    );
    recordAttempt(profile.scope, [...pending, ...planned.plan.shadowed]);
    const authorizationOperation = Promise.resolve().then(() =>
      authorize({
        profileId: profile.profileId,
        scope: structuredClone(profile.scope),
        contributions: planned.plan.selected.map((contribution) => ({
          contribution: structuredClone(contribution.declaration),
          instanceIdentity: contribution.instanceIdentity,
          configurationDigest: contribution.configurationDigest,
        })),
      }),
    );
    const authorizationOutcome = await outcomeWithin(
      authorizationOperation,
      disposerTimeoutMs,
    );
    let rawAuthorization: unknown;
    if (authorizationOutcome.kind === 'settled') {
      rawAuthorization = authorizationOutcome.value;
    } else {
      rawAuthorization = { kind: 'unavailable' };
      if (authorizationOutcome.kind === 'timed-out') {
        retainPendingLifecycle(
          key,
          planned.plan.selected.map((candidate) =>
            entry(candidate, 'pending', 'authorization-unavailable'),
          ),
          nextGeneration,
          'authorization-unavailable',
        );
        void authorizationOperation
          .then(
            async (lateAuthorization) => {
              const release =
                recognizableAuthorizationRelease(lateAuthorization);
              // The caller's deadline already elapsed. This continuation owns
              // the actual late lease, not another bounded wait: only a
              // successful release may reopen scope admission. A hanging or
              // rejected release leaves the existing visible pending debt.
              if (release) {
                const releasing = ownAuthorizationRelease(
                  key,
                  planned.plan.selected,
                  release,
                  nextGeneration,
                ).start();
                // Transfer custody synchronously before clearing the wait for
                // the authorizer. The release token now owns completion truth.
                pendingLifecycle.delete(key);
                await releasing;
              } else {
                const lateOutcome = validatePlanAuthorization(
                  lateAuthorization,
                  planned.plan.selected,
                );
                // Only a recognized no-lease response proves there is no
                // cleanup obligation; malformed output cannot prove absence.
                if (!lateOutcome || lateOutcome.kind === 'granted') return;
                pendingLifecycle.delete(key);
              }
            },
            () => pendingLifecycle.delete(key),
          )
          .catch(() => {});
      }
    }
    const authorization = validatePlanAuthorization(
      rawAuthorization,
      planned.plan.selected,
    );
    if (authorization?.kind !== 'granted') {
      if (!authorization) {
        const release = recognizableAuthorizationRelease(rawAuthorization);
        if (release)
          await ownAuthorizationRelease(
            key,
            planned.plan.selected,
            release,
            nextGeneration,
          ).within();
      }
      const unavailable =
        !authorization || authorization.kind === 'unavailable';
      recordAttempt(profile.scope, [
        ...planned.plan.selected.map((candidate) =>
          entry(
            candidate,
            unavailable ? 'pending' : 'failed',
            unavailable ? 'authorization-unavailable' : 'authorization-denied',
          ),
        ),
        ...planned.plan.shadowed,
      ]);
      return {
        kind: unavailable ? 'pending' : 'failed',
        inspection: inspect(profile.scope),
      };
    }

    // One owner joins every rollback operation for this authorization plan.
    // Disposer deadlines bound responses; they never settle this ownership.
    const rollbackOwner: {
      prior: Promise<'disposed' | 'failed'>[];
      late?: Promise<'disposed' | 'failed'>;
    } = { prior: [] };
    const releaseCustody = ownAuthorizationRelease(
      key,
      planned.plan.selected,
      () => authorization.lease.release(),
      nextGeneration,
    );
    const beginAuthorizationRelease = releaseCustody.start;
    const releaseAuthorization = releaseCustody.within;
    const authorizationCurrent = () => {
      try {
        return authorization.lease.isCurrent() === true;
      } catch {
        return false;
      }
    };
    const missingBindings = planned.plan.selected.filter(
      (candidate) => !authorization.bindings.has(candidate.instanceIdentity),
    );
    if (missingBindings.length > 0) {
      const missing = new Set(
        missingBindings.map((candidate) => candidate.instanceIdentity),
      );
      await releaseAuthorization();
      recordAttempt(profile.scope, [
        ...planned.plan.selected.map((candidate) =>
          missing.has(candidate.instanceIdentity)
            ? entry(candidate, 'failed', 'implementation-unavailable')
            : entry(candidate, 'pending', 'activation-aborted'),
        ),
        ...planned.plan.shadowed,
      ]);
      return { kind: 'failed', inspection: inspect(profile.scope) };
    }

    const sequence = nextActivationSequence();
    const staged: ActiveContribution[] = [];
    const retainUnclaimable = (
      contribution: NormalizedContribution,
      binding: PluginCompositionInstalledContributionBinding,
      lease: PluginCompositionOccurrenceLease,
      resource: object,
      handle?: NonNullable<ReturnType<typeof snapshotStagedHandle>>,
    ) => {
      // Custody owns this exact handle even though it cannot own the shared
      // disposer. A later stage must not claim it after the original disposer
      // owner retires; exact returns of this resource are borrowed too.
      claimedHandles.set(resource, lease.occurrenceIdentity);
      if (handle) disputedDisposers.add(handle.disposer);
      unclaimedResources.set(key, {
        resource,
        ...(handle ? { staged: handle } : {}),
        entry: entry(
          contribution,
          'pending',
          handle ? 'staged-resource-conflict' : 'staged-resource-ambiguous',
          nextGeneration,
          { binding, occurrence: lease },
        ),
      });
    };
    let rollbackSettlement: Promise<void> | undefined;
    const settleRollbackOwnership = async () => {
      if (!rollbackOwner.late && rollbackOwner.prior.length === 0) return;
      if (!rollbackSettlement) {
        retainPendingLifecycle(
          key,
          planned.plan.selected.map((candidate) =>
            entry(candidate, 'pending', 'activation-aborted'),
          ),
          nextGeneration,
          'activation-aborted',
        );
        // One continuation owns every rollback path and the actual lease
        // release. Deadlines only bound callers; failure retains admission.
        rollbackSettlement = Promise.all([
          ...rollbackOwner.prior,
          ...(rollbackOwner.late ? [rollbackOwner.late] : []),
        ])
          .then(async (outcomes) => {
            if (outcomes.some((outcome) => outcome !== 'disposed')) return;
            const releasing = beginAuthorizationRelease();
            pendingLifecycle.delete(key);
            await releasing;
          })
          .catch(() => {});
      }
      if (!rollbackOwner.late) {
        await outcomeWithin(rollbackSettlement, disposerTimeoutMs);
      }
    };
    const abortForCurrentness = async () => {
      const rollback = await disposeReverse(
        staged,
        'rollback',
        key,
        nextGeneration,
        rollbackOwner.prior,
      );
      await settleRollbackOwnership();
      recordAttempt(profile.scope, [
        ...planned.plan.selected.map((candidate) =>
          entry(candidate, 'pending', 'authorization-unavailable'),
        ),
        ...rollback,
        ...planned.plan.shadowed,
      ]);
      return {
        kind: 'pending' as const,
        inspection: inspect(profile.scope),
      };
    };

    try {
      if (!authorizationCurrent()) return await abortForCurrentness();
      for (let index = 0; index < planned.plan.selected.length; index += 1) {
        const contribution = planned.plan.selected[index];
        const binding = authorization.bindings.get(
          contribution.instanceIdentity,
        )!;
        const leaseControl = createOccurrenceLease(
          contribution,
          key,
          nextGeneration,
          sequence,
        );
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
          const stageOperation = Promise.resolve().then(() =>
            binding.factory.stage({
              profileId: profile.profileId,
              scope: structuredClone(profile.scope),
              contribution: structuredClone(contribution.declaration),
              instanceIdentity: contribution.instanceIdentity,
              configuration: structuredClone(contribution.configuration),
              occurrence: leaseControl.lease,
              dependencies,
            }),
          );
          const stageOutcome = await outcomeWithin(
            stageOperation,
            disposerTimeoutMs,
          );
          if (stageOutcome.kind === 'timed-out') {
            leaseControl.fence();
            retainPendingLifecycle(
              key,
              [entry(contribution, 'pending', 'activation-aborted')],
              nextGeneration,
              'activation-aborted',
            );
            rollbackOwner.late = stageOperation
              .then<'disposed' | 'failed', 'disposed' | 'failed'>(
                async (lateHandle) => {
                  const claim = claimOccurrence(leaseControl, lateHandle);
                  // Exact borrowed identity acquired no new resource. Join any
                  // earlier B rollback, then release B's lease; never dispose A.
                  // Primitive invalid results likewise return no handle. This
                  // settles only this stage's obligation; earlier rollback and
                  // actual authorization release still own their full join.
                  if (claim.kind === 'borrowed' || claim.kind === 'no-resource')
                    return 'disposed';
                  if (claim.kind === 'conflict')
                    retainUnclaimable(
                      contribution,
                      binding,
                      leaseControl.lease,
                      claim.staged.identity,
                      claim.staged,
                    );
                  if (claim.kind === 'ambiguous')
                    retainUnclaimable(
                      contribution,
                      binding,
                      leaseControl.lease,
                      claim.resource,
                    );
                  if (claim.kind !== 'claimed') return 'failed';
                  const occurrence = claim.occurrence;
                  const settlements: Promise<'disposed' | 'failed'>[] = [];
                  await disposeOne(
                    { ...contribution, binding, occurrence },
                    key,
                    nextGeneration,
                    'rollback',
                    settlements,
                  );
                  return settlements[0];
                },
                () => 'disposed',
              )
              .catch(() => 'failed' as const);
            throw new Error('plugin composition staging timed out');
          }
          if (stageOutcome.kind === 'rejected') {
            throw new Error('plugin composition staging failed');
          }
          const rawHandle = stageOutcome.value;
          const claim = claimOccurrence(leaseControl, rawHandle);
          if (claim.kind === 'conflict' || claim.kind === 'ambiguous') {
            retainUnclaimable(
              contribution,
              binding,
              leaseControl.lease,
              claim.kind === 'conflict'
                ? claim.staged.identity
                : claim.resource,
              claim.kind === 'conflict' ? claim.staged : undefined,
            );
            // This is an unresolved owned resource, not a completed cleanup.
            // Keep whole-plan authorization custody through the common join.
            rollbackOwner.prior.push(Promise.resolve('failed'));
          }
          if (claim.kind !== 'claimed')
            throw new Error('invalid staged contribution');
          const occurrence = claim.occurrence;
          staged.push({ ...contribution, binding, occurrence });
          // A recognizable disposer is still rollback authority even when the
          // surrounding result is malformed. Claim it before refusing so this
          // occurrence is fenced and disposed without touching an already-
          // claimed handle or disposer from another scope.
          if (!claim.exact) {
            throw new Error('malformed staged contribution');
          }
        } catch {
          leaseControl.fence();
          const rollback = await disposeReverse(
            staged,
            'rollback',
            key,
            nextGeneration,
            rollbackOwner.prior,
          );
          await settleRollbackOwnership();
          const blocked = planned.plan.selected
            .slice(index + 1)
            .map((candidate) =>
              entry(candidate, 'pending', 'activation-aborted'),
            );
          const rollbackFailures = new Set(
            rollback.map((candidate) => candidate.instanceIdentity),
          );
          const rolledBack = staged
            .filter(
              (candidate) =>
                candidate.instanceIdentity !== contribution.instanceIdentity &&
                !rollbackFailures.has(candidate.instanceIdentity),
            )
            .map((candidate) =>
              entry(candidate, 'pending', 'activation-aborted'),
            );
          recordAttempt(profile.scope, [
            entry(contribution, 'failed', 'activation-failed', undefined, {
              binding,
              occurrence: leaseControl.lease,
            }),
            ...rolledBack,
            ...blocked,
            ...rollback,
            ...planned.plan.shadowed,
          ]);
          return { kind: 'failed', inspection: inspect(profile.scope) };
        }
        if (!authorizationCurrent()) return await abortForCurrentness();
      }
      if (!authorizationCurrent()) return await abortForCurrentness();

      const generation = nextGeneration;
      if (previous) fenceAll(previous.contributions);
      active.set(key, {
        generation,
        profileId: profile.profileId,
        scope: structuredClone(profile.scope),
        contributions: staged,
      });
      const publishedShadowed = planned.plan.shadowed.map((candidate) => ({
        ...candidate,
        generation,
      }));
      // Publication ends staging immediately. Previous-generation retirement
      // and bounded lease release must not make the live generation appear
      // both active and pending.
      recordAttempt(profile.scope, publishedShadowed);
      await releaseAuthorization();
      const retirementFailures = previous
        ? await disposeReverse(
            previous.contributions,
            'retire',
            key,
            previous.generation,
          )
        : [];
      recordAttempt(profile.scope, [
        ...publishedShadowed,
        ...retirementFailures,
      ]);
      return {
        kind: 'activated',
        generation,
        liveFences: retirementFailures,
        inspection: inspect(profile.scope),
      };
    } finally {
      if (rollbackOwner.late || rollbackOwner.prior.length > 0) {
        if (!rollbackSettlement) await settleRollbackOwnership();
      } else {
        await releaseAuthorization();
      }
    }
  };

  return Object.freeze({
    apply(profile: PluginCompositionProfile) {
      const snapshot = snapshotProfile(profile);
      if (!snapshot) {
        return Promise.resolve({
          kind: 'refused' as const,
          inspection: {
            scope: INVALID_SCOPE,
            generation: 0,
            active: [],
            pending: [],
            failed: [],
            shadowed: [],
          },
        });
      }
      const key = scopeKey(snapshot.scope);
      if (
        !retainedScopeKeys().has(key) &&
        retainedScopeKeys().size >= maxRetainedScopes
      ) {
        // Refusal is observable without admitting or retaining this scope.
        // Planning is bounded and inert: it preserves selected/shadowed rows
        // and any validation failures without authorizing or staging anything.
        const requested = plan(snapshot);
        const entries =
          requested.kind === 'ready'
            ? [
                ...requested.plan.selected.map((candidate) =>
                  entry(candidate, 'pending', 'scope-capacity'),
                ),
                ...requested.plan.shadowed,
              ]
            : requested.entries.map((candidate) =>
                candidate.status === 'pending'
                  ? { ...candidate, reason: 'scope-capacity' as const }
                  : candidate,
              );
        return Promise.resolve({
          kind: 'refused' as const,
          inspection: cloneInspection({
            scope: snapshot.scope,
            generation: 0,
            active: [],
            pending: entries.filter(
              (candidate) => candidate.status === 'pending',
            ),
            failed: entries.filter(
              (candidate) => candidate.status === 'failed',
            ),
            shadowed: entries.filter(
              (candidate) => candidate.status === 'shadowed',
            ),
          }),
        });
      }
      return enqueueScope(key, async () => {
        const result = await applyNow(snapshot);
        // Early-return inspections can precede finally-owned release work.
        // Return the actual debt projection after those bounded finalizers.
        return {
          ...result,
          ...(result.kind === 'activated'
            ? {
                liveFences: [...result.liveFences, ...releaseEntries(key)],
              }
            : {}),
          inspection: inspect(snapshot.scope),
        };
      });
    },
    retire(scope: PluginCompositionScope) {
      const safeScope = snapshotScope(scope);
      if (!safeScope) {
        return Promise.resolve({
          kind: 'refused' as const,
          liveFences: [],
          inspection: {
            scope: INVALID_SCOPE,
            generation: 0,
            active: [],
            pending: [],
            failed: [],
            shadowed: [],
          },
        });
      }
      const key = scopeKey(safeScope);
      if (!retainedScopeKeys().has(key)) {
        return Promise.resolve({
          kind: 'retired' as const,
          liveFences: [],
          inspection: inspect(safeScope),
        });
      }
      return enqueueScope(key, async () => {
        const current = active.get(key);
        if (current) fenceAll(current.contributions);
        active.delete(key);
        attempts.delete(key);
        const failures = current
          ? await disposeReverse(
              current.contributions,
              'retire',
              key,
              current.generation,
            )
          : [];
        const liveFences = fenceEntries(key);
        const pending = [
          ...(pendingLifecycle.get(key)?.entries ?? []),
          ...releaseEntries(key),
          ...unclaimedEntries(key),
        ];
        return {
          kind:
            hasLifecycleDebt(key) || liveFences.length > 0
              ? ('pending' as const)
              : ('retired' as const),
          liveFences:
            liveFences.length > 0 || pending.length > 0
              ? [...liveFences, ...pending]
              : failures.filter(
                  (candidate) => candidate.reason !== 'disposer-timeout',
                ),
          inspection: inspect(safeScope),
        };
      });
    },
    inspect,
  });
}

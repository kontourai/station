/**
 * Provider registry — generic workspace-scoped store with backward-compat wrappers
 */

import type { EngineId } from '@kontourai/station-contracts/provider';
import { adapterRegistration } from '../../telemetry/metrics.js';
import {
  awaitSettlementWithin,
  raceWithSignal,
} from '../../utils/bounded-async.js';
import {
  type ProviderAdapterShape,
  setProviderAdapterRegistrationProvenance,
} from '../adapter-shape.js';
import {
  BuiltinIntegrationRegistryProvider,
  DefaultAgentRegistryProvider,
  DefaultAuthProvider,
  DefaultBrandingProvider,
  DefaultUserDirectoryProvider,
  DefaultUserIdentityProvider,
} from '../llm/defaults.js';
import type {
  IACPConnectionRegistryProvider,
  IAgentRegistryProvider,
  IAuthProvider,
  IBrandingProvider,
  IIntegrationRegistryProvider,
  INotificationProvider,
  IPluginRegistryProvider,
  IProviderAdapterRegistry,
  IPullRequestProvider,
  ISettingsProvider,
  ISkillRegistryProvider,
  IUserDirectoryProvider,
  IUserIdentityProvider,
} from '../provider-interfaces.js';
import { PROVIDER_TYPE_META } from '../provider-interfaces.js';
import { createIntegrationRegistryProvider } from './integration-registry-provider.js';

// ── Generic Store ──────────────────────────────────────

interface ProviderEntry {
  provider: any;
  source: string;
  builtin: boolean;
}

export interface PreparedPluginProviderRegistration {
  type: string;
  provider: any;
  source: string;
  layout?: string;
}

const PREPARED_ADAPTER_CLEANUP_TIMEOUT_MS = 2_000;
/**
 * Prepared adapters can start processes before registry publication. Keep a
 * failed disposal bound to the plugin source that prepared it so that source's
 * winning grant reconciliation can settle the exact debt before reporting
 * completion. Shutdown may still drain every source by omitting the filter.
 */
interface PreparedAdapterCleanupAttempt {
  sources: Set<string>;
  cleanup: Promise<void>;
  state: 'pending' | 'rejected';
}

const retainedPreparedAdapterCleanup = new Map<
  ProviderAdapterShape,
  PreparedAdapterCleanupAttempt
>();

function preparedAdapterCleanup(
  source: string,
  adapter: ProviderAdapterShape,
): Promise<void> {
  const retained = retainedPreparedAdapterCleanup.get(adapter);
  if (retained?.state === 'pending') {
    retained.sources.add(source);
    return retained.cleanup;
  }

  // Publish ownership before invoking plugin code. A deadline only bounds the
  // waiter, never the teardown itself: every retry joins this exact promise
  // until it settles. Only a terminal rejection authorizes another attempt.
  const attempt: PreparedAdapterCleanupAttempt = {
    sources: new Set([...(retained?.sources ?? []), source]),
    cleanup: Promise.resolve().then(() => adapter.stopAll()),
    state: 'pending',
  };
  retainedPreparedAdapterCleanup.set(adapter, attempt);
  void attempt.cleanup.then(
    () => {
      if (retainedPreparedAdapterCleanup.get(adapter) === attempt) {
        retainedPreparedAdapterCleanup.delete(adapter);
      }
    },
    () => {
      if (retainedPreparedAdapterCleanup.get(adapter) === attempt) {
        attempt.state = 'rejected';
      }
    },
  );
  return attempt.cleanup;
}
let pluginProviderMutationQueue = Promise.resolve();
const pluginProviderSourceGenerations = new Map<string, number>();

function advancePluginProviderSourceGeneration(source: string): void {
  pluginProviderSourceGenerations.set(
    source,
    (pluginProviderSourceGenerations.get(source) ?? 0) + 1,
  );
}

export function pluginProviderSourceGeneration(source: string): number {
  return pluginProviderSourceGenerations.get(source) ?? 0;
}

function serializePluginProviderMutation<T>(
  operation: () => Promise<T>,
): Promise<T> {
  const result = pluginProviderMutationQueue.then(operation, operation);
  pluginProviderMutationQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function splitPreparedPluginProviders(
  registrations: PreparedPluginProviderRegistration[],
): {
  active: PreparedPluginProviderRegistration[];
  displaced: PreparedPluginProviderRegistration[];
} {
  const lastAdapterIndex = new Map<string, number>();
  registrations.forEach((registration, index) => {
    if (registration.type === 'providerAdapter') {
      lastAdapterIndex.set(
        `${registration.source}:${(registration.provider as ProviderAdapterShape).provider}`,
        index,
      );
    }
  });
  const active = registrations.filter(
    (registration, index) =>
      registration.type !== 'providerAdapter' ||
      lastAdapterIndex.get(
        `${registration.source}:${(registration.provider as ProviderAdapterShape).provider}`,
      ) === index,
  );
  const activeAdapters = new Set(
    active
      .filter((registration) => registration.type === 'providerAdapter')
      .map((registration) => registration.provider),
  );
  return {
    active,
    displaced: registrations.filter(
      (registration, index) =>
        registration.type === 'providerAdapter' &&
        lastAdapterIndex.get(
          `${registration.source}:${(registration.provider as ProviderAdapterShape).provider}`,
        ) !== index &&
        !activeAdapters.has(registration.provider),
    ),
  };
}

export async function disposePreparedPluginProviders(
  registrations: PreparedPluginProviderRegistration[],
): Promise<void> {
  const adapters = new Map<ProviderAdapterShape, string>();
  for (const registration of registrations) {
    if (registration.type !== 'providerAdapter') continue;
    const adapter = registration.provider as ProviderAdapterShape;
    if (!adapters.has(adapter)) adapters.set(adapter, registration.source);
  }
  const results = await Promise.allSettled(
    [...adapters].map(async ([adapter, source]) => {
      const cleanup = preparedAdapterCleanup(source, adapter);
      const settled = await awaitSettlementWithin(
        cleanup,
        PREPARED_ADAPTER_CLEANUP_TIMEOUT_MS,
      );
      if (!settled) {
        throw new Error('Prepared plugin provider cleanup timed out.');
      }
      await cleanup;
    }),
  );
  const failures = results
    .filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    )
    .map((result) => result.reason);
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      'Prepared plugin provider cleanup failed.',
    );
  }
}

export async function disposeRetainedPreparedPluginProviders(
  source?: string,
): Promise<void> {
  await disposePreparedPluginProviders(
    [...retainedPreparedAdapterCleanup].flatMap(([provider, attempt]) =>
      [...attempt.sources]
        .filter((retainedSource) =>
          source === undefined ? true : retainedSource === source,
        )
        .map((retainedSource) => ({
          type: 'providerAdapter' as const,
          provider,
          source: retainedSource,
        })),
    ),
  );
}

// type -> workspace -> entry  (workspace '*' = global)
const store = new Map<string, Map<string, ProviderEntry>>();
const pluginStore = new Map<string, Map<string, ProviderEntry>>();

// additive types store arrays
const additiveStore = new Map<string, ProviderEntry[]>();
const pluginAdditiveStore = new Map<string, ProviderEntry[]>();
let providerAdapterLaunchabilityRevision = 0;
const providerAdapterLaunchabilityListeners = new Set<
  (revision: number) => void
>();

function commitProviderAdapterLaunchabilityRevision(): void {
  providerAdapterLaunchabilityRevision += 1;
  for (const listener of providerAdapterLaunchabilityListeners) {
    try {
      listener(providerAdapterLaunchabilityRevision);
    } catch {
      console.debug('Provider adapter launchability listener failed.');
    }
  }
}

export const providerAdapterLaunchabilitySource = {
  getLaunchabilityRevision(): number {
    return providerAdapterLaunchabilityRevision;
  },
  onLaunchabilityChange(listener: (revision: number) => void): () => void {
    providerAdapterLaunchabilityListeners.add(listener);
    return () => providerAdapterLaunchabilityListeners.delete(listener);
  },
};

export function registerProvider(
  type: string,
  provider: any,
  opts?: {
    layout?: string;
    source?: string;
    builtin?: boolean;
    plugin?: boolean;
  },
): void {
  const ws = opts?.layout ?? '*';
  const source = opts?.source ?? 'unknown';
  const builtin = opts?.builtin ?? false;
  const targetStore = opts?.plugin ? pluginStore : store;
  const targetAdditiveStore = opts?.plugin
    ? pluginAdditiveStore
    : additiveStore;
  // For additive types, push to array.
  if (PROVIDER_TYPE_META[type] === 'additive') {
    if (!targetAdditiveStore.has(type)) targetAdditiveStore.set(type, []);
    targetAdditiveStore.get(type)!.push({ provider, source, builtin });
    return;
  }
  // Singleton types
  if (!targetStore.has(type)) targetStore.set(type, new Map());
  targetStore.get(type)!.set(ws, { provider, source, builtin });
}

export function registerPullRequestProvider(provider: IPullRequestProvider) {
  registerProvider('pullRequest', provider, { builtin: true });
}

export function getProvider<T>(type: string, layout?: string): T | null {
  if (layout) {
    const wsEntry =
      pluginStore.get(type)?.get(layout) ?? store.get(type)?.get(layout);
    if (wsEntry) return wsEntry.provider as T;
  }
  const globalEntry =
    pluginStore.get(type)?.get('*') ?? store.get(type)?.get('*');
  return globalEntry ? (globalEntry.provider as T) : null;
}

export function listProviders(type: string): ProviderEntry[] {
  // Check additive store first
  const additive = [
    ...(additiveStore.get(type) ?? []),
    ...(pluginAdditiveStore.get(type) ?? []),
  ];
  if (additive.length > 0) return additive;
  // Singleton: collect all workspace entries
  const typeMap = new Map(store.get(type));
  for (const [workspace, entry] of pluginStore.get(type) ?? []) {
    typeMap.set(workspace, entry);
  }
  return Array.from(typeMap.values());
}

export function clearAll(): void {
  const hadProviderAdapters =
    (additiveStore.get('providerAdapter')?.length ?? 0) > 0 ||
    (pluginAdditiveStore.get('providerAdapter')?.length ?? 0) > 0;
  const pluginSources = new Set([
    ...[...pluginStore.values()].flatMap((entries) =>
      [...entries.values()].map((entry) => entry.source),
    ),
    ...[...pluginAdditiveStore.values()].flatMap((entries) =>
      entries.map((entry) => entry.source),
    ),
  ]);
  store.clear();
  pluginStore.clear();
  additiveStore.clear();
  pluginAdditiveStore.clear();
  for (const source of pluginSources)
    advancePluginProviderSourceGeneration(source);
  if (hadProviderAdapters) commitProviderAdapterLaunchabilityRevision();
}

/**
 * Clear plugin-provided entries only, preserving built-in registrations
 * (e.g. provider adapters registered during core initialization).
 */
export function clearPluginProviders(): void {
  const pluginAdapterCount =
    pluginAdditiveStore.get('providerAdapter')?.length ?? 0;
  const sources = new Set([
    ...[...pluginStore.values()].flatMap((entries) =>
      [...entries.values()].map((entry) => entry.source),
    ),
    ...[...pluginAdditiveStore.values()].flatMap((entries) =>
      entries.map((entry) => entry.source),
    ),
  ]);
  pluginStore.clear();
  pluginAdditiveStore.clear();
  for (const source of sources) advancePluginProviderSourceGeneration(source);
  if (pluginAdapterCount > 0) commitProviderAdapterLaunchabilityRevision();
}

function registerPreparedInto(
  targetStore: Map<string, Map<string, ProviderEntry>>,
  targetAdditiveStore: Map<string, ProviderEntry[]>,
  registration: PreparedPluginProviderRegistration,
): void {
  const entry = {
    provider: registration.provider,
    source: registration.source,
    builtin: false,
  };
  if (PROVIDER_TYPE_META[registration.type] === 'additive') {
    const entries = targetAdditiveStore.get(registration.type) ?? [];
    if (registration.type === 'providerAdapter') {
      const adapter = registration.provider as ProviderAdapterShape;
      setProviderAdapterRegistrationProvenance(adapter, 'plugin');
    }
    targetAdditiveStore.set(registration.type, [...entries, entry]);
    return;
  }
  const workspace = registration.layout ?? '*';
  const byWorkspace = targetStore.get(registration.type) ?? new Map();
  byWorkspace.set(workspace, entry);
  targetStore.set(registration.type, byWorkspace);
}

export async function registerPreparedPluginProviders(
  registrations: PreparedPluginProviderRegistration[],
): Promise<void> {
  const sources = new Set(
    registrations.map((registration) => registration.source),
  );
  if (sources.size > 1) {
    throw new Error(
      'Incremental plugin provider registration requires one source generation.',
    );
  }
  const source = sources.values().next().value;
  if (!source) return;
  await replacePluginProvidersForSource(source, registrations);
}

async function replacePluginProvidersForSourceInsideMutation(
  source: string,
  registrations: PreparedPluginProviderRegistration[],
  canCommit: () => boolean = () => true,
): Promise<'replaced' | 'superseded'> {
  if (registrations.some((registration) => registration.source !== source)) {
    throw new Error(
      'Plugin provider source replacement received mixed sources.',
    );
  }
  const { active, displaced } = splitPreparedPluginProviders(registrations);
  try {
    await disposePreparedPluginProviders(displaced);
  } catch (error) {
    const cleanupErrors: unknown[] = [error];
    try {
      await disposePreparedPluginProviders(active);
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    throw new AggregateError(
      cleanupErrors,
      'Plugin provider registration preparation failed.',
    );
  }
  if (!canCommit()) {
    await disposePreparedPluginProviders(active);
    return 'superseded';
  }
  const nextStore = new Map<string, Map<string, ProviderEntry>>();
  for (const [type, entries] of pluginStore) {
    const retained = new Map(
      [...entries].filter(([, entry]) => entry.source !== source),
    );
    if (retained.size > 0) nextStore.set(type, retained);
  }
  const nextAdditiveStore = new Map<string, ProviderEntry[]>();
  for (const [type, entries] of pluginAdditiveStore) {
    const retained = entries.filter((entry) => entry.source !== source);
    if (retained.length > 0) nextAdditiveStore.set(type, retained);
  }
  for (const registration of active) {
    registerPreparedInto(nextStore, nextAdditiveStore, registration);
  }

  const hadSourceAdapters = (
    pluginAdditiveStore.get('providerAdapter') ?? []
  ).some((entry) => entry.source === source);
  const hasSourceAdapters = active.some(
    (registration) => registration.type === 'providerAdapter',
  );
  pluginStore.clear();
  for (const [type, entries] of nextStore) pluginStore.set(type, entries);
  pluginAdditiveStore.clear();
  for (const [type, entries] of nextAdditiveStore) {
    pluginAdditiveStore.set(type, entries);
  }
  advancePluginProviderSourceGeneration(source);
  if (hadSourceAdapters || hasSourceAdapters) {
    commitProviderAdapterLaunchabilityRevision();
  }
  return 'replaced';
}

export async function replacePluginProvidersForSource(
  source: string,
  registrations: PreparedPluginProviderRegistration[],
): Promise<void> {
  await serializePluginProviderMutation(() =>
    replacePluginProvidersForSourceInsideMutation(source, registrations),
  );
}

/**
 * Publishes one prepared source only while both the provider source generation
 * and the caller's owning lifecycle generation remain current. The final
 * predicate runs after staged duplicate cleanup and immediately before the
 * synchronous store commit, so no newer revocation can be observed and then
 * overwritten by stale retained activation work.
 */
export async function replacePluginProvidersForSourceGeneration(
  source: string,
  expectedGeneration: number,
  registrations: PreparedPluginProviderRegistration[],
  isCurrent: () => boolean,
): Promise<'activated' | 'superseded'> {
  const current = () => {
    try {
      return (
        pluginProviderSourceGeneration(source) === expectedGeneration &&
        isCurrent() === true
      );
    } catch {
      return false;
    }
  };
  const result = await serializePluginProviderMutation(() =>
    replacePluginProvidersForSourceInsideMutation(
      source,
      registrations,
      current,
    ),
  );
  return result === 'replaced' ? 'activated' : 'superseded';
}

export async function retirePluginProvidersForSourceGeneration(
  source: string,
  expectedGeneration: number,
): Promise<'retired' | 'superseded'> {
  return serializePluginProviderMutation(async () => {
    if (pluginProviderSourceGeneration(source) !== expectedGeneration) {
      return 'superseded';
    }
    await replacePluginProvidersForSourceInsideMutation(source, []);
    return 'retired';
  });
}

/**
 * Runs a non-registry side effect while the exact plugin provider generation
 * remains current. Provider replacement for this or any other source queues
 * behind the operation, so callers can make generation-qualified cleanup a
 * single CAS boundary instead of checking and then acting on stale state.
 * The callback must not call a serialized provider mutation recursively.
 */
export async function withPluginProviderSourceGeneration<T>(
  source: string,
  expectedGeneration: number,
  operation: () => Promise<T>,
): Promise<
  | { readonly kind: 'applied'; readonly value: T }
  | { readonly kind: 'superseded' }
> {
  return serializePluginProviderMutation(async () => {
    if (pluginProviderSourceGeneration(source) !== expectedGeneration) {
      return { kind: 'superseded' };
    }
    return { kind: 'applied', value: await operation() };
  });
}

export async function replacePluginProviders(
  registrations: PreparedPluginProviderRegistration[],
): Promise<void> {
  await serializePluginProviderMutation(async () => {
    const priorSources = new Set([
      ...[...pluginStore.values()].flatMap((entries) =>
        [...entries.values()].map((entry) => entry.source),
      ),
      ...[...pluginAdditiveStore.values()].flatMap((entries) =>
        entries.map((entry) => entry.source),
      ),
    ]);
    const { active, displaced } = splitPreparedPluginProviders(registrations);
    try {
      await disposePreparedPluginProviders(displaced);
    } catch (error) {
      const cleanupErrors: unknown[] = [error];
      try {
        await disposePreparedPluginProviders(active);
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
      throw new AggregateError(
        cleanupErrors,
        'Plugin provider generation preparation failed.',
      );
    }
    const nextStore = new Map<string, Map<string, ProviderEntry>>();
    const nextAdditiveStore = new Map<string, ProviderEntry[]>();
    for (const registration of active) {
      registerPreparedInto(nextStore, nextAdditiveStore, registration);
    }

    const hadPluginAdapters =
      (pluginAdditiveStore.get('providerAdapter')?.length ?? 0) > 0;
    const hasPluginAdapters =
      (nextAdditiveStore.get('providerAdapter')?.length ?? 0) > 0;
    pluginStore.clear();
    for (const [type, entries] of nextStore) pluginStore.set(type, entries);
    pluginAdditiveStore.clear();
    for (const [type, entries] of nextAdditiveStore) {
      pluginAdditiveStore.set(type, entries);
    }
    const nextSources = new Set(active.map((entry) => entry.source));
    for (const source of new Set([...priorSources, ...nextSources])) {
      advancePluginProviderSourceGeneration(source);
    }
    if (hadPluginAdapters || hasPluginAdapters) {
      commitProviderAdapterLaunchabilityRevision();
    }
  });
}

// ── Provider Adapters ──────────────────────────────────

export function registerProviderAdapter(
  adapter: ProviderAdapterShape,
  options: { builtin?: boolean; source?: string; plugin?: boolean } = {},
): void {
  const builtin = options.builtin === true;
  const plugin = options.plugin ?? !builtin;
  setProviderAdapterRegistrationProvenance(
    adapter,
    builtin ? 'builtin' : 'plugin',
  );
  const targetStore = plugin ? pluginAdditiveStore : additiveStore;
  const existing = targetStore.get('providerAdapter') ?? [];
  const replacing = getProviderAdapters().some(
    (entry) => entry.provider === adapter.provider,
  );
  targetStore.set(
    'providerAdapter',
    existing.filter(
      (entry) =>
        (entry.provider as ProviderAdapterShape).provider !==
          adapter.provider || entry.builtin !== builtin,
    ),
  );
  registerProvider('providerAdapter', adapter, {
    source: options.source ?? adapter.provider,
    builtin,
    plugin,
  });
  adapterRegistration.add(1, {
    adapter_id: builtin ? adapter.provider : 'plugin',
    source: builtin ? 'builtin' : 'plugin',
    outcome: replacing ? 'replaced' : 'registered',
    reason: 'registerProviderAdapter',
  });
  commitProviderAdapterLaunchabilityRevision();
}

export function registerProviderAdapters(
  adapters: ProviderAdapterShape[],
  options: { builtin?: boolean; source?: string } = {},
): void {
  for (const adapter of adapters) {
    registerProviderAdapter(adapter, options);
  }
}

export function getProviderAdapters(): ProviderAdapterShape[] {
  const active = new Map<string, ProviderEntry>();
  for (const entry of listProviders('providerAdapter')) {
    const adapter = entry.provider as ProviderAdapterShape;
    const current = active.get(adapter.provider);
    if (!current || !entry.builtin) {
      active.set(adapter.provider, entry);
    }
  }
  return [...active.values()].map(
    (entry) => entry.provider as ProviderAdapterShape,
  );
}

export function getProviderAdapter(
  provider: EngineId,
): ProviderAdapterShape | undefined {
  return getProviderAdapters().find((adapter) => adapter.provider === provider);
}

export function createProviderAdapterRegistry(): IProviderAdapterRegistry {
  return {
    register(adapter) {
      registerProviderAdapter(adapter);
    },
    get(provider) {
      return getProviderAdapter(provider);
    },
    list() {
      return getProviderAdapters();
    },
    onChange(listener) {
      return providerAdapterLaunchabilitySource.onLaunchabilityChange(listener);
    },
  };
}

// ── Auth ───────────────────────────────────────────────

export function registerAuthProvider(provider: IAuthProvider) {
  registerProvider('auth', provider);
}

export function getAuthProvider(): IAuthProvider {
  return getProvider<IAuthProvider>('auth') ?? new DefaultAuthProvider();
}

// ── User Identity ──────────────────────────────────────

export function registerUserIdentityProvider(provider: IUserIdentityProvider) {
  registerProvider('userIdentity', provider);
}

export function getUserIdentityProvider(): IUserIdentityProvider {
  return (
    getProvider<IUserIdentityProvider>('userIdentity') ??
    new DefaultUserIdentityProvider()
  );
}

// ── User Directory ─────────────────────────────────────

export function registerUserDirectoryProvider(
  provider: IUserDirectoryProvider,
) {
  registerProvider('userDirectory', provider);
}

export function getUserDirectoryProvider(): IUserDirectoryProvider {
  return (
    getProvider<IUserDirectoryProvider>('userDirectory') ??
    new DefaultUserDirectoryProvider()
  );
}

// ── Agent Registry ─────────────────────────────────────

export function registerAgentRegistryProvider(
  provider: IAgentRegistryProvider,
) {
  registerProvider('agentRegistry', provider);
}

export function getAgentRegistryProvider(): IAgentRegistryProvider {
  const entries = listProviders('agentRegistry');
  return entries.length > 0
    ? (entries[0].provider as IAgentRegistryProvider)
    : new DefaultAgentRegistryProvider();
}

// ── Tool Registry ──────────────────────────────────────

export function registerIntegrationRegistryProvider(
  provider: IIntegrationRegistryProvider,
) {
  registerProvider('integrationRegistry', provider);
}

export function registerACPConnectionRegistryProvider(
  provider: IACPConnectionRegistryProvider,
  source = provider.id ?? 'acpConnectionRegistry',
  builtin = false,
) {
  registerProvider('acpConnectionRegistry', provider, { source, builtin });
}

export function getIntegrationRegistryProvider(): IIntegrationRegistryProvider {
  const entries = listProviders('integrationRegistry');
  const providers = entries.map(
    (entry) => entry.provider as IIntegrationRegistryProvider,
  );
  if (entries.length === 0) {
    return createIntegrationRegistryProvider([
      new BuiltinIntegrationRegistryProvider(),
    ]);
  }
  providers.push(new BuiltinIntegrationRegistryProvider());
  return createIntegrationRegistryProvider(providers);
}

// ── Skill Registry ─────────────────────────────────────

export function registerSkillRegistryProvider(
  provider: ISkillRegistryProvider,
) {
  registerProvider('skillRegistry', provider);
}

export function getSkillRegistryProviders(): {
  provider: ISkillRegistryProvider;
  source: string;
}[] {
  return listProviders('skillRegistry') as {
    provider: ISkillRegistryProvider;
    source: string;
  }[];
}

// ── Plugin Registry ────────────────────────────────────

export function registerPluginRegistryProvider(
  provider: IPluginRegistryProvider,
  source = 'Core',
): void {
  registerProvider('pluginRegistry', provider, { source });
}

// Accessed via dynamic import() namespace in plugin-install-shared.
// fallow-ignore-next-line unused-export
export function getPluginRegistryProviders(): {
  provider: IPluginRegistryProvider;
  source: string;
}[] {
  return listProviders('pluginRegistry') as {
    provider: IPluginRegistryProvider;
    source: string;
  }[];
}

// ── Cross-Provider Prerequisites ───────────────────────

export async function getAllPrerequisites(options?: {
  signal?: AbortSignal;
}): Promise<
  Array<
    import('@kontourai/station-contracts/tool').Prerequisite & {
      source: string;
      reason?: 'timed_out';
    }
  >
> {
  type SourcedPrerequisite =
    import('@kontourai/station-contracts/tool').Prerequisite & {
      source: string;
      reason?: 'timed_out';
    };
  const entries: Array<{
    provider?: {
      getPrerequisites?: () => Promise<
        import('@kontourai/station-contracts/tool').Prerequisite[]
      >;
    };
    source: string;
  }> = [];
  const collect = async (entry: {
    provider?: {
      getPrerequisites?: () => Promise<
        import('@kontourai/station-contracts/tool').Prerequisite[]
      >;
    };
    source: string;
  }): Promise<SourcedPrerequisite[]> => {
    if (typeof entry.provider?.getPrerequisites !== 'function') return [];
    try {
      const items = await raceWithSignal(
        entry.provider.getPrerequisites(),
        options?.signal,
      );
      return items.map((prerequisite) => ({
        ...prerequisite,
        source: entry.source,
      }));
    } catch (error) {
      const timedOut = options?.signal?.aborted === true;
      return [
        {
          id: `provider-prerequisites:${entry.source}`,
          name: `${entry.source} prerequisites`,
          description: timedOut
            ? 'Prerequisite discovery timed out.'
            : error instanceof Error
              ? error.message
              : 'Provider prerequisite discovery failed.',
          status: 'error',
          category: 'required',
          source: entry.source,
          ...(timedOut ? { reason: 'timed_out' as const } : {}),
        },
      ];
    }
  };

  // Collect the registry snapshot synchronously, then probe every provider in
  // parallel. Status discovery has one shared AbortSignal budget; a provider
  // that exceeds it becomes an explicit required error instead of extending
  // the status endpoint's latency.
  for (const providerStore of [store, pluginStore]) {
    for (const [, wsMap] of providerStore) {
      for (const [, entry] of wsMap) {
        entries.push(entry);
      }
    }
  }

  for (const providerStore of [additiveStore, pluginAdditiveStore]) {
    for (const [, registeredEntries] of providerStore) {
      for (const entry of registeredEntries) {
        entries.push(entry);
      }
    }
  }

  const collected = (await Promise.all(entries.map(collect))).flat();

  // Providers sharing one source (e.g. station-core's built-ins) each
  // synthesize an identical failure placeholder when discovery fails, which
  // would render as N duplicate rows. Collapse fully identical placeholders
  // into the first occurrence and record how many providers it represents.
  // Real provider-reported prerequisites are never collapsed.
  const deduped: SourcedPrerequisite[] = [];
  const placeholderCounts = new Map<
    string,
    { entry: SourcedPrerequisite; count: number }
  >();
  for (const item of collected) {
    if (!item.id.startsWith('provider-prerequisites:')) {
      deduped.push(item);
      continue;
    }
    const key = JSON.stringify([
      item.id,
      item.name,
      item.description,
      item.status,
      item.category,
      item.source,
    ]);
    const existing = placeholderCounts.get(key);
    if (existing) {
      existing.count += 1;
      continue;
    }
    placeholderCounts.set(key, { entry: item, count: 1 });
    deduped.push(item);
  }
  for (const { entry, count } of placeholderCounts.values()) {
    if (count > 1) {
      entry.description = `${entry.description} (${count} providers)`;
    }
  }
  return deduped;
}

// ── Branding ───────────────────────────────────────────

export function registerBrandingProvider(provider: IBrandingProvider) {
  registerProvider('branding', provider);
}

export function getBrandingProvider(): IBrandingProvider {
  return (
    getProvider<IBrandingProvider>('branding') ?? new DefaultBrandingProvider()
  );
}

// ── Settings ───────────────────────────────────────────

export function registerSettingsProvider(provider: ISettingsProvider) {
  registerProvider('settings', provider);
}

// ── Notification ────────────────────────────────────────

export function getNotificationProviders(): {
  provider: INotificationProvider;
  source: string;
}[] {
  return listProviders('notification') as {
    provider: INotificationProvider;
    source: string;
  }[];
}

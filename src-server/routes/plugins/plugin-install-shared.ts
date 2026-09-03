import { execFile as execFileCb } from 'node:child_process';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { agentId } from '@kontourai/station-contracts/agent-identity';
import {
  isCanonicalPluginId,
  type PluginManifest,
} from '@kontourai/station-contracts/plugin';
import type { ServerEventName } from '@kontourai/station-contracts/runtime-events';
import { acquireFileMutationLockAsync } from '@kontourai/station-shared/lifecycle-events';
import { copyPluginIntegrations } from '@kontourai/station-shared/parsers';
import { createStationTempDirSync } from '@kontourai/station-shared/temp-dir';
import {
  acquireAgentIdentityMutationLockAtHome,
  DefaultAgentMutationError,
  registryOwnsAgentAtHomeSync,
} from '../../domain/agent-registry.js';
import { owningProjectExists } from '../../domain/config-loader-agents.js';
import { saveIntegrationConfig } from '../../domain/config-loader-storage.js';
import {
  type IPluginRegistryProvider,
  PROVIDER_TYPE_META,
} from '../../providers/provider-interfaces.js';
import {
  getIntegrationRegistryProvider,
  getPluginRegistryProviders,
} from '../../providers/registries/registry.js';
import {
  type RegistryInstallAliases,
  RegistryInstallAliasFormatError,
  readRegistryInstallAliases,
  writeRegistryInstallAliases,
} from '../../providers/registries/registry-install-aliases.js';
import { ContextSafetyError } from '../../services/orchestration/context-safety.js';
import { scanPluginPromptGeneration } from '../../services/plugins/plugin-command-skill-source.js';
import {
  computePluginContentDigest,
  findPluginContentLockCycleError,
  forgetPluginContentDigest,
  PLUGIN_TREE_COPY,
  withPluginContentLock,
} from '../../services/plugins/plugin-content-integrity.js';
import {
  assertPluginInstallConsent,
  derivePluginConsentBasis,
  type PluginInstallConsent,
} from '../../services/plugins/plugin-install-consent.js';
import {
  readPluginManifestFile,
  readPluginManifestFileSync,
} from '../../services/plugins/plugin-manifest-loader.js';
import {
  hasGrant,
  type PluginDependencyOwnershipEntry,
  type PluginInstallAuthorityRecord,
  processInstallPermissions,
  readPluginDependencyOwnership,
  rebindGrantsAfterContentChange,
  recordPluginDependencyOwnership,
  removePluginHostRecord,
  requiredPermissionsForManifest,
  restorePluginGrantEntry,
  revokeAllGrants,
  snapshotPluginGrantEntry,
} from '../../services/plugins/plugin-permissions.js';
import { assertPluginIdentityAvailable } from '../../services/plugins/reserved-plugin-identities.js';
import { pluginInstalls, pluginUninstalls } from '../../telemetry/metrics.js';
import type { Logger } from '../../utils/logger.js';
import {
  assertExistingPathInside,
  assertPathInside,
} from '../../utils/path-containment.js';
import { errorMessage } from '../schemas/schemas.js';
import { assertPluginBundleAssetsContained } from './plugin-bundles.js';
import { loadPluginProviders } from './plugin-loader.js';
import {
  type PluginPublicServerQuiescence,
  quiescePluginPublicServerModule,
} from './plugin-public-server.js';
import {
  detectWorkspacePaneCatalogConflicts,
  fetchPluginSource,
  installPluginDependency,
  type PluginDependencyLifecycle,
  resolvePluginDependencySource,
} from './plugin-source.js';

const execFile = promisify(execFileCb);

function assertExecutableToken(command: unknown): asserts command is string {
  if (
    typeof command !== 'string' ||
    command.length === 0 ||
    command.length > 128 ||
    !/^[A-Za-z0-9._+-]+$/.test(command)
  ) {
    throw new Error('Integration command must be one executable token');
  }
}

function assertIntegrationId(id: unknown): asserts id is string {
  if (
    typeof id !== 'string' ||
    id.length === 0 ||
    id.length > 128 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(id)
  ) {
    throw new Error(`Invalid integration id: ${String(id)}`);
  }
}

function assertNoSymlinkTree(
  root: string,
  target: string,
  label: string,
): void {
  assertExistingPathInside(root, target, label);
  const status = lstatSync(target);
  if (status.isSymbolicLink()) {
    throw new Error(`${label} must not contain symlinks`);
  }
  if (!status.isDirectory()) {
    throw new Error(`${label} must be a directory`);
  }

  for (const entry of readdirSync(target, { withFileTypes: true })) {
    const child = join(target, entry.name);
    assertPathInside(root, child, label);
    if (entry.isSymbolicLink()) {
      throw new Error(`${label} must not contain symlinks`);
    }
    if (entry.isDirectory()) {
      assertNoSymlinkTree(root, child, label);
    }
  }
}

async function resolveSinglePluginRegistryProvider(id: string): Promise<{
  provider: IPluginRegistryProvider;
  source: string | null;
}> {
  const entries = getPluginRegistryProviders() as Array<{
    source?: string;
    provider: IPluginRegistryProvider;
  }>;
  const matches: Array<{
    providerIndex: number;
    providerSource?: string;
    provider: IPluginRegistryProvider;
    source: string | null;
  }> = [];

  for (const [providerIndex, entry] of entries.entries()) {
    if (entry.provider.resolveSource) {
      const resolved = await entry.provider.resolveSource(id);
      if (resolved) {
        matches.push({
          providerIndex,
          providerSource: entry.source,
          provider: entry.provider,
          source: resolved,
        });
      }
    }
    if (entry.provider.listAvailable) {
      const items = await entry.provider.listAvailable();
      const match = items.find((item) => item.id === id);
      if (match) {
        if (match.source) {
          matches.push({
            providerIndex,
            providerSource: entry.source,
            provider: entry.provider,
            source: match.source,
          });
        } else if (!entry.provider.resolveSource) {
          matches.push({
            providerIndex,
            providerSource: entry.source,
            provider: entry.provider,
            source: null,
          });
        }
      }
    }
  }

  const uniqueProviderMatches = new Map<
    number,
    { provider: IPluginRegistryProvider; source: string | null }
  >();
  for (const match of matches) {
    const existing = uniqueProviderMatches.get(match.providerIndex);
    if (existing && existing.source !== match.source) {
      throw new Error(
        `Plugin '${id}' is ambiguous within plugin registry provider '${match.providerSource ?? match.providerIndex}'`,
      );
    }
    uniqueProviderMatches.set(match.providerIndex, {
      provider: match.provider,
      source: match.source,
    });
  }

  if (uniqueProviderMatches.size > 1) {
    throw new Error(
      `Plugin '${id}' is ambiguous across multiple plugin registry providers`,
    );
  }

  const [providerMatch] = uniqueProviderMatches.values();
  if (!providerMatch) {
    throw new Error(`No plugin registry provider could install ${id}`);
  }
  return providerMatch;
}

export async function ensureCanonicalRegistryInstallAliases(
  projectHomeDir: string,
): Promise<void> {
  const target = join(projectHomeDir, ...REGISTRY_INSTALLS_PATH);
  if (!existsSync(target)) return;

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(target, 'utf-8'));
  } catch {
    readRegistryInstallAliases(projectHomeDir);
    return;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    readRegistryInstallAliases(projectHomeDir);
    return;
  }

  const entries = Object.entries(parsed as Record<string, unknown>);
  if (!entries.some(([, value]) => typeof value === 'string')) {
    readRegistryInstallAliases(projectHomeDir);
    return;
  }

  const aliases: RegistryInstallAliases = {};
  for (const [id, value] of entries) {
    if (typeof value === 'string') {
      let match: Awaited<
        ReturnType<typeof resolveSinglePluginRegistryProvider>
      >;
      try {
        match = await resolveSinglePluginRegistryProvider(id);
      } catch (error) {
        throw new RegistryInstallAliasFormatError(
          `Pre-ownership registry install '${id}' cannot be assigned to exactly one registry source: ${errorMessage(error)}. Remove the ambiguity, then retry to migrate config/registry-installs.json.`,
        );
      }
      if (!match.provider.registryKey) {
        throw new RegistryInstallAliasFormatError(
          `Pre-ownership registry install '${id}' belongs to a provider without a stable source identity. Reinstall it after removing the prior alias.`,
        );
      }
      aliases[id] = {
        pluginName: value,
        registryKey: match.provider.registryKey,
      };
      continue;
    }
    const alias = value as {
      pluginName?: unknown;
      registryKey?: unknown;
    } | null;
    if (
      !alias ||
      typeof alias !== 'object' ||
      typeof alias.pluginName !== 'string' ||
      typeof alias.registryKey !== 'string'
    ) {
      throw new RegistryInstallAliasFormatError(
        `Registry install alias '${id}' is not source-preserving. Reinstall the affected plugin to regenerate config/registry-installs.json.`,
      );
    }
    aliases[id] = {
      pluginName: alias.pluginName,
      registryKey: alias.registryKey,
    };
  }
  writeRegistryInstallAliases(projectHomeDir, aliases);
}

export interface PluginLifecycleEventBus {
  emit: (event: ServerEventName, data?: Record<string, unknown>) => void;
}

export interface PluginInstallSharedDeps {
  agentsDir: string;
  eventBus?: PluginLifecycleEventBus;
  logger: Logger;
  pluginsDir: string;
  projectHomeDir: string;
  buildPlugin: (pluginDir: string, name: string) => Promise<void>;
  beginConfigurationMutation?: () => void;
  settleProviderAdapterRetirements?: () => Promise<void>;
  reconcileEngineConnections?: (plugin: string) => Promise<void>;
  removeEngineConnections?: (plugin: string) => Promise<void>;
  quiesceEventSubscriptions?: (
    pluginName: string,
  ) => Promise<{ release(): void }>;
}

export interface InstalledPluginResult {
  success: true;
  plugin: {
    name: string;
    displayName?: string;
    version: string;
    hasBundle: boolean;
    agents: Array<{ slug: string }>;
  };
  layout?: { slug: string };
  tools: Array<{
    id: string;
    status: 'installed' | 'missing' | 'installed-now';
  }>;
  dependencies: Array<{
    id: string;
    status: string;
    error?: string;
  }>;
  permissions: {
    /** Passive permissions: granted by installing, nobody was asked. */
    autoGranted: string[];
    /**
     * Active-tier permissions granted because the operator approved them
     * BEFORE this install ran (archive#4288). Named apart from
     * `autoGranted` so neither word has to cover the other's meaning.
     */
    consentGranted: string[];
    pendingConsent: Array<{ permission: string; tier: string }>;
    /**
     * Permissions this install WITHDREW because it replaced the code they
     * were granted against (archive#4288). Named rather than implied: an
     * install over an existing plugin can leave it holding less than it did a
     * moment ago, and a capability that disappears without a word is its own
     * defect. Empty on a first install, which withdraws nothing.
     */
    withdrawn: string[];
  };
}

const REGISTRY_INSTALLS_PATH = ['config', 'registry-installs.json'] as const;
const AGENT_REGISTRY_PATH = ['config', 'agent-registry.json'] as const;
// Plugin grants are deliberately NOT in the raw-copy backup set (archive#1835
// finding 2): a whole-file cpSync restore bypasses the grants store's lock and
// atomic writer (it can tear), and a stale snapshot reverts consent recorded
// for OTHER plugins between snapshot and rollback (e.g. a host approval).
// Only the installing plugin's OWN entry is snapshotted and restored, through
// the store's locked mutate.
const PLUGIN_GRANTS_ENTRY_SNAPSHOT = [
  'project-files',
  'plugin-grants-entry.json',
] as const;
interface RemovedDependencyBackup {
  entry: PluginDependencyOwnershipEntry;
  backupDir: string;
  manifest: PluginManifest;
  grantSnapshot: ReturnType<typeof snapshotPluginGrantEntry>;
}

function pluginHasDependencyLifecycle(manifest: PluginManifest): boolean {
  return Boolean(manifest.providers?.length || manifest.settings?.length);
}

function assertDependencyProviderSlotsAvailable(
  pluginsDir: string,
  dependencyId: string,
  manifest: PluginManifest,
): void {
  for (const provider of manifest.providers ?? []) {
    if (PROVIDER_TYPE_META[provider.type] === 'additive') continue;
    for (const entry of readdirSync(pluginsDir, { withFileTypes: true })) {
      if (
        !entry.isDirectory() ||
        entry.name === dependencyId ||
        entry.name.startsWith('.preview-')
      ) {
        continue;
      }
      const manifestPath = join(pluginsDir, entry.name, 'plugin.json');
      if (!existsSync(manifestPath)) continue;
      try {
        const installed = readPluginManifestFileSync(manifestPath);
        const collision = (installed.providers ?? []).find(
          (candidate) =>
            candidate.type === provider.type &&
            (candidate.layout ?? null) === (provider.layout ?? null),
        );
        if (collision) {
          throw new Error(
            `Plugin dependency '${dependencyId}' provider '${provider.type}' collides with plugin '${installed.name}'`,
          );
        }
      } catch (error) {
        if (
          errorMessage(error).includes(`Plugin dependency '${dependencyId}'`)
        ) {
          throw error;
        }
        throw new Error(
          `Plugin dependency '${dependencyId}' provider collision check could not read installed plugin '${entry.name}'`,
          { cause: error },
        );
      }
    }
  }
}

function deriveDependencyOwnership(
  pluginsDir: string,
  createdPluginTrees: ReadonlySet<string>,
  retained: readonly PluginDependencyOwnershipEntry[] = [],
  declaredDependencyIds?: ReadonlySet<string>,
): PluginDependencyOwnershipEntry[] {
  const entries = new Map(
    retained
      .filter(
        (entry) =>
          !declaredDependencyIds || declaredDependencyIds.has(entry.id),
      )
      .map((entry) => [entry.id, entry]),
  );
  for (const id of createdPluginTrees) {
    const contentDigest = computePluginContentDigest(pluginsDir, id);
    if (!contentDigest) {
      throw new Error(
        `Plugin dependency '${id}' could not be recorded after installation`,
      );
    }
    entries.set(id, { id, contentDigest });
  }
  return [...entries.values()];
}

function dependencyHasOtherInstalledConsumer(
  pluginsDir: string,
  removedPluginName: string,
  dependencyId: string,
): boolean {
  const transitivelyDependsOn = (
    manifest: PluginManifest,
    visiting: Set<string>,
  ): boolean => {
    for (const dependency of manifest.dependencies ?? []) {
      if (dependency.id === dependencyId) return true;
      if (visiting.has(dependency.id)) continue;
      visiting.add(dependency.id);
      try {
        assertPluginNameSegment(dependency.id);
        const manifestPath = join(pluginsDir, dependency.id, 'plugin.json');
        if (!existsSync(manifestPath)) return true;
        if (
          transitivelyDependsOn(
            readPluginManifestFileSync(manifestPath),
            visiting,
          )
        ) {
          return true;
        }
      } catch {
        return true;
      }
    }
    return false;
  };
  for (const entry of readdirSync(pluginsDir, { withFileTypes: true })) {
    if (
      !entry.isDirectory() ||
      entry.name === removedPluginName ||
      entry.name === dependencyId ||
      entry.name.startsWith('.preview-')
    ) {
      continue;
    }
    try {
      const manifestPath = join(pluginsDir, entry.name, 'plugin.json');
      if (!existsSync(manifestPath)) continue;
      const manifest = readPluginManifestFileSync(manifestPath);
      if (transitivelyDependsOn(manifest, new Set([manifest.name]))) {
        return true;
      }
    } catch {
      // If another installed plugin cannot be inspected, deleting a dependency
      // it may reference would turn corruption into destructive guesswork.
      return true;
    }
  }
  return false;
}

function createDependencyLifecycle(options: {
  consent: PluginInstallConsent;
  pluginsDir: string;
  projectHomeDir: string;
  logger: Logger;
  reconcileEngineConnections?: (plugin: string) => Promise<void>;
  settleProviderAdapterRetirements?: () => Promise<void>;
}): PluginDependencyLifecycle {
  const approvals = new Map<
    string,
    NonNullable<
      Extract<
        PluginInstallConsent,
        { kind: 'operator-decision' }
      >['dependencyApprovals']
    >[number]
  >();
  if (options.consent.kind === 'operator-decision') {
    for (const approval of options.consent.dependencyApprovals ?? []) {
      if (approvals.has(approval.id)) {
        throw new Error(
          `Plugin dependency '${approval.id}' has duplicate approvals`,
        );
      }
      approvals.set(approval.id, approval);
    }
  }
  const grantSnapshots = new Map<
    string,
    ReturnType<typeof snapshotPluginGrantEntry>
  >();
  const activated = new Set<string>();

  const rollbackDependency = async (dependencyId: string): Promise<void> => {
    if (!activated.has(dependencyId)) return;
    const failures: unknown[] = [];
    const attempt = async (cleanup: () => Promise<void>): Promise<void> => {
      try {
        await cleanup();
      } catch (error) {
        failures.push(error);
      }
    };
    await attempt(async () => {
      const { replacePluginProvidersForSource } = await import(
        '../../providers/registries/registry.js'
      );
      await replacePluginProvidersForSource(dependencyId, []);
    });
    await attempt(() =>
      restorePluginGrantEntry(
        options.projectHomeDir,
        dependencyId,
        grantSnapshots.get(dependencyId) ?? null,
      ),
    );
    await attempt(async () => {
      await options.reconcileEngineConnections?.(dependencyId);
    });
    await attempt(async () => {
      await options.settleProviderAdapterRetirements?.();
    });
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        `Plugin dependency '${dependencyId}' lifecycle rollback failed`,
      );
    }
    // Keep the claim until every cleanup step settles so a caller can retry a
    // partial rollback without the second attempt becoming a no-op.
    activated.delete(dependencyId);
  };

  return {
    validate({ dependencyId, dependencyDir, manifest }) {
      if (!pluginHasDependencyLifecycle(manifest)) return;
      const approval = approvals.get(dependencyId);
      if (!approval) {
        throw new Error(
          `Plugin dependency '${dependencyId}' has lifecycle contributions but no preview-bound permission approval`,
        );
      }
      const basis = derivePluginConsentBasis(dependencyDir, manifest);
      if (!basis) {
        throw new Error(
          `Plugin dependency '${dependencyId}' source could not be read, so it was not installed`,
        );
      }
      assertPluginInstallConsent({
        pluginName: dependencyId,
        consent: {
          kind: 'operator-decision',
          permissions: approval.permissions,
          contentDigest: approval.contentDigest,
          dependencies: approval.dependencies,
        },
        basis,
      });
      assertDependencyProviderSlotsAvailable(
        options.pluginsDir,
        dependencyId,
        manifest,
      );
      if (!grantSnapshots.has(dependencyId)) {
        grantSnapshots.set(
          dependencyId,
          snapshotPluginGrantEntry(options.projectHomeDir, dependencyId),
        );
      }
    },
    async activate({ dependencyId, manifest }) {
      if (
        !pluginHasDependencyLifecycle(manifest) ||
        activated.has(dependencyId)
      ) {
        return;
      }
      const approval = approvals.get(dependencyId);
      if (!approval || !grantSnapshots.has(dependencyId)) {
        throw new Error(
          `Plugin dependency '${dependencyId}' was not validated for lifecycle activation`,
        );
      }
      // Activation ownership begins before the first effect. If any later
      // step fails, compensation retains this claim until all derived state
      // (providers, grants, engine connections, and retirements) is settled.
      activated.add(dependencyId);
      try {
        await processInstallPermissions(
          options.projectHomeDir,
          dependencyId,
          requiredPermissionsForManifest(manifest),
          { consented: approval.permissions },
        );
        const activeProviders = hasGrant(
          options.projectHomeDir,
          dependencyId,
          'providers.register',
        )
          ? (manifest.providers ?? [])
          : [];
        await loadPluginProviders(
          options.pluginsDir,
          dependencyId,
          { ...manifest, providers: activeProviders },
          options.logger,
          { strict: true },
        );
        await options.reconcileEngineConnections?.(dependencyId);
        await options.settleProviderAdapterRetirements?.();
      } catch (error) {
        try {
          await rollbackDependency(dependencyId);
        } catch (rollbackError) {
          throw new AggregateError(
            [error, rollbackError],
            `Plugin dependency '${dependencyId}' activation and rollback both failed`,
          );
        }
        throw error;
      }
    },
    rollback: rollbackDependency,
  };
}

async function removeOwnedDependencyLifecycles(options: {
  dependencies: readonly PluginDependencyOwnershipEntry[];
  removedPluginName: string;
  pluginsDir: string;
  projectHomeDir: string;
  backupRoot: string;
  logger: Logger;
  reconcileEngineConnections?: (plugin: string) => Promise<void>;
  settleProviderAdapterRetirements?: () => Promise<void>;
}): Promise<RemovedDependencyBackup[]> {
  const removed: RemovedDependencyBackup[] = [];
  try {
    for (const dependency of [...options.dependencies].reverse()) {
      const dependencyDir = join(options.pluginsDir, dependency.id);
      assertPathInside(
        options.pluginsDir,
        dependencyDir,
        'Owned plugin dependency target',
      );
      await withPluginContentLock(
        options.pluginsDir,
        dependency.id,
        async () => {
          if (!existsSync(dependencyDir)) return;
          if (
            dependencyHasOtherInstalledConsumer(
              options.pluginsDir,
              options.removedPluginName,
              dependency.id,
            )
          ) {
            options.logger.info(
              'Preserved shared plugin dependency during removal',
              { plugin: dependency.id },
            );
            return;
          }
          if (
            computePluginContentDigest(options.pluginsDir, dependency.id) !==
            dependency.contentDigest
          ) {
            options.logger.warn(
              'Preserved plugin dependency because its installed content no longer matches the creating install',
              { plugin: dependency.id },
            );
            return;
          }
          const manifest = await readPluginManifestFile(
            join(dependencyDir, 'plugin.json'),
          );
          const grantSnapshot = snapshotPluginGrantEntry(
            options.projectHomeDir,
            dependency.id,
          );
          const backupDir = join(
            options.backupRoot,
            'dependencies',
            dependency.id,
          );
          assertPathInside(
            options.backupRoot,
            backupDir,
            'Dependency uninstall backup',
          );
          mkdirSync(dirname(backupDir), { recursive: true });
          cpSync(dependencyDir, backupDir, PLUGIN_TREE_COPY);
          const backup: RemovedDependencyBackup = {
            entry: dependency,
            backupDir,
            manifest,
            grantSnapshot,
          };
          const { replacePluginProvidersForSource } = await import(
            '../../providers/registries/registry.js'
          );
          try {
            await replacePluginProvidersForSource(dependency.id, []);
            await revokeAllGrants(options.projectHomeDir, dependency.id);
            rmSync(dependencyDir, { recursive: true, force: true });
            forgetPluginContentDigest(options.pluginsDir, dependency.id);
            await removePluginHostRecord(options.projectHomeDir, dependency.id);
            forgetRegistryInstallsForPlugin(
              options.projectHomeDir,
              dependency.id,
            );
            await options.reconcileEngineConnections?.(dependency.id);
            await options.settleProviderAdapterRetirements?.();
            removed.push(backup);
          } catch (error) {
            try {
              if (!existsSync(dependencyDir)) {
                cpSync(backupDir, dependencyDir, PLUGIN_TREE_COPY);
              }
              await restorePluginGrantEntry(
                options.projectHomeDir,
                dependency.id,
                grantSnapshot,
              );
              await loadPluginProviders(
                options.pluginsDir,
                dependency.id,
                hasGrant(
                  options.projectHomeDir,
                  dependency.id,
                  'providers.register',
                )
                  ? manifest
                  : { ...manifest, providers: [] },
                options.logger,
                { strict: true },
              );
              await options.reconcileEngineConnections?.(dependency.id);
              await options.settleProviderAdapterRetirements?.();
            } catch (rollbackError) {
              throw new AggregateError(
                [error, rollbackError],
                `Plugin dependency '${dependency.id}' removal and rollback both failed`,
              );
            }
            throw error;
          }
        },
      );
    }
  } catch (error) {
    try {
      await restoreRemovedDependencyLifecycles({
        backups: removed,
        pluginsDir: options.pluginsDir,
        projectHomeDir: options.projectHomeDir,
        logger: options.logger,
        reconcileEngineConnections: options.reconcileEngineConnections,
        settleProviderAdapterRetirements:
          options.settleProviderAdapterRetirements,
      });
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        'Plugin dependency removal and rollback both failed',
      );
    }
    throw error;
  }
  return removed;
}

async function restoreRemovedDependencyLifecycles(options: {
  backups: readonly RemovedDependencyBackup[];
  pluginsDir: string;
  projectHomeDir: string;
  logger: Logger;
  reconcileEngineConnections?: (plugin: string) => Promise<void>;
  settleProviderAdapterRetirements?: () => Promise<void>;
}): Promise<void> {
  for (const backup of [...options.backups].reverse()) {
    await withPluginContentLock(
      options.pluginsDir,
      backup.entry.id,
      async () => {
        const dependencyDir = join(options.pluginsDir, backup.entry.id);
        if (existsSync(dependencyDir)) {
          const digest = computePluginContentDigest(
            options.pluginsDir,
            backup.entry.id,
          );
          if (digest !== backup.entry.contentDigest) {
            throw new Error(
              `Plugin dependency '${backup.entry.id}' changed before uninstall rollback`,
            );
          }
        } else {
          cpSync(backup.backupDir, dependencyDir, PLUGIN_TREE_COPY);
        }
        forgetPluginContentDigest(options.pluginsDir, backup.entry.id);
        await restorePluginGrantEntry(
          options.projectHomeDir,
          backup.entry.id,
          backup.grantSnapshot,
        );
        await loadPluginProviders(
          options.pluginsDir,
          backup.entry.id,
          hasGrant(
            options.projectHomeDir,
            backup.entry.id,
            'providers.register',
          )
            ? backup.manifest
            : { ...backup.manifest, providers: [] },
          options.logger,
          { strict: true },
        );
        await options.reconcileEngineConnections?.(backup.entry.id);
        await options.settleProviderAdapterRetirements?.();
      },
    );
  }
}

function backupProjectFile(
  projectHomeDir: string,
  relativePath: readonly string[],
  backupRoot: string,
): void {
  const source = join(projectHomeDir, ...relativePath);
  assertPathInside(projectHomeDir, source, 'Project file backup source');
  const target = join(backupRoot, 'project-files', ...relativePath);
  assertPathInside(backupRoot, target, 'Project file backup target');
  mkdirSync(dirname(target), { recursive: true });
  if (existsSync(source)) {
    cpSync(source, target);
  } else {
    writeFileSync(`${target}.missing`, '');
  }
}

function restoreProjectFile(
  projectHomeDir: string,
  relativePath: readonly string[],
  backupRoot: string,
): void {
  const target = join(projectHomeDir, ...relativePath);
  assertPathInside(projectHomeDir, target, 'Project file restore target');
  const source = join(backupRoot, 'project-files', ...relativePath);
  assertPathInside(backupRoot, source, 'Project file restore source');
  if (existsSync(`${source}.missing`)) {
    rmSync(target, { force: true });
    return;
  }
  if (!existsSync(source)) return;
  mkdirSync(dirname(target), { recursive: true });
  cpSync(source, target);
}

export function backupPluginDurableState(
  projectHomeDir: string,
  backupRoot: string,
  pluginName: string,
): void {
  backupProjectFile(projectHomeDir, REGISTRY_INSTALLS_PATH, backupRoot);
  backupProjectFile(projectHomeDir, AGENT_REGISTRY_PATH, backupRoot);
  // Throws the typed grants-unavailable error when the store is corrupt: an
  // install/uninstall must not begin against a consent store it cannot read.
  const entry = snapshotPluginGrantEntry(projectHomeDir, pluginName);
  const snapshotPath = join(backupRoot, ...PLUGIN_GRANTS_ENTRY_SNAPSHOT);
  assertPathInside(backupRoot, snapshotPath, 'Plugin grants snapshot target');
  mkdirSync(dirname(snapshotPath), { recursive: true });
  writeFileSync(snapshotPath, JSON.stringify({ pluginName, entry }, null, 2));
}

export async function restorePluginDurableState(
  projectHomeDir: string,
  backupRoot: string,
): Promise<void> {
  restoreProjectFile(projectHomeDir, REGISTRY_INSTALLS_PATH, backupRoot);
  restoreProjectFile(projectHomeDir, AGENT_REGISTRY_PATH, backupRoot);
  const snapshotPath = join(backupRoot, ...PLUGIN_GRANTS_ENTRY_SNAPSHOT);
  assertPathInside(backupRoot, snapshotPath, 'Plugin grants snapshot source');
  if (!existsSync(snapshotPath)) return;
  const parsed: unknown = JSON.parse(readFileSync(snapshotPath, 'utf-8'));
  const snapshot = parsed as { pluginName?: unknown; entry?: unknown };
  // archive#4288: the snapshot carries the grant RECORD (permissions plus the
  // content digest they were granted against), so the validation is shape-
  // checked here too — a rollback that restored permissions without their
  // digest would leave the entry reading `unverified` for a tree that was
  // never actually re-consented.
  const entry = snapshot.entry as
    | {
        permissions?: unknown;
        contentDigest?: unknown;
        installAuthority?: unknown;
      }
    | null
    | undefined;
  const installAuthority =
    entry && typeof entry === 'object'
      ? (entry.installAuthority as
          | {
              version?: unknown;
              installedDigest?: unknown;
              ownedDependencies?: unknown;
            }
          | undefined)
      : undefined;
  const installAuthorityValid =
    installAuthority === undefined ||
    (installAuthority !== null &&
      typeof installAuthority === 'object' &&
      Object.keys(installAuthority).sort().join(',') ===
        'installedDigest,ownedDependencies,version' &&
      installAuthority.version === 1 &&
      typeof installAuthority.installedDigest === 'string' &&
      /^sha256:[0-9a-f]{64}$/.test(installAuthority.installedDigest) &&
      Array.isArray(installAuthority.ownedDependencies) &&
      installAuthority.ownedDependencies.length <= 256 &&
      installAuthority.ownedDependencies.every((dependency) => {
        if (!dependency || typeof dependency !== 'object') return false;
        const candidate = dependency as {
          id?: unknown;
          contentDigest?: unknown;
        };
        return (
          Object.keys(candidate).sort().join(',') === 'contentDigest,id' &&
          isCanonicalPluginId(candidate.id) &&
          typeof candidate.contentDigest === 'string' &&
          /^sha256:[0-9a-f]{64}$/.test(candidate.contentDigest)
        );
      }) &&
      new Set(
        installAuthority.ownedDependencies.map(
          (dependency) => (dependency as { id: string }).id,
        ),
      ).size === installAuthority.ownedDependencies.length);
  if (
    typeof snapshot.pluginName !== 'string' ||
    snapshot.pluginName.length === 0 ||
    !(
      entry === null ||
      (typeof entry === 'object' &&
        entry !== null &&
        Array.isArray(entry.permissions) &&
        entry.permissions.every((value) => typeof value === 'string') &&
        installAuthorityValid &&
        (installAuthority === undefined ||
          typeof entry.contentDigest === 'string') &&
        (entry.contentDigest === null ||
          (typeof entry.contentDigest === 'string' &&
            entry.contentDigest.length > 0)))
    )
  ) {
    // Loud into the rollback error aggregation — never a raw-copy fallback.
    throw new Error('Plugin grants rollback snapshot is malformed');
  }
  await restorePluginGrantEntry(
    projectHomeDir,
    snapshot.pluginName,
    entry === null || entry === undefined
      ? null
      : {
          permissions: entry.permissions as string[],
          contentDigest: entry.contentDigest as string | null,
          ...(installAuthority
            ? {
                installAuthority:
                  installAuthority as PluginInstallAuthorityRecord,
              }
            : {}),
        },
  );
}

export function assertPluginNameSegment(pluginName: string): void {
  if (
    !pluginName ||
    pluginName === '.' ||
    pluginName === '..' ||
    isAbsolute(pluginName) ||
    pluginName.includes('/') ||
    pluginName.includes('\\')
  ) {
    throw new Error(`Invalid plugin name: ${pluginName || '(empty)'}`);
  }
}

const PLUGIN_AGENT_OWNER_FILE = '.station-plugin-owner.json';

function pluginAgentOwner(agentDir: string): string | null {
  const marker = join(agentDir, PLUGIN_AGENT_OWNER_FILE);
  if (!existsSync(marker)) return null;
  const stats = lstatSync(marker);
  if (!stats.isFile() || stats.isSymbolicLink()) return null;
  try {
    const parsed = JSON.parse(readFileSync(marker, 'utf-8')) as {
      plugin?: unknown;
    };
    return typeof parsed.plugin === 'string' ? parsed.plugin : null;
  } catch {
    return null;
  }
}

function assertPluginAgentOwned(agentDir: string, pluginName: string): void {
  const owner = pluginAgentOwner(agentDir);
  if (owner !== pluginName) {
    throw new Error(
      `Agent '${basename(agentDir)}' is already owned by ${owner ? `plugin '${owner}'` : 'a custom Agent'}; plugin '${pluginName}' cannot replace it.`,
    );
  }
}

async function removePluginAgentDefinitions(
  agentsDir: string,
  projectHomeDir: string,
  pluginName: string,
  manifest: PluginManifest,
): Promise<void> {
  for (const agent of manifest.agents ?? []) {
    let agentDir: string;
    try {
      assertPluginNameSegment(pluginName);
      assertPluginNameSegment(agent.slug);
      agentId(agent.slug);
      agentDir = join(agentsDir, agent.slug);
      assertPathInside(agentsDir, agentDir, 'Plugin agent target');
    } catch {
      continue;
    }
    const releaseIdentity =
      await acquireAgentIdentityMutationLockAtHome(projectHomeDir);
    try {
      if (existsSync(agentDir)) {
        assertPluginAgentOwned(agentDir, pluginName);
        rmSync(agentDir, { recursive: true, force: true });
      }
    } finally {
      await releaseIdentity();
    }
  }
}

/**
 * §3.3 ownership preservation across plugin sync (archive#1004 review
 * HIGH-1): a plugin's own `agent.json` almost never authors `project` — it
 * is a scope a HUMAN assigns after install, not something the plugin author
 * knows about. `synchronizePluginAgentDefinitions` deletes-then-recopies
 * the installed agent directory raw on every sync, which would otherwise
 * silently clear that assignment on every plugin update. Captured BEFORE
 * `removePluginAgentDefinitions` runs, keyed by slug, so it survives the
 * delete.
 */
export function capturePersistedAgentOwnership(
  agentsDir: string,
  pluginName: string,
  manifest: PluginManifest,
): Map<string, string | undefined> {
  const persisted = new Map<string, string | undefined>();
  for (const agent of manifest.agents ?? []) {
    let targetDir: string;
    try {
      assertPluginNameSegment(pluginName);
      assertPluginNameSegment(agent.slug);
      agentId(agent.slug);
      targetDir = join(agentsDir, agent.slug);
      assertPathInside(agentsDir, targetDir, 'Plugin agent target');
    } catch {
      continue;
    }
    const existingManifestPath = join(targetDir, 'agent.json');
    if (!existsSync(existingManifestPath)) continue;
    try {
      const existing = JSON.parse(
        readFileSync(existingManifestPath, 'utf-8'),
      ) as { project?: unknown };
      persisted.set(
        agent.slug,
        typeof existing.project === 'string' ? existing.project : undefined,
      );
    } catch {
      // Unreadable/corrupt — nothing safe to carry forward; treated the
      // same as "no persisted value" below.
    }
  }
  return persisted;
}

/**
 * Reconciles the freshly-copied `agent.json`'s `project` field against the
 * ownership rules (archive#1004 review HIGH-1): an incoming definition that
 * explicitly declares its OWN valid owner wins; an incoming definition that
 * declares an unknown owner has it stripped (with a warn) — plugins cannot
 * mint orphans; an incoming definition that declares nothing carries
 * forward whatever was already persisted (preserving an orphan's state too,
 * matching the loader's own never-rewrite discipline). Reuses
 * `owningProjectExists` — the exact same existence check `saveAgentConfig`
 * applies — rather than duplicating it.
 */
function reconcilePluginAgentOwnership(options: {
  targetDir: string;
  projectHomeDir: string;
  pluginName: string;
  agentSlug: string;
  persistedProject: string | undefined;
  logger?: Logger;
}): void {
  const agentManifestPath = join(options.targetDir, 'agent.json');
  let spec: Record<string, unknown>;
  try {
    spec = JSON.parse(readFileSync(agentManifestPath, 'utf-8'));
  } catch {
    return;
  }
  const rawProject = spec.project;
  // A present-but-non-string `project` (e.g. authored/generated with a
  // numeric or object value) must never survive the copy — the persisted
  // spec always has to satisfy agent.schema.json's `project: { type:
  // 'string' }`, or the record becomes unloadable (closure review HIGH-1
  // residual a). Treated the same as "unknown owner": stripped, with a
  // warn, rather than silently written back invalid.
  const hasInvalidProjectType =
    rawProject !== undefined && typeof rawProject !== 'string';
  const declaredProject =
    typeof rawProject === 'string' ? rawProject : undefined;

  let resolvedProject: string | undefined;
  if (hasInvalidProjectType) {
    resolvedProject = undefined;
    options.logger?.warn(
      'Plugin agent declares a non-string owning project; installing without ownership',
      {
        plugin: options.pluginName,
        agent: options.agentSlug,
        project: rawProject,
      },
    );
  } else if (declaredProject !== undefined) {
    if (owningProjectExists(options.projectHomeDir, declaredProject)) {
      resolvedProject = declaredProject;
    } else {
      resolvedProject = undefined;
      options.logger?.warn(
        'Plugin agent declares an unknown owning project; installing without ownership',
        {
          plugin: options.pluginName,
          agent: options.agentSlug,
          project: declaredProject,
        },
      );
    }
  } else {
    resolvedProject = options.persistedProject;
  }

  if (!hasInvalidProjectType && resolvedProject === declaredProject) return;
  if (resolvedProject === undefined) {
    delete spec.project;
  } else {
    spec.project = resolvedProject;
  }
  writeFileSync(agentManifestPath, JSON.stringify(spec, null, 2), 'utf-8');
}

export async function synchronizePluginAgentDefinitions(options: {
  agentsDir: string;
  pluginDir: string;
  pluginName: string;
  projectHomeDir: string;
  manifest: PluginManifest;
  previousManifest?: PluginManifest | null;
  include?: (slug: string) => boolean;
  logger?: Logger;
  /**
   * Pre-captured ownership map (archive#1004 review HIGH-1 residual b):
   * when the caller already deleted the installed agent directories before
   * calling this (e.g. `uninstallInstalledPlugin`'s rollback, called after
   * its own try block already ran `removePluginAgentDefinitions`), a live
   * `capturePersistedAgentOwnership` read here would find nothing — the
   * directories are already gone by the time this runs. Pass the map
   * captured BEFORE that deletion instead; falls back to the normal live
   * capture when omitted (the ordinary install/update path, where nothing
   * has been deleted yet).
   */
  persistedOwnership?: ReadonlyMap<string, string | undefined>;
}): Promise<void> {
  const persistedOwnership =
    options.persistedOwnership ??
    capturePersistedAgentOwnership(
      options.agentsDir,
      options.pluginName,
      options.manifest,
    );
  if (options.previousManifest) {
    await removePluginAgentDefinitions(
      options.agentsDir,
      options.projectHomeDir,
      options.previousManifest.name || options.pluginName,
      options.previousManifest,
    );
  }
  if (!options.manifest.agents?.length) return;
  assertPluginNameSegment(options.pluginName);
  mkdirSync(options.agentsDir, { recursive: true });
  for (const agent of options.manifest.agents) {
    assertPluginNameSegment(agent.slug);
    const slug = agentId(agent.slug);
    if (options.include && !options.include(slug)) continue;
    const sourceDir = join(options.pluginDir, 'agents', agent.slug);
    const targetDir = join(options.agentsDir, slug);
    assertPathInside(options.agentsDir, targetDir, 'Plugin agent target');
    if (existsSync(sourceDir)) {
      assertNoSymlinkTree(options.pluginDir, sourceDir, 'Plugin agent source');
      const agentManifestPath = join(sourceDir, 'agent.json');
      const agentManifestStatus = lstatSync(agentManifestPath);
      if (!agentManifestStatus.isFile()) {
        throw new Error('Plugin agent source manifest must be a regular file');
      }
      const releaseIdentity = await acquireAgentIdentityMutationLockAtHome(
        options.projectHomeDir,
      );
      try {
        if (registryOwnsAgentAtHomeSync(options.projectHomeDir, slug)) {
          throw new DefaultAgentMutationError(slug);
        }
        if (existsSync(targetDir)) {
          throw new Error(
            `Agent '${slug}' already exists; plugin '${options.pluginName}' must contribute a globally unique clean Agent ID.`,
          );
        }
        cpSync(sourceDir, targetDir, { recursive: true });
        writeFileSync(
          join(targetDir, PLUGIN_AGENT_OWNER_FILE),
          JSON.stringify({ plugin: options.pluginName }, null, 2),
          { encoding: 'utf-8', mode: 0o600 },
        );
        reconcilePluginAgentOwnership({
          targetDir,
          projectHomeDir: options.projectHomeDir,
          pluginName: options.pluginName,
          agentSlug: agent.slug,
          persistedProject: persistedOwnership.get(agent.slug),
          logger: options.logger,
        });
      } finally {
        await releaseIdentity();
      }
    }
  }
}

function assertRegistryAliasAvailable(
  aliases: RegistryInstallAliases,
  registryId: string,
  registryKey: string,
  pluginName: string,
): void {
  const existingAlias = aliases[registryId];
  if (
    existingAlias &&
    (existingAlias.pluginName !== pluginName ||
      existingAlias.registryKey !== registryKey)
  ) {
    throw new Error(
      `Registry item '${registryId}' is already owned by another registry source or plugin target`,
    );
  }

  for (const [existingRegistryId, alias] of Object.entries(aliases)) {
    if (existingRegistryId !== registryId && alias.pluginName === pluginName) {
      throw new Error(
        `Plugin '${pluginName}' is already linked to registry item '${existingRegistryId}'`,
      );
    }
  }
}

function assertRegistryInstallTargetAvailable(
  projectHomeDir: string,
  pluginsDir: string,
  registryId: string | undefined,
  registryKey: string | undefined,
  pluginName: string,
): void {
  if (!registryId) {
    return;
  }
  if (!registryKey) {
    throw new Error(`Registry item '${registryId}' has no source identity`);
  }

  const aliases = readRegistryInstallAliases(projectHomeDir);
  assertRegistryAliasAvailable(aliases, registryId, registryKey, pluginName);

  const pluginDir = join(pluginsDir, pluginName);
  const existingAlias = aliases[registryId];
  const ownsExistingTarget =
    existingAlias?.pluginName === pluginName &&
    existingAlias.registryKey === registryKey;
  if (existsSync(pluginDir) && !ownsExistingTarget) {
    throw new Error(
      `Plugin '${pluginName}' is already installed outside registry item '${registryId}'`,
    );
  }
}

function rememberRegistryInstall(
  projectHomeDir: string,
  registryId: string | undefined,
  registryKey: string | undefined,
  pluginName: string,
): void {
  if (!registryId) {
    return;
  }
  if (!registryKey) {
    throw new Error(`Registry item '${registryId}' has no source identity`);
  }

  const aliases = readRegistryInstallAliases(projectHomeDir);
  assertRegistryAliasAvailable(aliases, registryId, registryKey, pluginName);
  aliases[registryId] = { pluginName, registryKey };
  writeRegistryInstallAliases(projectHomeDir, aliases);
}

function forgetRegistryInstallsForPlugin(
  projectHomeDir: string,
  pluginName: string,
  explicitRegistryId?: string,
): void {
  const aliases = readRegistryInstallAliases(projectHomeDir);
  let changed = false;

  for (const [registryId, alias] of Object.entries(aliases)) {
    // A registry id is not a plugin identity. Delete only an alias whose
    // target is the plugin being removed, and when the caller knows the
    // registry id require that owner too. This preserves `{ dep -> other }`
    // while retiring an owned plugin named `dep`.
    if (
      alias.pluginName === pluginName &&
      (!explicitRegistryId || registryId === explicitRegistryId)
    ) {
      delete aliases[registryId];
      changed = true;
    }
  }

  if (changed) {
    writeRegistryInstallAliases(projectHomeDir, aliases);
  }
}

function resolveInstalledPluginName(
  projectHomeDir: string,
  pluginsDir: string,
  pluginIdOrName: string,
): string | null {
  assertPluginNameSegment(pluginIdOrName);
  const directPath = join(pluginsDir, pluginIdOrName, 'plugin.json');
  assertPathInside(pluginsDir, directPath, 'Plugin lookup target');
  if (existsSync(directPath)) {
    return pluginIdOrName;
  }

  const aliases = readRegistryInstallAliases(projectHomeDir);
  const aliasTarget = aliases[pluginIdOrName]?.pluginName;
  if (aliasTarget) {
    assertPluginNameSegment(aliasTarget);
  }
  const aliasPath = aliasTarget
    ? join(pluginsDir, aliasTarget, 'plugin.json')
    : null;
  if (aliasPath) assertPathInside(pluginsDir, aliasPath, 'Plugin alias target');
  if (aliasTarget && aliasPath && existsSync(aliasPath)) {
    return aliasTarget;
  }

  return null;
}

/**
 * Undoes the dependency trees THIS install created, and nothing else.
 *
 * It used to diff `<plugins>` against a listing taken before the install and
 * delete everything that had appeared since — which is every plugin directory
 * a CONCURRENT operation created in the same window, deleted with no lock
 * held while that operation was still building into it (archive#4309 follow-up
 * review, HIGH 1). `createdPluginTrees` is populated by the frames that did
 * the creating (`installPluginDependency`), so a tree is removed because this
 * install made it, not because it appeared during a window.
 *
 * The recorded identity is the plugin NAME, and that binding is not stable
 * across the creating frame's release: if a concurrent operation completes a
 * full install-over of that dependency before this rollback runs, the name
 * still resolves and the rollback removes THEIR tree — under the lock, so
 * nothing tears, but their install is undone and their grants then bind a
 * digest of bytes that no longer exist. The window is the failure window
 * rather than the whole install, which is the improvement over the listing
 * diff, but it is not closed. Recording the content digest beside the name
 * and comparing it here would close it.
 *
 * Each removal takes the dependency's own content lock, because this call runs
 * after the creating frame released it and a concurrent operation may have
 * adopted the tree in between. That lock CAN be refused — this function is
 * reached from a catch, and one of the things that reaches it is a refused
 * acquisition — so a removal that cannot take the lock is logged and skipped
 * rather than forced: leaving an orphaned dependency tree is recoverable, and
 * deleting a tree another operation is inside is not.
 */
/**
 * How long the rollback waits for a dependency's content lock before giving up
 * and leaving the tree. Generous enough that an ordinary handover completes,
 * far short of the multi-minute span a transitive install can hold.
 */
const ROLLBACK_LOCK_TIMEOUT_MS = 10_000;

export async function removeDependencyTreesCreatedByThisInstall(
  pluginsDir: string,
  createdPluginTrees: ReadonlySet<string>,
  parentPluginName: string,
  logger: Logger,
  // Injectable so the timeout path is EXECUTABLE in a test. A rejection path
  // that never runs is not a guarantee, and a 10s wait is not a test.
  lockTimeoutMs: number = ROLLBACK_LOCK_TIMEOUT_MS,
  rollbackLifecycle?: (dependencyId: string) => Promise<void>,
  createdPluginDigests?: ReadonlyMap<string, string>,
): Promise<void> {
  // Recursive creation records postorder (leaf before its dependent). Undo in
  // the reverse so a dependent lifecycle retires before the service it uses.
  for (const name of [...createdPluginTrees].reverse()) {
    if (name === parentPluginName) continue;
    const target = join(pluginsDir, name);
    try {
      assertPathInside(pluginsDir, target, 'Created dependency plugin target');
      // BOUNDED, unlike every other acquire in the codebase. The module argues
      // against timeouts because a bound long enough not to kill a legitimate
      // slow install is indistinguishable from a hang -- but that argument does
      // not transfer here, because at THIS call site failure is already the
      // designed outcome: the catch below logs and leaves the tree.
      //
      // Unbounded, this rollback would queue behind a holder whose span is the
      // dependency's whole transitive subtree (~90s of clone+install per node,
      // sequentially), while still holding the parent's content lock, the
      // parent's server quiescence, and the cross-process publication lock --
      // so every other install on the machine fails meanwhile. A bounded wait
      // converts that stall into the disposition the code already treats as
      // correct.
      let expired = false;
      let admitted = false;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const locked = withPluginContentLock(pluginsDir, name, async () => {
        if (expired) return;
        admitted = true;
        const expectedDigest = createdPluginDigests?.get(name);
        if (!expectedDigest) {
          logger.warn(
            'Preserved a dependency because this install could not bind rollback ownership to its exact content',
            { dep: name },
          );
          return;
        }
        if (computePluginContentDigest(pluginsDir, name) !== expectedDigest) {
          logger.warn(
            'Preserved a dependency because its installed content changed after this install created it',
            { dep: name },
          );
          return;
        }
        await rollbackLifecycle?.(name);
        rmSync(target, { recursive: true, force: true });
      });
      try {
        await Promise.race([
          locked,
          new Promise((_resolve, reject) => {
            timeout = setTimeout(() => {
              if (admitted) return;
              expired = true;
              reject(
                new Error(
                  `Timed out waiting for the content lock of '${name}'`,
                ),
              );
            }, lockTimeoutMs);
            timeout.unref?.();
          }),
        ]);
      } finally {
        if (timeout) clearTimeout(timeout);
      }
    } catch (error) {
      // The reason is DERIVED, not assumed: this try covers three failure
      // sources -- a path escape, a lock refusal or timeout, and `rmSync`
      // itself throwing. Reporting all three as 'the lock could not be taken'
      // told the operator to retry once another operation finished when none
      // existed, and called a partially-deleted tree 'left in place'.
      const lockRefused =
        findPluginContentLockCycleError(error) !== null ||
        errorMessage(error).startsWith(
          'Timed out waiting for the content lock',
        );
      logger.warn(
        lockRefused
          ? 'Left a dependency this install created in place: its content lock could not be taken for the rollback'
          : 'Could not remove a dependency this install created; it may be partially removed',
        { dep: name, error: errorMessage(error) },
      );
    }
  }
}

function readPluginOwnedIntegrationIds(
  projectIntegrationsDir: string,
  pluginName: string,
): string[] {
  const ids = new Set<string>();
  if (existsSync(projectIntegrationsDir)) {
    for (const entry of readdirSync(projectIntegrationsDir, {
      withFileTypes: true,
    })) {
      if (!entry.isDirectory()) continue;
      const definitionPath = join(
        projectIntegrationsDir,
        entry.name,
        'integration.json',
      );
      try {
        const definition = JSON.parse(readFileSync(definitionPath, 'utf-8'));
        if (definition.plugin === pluginName) ids.add(entry.name);
      } catch {}
    }
  }
  return [...ids];
}

function backupPluginOwnedIntegrations(
  projectIntegrationsDir: string,
  pluginName: string,
  backupRoot: string,
): void {
  const backupDir = join(backupRoot, 'integrations');
  for (const integrationId of readPluginOwnedIntegrationIds(
    projectIntegrationsDir,
    pluginName,
  )) {
    assertPluginNameSegment(integrationId);
    const source = join(projectIntegrationsDir, integrationId);
    const target = join(backupDir, integrationId);
    assertPathInside(projectIntegrationsDir, source, 'Integration source');
    assertPathInside(backupDir, target, 'Integration backup target');
    mkdirSync(backupDir, { recursive: true });
    cpSync(source, target, { recursive: true });
  }
}

function restorePluginOwnedIntegrations(
  projectIntegrationsDir: string,
  pluginName: string,
  backupRoot: string,
): void {
  for (const integrationId of readPluginOwnedIntegrationIds(
    projectIntegrationsDir,
    pluginName,
  )) {
    assertPluginNameSegment(integrationId);
    const target = join(projectIntegrationsDir, integrationId);
    assertPathInside(projectIntegrationsDir, target, 'Integration target');
    rmSync(target, { recursive: true, force: true });
  }
  const backupDir = join(backupRoot, 'integrations');
  if (!existsSync(backupDir)) return;
  for (const entry of readdirSync(backupDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    assertPluginNameSegment(entry.name);
    const source = join(backupDir, entry.name);
    const target = join(projectIntegrationsDir, entry.name);
    assertPathInside(backupDir, source, 'Integration backup source');
    assertPathInside(
      projectIntegrationsDir,
      target,
      'Integration restore target',
    );
    mkdirSync(projectIntegrationsDir, { recursive: true });
    cpSync(source, target, { recursive: true });
  }
}

export function removePluginOwnedIntegrations(
  projectIntegrationsDir: string,
  pluginName: string,
): void {
  for (const integrationId of readPluginOwnedIntegrationIds(
    projectIntegrationsDir,
    pluginName,
  )) {
    assertPluginNameSegment(integrationId);
    const target = join(projectIntegrationsDir, integrationId);
    assertPathInside(projectIntegrationsDir, target, 'Integration target');
    rmSync(target, { recursive: true, force: true });
  }
}

async function autoInstallCopiedIntegrationCommands(
  copiedIntegrations: string[],
  projectHomeDir: string,
  logger: Logger,
): Promise<void> {
  for (const integrationId of copiedIntegrations) {
    try {
      const definitionPath = join(
        projectHomeDir,
        'integrations',
        integrationId,
        'integration.json',
      );
      if (!existsSync(definitionPath)) continue;
      const definition = JSON.parse(readFileSync(definitionPath, 'utf-8'));
      if (!definition.command) continue;
      assertExecutableToken(definition.command);

      try {
        await execFile(
          process.platform === 'win32' ? 'where' : 'which',
          [definition.command],
          { windowsHide: true },
        );
        continue;
      } catch (error) {
        logger.debug('Command not found, will attempt auto-install', {
          command: definition.command,
          error,
        });
      }

      const registry = getIntegrationRegistryProvider();
      if (registry.installByCommand) {
        const installResult = await registry.installByCommand(
          definition.command,
        );
        logger.info(
          `Auto-install ${definition.command}: ${installResult.success ? 'ok' : installResult.message}`,
        );
      }
    } catch (error: unknown) {
      logger.warn(`Failed to auto-install command for ${integrationId}`, {
        error: errorMessage(error),
      });
    }
  }
}

async function installRequiredPluginTools(
  manifest: PluginManifest,
  skipSet: Set<string>,
  projectHomeDir: string,
  logger: Logger,
): Promise<InstalledPluginResult['tools']> {
  const toolsDir = join(projectHomeDir, 'integrations');
  const requiredTools = (manifest.integrations?.required || []).filter(
    (toolId: string) => !skipSet.has(`tool:${toolId}`),
  );
  const toolResults: InstalledPluginResult['tools'] = [];

  for (const toolId of requiredTools) {
    assertIntegrationId(toolId);
    const toolDir = join(toolsDir, toolId);
    assertPathInside(toolsDir, toolDir, 'Required integration target');
    if (existsSync(join(toolsDir, toolId, 'integration.json'))) {
      toolResults.push({ id: toolId, status: 'installed' });
      continue;
    }

    try {
      const registry = getIntegrationRegistryProvider();
      const installResult = await registry.install(toolId);
      const toolDef = installResult.success
        ? await registry.getToolDef(toolId)
        : null;
      if (toolDef) {
        await saveIntegrationConfig(projectHomeDir, toolId, toolDef);
      }
      toolResults.push({
        id: toolId,
        status: installResult.success ? 'installed-now' : 'missing',
      });
    } catch (error) {
      logger.debug('Failed to install required tool', { toolId, error });
      toolResults.push({ id: toolId, status: 'missing' });
    }
  }

  return toolResults;
}

async function readManifestForRemoval(
  manifestPath: string,
  fallbackName: string,
  logger: Logger,
): Promise<PluginManifest> {
  try {
    return await readPluginManifestFile(manifestPath);
  } catch (error) {
    if (!(error instanceof ContextSafetyError)) {
      throw error;
    }

    logger.warn('Unsafe plugin manifest encountered during uninstall', {
      manifestPath,
      findings: error.findings,
      source: error.source,
    });

    try {
      return JSON.parse(readFileSync(manifestPath, 'utf-8')) as PluginManifest;
    } catch (parseError) {
      logger.warn('Failed to parse unsafe plugin manifest during uninstall', {
        manifestPath,
        error: errorMessage(parseError),
      });
      return {
        agents: [],
        name: fallbackName,
        version: 'unknown',
      } satisfies PluginManifest;
    }
  }
}

export async function installPluginFromSource(
  source: string,
  skip: string[] | undefined,
  deps: PluginInstallSharedDeps,
  options?: {
    registryId?: string;
    registryKey?: string;
    /**
     * The operator's pre-install decision (archive#4288). Omitted means no
     * decision was taken — which is not the same as "none was needed", and is
     * why the default names a caller rather than being permissive: the check
     * refuses whatever such a caller could not have disclosed.
     */
    consent?: PluginInstallConsent;
  },
): Promise<InstalledPluginResult> {
  const {
    agentsDir,
    buildPlugin,
    eventBus,
    logger,
    pluginsDir,
    projectHomeDir,
  } = deps;
  const consent: PluginInstallConsent = options?.consent ?? {
    kind: 'no-operator-decision',
    caller: 'this caller',
  };
  const skipSet = new Set<string>(skip || []);
  // Populated by `installPluginDependency` as it creates trees, and read only
  // by this function's rollback. Identity of what WE created, never a listing
  // diff — see `removeDependencyTreesCreatedByThisInstall`.
  const createdPluginTrees = new Set<string>();
  const createdPluginDigests = new Map<string, string>();
  let retiredDependencyBackups: RemovedDependencyBackup[] = [];

  const result = await fetchPluginSource(source, pluginsDir, logger);
  if ('error' in result) {
    throw new Error(result.error);
  }

  const { tempDir, tempName } = result;
  let backupRoot: string | null = null;
  // Destructive rollback (delete the live plugin dir, restore from backup) is
  // gated on this flag, never on backupRoot existence: the root is created
  // before the backup finishes (archive#1835 delta review).
  let backupComplete = false;
  let serverQuiescence: PluginPublicServerQuiescence | null = null;
  let eventSubscriptionQuiescence: { release(): void } | null = null;
  let releaseInstallPublication: (() => Promise<void>) | undefined;
  try {
    const manifest = await readPluginManifestFile(join(tempDir, 'plugin.json'));
    const pluginName = manifest.name || tempName;
    assertPluginNameSegment(pluginName);
    // The identity itself, not just its shape as a path segment: Station
    // mounts its own routes at some literal first segments on `/api/plugins`,
    // and a plugin installed under one of those names cannot own the
    // namespace it is being handed. Refused here rather than at a request
    // boundary because the collision is created by the NAME, and this is the
    // moment the name becomes a directory. Kept separate from
    // `assertPluginNameSegment` on purpose — that one is called by read and
    // uninstall routes too, and refusing there would strand a plugin already
    // installed under such a name instead of letting the operator remove it.
    assertPluginIdentityAvailable(pluginName);

    // ── The consent gate (archive#4288) ──────────────────────────────────
    //
    // Everything above this line reads: the source has been staged into
    // `<plugins>/.preview-*`, and its manifest parsed. Nothing outside that
    // staging directory has been touched, and the `finally` below removes it
    // on every exit — so a refusal HERE costs nothing to undo, which is the
    // entire property. Consent used to be requested from the install
    // mutation's `onSuccess`, i.e. after the tree copy, the agent writes, the
    // integration copies and the passive grants; declining left all of it.
    //
    // It is deliberately the FIRST thing after the identity refusals and
    // before `ensureCanonicalRegistryInstallAliases`, so a refused install
    // performs no write of any kind — not even the registry-alias format
    // migration, which is unrelated to this plugin but is still a write.
    const consentBasis = derivePluginConsentBasis(tempDir, manifest);
    if (consentBasis === null) {
      throw new Error(
        `Plugin '${pluginName}' source could not be read, so it was not installed`,
      );
    }
    assertPluginInstallConsent({ pluginName, consent, basis: consentBasis });
    const consentedPermissions =
      consent.kind === 'operator-decision' ? consent.permissions : [];
    // archive#4288, review MEDIUM 1. The gate above can only check the ids the
    // STAGED manifest declares; `installPluginDependency` then recurses into
    // each dependency's own manifest, fetched after the decision was taken. So
    // the approved list travels down the recursion and is enforced at the
    // fetch — a transitive id that appeared after the preview is refused
    // before its bytes are pulled. `consent.dependencies` and not
    // `consentBasis.dependencies`: the preview's `resolvePluginDependencies`
    // resolves transitively, so the client's list is the one that covers the
    // levels below. A caller holding no decision approved nothing, which is
    // consistent — the gate above already refuses any manifest declaring
    // `dependencies` when no decision was taken.
    const approvedDependencyIds = new Set(
      consent.kind === 'operator-decision' ? consent.dependencies : [],
    );
    const dependencySourceRoot = dirname(resolve(source));
    const resolvedDependencies = (manifest.dependencies ?? []).map(
      (dependency) =>
        resolvePluginDependencySource(dependency, source, dependencySourceRoot),
    );
    const dependencyLifecycle = createDependencyLifecycle({
      consent,
      pluginsDir,
      projectHomeDir,
      logger,
      reconcileEngineConnections: deps.reconcileEngineConnections,
      settleProviderAdapterRetirements: deps.settleProviderAdapterRetirements,
    });

    await ensureCanonicalRegistryInstallAliases(projectHomeDir);
    if (manifest.workspacePanes?.length) {
      for (const pane of manifest.workspacePanes) {
        if (skipSet.has(`pane:${pane.id}`)) {
          throw new Error(
            `Workspace Pane '${pane.id}' is non-skippable; install a package whose manifest has no conflicting declaration.`,
          );
        }
      }
    }
    const pluginDir = join(pluginsDir, pluginName);
    assertPathInside(pluginsDir, pluginDir, 'Plugin install target');
    assertRegistryInstallTargetAvailable(
      projectHomeDir,
      pluginsDir,
      options?.registryId,
      options?.registryKey,
      pluginName,
    );
    const existingManifest = existsSync(join(pluginDir, 'plugin.json'))
      ? await readManifestForRemoval(
          join(pluginDir, 'plugin.json'),
          pluginName,
          logger,
        )
      : null;
    const persistedAgentOwnership = existingManifest
      ? capturePersistedAgentOwnership(agentsDir, pluginName, existingManifest)
      : new Map<string, string | undefined>();
    const hadExistingPlugin = existingManifest !== null;
    const retainedDependencyOwnership = hadExistingPlugin
      ? readPluginDependencyOwnership(projectHomeDir, pluginName)
      : [];
    if (hadExistingPlugin) {
      eventSubscriptionQuiescence =
        (await deps.quiesceEventSubscriptions?.(pluginName)) ?? null;
      try {
        serverQuiescence = await quiescePluginPublicServerModule(
          pluginsDir,
          pluginName,
        );
      } catch (error) {
        eventSubscriptionQuiescence?.release();
        eventSubscriptionQuiescence = null;
        throw error;
      }
    }
    deps.beginConfigurationMutation?.();

    const dependencyResults: InstalledPluginResult['dependencies'] = [];
    // The parent is the root of this dependency walk even though its staged
    // tree is not copied until later. Seeding it closes edges back to an
    // already-installed parent during install-over instead of letting the
    // filesystem fast path disguise that self-cycle as satisfaction.
    const installingDependencyIds = new Set([pluginName]);
    let installedLayoutSlug: string | null = null;
    // archive#4288, review HIGH 3: this is a tree-mutating path like update
    // and uninstall — it deletes `<plugins>/<name>` and copies a new tree in
    // its place — so it holds the same per-plugin content lock they do. That
    // is what serializes it against a concurrent consent decision's
    // revalidate → commit span, and what forgets the memoized digest when it
    // releases. The lock is taken here rather than at the top of the function
    // because the plugin's NAME is not known until its manifest is read.
    return await withPluginContentLock(pluginsDir, pluginName, async () => {
      try {
        const installBackupRoot = createStationTempDirSync('plugin-install');
        backupRoot = installBackupRoot;
        // Plugin directory + integrations are backed up BEFORE the grants
        // snapshot: backupPluginDurableState throws typed on a corrupt grants
        // store, and the destructive delete-and-restore rollback below is only
        // entered once the backup is COMPLETE (archive#1835 delta review). Gating on
        // backupRoot alone destroyed the installed plugin: the catch deleted
        // the live directory and then restored from a backup that was never
        // taken.
        if (hadExistingPlugin) {
          const backupDir = join(installBackupRoot, 'plugin');
          cpSync(pluginDir, backupDir, PLUGIN_TREE_COPY);
          backupPluginOwnedIntegrations(
            join(projectHomeDir, 'integrations'),
            pluginName,
            installBackupRoot,
          );
        }
        backupPluginDurableState(projectHomeDir, installBackupRoot, pluginName);
        backupComplete = true;

        // The parent and every dependency publish under one cross-process
        // transaction. A provider collision cannot race between preflight and
        // dependency activation, and rollback retains the same outer fence.
        releaseInstallPublication = await acquireFileMutationLockAsync(
          join(projectHomeDir, 'plugin-install-publication.mutation'),
        );

        for (const [index, dependency] of (
          manifest.dependencies ?? []
        ).entries()) {
          const resolvedDependency = resolvedDependencies[index]!;
          const dependencyResult = await installPluginDependency(
            resolvedDependency,
            pluginsDir,
            () => ({
              async resolveSource(id: string) {
                return (await resolveSinglePluginRegistryProvider(id)).source;
              },
              async install(
                id: string,
                installOptions?: { expectedInstalledPluginName?: string },
              ) {
                const entry = await resolveSinglePluginRegistryProvider(id);
                return entry.provider.install(id, installOptions);
              },
            }),
            buildPlugin,
            logger,
            installingDependencyIds,
            createdPluginTrees,
            approvedDependencyIds,
            dependencyLifecycle,
            dependencySourceRoot,
            createdPluginDigests,
          );
          dependencyResults.push({
            id: dependency.id,
            status: dependencyResult.success ? 'installed' : 'failed',
            error: dependencyResult.error,
          });
          if (!dependencyResult.success) {
            // `cause`, not just the message: a refused lock acquisition is a
            // typed error carrying WHICH plugins are waiting on each other,
            // and flattening it here is what left the routes with a sentence
            // they could only answer 500 to (archive#4309 follow-up).
            throw new Error(
              dependencyResult.error ||
                `Plugin dependency '${dependency.id}' failed to install`,
              { cause: dependencyResult.cause },
            );
          }
        }

        // One cross-process publication transaction owns the fresh catalog
        // preflight through durable plugin copy. Without it two installs can
        // both observe an unused descriptor id and publish a collision.
        if (manifest.workspacePanes?.length) {
          const [conflict] = detectWorkspacePaneCatalogConflicts(
            manifest,
            projectHomeDir,
          );
          if (conflict) {
            throw new Error(
              `Workspace Pane '${conflict.id}' conflicts with existing declaration '${conflict.existingSource}' and cannot be installed.`,
            );
          }
        }

        if (manifest.layout && !skipSet.has(`layout:${manifest.layout.slug}`)) {
          const layoutSource = join(tempDir, manifest.layout.source);
          assertExistingPathInside(
            tempDir,
            layoutSource,
            'Plugin layout source',
          );
          if (existsSync(layoutSource)) {
            installedLayoutSlug = manifest.layout.slug;
          }
        }

        scanPluginPromptGeneration(tempDir, pluginName);
        await buildPlugin(tempDir, pluginName);
        assertPluginBundleAssetsContained(tempDir);

        if (existsSync(pluginDir) && pluginDir !== tempDir) {
          rmSync(pluginDir, { recursive: true, force: true });
        }
        if (tempDir !== pluginDir) {
          cpSync(tempDir, pluginDir, { recursive: true });
        }
        // The tree just changed. The lock's release forgets the memoized
        // digest, but reads happen INSIDE this span (`hasGrant` below, and
        // `rebindGrantsAfterContentChange`), so it is dropped here too —
        // O(1), and it is what stops those reads answering from a digest
        // taken before the install (archive#4288).
        forgetPluginContentDigest(pluginsDir, pluginName);

        await synchronizePluginAgentDefinitions({
          agentsDir,
          pluginDir,
          pluginName,
          projectHomeDir,
          manifest,
          previousManifest: existingManifest,
          persistedOwnership: persistedAgentOwnership,
          include: (slug) => !skipSet.has(`agent:${slug}`),
          logger,
        });

        removePluginOwnedIntegrations(
          join(projectHomeDir, 'integrations'),
          pluginName,
        );
        const copiedIntegrations = copyPluginIntegrations(
          pluginDir,
          join(projectHomeDir, 'integrations'),
        );
        for (const integrationId of copiedIntegrations) {
          logger.info(`Copied tool config: ${integrationId}`);
        }
        await autoInstallCopiedIntegrationCommands(
          copiedIntegrations,
          projectHomeDir,
          logger,
        );

        // archive#4288, review HIGH 2. Installing OVER an existing plugin is
        // a first-class path — it backs up, it has `hadExistingPlugin`, and
        // `assertRegistryInstallTargetAvailable` deliberately permits
        // reinstalling over the same registry item, which is how a registry
        // plugin gets a new version. It replaced the tree and then went
        // straight to `processInstallPermissions`, so the consent given to
        // the code it had just deleted carried over to the code that replaced
        // it, and `hasGrant(..., 'providers.register')` below loaded the new
        // code's providers under the old code's approval.
        //
        // So the update route's re-bind runs here too, on the same terms and
        // in the same position: after the tree is final, before the first
        // read of a grant. Permissions the new manifest newly derives are not
        // inherited either — `rebindGrantsAfterContentChange` re-derives from
        // `requiredPermissionsForManifest`, so a version that contributes a
        // `serverModule` where the old one did not starts without
        // `plugin.server`.
        const rebound = hadExistingPlugin
          ? await rebindGrantsAfterContentChange(
              projectHomeDir,
              pluginName,
              manifest,
            )
          : { retained: [], withdrawn: [] };
        if (rebound.withdrawn.length > 0) {
          logger.info(
            'Plugin install over an existing plugin withdrew consent bound to the replaced content',
            {
              plugin: pluginName,
              withdrawn: rebound.withdrawn,
              retained: rebound.retained,
            },
          );
          eventBus?.emit('plugins:grants-changed', { name: pluginName });
        }
        const {
          autoGranted,
          consentGranted,
          pendingConsent,
          withdrawn: autoGrantWithdrew,
        } = await processInstallPermissions(
          projectHomeDir,
          pluginName,
          requiredPermissionsForManifest(manifest),
          // The decision the gate above already refused to proceed without,
          // recorded against the tree that just landed rather than through a
          // second round trip after the mutation (archive#4288).
          { consented: consentedPermissions },
        );
        // Derived, not the `[]` a first install used to assert (archive#4288,
        // delta review). A first install CAN withdraw: a leftover grants
        // entry for this name — left by a hand-deleted plugin directory, or
        // by an uninstall that failed after the tree went — is `changed`
        // against the tree that just landed, so the auto-grant drops
        // everything it held. `rebindGrantsAfterContentChange` leaves the
        // record bound when it runs, so the two sets only ever overlap on a
        // path where both did work.
        const withdrewOnInstall = [
          ...new Set([...rebound.withdrawn, ...autoGrantWithdrew]),
        ];
        if (autoGrantWithdrew.length > 0) {
          logger.info(
            'Plugin install withdrew consent left over from an earlier installation under this name',
            { plugin: pluginName, withdrawn: autoGrantWithdrew },
          );
          eventBus?.emit('plugins:grants-changed', { name: pluginName });
        }
        const droppedDependencyOwnership = retainedDependencyOwnership.filter(
          (entry) => !approvedDependencyIds.has(entry.id),
        );
        if (droppedDependencyOwnership.length > 0) {
          // Retire old graph members before replacing the ownership record.
          // If retirement fails, the helper restores every completed removal
          // and the old record remains authoritative for a retry. If a later
          // publication step fails, the outer catch restores these backups
          // alongside the old parent tree and grant/ownership snapshot.
          retiredDependencyBackups = await removeOwnedDependencyLifecycles({
            dependencies: droppedDependencyOwnership,
            removedPluginName: pluginName,
            pluginsDir,
            projectHomeDir,
            backupRoot: installBackupRoot,
            logger,
            reconcileEngineConnections: deps.reconcileEngineConnections,
            settleProviderAdapterRetirements:
              deps.settleProviderAdapterRetirements,
          });
        }
        await recordPluginDependencyOwnership(
          projectHomeDir,
          pluginName,
          deriveDependencyOwnership(
            pluginsDir,
            createdPluginTrees,
            retainedDependencyOwnership,
            approvedDependencyIds,
          ),
        );
        const activeProviders = hasGrant(
          projectHomeDir,
          pluginName,
          'providers.register',
        )
          ? (manifest.providers ?? []).filter(
              (provider) => !skipSet.has(`provider:${provider.type}`),
            )
          : [];
        await loadPluginProviders(
          pluginsDir,
          pluginName,
          { ...manifest, providers: activeProviders },
          logger,
          { strict: true },
        );
        await deps.reconcileEngineConnections?.(pluginName);

        const toolResults = await installRequiredPluginTools(
          manifest,
          skipSet,
          projectHomeDir,
          logger,
        );
        rememberRegistryInstall(
          projectHomeDir,
          options?.registryId,
          options?.registryKey,
          pluginName,
        );
        await deps.settleProviderAdapterRetirements?.();

        eventBus?.emit('plugins:installed', {
          name: pluginName,
          agents: manifest.agents?.map((agent) => agent.slug) || [],
        });
        pluginInstalls.add(1, { plugin: pluginName });

        return {
          success: true,
          plugin: {
            name: pluginName,
            displayName: manifest.displayName,
            version: manifest.version,
            hasBundle: existsSync(join(pluginDir, 'dist', 'bundle.js')),
            agents: (manifest.agents || []).map((agent) => ({
              slug: agent.slug,
            })),
          },
          layout: installedLayoutSlug
            ? { slug: installedLayoutSlug }
            : undefined,
          tools: toolResults,
          dependencies: dependencyResults,
          permissions: {
            autoGranted,
            consentGranted,
            pendingConsent,
            withdrawn: withdrewOnInstall,
          },
        };
      } catch (error) {
        await removeDependencyTreesCreatedByThisInstall(
          pluginsDir,
          createdPluginTrees,
          pluginName,
          logger,
          ROLLBACK_LOCK_TIMEOUT_MS,
          (dependencyId) => dependencyLifecycle.rollback(dependencyId),
          createdPluginDigests,
        );
        if (hadExistingPlugin && !backupComplete) {
          // The failure happened while (or before) taking the backup: nothing
          // has touched the existing installation yet, and there is no complete
          // backup to restore from. Deleting the live plugin directory here
          // would be unrecoverable — fail the install and leave it alone
          // (archive#1835 delta review).
          throw error;
        }
        if (hadExistingPlugin && backupRoot) {
          try {
            rmSync(pluginDir, { recursive: true, force: true });
            cpSync(join(backupRoot, 'plugin'), pluginDir, PLUGIN_TREE_COPY);
            // archive#4288, delta review MEDIUM 1. The memo currently holds
            // the digest of the tree this rollback just DELETED —
            // `rebindGrantsAfterContentChange` and `processInstallPermissions`
            // both refreshed it to the new tree's value before the failure.
            // `restorePluginDurableState` below puts the old grant record back
            // with the old digest, so `hasGrant(..., 'providers.register')`
            // would compare a restored v1 record against a memoized v2 digest,
            // derive `changed`, and load the restored plugin with NO providers
            // — a failed install silently unregistering a working plugin's
            // providers until the next restart. The lock's release forgets it
            // too, but that is after every read in here.
            forgetPluginContentDigest(pluginsDir, pluginName);
            restorePluginOwnedIntegrations(
              join(projectHomeDir, 'integrations'),
              pluginName,
              backupRoot,
            );
            await restorePluginDurableState(projectHomeDir, backupRoot);
            await restoreRemovedDependencyLifecycles({
              backups: retiredDependencyBackups,
              pluginsDir,
              projectHomeDir,
              logger,
              reconcileEngineConnections: deps.reconcileEngineConnections,
              settleProviderAdapterRetirements:
                deps.settleProviderAdapterRetirements,
            });
            await synchronizePluginAgentDefinitions({
              agentsDir,
              pluginDir,
              pluginName,
              projectHomeDir,
              manifest: existingManifest,
              previousManifest: manifest,
              logger,
              persistedOwnership: persistedAgentOwnership,
            });
            await loadPluginProviders(
              pluginsDir,
              pluginName,
              hasGrant(projectHomeDir, pluginName, 'providers.register')
                ? existingManifest
                : { ...existingManifest, providers: [] },
              logger,
              { strict: true },
            );
            await deps.reconcileEngineConnections?.(pluginName);
            await deps.settleProviderAdapterRetirements?.();
          } catch (rollbackError) {
            throw new AggregateError(
              [error, rollbackError],
              'Plugin install and rollback both failed.',
            );
          }
        } else {
          // Rollback failures must not REPLACE the original install failure —
          // aggregate both, matching the existing-plugin and uninstall branches
          // (archive#1835 delta review).
          try {
            rmSync(pluginDir, { recursive: true, force: true });
            removePluginOwnedIntegrations(
              join(projectHomeDir, 'integrations'),
              pluginName,
            );
            if (backupRoot && backupComplete) {
              await restorePluginDurableState(projectHomeDir, backupRoot);
            }
            const { replacePluginProvidersForSource } = await import(
              '../../providers/registries/registry.js'
            );
            await replacePluginProvidersForSource(pluginName, []);
            await deps.reconcileEngineConnections?.(pluginName);
            await deps.settleProviderAdapterRetirements?.();
            await synchronizePluginAgentDefinitions({
              agentsDir,
              pluginDir,
              pluginName,
              projectHomeDir,
              manifest: { ...manifest, agents: [] },
              previousManifest: manifest,
              logger,
            });
          } catch (rollbackError) {
            throw new AggregateError(
              [error, rollbackError],
              'Plugin install and rollback both failed.',
            );
          }
        }
        throw error;
      }
    });
  } finally {
    await releaseInstallPublication?.();
    serverQuiescence?.release();
    eventSubscriptionQuiescence?.release();
    if (backupRoot) {
      rmSync(backupRoot, { recursive: true, force: true });
    }
    if (
      tempDir.startsWith(join(pluginsDir, '.preview-')) &&
      existsSync(tempDir)
    ) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
}

export async function uninstallInstalledPlugin(
  name: string,
  deps: PluginInstallSharedDeps,
): Promise<{ success: true }> {
  const { agentsDir, eventBus, logger, pluginsDir, projectHomeDir } = deps;
  await ensureCanonicalRegistryInstallAliases(projectHomeDir);
  const installedPluginName =
    resolveInstalledPluginName(projectHomeDir, pluginsDir, name) || name;
  const pluginDir = join(pluginsDir, installedPluginName);
  // The selected installed directory is the uninstall identity. A mutable
  // manifest may describe what needs cleanup, but it cannot rename the
  // principal whose grants, providers, integrations, or host record are
  // removed.
  const pluginName = installedPluginName;

  if (!existsSync(pluginDir)) {
    throw new Error('Plugin not found');
  }

  let backupRoot: string | null = null;
  let releaseInstallPublication: (() => Promise<void>) | undefined;
  let removedDependencyBackups: RemovedDependencyBackup[] = [];
  const manifest = await readManifestForRemoval(
    join(pluginDir, 'plugin.json'),
    installedPluginName,
    logger,
  );
  // Destructive dependency cleanup reads only Station's host-owned install
  // authority. The parent manifest and every file in its mutable tree are
  // untrusted uninstall inputs and cannot mint ownership over another plugin.
  const ownedDependencies = readPluginDependencyOwnership(
    projectHomeDir,
    installedPluginName,
  );
  const eventSubscriptionQuiescence =
    (await deps.quiesceEventSubscriptions?.(pluginName)) ?? null;
  let serverQuiescence: PluginPublicServerQuiescence;
  try {
    serverQuiescence = await quiescePluginPublicServerModule(
      pluginsDir,
      pluginName,
    );
  } catch (error) {
    eventSubscriptionQuiescence?.release();
    throw error;
  }
  deps.beginConfigurationMutation?.();
  // Captured BEFORE any agent directory deletion (archive#1004 review
  // HIGH-1 residual b) — if a later step in this try block throws, the
  // catch block's rollback `synchronizePluginAgentDefinitions` call can no
  // longer recover human-assigned ownership by reading the (by-then
  // already-deleted) directories itself; it needs this map instead.
  let persistedAgentOwnership: ReadonlyMap<string, string | undefined> =
    new Map();
  // Destructive rollback requires this flag, never backupRoot existence: a
  // PARTIAL backup (copy failed midway, or the grants snapshot threw) must
  // fail the uninstall without deleting the live plugin and "restoring" an
  // incomplete copy (archive#1835 delta-2 review; same invariant as install).
  let backupComplete = false;
  try {
    backupRoot = createStationTempDirSync('plugin-uninstall');
    cpSync(pluginDir, join(backupRoot, 'plugin'), PLUGIN_TREE_COPY);
    backupPluginOwnedIntegrations(
      join(projectHomeDir, 'integrations'),
      pluginName,
      backupRoot,
    );
    // Last: throws typed on a corrupt grants store, before which every other
    // backup element is already complete.
    backupPluginDurableState(projectHomeDir, backupRoot, pluginName);
    backupComplete = true;
    releaseInstallPublication = await acquireFileMutationLockAsync(
      join(projectHomeDir, 'plugin-install-publication.mutation'),
    );

    if (manifest.agents) {
      persistedAgentOwnership = capturePersistedAgentOwnership(
        agentsDir,
        pluginName,
        manifest,
      );
      await removePluginAgentDefinitions(
        agentsDir,
        projectHomeDir,
        pluginName,
        manifest,
      );
    }

    await revokeAllGrants(projectHomeDir, pluginName);
    removePluginOwnedIntegrations(
      join(projectHomeDir, 'integrations'),
      pluginName,
    );
    rmSync(pluginDir, { recursive: true, force: true });
    const { replacePluginProvidersForSource } = await import(
      '../../providers/registries/registry.js'
    );
    await replacePluginProvidersForSource(pluginName, []);
    await deps.settleProviderAdapterRetirements?.();
    await deps.removeEngineConnections?.(pluginName);
    removedDependencyBackups = await removeOwnedDependencyLifecycles({
      dependencies: ownedDependencies,
      removedPluginName: pluginName,
      pluginsDir,
      projectHomeDir,
      backupRoot,
      logger,
      reconcileEngineConnections: deps.reconcileEngineConnections,
      settleProviderAdapterRetirements: deps.settleProviderAdapterRetirements,
    });
    forgetRegistryInstallsForPlugin(
      projectHomeDir,
      installedPluginName,
      name === installedPluginName ? undefined : name,
    );
    await removePluginHostRecord(projectHomeDir, pluginName);
    eventBus?.emit('plugins:removed', { name: pluginName });
    pluginUninstalls.add(1, { plugin: pluginName });
    logger.info('Plugin removed', { plugin: pluginName });
    return { success: true };
  } catch (error) {
    // Only a COMPLETE backup may drive the delete-and-restore rollback; an
    // incomplete one means nothing destructive has run inside the try yet —
    // fail the uninstall and leave the live plugin and its integrations
    // untouched (archive#1835 delta-2 review).
    if (backupRoot && backupComplete) {
      try {
        await restoreRemovedDependencyLifecycles({
          backups: removedDependencyBackups,
          pluginsDir,
          projectHomeDir,
          logger,
          reconcileEngineConnections: deps.reconcileEngineConnections,
          settleProviderAdapterRetirements:
            deps.settleProviderAdapterRetirements,
        });
        rmSync(pluginDir, { recursive: true, force: true });
        cpSync(join(backupRoot, 'plugin'), pluginDir, PLUGIN_TREE_COPY);
        // Defensive, for the same reason as the install rollback above
        // (archive#4288, delta review MEDIUM 1). Nothing in the uninstall
        // path refreshes the memo today, so this rollback's `hasGrant` is
        // correct by luck rather than by construction; a restored tree is a
        // tree whose memoized digest must not be trusted, whoever wrote it.
        forgetPluginContentDigest(pluginsDir, pluginName);
        restorePluginOwnedIntegrations(
          join(projectHomeDir, 'integrations'),
          pluginName,
          backupRoot,
        );
        await restorePluginDurableState(projectHomeDir, backupRoot);
        await synchronizePluginAgentDefinitions({
          agentsDir,
          pluginDir,
          pluginName,
          projectHomeDir,
          manifest,
          previousManifest: { ...manifest, agents: [] },
          logger,
          persistedOwnership: persistedAgentOwnership,
        });
        await loadPluginProviders(
          pluginsDir,
          pluginName,
          hasGrant(projectHomeDir, pluginName, 'providers.register')
            ? manifest
            : { ...manifest, providers: [] },
          logger,
          {
            strict: true,
          },
        );
        await deps.reconcileEngineConnections?.(pluginName);
        await deps.settleProviderAdapterRetirements?.();
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          'Plugin uninstall and rollback both failed.',
        );
      } finally {
        rmSync(backupRoot, { recursive: true, force: true });
      }
    }
    throw error;
  } finally {
    await releaseInstallPublication?.();
    serverQuiescence.release();
    eventSubscriptionQuiescence?.release();
    if (backupRoot) {
      rmSync(backupRoot, { recursive: true, force: true });
    }
  }
}

export async function resolvePluginRegistrySource(
  id: string,
): Promise<string | null> {
  try {
    return (await resolveSinglePluginRegistryProvider(id)).source;
  } catch (error) {
    if (errorMessage(error).startsWith('No plugin registry provider')) {
      return null;
    }
    throw error;
  }
}

export async function resolvePluginRegistryInstall(
  id: string,
): Promise<{ source: string; registryKey: string } | null> {
  try {
    const match = await resolveSinglePluginRegistryProvider(id);
    if (!match.source) {
      return null;
    }
    if (!match.provider.registryKey) {
      throw new Error(
        `Plugin registry provider for '${id}' does not expose a stable source identity`,
      );
    }
    return {
      source: match.source,
      registryKey: match.provider.registryKey,
    };
  } catch (error) {
    if (errorMessage(error).startsWith('No plugin registry provider')) {
      return null;
    }
    throw error;
  }
}

export async function readRegistryPluginAvailability(projectHomeDir: string) {
  await ensureCanonicalRegistryInstallAliases(projectHomeDir);
  const entries = (
    await import('../../providers/registries/registry.js')
  ).getPluginRegistryProviders();

  const groups = await Promise.all(
    entries.map(async (entry) => {
      const [available, installed] = await Promise.all([
        entry.provider.listAvailable(),
        entry.provider.listInstalled(),
      ]);
      const installedIds = new Set(installed.map((item) => String(item.id)));
      return available.map((item) => ({
        ...item,
        source: entry.source,
        installed: installedIds.has(String(item.id)),
      }));
    }),
  );

  return groups.flat();
}

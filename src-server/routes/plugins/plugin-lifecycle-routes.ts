import { cpSync, existsSync, lstatSync, realpathSync, rmSync } from 'node:fs';
import { basename, isAbsolute, join, relative } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type {
  PluginInstallationRevision,
  PluginManifest,
} from '@kontourai/station-contracts/plugin';
import {
  SERVER_EVENTS,
  type ServerEventName,
} from '@kontourai/station-contracts/runtime-events';
import { copyPluginIntegrations } from '@kontourai/station-shared/parsers';
import { createStationTempDirSync } from '@kontourai/station-shared/temp-dir';
import { Hono } from 'hono';
import {
  capturePluginProviderGeneration,
  preparePluginProviderGeneration,
  publishPluginProviderGeneration,
} from '../../providers/plugin-provider-loader.js';
import type { PluginProviderReadView } from '../../providers/registries/registry.js';
import { getPluginRegistryProviders } from '../../providers/registries/registry.js';
import { readRegistryInstallAliases } from '../../providers/registries/registry-install-aliases.js';
import type { AgentConfigurationMutationRunner } from '../../runtime/types.js';
import { isContextSafetyError } from '../../services/orchestration/context-safety.js';
import type { PackageMcpAdmissionJournal } from '../../services/plugins/package-mcp-admission.js';
import { scanPluginPromptGeneration } from '../../services/plugins/plugin-command-skill-source.js';
import {
  forgetPluginContentDigest,
  PLUGIN_TREE_COPY,
  withPluginContentLock,
} from '../../services/plugins/plugin-content-integrity.js';
import { resolveInstalledPluginRoot } from '../../services/plugins/plugin-incarnation.js';
import {
  captureLocalPluginInstallation,
  reconcileLocalPluginInstallations,
} from '../../services/plugins/plugin-installation-local.js';
import type { PluginInstallationHost } from '../../services/plugins/plugin-installation-service.js';
import { PluginInstallationPending } from '../../services/plugins/plugin-installation-service.js';
import {
  readPluginManifestFileSync,
  readPluginManifestFileWithFormat,
} from '../../services/plugins/plugin-manifest-loader.js';
import {
  createPluginGrantMutationScope,
  hasGrant,
  observePluginGrantRevisions,
  rebindGrantsAfterContentChange,
} from '../../services/plugins/plugin-permissions.js';
import { isRegistryAcquisitionRefusal } from '../../services/plugins/registry-acquisition.js';
import type { RegistryTrustPolicyAuthority } from '../../services/plugins/registry-trust-policy.js';
import { pluginUpdates } from '../../telemetry/metrics.js';
import { execGit } from '../../utils/git-exec.js';
import type { Logger } from '../../utils/logger.js';
import { assertPathInside } from '../../utils/path-containment.js';
import { errorMessage, param } from '../schemas/schemas.js';
import {
  captureConfigurationMutation,
  configurationActivationPayload,
  configurationMutationStatus,
} from '../system/configuration-activation.js';
import { capturePluginConfigurationMutation } from './plugin-configuration-activation.js';
import {
  assertPluginNameSegment,
  capturePersistedAgentOwnership,
  ensureCanonicalRegistryInstallAliases,
  installPluginFromSource,
  removePluginOwnedIntegrations,
  resolvePluginRegistryInstall,
  synchronizePluginAgentDefinitions,
  uninstallInstalledPlugin,
} from './plugin-install-shared.js';
import { loadPluginProviders } from './plugin-loader.js';
import {
  type PluginPublicServerQuiescence,
  quiesceAllPluginPublicServerModules,
  quiescePluginPublicServerModule,
} from './plugin-public-server.js';

interface PluginLifecycleRouteDeps {
  installationHost?: PluginInstallationHost;
  registryTrustPolicyAuthority?: RegistryTrustPolicyAuthority;
  packageMcpJournal?: PackageMcpAdmissionJournal;
  agentsDir: string;
  eventBus?: {
    emit: (event: ServerEventName, data?: Record<string, unknown>) => void;
  };
  logger: Logger;
  pluginsDir: string;
  projectHomeDir: string;
  buildPlugin: (
    pluginDir: string,
    name: string,
    manifest?: PluginManifest,
  ) => Promise<void>;
  applyConfigurationMutation?: AgentConfigurationMutationRunner;
  refreshKitObservability?: () => void;
  settleProviderAdapterRetirements?: () => Promise<void>;
  reconcileEngineConnections?: (
    plugin: string,
    view?: PluginProviderReadView,
  ) => Promise<void>;
  removeEngineConnections?: (plugin: string) => Promise<void>;
  quiesceEventSubscriptions?: (
    pluginName?: string,
  ) => Promise<{ release(): void }>;
}

class PluginUpdateRejectedError extends Error {}

type PluginRegistryProviderEntry = ReturnType<
  typeof getPluginRegistryProviders
>[number];

function assertExistingPluginRootInside(
  pluginsDir: string,
  pluginDir: string,
): void {
  if (!existsSync(pluginDir)) {
    assertPathInside(pluginsDir, pluginDir, 'Plugin update target');
    return;
  }
  if (lstatSync(pluginDir).isSymbolicLink()) {
    try {
      if (
        resolveInstalledPluginRoot(pluginsDir, basename(pluginDir))?.kind !==
        'incarnation'
      )
        throw new Error('unsupported pointer');
    } catch {
      throw new Error(
        'Plugin update target cannot be an unsupported symbolic link',
      );
    }
  }
  const pluginsRoot = realpathSync(pluginsDir);
  const pluginRoot = realpathSync(pluginDir);
  const targetRelativePath = relative(pluginsRoot, pluginRoot);
  if (
    targetRelativePath === '' ||
    targetRelativePath.startsWith('..') ||
    isAbsolute(targetRelativePath)
  ) {
    throw new Error('Plugin update target escapes plugin root');
  }
}

async function listPluginRegistryUpdates() {
  const updates: Array<{
    name: string;
    currentVersion: string;
    latestVersion: string;
    source: string;
  }> = [];

  for (const entry of getPluginRegistryProviders()) {
    const [available, installed] = await Promise.all([
      entry.provider.listAvailable(),
      entry.provider.listInstalled(),
    ]);
    for (const installedPlugin of installed) {
      const installedName =
        installedPlugin.installedPluginName ?? installedPlugin.id;
      const availablePlugin = available.find(
        (plugin) => plugin.id === installedPlugin.id,
      );
      if (
        availablePlugin?.version &&
        availablePlugin.version !== installedPlugin.version
      ) {
        updates.push({
          name: installedName,
          currentVersion: installedPlugin.version || 'unknown',
          latestVersion: availablePlugin.version,
          source: 'registry',
        });
      }
    }
  }

  return updates;
}

async function findOwningPluginRegistryProvider(
  name: string,
  projectHomeDir: string,
): Promise<
  | {
      success: true;
      entry: PluginRegistryProviderEntry;
      installedName: string;
      registryId: string;
    }
  | { success: false; message: string }
> {
  await ensureCanonicalRegistryInstallAliases(projectHomeDir);
  const matches: Array<{
    entry: PluginRegistryProviderEntry;
    installedName: string;
    registryId: string;
  }> = [];

  for (const entry of getPluginRegistryProviders()) {
    const installed = await entry.provider.listInstalled();
    const providerMatches = installed
      .map((plugin) => {
        return {
          item: plugin,
          installedName: plugin.installedPluginName ?? plugin.id,
        };
      })
      .filter(
        ({ item, installedName }) => item.id === name || installedName === name,
      );

    for (const installedPlugin of providerMatches) {
      matches.push({
        entry,
        installedName: installedPlugin.installedName,
        registryId: installedPlugin.item.id,
      });
    }
  }

  const matchedTargets = new Set(matches.map((match) => match.installedName));
  if (matchedTargets.size === 1) {
    const [matchedTarget] = matchedTargets;
    for (const entry of getPluginRegistryProviders()) {
      const installed = await entry.provider.listInstalled();
      for (const plugin of installed) {
        const installedName = plugin.installedPluginName ?? plugin.id;
        if (installedName !== matchedTarget) continue;
        if (
          matches.some(
            (match) =>
              match.entry === entry &&
              match.installedName === installedName &&
              match.registryId === plugin.id,
          )
        ) {
          continue;
        }
        matches.push({
          entry,
          installedName,
          registryId: plugin.id,
        });
      }
    }
  }

  if (matches.length === 1) {
    return { success: true, ...matches[0] };
  }

  if (matches.length > 1) {
    return {
      success: false,
      message: `Plugin '${name}' is installed by multiple plugin registry providers`,
    };
  }

  return {
    success: false,
    message: `No plugin registry provider owns installed plugin '${name}'`,
  };
}

function resolvePluginRemovalTarget(
  name: string,
  projectHomeDir: string,
  directPluginExists: boolean,
):
  | { success: true; installedName: string }
  | {
      success: false;
      reason:
        | 'alias-collision'
        | 'conflicting-targets'
        | 'not-found'
        | 'ownership-unavailable';
      installedName?: string;
    } {
  let aliases: ReturnType<typeof readRegistryInstallAliases>;
  try {
    // Removal needs the host-owned install record, not a fresh network answer.
    // A direct local plugin must remain removable while an unrelated registry
    // is offline, and the durable aliases are already the collision authority
    // written by registry installation.
    aliases = readRegistryInstallAliases(projectHomeDir);
  } catch {
    return {
      success: false,
      reason: 'ownership-unavailable',
    };
  }

  const matchingTargets = new Set(
    Object.entries(aliases)
      .filter(
        ([registryId, alias]) =>
          registryId === name || alias.pluginName === name,
      )
      .map(([, alias]) => alias.pluginName),
  );
  if (matchingTargets.size > 1) {
    return {
      success: false,
      reason: 'conflicting-targets',
    };
  }
  const [aliasTarget] = matchingTargets;
  if (directPluginExists && aliasTarget && aliasTarget !== name) {
    return {
      success: false,
      reason: 'alias-collision',
      installedName: aliasTarget,
    };
  }
  if (aliasTarget) return { success: true, installedName: aliasTarget };
  if (directPluginExists) return { success: true, installedName: name };
  return { success: false, reason: 'not-found' };
}

async function updatePluginFromRegistry(name: string, projectHomeDir: string) {
  const owner = await findOwningPluginRegistryProvider(name, projectHomeDir);
  if (!owner.success) {
    return owner;
  }

  if (
    !owner.entry.provider.update &&
    owner.installedName !== owner.registryId
  ) {
    return {
      success: false,
      message: `Plugin registry provider '${owner.entry.source}' cannot update aliased plugin '${owner.installedName}' without an update operation`,
    };
  }
  const operation = owner.entry.provider.update ?? owner.entry.provider.install;
  return operation.call(owner.entry.provider, owner.registryId);
}

export function registerPluginLifecycleRoutes(
  app: Hono,
  deps: PluginLifecycleRouteDeps,
): void {
  const {
    agentsDir,
    applyConfigurationMutation,
    buildPlugin,
    eventBus,
    logger,
    pluginsDir,
    projectHomeDir,
    quiesceEventSubscriptions,
    refreshKitObservability,
    removeEngineConnections,
    settleProviderAdapterRetirements,
  } = deps;
  // Lifecycle operations must also address pending installations. The journal
  // selects retained bytes; a compatibility alias is never their authority.
  const resolveLifecycleRoot = (name: string) =>
    deps.packageMcpJournal
      ? (captureLocalPluginInstallation(
          pluginsDir,
          deps.packageMcpJournal,
          name,
        )?.root ?? null)
      : resolveInstalledPluginRoot(pluginsDir, name);

  app.get('/check-updates', async (c) => {
    const updates: Array<{
      name: string;
      currentVersion: string;
      latestVersion: string;
      source: string;
    }> = [];

    try {
      if (existsSync(pluginsDir)) {
        const { readdirSync } = await import('node:fs');
        const entries = readdirSync(pluginsDir, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          const dir = join(pluginsDir, entry.name);
          const gitDir = join(dir, '.git');
          const manifestPath = join(dir, 'plugin.json');
          if (!existsSync(gitDir) || !existsSync(manifestPath)) continue;

          try {
            await execGit(['fetch', '--quiet'], {
              cwd: dir,
              timeout: 10000,
            });
            const { stdout: behind } = await execGit(
              ['rev-list', '--count', 'HEAD..@{u}'],
              { cwd: dir, encoding: 'utf-8' },
            );
            if (parseInt(behind.trim(), 10) > 0) {
              const manifest = readPluginManifestFileSync(manifestPath);
              const commitsBehind = behind.trim();
              updates.push({
                name: entry.name,
                currentVersion: manifest.version || 'unknown',
                latestVersion: `${commitsBehind} commit${commitsBehind === '1' ? '' : 's'} behind`,
                source: 'git',
              });
            }
          } catch (error) {
            logger.debug('Failed to check git updates for plugin', {
              plugin: entry.name,
              error,
            });
          }
        }
      }

      try {
        const registryUpdates = await listPluginRegistryUpdates();
        for (const update of registryUpdates) {
          if (updates.some((existing) => existing.name === update.name)) {
            continue;
          }
          updates.push(update);
        }
      } catch (error) {
        logger.debug('Failed to check registry for plugin updates', { error });
      }

      return c.json({ updates });
    } catch (error: unknown) {
      logger.error('Failed to check for updates', {
        error: errorMessage(error),
      });
      return c.json({ updates: [] });
    }
  });

  const captureUpdateTarget = (pluginName: string) => {
    const captured = deps.packageMcpJournal
      ? captureLocalPluginInstallation(
          pluginsDir,
          deps.packageMcpJournal,
          pluginName,
        )
      : null;
    const root = deps.packageMcpJournal
      ? (captured?.root ?? null)
      : resolveInstalledPluginRoot(pluginsDir, pluginName);
    if (!root) return null;
    const installation = captured?.installation ?? null;
    return {
      root,
      installation,
      isCurrent: () => {
        try {
          if (deps.packageMcpJournal) {
            const current = captureLocalPluginInstallation(
              pluginsDir,
              deps.packageMcpJournal,
              pluginName,
            );
            return (
              !!current &&
              isDeepStrictEqual(current.installation, installation) &&
              current.root.packageRoot === root.packageRoot
            );
          }
          const current = resolveInstalledPluginRoot(pluginsDir, pluginName);
          return (
            current?.kind === root.kind &&
            current.packageRoot === root.packageRoot
          );
        } catch {
          return false;
        }
      },
    };
  };

  app.post('/:name/update', async (c) => {
    const name = param(c, 'name');
    try {
      assertPluginNameSegment(name);
    } catch (error) {
      return c.json({ success: false, error: errorMessage(error) }, 400);
    }
    let requestGrantRevisions: ReturnType<typeof observePluginGrantRevisions>;
    try {
      requestGrantRevisions = observePluginGrantRevisions(projectHomeDir);
    } catch (error) {
      return c.json({ success: false, error: errorMessage(error) }, 503);
    }
    let registryOwner: Awaited<
      ReturnType<typeof findOwningPluginRegistryProvider>
    > | null = null;
    let installedPluginName = name;
    let updateTarget: ReturnType<typeof captureUpdateTarget> = null;
    let pluginDir = join(pluginsDir, name);
    try {
      assertPathInside(pluginsDir, pluginDir, 'Plugin update target');
      updateTarget = captureUpdateTarget(name);
      pluginDir = updateTarget?.root.packageRoot ?? pluginDir;
    } catch (error) {
      return c.json({ success: false, error: errorMessage(error) }, 400);
    }

    const directPluginExists = existsSync(pluginDir);
    registryOwner = await findOwningPluginRegistryProvider(
      name,
      projectHomeDir,
    );
    if (updateTarget && !updateTarget.isCurrent())
      return c.json(
        {
          success: false,
          error:
            'Plugin installation changed before update; reload before retrying',
        },
        409,
      );
    if (!registryOwner.success && registryOwner.message.includes('multiple')) {
      return c.json({ success: false, error: registryOwner.message }, 400);
    }

    if (registryOwner.success) {
      if (directPluginExists && registryOwner.installedName !== name) {
        return c.json(
          {
            success: false,
            error: `Registry plugin '${name}' resolves to installed plugin '${registryOwner.installedName}', but plugin '${name}' also exists`,
          },
          400,
        );
      }
      installedPluginName = registryOwner.installedName;
      if (!updateTarget)
        updateTarget = captureUpdateTarget(installedPluginName);
      pluginDir =
        updateTarget?.root.packageRoot ?? join(pluginsDir, installedPluginName);
      try {
        assertPathInside(
          pluginsDir,
          join(pluginsDir, installedPluginName),
          'Plugin update target',
        );
      } catch (error) {
        return c.json({ success: false, error: errorMessage(error) }, 400);
      }
      if (!existsSync(pluginDir)) {
        return c.json({ success: false, error: 'Plugin not found' }, 404);
      }
    } else if (!directPluginExists) {
      return c.json({ success: false, error: registryOwner.message }, 404);
    } else {
      registryOwner = null;
    }
    try {
      assertExistingPluginRootInside(pluginsDir, pluginDir);
    } catch (error) {
      return c.json({ success: false, error: errorMessage(error) }, 400);
    }

    if (updateTarget && !updateTarget.isCurrent())
      return c.json(
        {
          success: false,
          error:
            'Plugin installation changed before update; reload before retrying',
        },
        409,
      );
    if (!updateTarget)
      return c.json(
        {
          success: false,
          error: 'Plugin installation is unavailable; reload before retrying',
        },
        409,
      );
    const installedRoot = updateTarget.root;
    if (installedRoot?.kind === 'incarnation') {
      try {
        const selected = updateTarget!.installation;
        if (!selected?.materialization || !selected.dataScope)
          throw new PluginUpdateRejectedError(
            'Plugin installation authority is unavailable',
          );
        const expectedInstallation: PluginInstallationRevision = {
          scope: selected.journalId,
          installation: selected.pluginId,
          generation: selected.incarnation,
          artifact: { digest: selected.contentDigest },
          materialization: selected.materialization,
          dataScope: selected.dataScope,
          ...(selected.origin ? { origin: selected.origin } : {}),
        };
        const registryInstall = registryOwner?.success
          ? await resolvePluginRegistryInstall(registryOwner.registryId)
          : null;
        const source = registryOwner?.success
          ? registryInstall?.source
          : (
              await execGit(['remote', 'get-url', 'origin'], {
                cwd: installedRoot.packageRoot,
                timeout: 30000,
              })
            ).stdout.trim();
        if (!source)
          return c.json(
            {
              success: false,
              error:
                'This package has no update source. Preview and install the new version from its source.',
            },
            409,
          );
        if (!updateTarget!.isCurrent())
          throw new PluginUpdateRejectedError(
            'Plugin installation changed while resolving its update source; reload before retrying',
          );
        const mutation = await capturePluginConfigurationMutation(
          applyConfigurationMutation,
          async (beginMutation, _activation, activationSession) =>
            installPluginFromSource(
              source,
              [],
              {
                agentsDir,
                pluginsDir,
                projectHomeDir,
                logger,
                buildPlugin,
                registryTrustPolicyAuthority: deps.registryTrustPolicyAuthority,
                packageMcpJournal: deps.packageMcpJournal,
                installationHost: deps.installationHost,
                beginConfigurationMutation: beginMutation,
                eventBus,
              },
              {
                grantSnapshot: requestGrantRevisions,
                activationSession,
                ...(registryOwner?.success
                  ? {
                      registryId: registryOwner.registryId,
                      registryKey: registryInstall!.registryKey,
                    }
                  : {}),
                consent: {
                  kind: 'no-operator-decision',
                  caller: 'portable package update',
                },
                dataPolicy: 'preserve',
                expectedPluginName: installedPluginName,
                expectedInstallation,
              },
            ),
          { rediscoverSkills: true },
        );
        return c.json(
          {
            ...mutation.value,
            success: mutation.activation?.status !== 'pending',
            ...configurationActivationPayload(mutation.activation),
          },
          configurationMutationStatus(mutation.activation, 200),
        );
      } catch (error) {
        if (error instanceof PluginInstallationPending)
          return c.json(
            {
              success: false,
              error: errorMessage(error),
              lifecycle: {
                status: 'pending',
                selected: error.selected,
                code: error.code,
              },
            },
            202,
          );
        return c.json({ success: false, error: errorMessage(error) }, 409);
      }
    }
    const gitDir = join(pluginDir, '.git');
    const isGitPlugin = existsSync(gitDir);
    if (!isGitPlugin && !registryOwner) {
      return c.json({ success: false, error: 'Plugin is not git-backed' }, 400);
    }
    if (
      registryOwner?.success &&
      !registryOwner.entry.provider.update &&
      registryOwner.installedName !== registryOwner.registryId
    ) {
      return c.json(
        {
          success: false,
          error: `Plugin registry provider '${registryOwner.entry.source}' cannot update aliased plugin '${registryOwner.installedName}' without an update operation`,
        },
        400,
      );
    }

    let backupRoot: string | null = null;
    try {
      // archive#3677 review HIGH 1: the whole tree mutation holds the
      // per-plugin content lock the consent decision's revalidate → commit
      // span also takes, so an update can never interleave between a
      // consent fingerprint revalidation and its grant commit.
      const mutation = await withPluginContentLock(
        pluginsDir,
        installedPluginName,
        () =>
          captureConfigurationMutation(
            applyConfigurationMutation,
            async (beginMutation) => {
              if (updateTarget && !updateTarget.isCurrent())
                throw new PluginUpdateRejectedError(
                  'Plugin installation changed before legacy update; reload before retrying',
                );
              backupRoot = createStationTempDirSync('plugin-update');
              const backupDir = join(backupRoot, 'plugin');
              cpSync(pluginDir, backupDir, PLUGIN_TREE_COPY);
              const {
                manifest: originalManifest,
                format: originalManifestFormat,
              } = await readPluginManifestFileWithFormat(
                join(backupDir, 'plugin.json'),
              );
              const originalIdentity = originalManifest.name || name;
              const persistedAgentOwnership = capturePersistedAgentOwnership(
                agentsDir,
                originalIdentity,
                originalManifest,
              );
              // archive#4288: the update is about to withdraw consent that
              // belonged to the OLD bytes. If any later step fails and the
              // tree is rolled back, the grants have to come back with it —
              // otherwise a failed update silently strips a plugin of
              // capability nobody decided to take away.
              const grantScope = createPluginGrantMutationScope(
                projectHomeDir,
                originalIdentity,
                {
                  expectedRevision:
                    requestGrantRevisions.revisionFor(originalIdentity),
                },
              );
              const eventSubscriptionQuiescence =
                (await quiesceEventSubscriptions?.(originalIdentity)) ?? null;
              let serverQuiescence: PluginPublicServerQuiescence;
              try {
                serverQuiescence = await quiescePluginPublicServerModule(
                  pluginsDir,
                  originalIdentity,
                );
              } catch (error) {
                eventSubscriptionQuiescence?.release();
                throw error;
              }
              try {
                beginMutation();
                let updatedManifest: PluginManifest | null = null;
                try {
                  if (registryOwner?.success) {
                    const result = await updatePluginFromRegistry(
                      registryOwner.registryId,
                      projectHomeDir,
                    );
                    if (!result.success) {
                      throw new PluginUpdateRejectedError(result.message);
                    }
                  } else if (isGitPlugin) {
                    await execGit(['pull', '--ff-only'], {
                      cwd: pluginDir,
                      timeout: 30000,
                    });
                  } else {
                    throw new PluginUpdateRejectedError(
                      'Plugin is not git-backed',
                    );
                  }

                  const manifestPath = join(pluginDir, 'plugin.json');
                  const { manifest, format: manifestFormat } =
                    await readPluginManifestFileWithFormat(manifestPath);
                  updatedManifest = manifest;
                  if (manifestFormat !== originalManifestFormat)
                    throw new PluginUpdateRejectedError(
                      'Plugin format migration requires a new validated installation',
                    );
                  if ((manifest.name || name) !== originalIdentity) {
                    throw new PluginUpdateRejectedError(
                      `Plugin identity cannot change during update: ${originalIdentity}`,
                    );
                  }
                  if (manifestFormat !== 'agent-plugin-1.0') {
                    scanPluginPromptGeneration(pluginDir, originalIdentity);
                  }

                  await synchronizePluginAgentDefinitions({
                    agentsDir,
                    pluginDir,
                    pluginName: originalIdentity,
                    projectHomeDir,
                    manifest,
                    previousManifest: originalManifest,
                    logger,
                    persistedOwnership: persistedAgentOwnership,
                  });

                  await buildPlugin(pluginDir, originalIdentity);
                  removePluginOwnedIntegrations(
                    join(projectHomeDir, 'integrations'),
                    originalIdentity,
                  );
                  if (manifestFormat !== 'agent-plugin-1.0') {
                    copyPluginIntegrations(
                      pluginDir,
                      join(projectHomeDir, 'integrations'),
                    );
                  }
                  // archive#4288 — the fix. Consent was given to the bytes
                  // this update just replaced, so it is re-bound HERE: after
                  // the build and the integration copy (the tree is final,
                  // so the digest describes what will actually execute) and
                  // BEFORE the first read of a grant below, so the provider
                  // load sees the post-update grants rather than inherited
                  // ones. Permissions the new manifest newly derives are not
                  // inherited either — `rebindGrantsAfterContentChange`
                  // re-derives from `requiredPermissionsForManifest`.
                  const rebound = await grantScope.run(() =>
                    rebindGrantsAfterContentChange(
                      projectHomeDir,
                      originalIdentity,
                      manifest,
                    ),
                  );
                  if (rebound.withdrawn.length > 0) {
                    logger.info(
                      'Plugin update withdrew consent bound to the replaced content',
                      {
                        plugin: originalIdentity,
                        withdrawn: rebound.withdrawn,
                        retained: rebound.retained,
                      },
                    );
                    eventBus?.emit(SERVER_EVENTS.PLUGINS_GRANTS_CHANGED, {
                      name: originalIdentity,
                    });
                  }
                  await loadPluginProviders(
                    pluginsDir,
                    originalIdentity,
                    hasGrant(
                      projectHomeDir,
                      originalIdentity,
                      'providers.register',
                    )
                      ? manifest
                      : { ...manifest, providers: [] },
                    logger,
                    { strict: true },
                  );
                  await deps.reconcileEngineConnections?.(originalIdentity);
                  await settleProviderAdapterRetirements?.();

                  eventBus?.emit('plugins:updated', {
                    name,
                    version: manifest.version,
                  });
                  pluginUpdates.add(1, { plugin: name });
                  grantScope.commit();
                  return {
                    success: true as const,
                    plugin: {
                      name: manifest.name,
                      version: manifest.version,
                    },
                    // Named, not implied: a plugin that quietly loses a
                    // capability with no explanation is its own defect.
                    permissions: {
                      withdrawn: rebound.withdrawn,
                      retained: rebound.retained,
                    },
                  };
                } catch (error) {
                  try {
                    rmSync(pluginDir, { recursive: true, force: true });
                    cpSync(backupDir, pluginDir, PLUGIN_TREE_COPY);
                    // archive#4288, delta review MEDIUM 1 (same defect the
                    // install rollback carries). `rebindGrantsAfterContentChange`
                    // above refreshed the memo to the UPDATED tree's digest;
                    // this rollback has just restored the old tree and
                    // the owned permission receipt restores the old digest with
                    // it, so the `hasGrant(..., 'providers.register')` below
                    // would compare them, derive `changed`, and reload the
                    // restored plugin with no providers at all.
                    forgetPluginContentDigest(pluginsDir, originalIdentity);
                    removePluginOwnedIntegrations(
                      join(projectHomeDir, 'integrations'),
                      originalIdentity,
                    );
                    if (originalManifestFormat !== 'agent-plugin-1.0') {
                      copyPluginIntegrations(
                        pluginDir,
                        join(projectHomeDir, 'integrations'),
                      );
                    }
                    // The tree is back to the reviewed bytes, so the consent
                    // recorded against them comes back with it — digest
                    // included, so the restored entry is `bound` again and
                    // not merely `unverified` (archive#4288).
                    const rollback = await grantScope.rollback();
                    if (rollback.state === 'unavailable')
                      throw new Error(
                        'Plugin permission rollback is unavailable; recovery is required',
                      );
                    await synchronizePluginAgentDefinitions({
                      agentsDir,
                      pluginDir,
                      pluginName: originalIdentity,
                      projectHomeDir,
                      manifest: originalManifest,
                      previousManifest: updatedManifest ?? originalManifest,
                      logger,
                      persistedOwnership: persistedAgentOwnership,
                    });
                    await loadPluginProviders(
                      pluginsDir,
                      originalIdentity,
                      hasGrant(
                        projectHomeDir,
                        originalIdentity,
                        'providers.register',
                      )
                        ? originalManifest
                        : { ...originalManifest, providers: [] },
                      logger,
                      { strict: true },
                    );
                    await deps.reconcileEngineConnections?.(originalIdentity);
                    await settleProviderAdapterRetirements?.();
                  } catch (rollbackError) {
                    throw new AggregateError(
                      [error, rollbackError],
                      'Plugin update and rollback both failed.',
                    );
                  }
                  throw error;
                }
              } finally {
                serverQuiescence.release();
                eventSubscriptionQuiescence?.release();
              }
            },
            { rediscoverSkills: true },
          ),
      );
      if (mutation.value.success) {
        try {
          refreshKitObservability?.();
        } catch (error: unknown) {
          logger.warn('Kit observability refresh failed after plugin update', {
            plugin: name,
            error: errorMessage(error),
          });
        }
      }

      return c.json(
        {
          ...mutation.value,
          success: mutation.activation?.status !== 'pending',
          ...configurationActivationPayload(mutation.activation),
        },
        configurationMutationStatus(mutation.activation, 200),
      );
    } catch (error: unknown) {
      if (isRegistryAcquisitionRefusal(error))
        return c.json(
          {
            success: false,
            code: 'registry-trust-refused',
            error:
              'Registry trust changed or could not be verified. Preview again; retained data has not been migrated.',
          },
          409,
        );
      if (
        isContextSafetyError(error) ||
        error instanceof PluginUpdateRejectedError
      ) {
        return c.json({ success: false, error: error.message }, 400);
      }
      logger.error('Plugin update failed', {
        plugin: name,
        error: errorMessage(error),
      });
      return c.json({ success: false, error: errorMessage(error) }, 500);
    } finally {
      if (backupRoot) {
        rmSync(backupRoot, { recursive: true, force: true });
      }
    }
  });

  app.delete('/:name', async (c) => {
    const name = param(c, 'name');
    try {
      assertPluginNameSegment(name);
    } catch (error) {
      return c.json({ success: false, error: errorMessage(error) }, 400);
    }
    let installedPluginName = name;
    let pluginDir = join(pluginsDir, name);
    try {
      assertPathInside(pluginsDir, pluginDir, 'Plugin removal target');
      pluginDir = resolveLifecycleRoot(name)?.packageRoot ?? pluginDir;
    } catch (error) {
      return c.json({ success: false, error: errorMessage(error) }, 400);
    }

    const directPluginExists = existsSync(pluginDir);
    const removalTarget = resolvePluginRemovalTarget(
      name,
      projectHomeDir,
      directPluginExists,
    );
    if (!removalTarget.success) {
      const error =
        removalTarget.reason === 'alias-collision'
          ? `Registry plugin '${name}' resolves to installed plugin '${removalTarget.installedName}', but plugin '${name}' also exists`
          : removalTarget.reason === 'conflicting-targets'
            ? `Plugin '${name}' has conflicting registry install targets`
            : removalTarget.reason === 'ownership-unavailable'
              ? 'Plugin registry ownership is unavailable. Repair config/registry-installs.json before retrying removal.'
              : 'Plugin not found';
      return c.json(
        {
          success: false,
          error,
        },
        removalTarget.reason === 'not-found' ? 404 : 400,
      );
    }
    installedPluginName = removalTarget.installedName;
    pluginDir = join(pluginsDir, installedPluginName);
    try {
      assertPathInside(pluginsDir, pluginDir, 'Plugin removal target');
      pluginDir =
        resolveLifecycleRoot(installedPluginName)?.packageRoot ?? pluginDir;
    } catch (error) {
      return c.json({ success: false, error: errorMessage(error) }, 400);
    }
    if (!existsSync(pluginDir)) {
      return c.json({ success: false, error: 'Plugin not found' }, 404);
    }

    try {
      assertExistingPluginRootInside(pluginsDir, pluginDir);
    } catch (error) {
      return c.json({ success: false, error: errorMessage(error) }, 400);
    }

    try {
      // archive#3677 review HIGH 1: removal also mutates the consent
      // fingerprint's subject tree — hold the same per-plugin content lock
      // the consent decision's revalidate → commit span takes, so a grant
      // cannot commit for a plugin being removed underneath it.
      // The shared uninstall owns publication -> content lock ordering.
      const mutation = await captureConfigurationMutation(
        applyConfigurationMutation,
        async (beginMutation) => {
          const result = await uninstallInstalledPlugin(installedPluginName, {
            agentsDir,
            registryTrustPolicyAuthority: deps.registryTrustPolicyAuthority,
            packageMcpJournal: deps.packageMcpJournal,
            installationHost: deps.installationHost,
            beginConfigurationMutation: beginMutation,
            buildPlugin,
            eventBus,
            logger,
            pluginsDir,
            projectHomeDir,
            removeEngineConnections,
            quiesceEventSubscriptions: quiesceEventSubscriptions
              ? (plugin) => quiesceEventSubscriptions(plugin)
              : undefined,
          });
          await settleProviderAdapterRetirements?.();
          return result;
        },
        { rediscoverSkills: true },
      );
      if (mutation.value.success) {
        try {
          refreshKitObservability?.();
        } catch (error: unknown) {
          logger.warn('Kit observability refresh failed after plugin removal', {
            plugin: name,
            error: errorMessage(error),
          });
        }
      }
      return c.json(
        {
          ...mutation.value,
          success: mutation.activation?.status !== 'pending',
          ...configurationActivationPayload(mutation.activation),
        },
        configurationMutationStatus(mutation.activation, 200),
      );
    } catch (error: unknown) {
      if (isContextSafetyError(error)) {
        return c.json({ success: false, error: error.message }, 400);
      }
      return c.json({ success: false, error: errorMessage(error) }, 500);
    }
  });

  app.post('/reload', async (c) => {
    if (deps.installationHost || deps.packageMcpJournal) {
      const projection = deps.installationHost
        ? await deps.installationHost.reconcile()
        : await reconcileLocalPluginInstallations(
            pluginsDir,
            deps.packageMcpJournal!,
          );
      if (projection.status === 'pending')
        return c.json(
          {
            success: false,
            error:
              'Plugin catalog projection remains pending; inspect retained generations.',
            lifecycle: projection,
          },
          202,
        );
    }
    const eventSubscriptionQuiescence =
      await quiesceEventSubscriptions?.().catch((error) => {
        logger.error(
          'Plugin event subscription quiescence failed before reload',
          {
            error: errorMessage(error),
          },
        );
        return null;
      });
    if (quiesceEventSubscriptions && !eventSubscriptionQuiescence) {
      return c.json(
        {
          success: false,
          error: 'Plugin event subscription reload could not begin',
        },
        500,
      );
    }
    const serverQuiescence = await quiesceAllPluginPublicServerModules().catch(
      (error) => {
        logger.error('Plugin server quiescence failed before reload', {
          error: errorMessage(error),
        });
        return null;
      },
    );
    if (!serverQuiescence) {
      eventSubscriptionQuiescence?.release();
      return c.json(
        { success: false, error: 'Plugin server reload could not begin' },
        500,
      );
    }
    try {
      const mutation = await captureConfigurationMutation(
        applyConfigurationMutation,
        async (beginMutation) => {
          beginMutation();
          const { resolvePluginProviders } = await import(
            '../../providers/resolver.js'
          );
          const { ConfigLoader } = await import(
            '../../domain/config-loader.js'
          );

          const configLoader = new ConfigLoader({ projectHomeDir });
          const overrides = await configLoader.loadPluginOverrides();

          const {
            basis,
            candidates: { resolved, conflicts },
          } = await capturePluginProviderGeneration(projectHomeDir, () =>
            existsSync(pluginsDir)
              ? resolvePluginProviders(
                  pluginsDir,
                  overrides,
                  (pluginName) =>
                    hasGrant(projectHomeDir, pluginName, 'providers.register'),
                  logger,
                )
              : { resolved: [], conflicts: [] },
          );

          for (const conflict of conflicts) {
            logger.warn('Provider conflict on reload', {
              type: conflict.type,
              candidates: conflict.candidates,
            });
          }

          const prepared = await preparePluginProviderGeneration(
            pluginsDir,
            resolved.map((entry) => ({
              pluginName: entry.pluginName,
              manifest: {
                providers: [
                  {
                    type: entry.type,
                    module: entry.module,
                    layout: entry.layout,
                  },
                ],
                displayName: entry.pluginName,
              } as PluginManifest,
            })),
            logger,
          );
          const published = await publishPluginProviderGeneration(
            basis,
            prepared,
          );
          await settleProviderAdapterRetirements?.();
          return { success: true as const, loaded: published.length };
        },
        { rediscoverSkills: true },
      );
      if (mutation.value.success) {
        try {
          refreshKitObservability?.();
        } catch (error: unknown) {
          logger.warn('Kit observability refresh failed after plugin reload', {
            error: errorMessage(error),
          });
        }
      }

      return c.json(
        {
          ...mutation.value,
          success: mutation.activation?.status !== 'pending',
          ...configurationActivationPayload(mutation.activation),
        },
        configurationMutationStatus(mutation.activation, 200),
      );
    } catch (error: unknown) {
      return c.json({ success: false, error: errorMessage(error) }, 500);
    } finally {
      serverQuiescence.release();
      eventSubscriptionQuiescence?.release();
    }
  });
}

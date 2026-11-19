import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type {
  PluginUpdateCheck,
  PluginUpdateRecord,
} from '@kontourai/station-contracts/plugin';
import {
  getPluginRegistryProviders,
  getRegisteredPluginRegistryProviders,
  pluginRegistryAllowedByManagedPolicy,
} from '../../providers/registries/registry.js';
import { readRegistryInstallAliases } from '../../providers/registries/registry-install-aliases.js';
import {
  managedCapabilityDenial,
  managedRegistryLimits,
  registryLocationAllowedByManagedPolicy,
} from '../../security/managed-capability-limits.js';
import { execGit } from '../../utils/git-exec.js';
import { ownGitRepositoryArgs } from '../../utils/own-git-repository.js';
import { resolveInstalledPluginRoot } from './plugin-incarnation.js';
import { readContainedPluginManifestSyncWithFormat } from './plugin-manifest-bounded-read.js';

/**
 * #4521: installed plugin directories whose recorded registry provenance
 * (`config/registry-installs.json`) is a registry the managed policy refuses.
 * The registered provider decides when it is still registered, so the
 * bundled examples stay allowed; a recorded registry no longer registered is
 * judged by its location alone. Plugins installed from a Git URL or a folder
 * carry no registry provenance and are not affected.
 */
function pluginsFromRefusedRegistries(projectHomeDir: string): Set<string> {
  const refused = new Set<string>();
  if (managedRegistryLimits()?.allowedUrls === undefined) return refused;
  const registered = getRegisteredPluginRegistryProviders();
  for (const alias of Object.values(
    readRegistryInstallAliases(projectHomeDir),
  )) {
    const entry = registered.find(
      (candidate) => candidate.provider.registryKey === alias.registryKey,
    );
    const allowed = entry
      ? pluginRegistryAllowedByManagedPolicy(entry)
      : registryLocationAllowedByManagedPolicy(alias.registryKey);
    if (!allowed) refused.add(alias.pluginName);
  }
  return refused;
}

/** Narrow structural logger: this module debugs per-plugin misses. */
export interface PluginUpdateCheckLogger {
  debug(message: string, meta?: Record<string, unknown>): void;
}

function readPluginDirectories(pluginsDir: string) {
  try {
    return readdirSync(pluginsDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

/** Shared operator-route and boot-time update scan. */
export async function checkPluginUpdates(options: {
  pluginsDir: string;
  logger: PluginUpdateCheckLogger;
  /** Defaults to the parent of `pluginsDir`, the Station home layout. */
  projectHomeDir?: string;
}): Promise<PluginUpdateCheck> {
  const { pluginsDir, logger } = options;
  const updates: PluginUpdateRecord[] = [];
  const managedByPolicy: NonNullable<PluginUpdateCheck['managedByPolicy']> = [];
  let successes = 0;
  let failures = 0;
  let refusedProvenance = new Set<string>();
  try {
    refusedProvenance = pluginsFromRefusedRegistries(
      options.projectHomeDir ?? dirname(pluginsDir),
    );
  } catch (error) {
    // Unreadable provenance under an allow list: check no git origin rather
    // than one the policy may refuse.
    if (managedRegistryLimits()?.allowedUrls !== undefined) throw error;
  }

  for (const entry of readPluginDirectories(pluginsDir)) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    try {
      const target = resolveInstalledPluginRoot(pluginsDir, entry.name);
      if (!target) continue;
      const dir = target.packageRoot;
      // The same selected checkout owns both Git commands and the manifest.
      const own = ownGitRepositoryArgs(dir);
      if (!own || !existsSync(join(dir, 'plugin.json'))) continue;
      // #4521: its registry is refused, so its git origin (that registry's
      // package host) is not fetched either.
      if (refusedProvenance.has(entry.name)) {
        managedByPolicy.push({
          name: entry.name,
          message: managedCapabilityDenial(
            'updates for plugins from this marketplace',
          ),
        });
        continue;
      }
      const { manifest } = readContainedPluginManifestSyncWithFormat(dir);
      await execGit([...own, 'fetch', '--quiet'], {
        cwd: dir,
        timeout: 10000,
        // An installed plugin's directory is Station-owned, and its origin
        // is the source the operator installed from, which may be a local
        // git path (#2363).
        hardening: { allowFileProtocol: true },
      });
      const { stdout: behind } = await execGit(
        [...own, 'rev-list', '--count', 'HEAD..@{u}'],
        { cwd: dir, encoding: 'utf-8' },
      );
      if (parseInt(behind.trim(), 10) > 0) {
        const commitsBehind = behind.trim();
        updates.push({
          name: entry.name,
          currentVersion: manifest.version || 'unknown',
          latestVersion: `${commitsBehind} commit${commitsBehind === '1' ? '' : 's'} behind`,
          source: 'git',
        });
      }
      successes += 1;
    } catch (error) {
      failures += 1;
      logger.debug('Failed to check git updates for plugin', {
        plugin: entry.name,
        error,
      });
    }
  }

  for (const { provider } of getPluginRegistryProviders()) {
    try {
      await provider.refresh?.();
      const [available, installed] = await Promise.all([
        provider.listAvailable(),
        provider.listInstalled(),
      ]);
      for (const plugin of installed) {
        const name = plugin.installedPluginName ?? plugin.id;
        const latestVersion = available.find(
          (item) => item.id === plugin.id,
        )?.version;
        if (
          latestVersion &&
          latestVersion !== plugin.version &&
          !updates.some((update) => update.name === name)
        ) {
          updates.push({
            name,
            currentVersion: plugin.version || 'unknown',
            latestVersion,
            source: 'registry',
          });
        }
      }
      successes += 1;
    } catch (error) {
      failures += 1;
      logger.debug('Failed to check registry for plugin updates', { error });
    }
  }

  return {
    status:
      failures === 0 ? 'complete' : successes === 0 ? 'unavailable' : 'partial',
    updates,
    ...(managedByPolicy.length > 0 ? { managedByPolicy } : {}),
  };
}

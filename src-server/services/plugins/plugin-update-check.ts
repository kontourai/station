import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
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
import { readPluginManifestFileSync } from './plugin-manifest-loader.js';

export interface PluginUpdateRecord {
  name: string;
  currentVersion: string;
  latestVersion: string;
  source: string;
}

/**
 * #4521: an installed plugin whose update check the managed policy skips,
 * because the registry it was installed from is outside
 * `limits.registries.allowedUrls`. Not an error: nothing was contacted.
 */
export interface PluginUpdateManagedByPolicy {
  name: string;
  message: string;
}

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

async function listPluginRegistryUpdates(): Promise<PluginUpdateRecord[]> {
  const updates: PluginUpdateRecord[] = [];

  // #4521: the managed policy's refused registries are already left out.
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

/**
 * station#2236: the update scan `GET /api/plugins/check-updates` serves,
 * extracted so the boot-time background check can run it in-process instead
 * of HTTP self-fetching its own operator-only route (which 401'd
 * `credential_missing` on every boot since #2067 — the headerless loopback
 * fetch carries no credential and the route refuses it before any scan
 * runs). Behavior is the route's, verbatim: git-backed plugins report
 * behind-counts, registry providers report version drift, per-plugin and
 * per-registry failures degrade to debug logs. Unexpected throws propagate
 * to the caller (the route's existing outer catch answers `[]`).
 */
export async function checkPluginUpdates(options: {
  pluginsDir: string;
  logger: PluginUpdateCheckLogger;
  /** Defaults to the parent of `pluginsDir`, the Station home layout. */
  projectHomeDir?: string;
}): Promise<{
  updates: PluginUpdateRecord[];
  managedByPolicy?: PluginUpdateManagedByPolicy[];
}> {
  const { pluginsDir, logger } = options;
  const updates: PluginUpdateRecord[] = [];
  const managedByPolicy: PluginUpdateManagedByPolicy[] = [];
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

  if (existsSync(pluginsDir)) {
    const entries = readdirSync(pluginsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dir = join(pluginsDir, entry.name);
      const manifestPath = join(dir, 'plugin.json');
      // Only the plugin's own repository: never one enclosing `dir`.
      const own = ownGitRepositoryArgs(dir);
      if (!own || !existsSync(manifestPath)) continue;
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

      try {
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
    logger.debug('Failed to check registry for plugin updates', {
      error,
    });
  }

  return managedByPolicy.length > 0
    ? { updates, managedByPolicy }
    : { updates };
}

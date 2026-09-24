import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { getPluginRegistryProviders } from '../../providers/registries/registry.js';
import { execGit } from '../../utils/git-exec.js';
import { readPluginManifestFileSync } from './plugin-manifest-loader.js';

export interface PluginUpdateRecord {
  name: string;
  currentVersion: string;
  latestVersion: string;
  source: string;
}

/** Narrow structural logger: this module debugs per-plugin misses. */
export interface PluginUpdateCheckLogger {
  debug(message: string, meta?: Record<string, unknown>): void;
}

async function listPluginRegistryUpdates(): Promise<PluginUpdateRecord[]> {
  const updates: PluginUpdateRecord[] = [];

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
}): Promise<{ updates: PluginUpdateRecord[] }> {
  const { pluginsDir, logger } = options;
  const updates: PluginUpdateRecord[] = [];

  if (existsSync(pluginsDir)) {
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
          // An installed plugin's directory is Station-owned, and its origin
          // is the source the operator installed from, which may be a local
          // git path (#2363).
          hardening: { allowFileProtocol: true },
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
    logger.debug('Failed to check registry for plugin updates', {
      error,
    });
  }

  return { updates };
}

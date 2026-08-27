/**
 * Plugin provider resolution engine
 * Reads plugin manifests, applies user overrides, detects singleton conflicts.
 */

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type {
  PluginManifest,
  PluginOverrides,
} from '@kontourai/station-contracts/plugin';
import { readPluginManifestFileSync } from '../services/plugins/plugin-manifest-loader.js';
import type { Logger } from '../utils/logger.js';
import { PROVIDER_TYPE_META } from './provider-interfaces.js';

export interface ResolvedEntry {
  pluginName: string;
  type: string;
  module: string;
  layout?: string;
}

export interface ProviderConflict {
  type: string;
  layout: string;
  candidates: string[];
}

export interface ResolvedProviders {
  resolved: ResolvedEntry[];
  conflicts: ProviderConflict[];
}

export function resolvePluginProviders(
  pluginsDir: string,
  overrides: PluginOverrides,
  includePlugin: (pluginName: string) => boolean = () => true,
  // Optional so this adds no required plumbing to existing callers or tests,
  // matching how the rest of `src-server` threads a logger.
  logger?: Pick<Logger, 'warn'>,
): ResolvedProviders {
  const resolved: ResolvedEntry[] = [];
  const conflicts: ProviderConflict[] = [];

  // Collect all provider entries from all plugins
  const byType = new Map<string, Map<string, ResolvedEntry[]>>(); // type -> layout -> entries

  if (!existsSync(pluginsDir)) return { resolved, conflicts };

  const dirs = readdirSync(pluginsDir, { withFileTypes: true });
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue;
    const manifestPath = join(pluginsDir, dir.name, 'plugin.json');
    if (!existsSync(manifestPath)) continue;

    let manifest: PluginManifest;
    try {
      manifest = readPluginManifestFileSync(manifestPath);
    } catch (e) {
      // WARN, not debug. This skip makes a plugin disappear -- its providers
      // stop loading, with no user-facing signal anywhere -- and station#4307
      // widened what gets rejected here: `manifest.name` is now held to
      // `isCanonicalPluginId` plus the reserved-key check, which nothing
      // enforced before. So a plugin installed under a name that was legal
      // then and is not now vanishes on upgrade, and at debug level nobody
      // ever learns why (station#4322).
      const detail = e instanceof Error ? e.message : String(e);
      const message = `Skipped a plugin whose manifest could not be read, so nothing it contributes is loaded: ${manifestPath} (${detail})`;
      if (logger) logger.warn(message);
      else console.warn(message);
      continue;
    }

    if (!manifest.providers?.length) continue;

    const pluginName = manifest.name || dir.name;
    if (!includePlugin(pluginName)) continue;

    const disabled = overrides[pluginName]?.disabled ?? [];

    for (const p of manifest.providers) {
      if (disabled.includes(p.type)) continue;

      const ws = p.layout ?? '*';
      const entry: ResolvedEntry = {
        pluginName,
        type: p.type,
        module: p.module,
        layout: p.layout,
      };

      if (!byType.has(p.type)) byType.set(p.type, new Map());
      const wsMap = byType.get(p.type)!;
      if (!wsMap.has(ws)) wsMap.set(ws, []);
      wsMap.get(ws)!.push(entry);
    }
  }

  // Resolve: singletons with >1 candidate = conflict
  for (const [type, wsMap] of byType) {
    const cardinality = PROVIDER_TYPE_META[type] ?? 'singleton';

    for (const [ws, entries] of wsMap) {
      if (cardinality === 'additive') {
        resolved.push(...entries);
      } else if (entries.length === 1) {
        resolved.push(entries[0]);
      } else {
        conflicts.push({
          type,
          layout: ws,
          candidates: entries.map((e) => e.pluginName),
        });
      }
    }
  }

  return { resolved, conflicts };
}

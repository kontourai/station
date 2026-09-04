/**
 * Plugin provider resolution engine
 * Reads plugin manifests, applies user overrides, detects singleton conflicts.
 */

import type {
  PluginManifest,
  PluginOverrides,
} from '@kontourai/station-contracts/plugin';
import { scanInstalledPluginInventory } from '../services/plugins/installed-plugin-inventory.js';
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

  for (const entry of scanInstalledPluginInventory(pluginsDir, logger)) {
    if (entry.state === 'rejected') continue;
    const manifest: PluginManifest = entry.manifest;

    if (!manifest.providers?.length) continue;

    const pluginName = manifest.name || entry.directoryName;
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

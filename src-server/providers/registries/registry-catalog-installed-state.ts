import { join } from 'node:path';
import type {
  RegistryCatalogSelection,
  RegistryItem,
} from '@kontourai/station-contracts/catalog';
import { scanInstalledPluginInventory } from '../../services/plugins/installed-plugin-inventory.js';
import { readRegistryInstallAliases } from './registry-install-aliases.js';
import { readRegistryCatalogSelection } from './registry-source-configuration.js';

/**
 * Marks the rows of one plugin-pipeline catalog (`plugins`, or a manifest's
 * `agents`) that this Station installed from that exact source and kind.
 */
export function readRegistryCatalogInstalledState(
  home: string,
  kind: Exclude<RegistryCatalogSelection['kind'], 'skills'> = 'plugins',
) {
  const installed = new Set(
    scanInstalledPluginInventory(join(home, 'plugins')).flatMap((item) =>
      item.state === 'valid' ? [item.manifest.name] : [],
    ),
  );
  const aliases = readRegistryInstallAliases(home);
  return (
    items: RegistryItem[],
    sourceId: string,
    registryKey: string | undefined,
  ): RegistryItem[] =>
    items.map(({ installedPluginName: _installedPluginName, ...item }) => {
      const alias = Object.entries(aliases).find(([id, alias]) => {
        if (
          alias.registryKey !== registryKey ||
          !installed.has(alias.pluginName)
        )
          return false;
        const selected = readRegistryCatalogSelection(id);
        return selected
          ? selected.kind === kind &&
              selected.sourceId === sourceId &&
              selected.itemId === item.catalog?.itemId
          : id === item.catalog?.itemId;
      })?.[1];
      return {
        ...item,
        installed: !!alias,
        ...(alias ? { installedPluginName: alias.pluginName } : {}),
      };
    });
}

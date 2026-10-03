import { join } from 'node:path';
import type { RegistryItem } from '@kontourai/station-contracts/catalog';
import { scanInstalledPluginInventory } from '../../services/plugins/installed-plugin-inventory.js';
import { readRegistryInstallAliases } from './registry-install-aliases.js';
import { readRegistryCatalogSelection } from './registry-source-configuration.js';

export function readRegistryCatalogInstalledState(home: string) {
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
          ? selected.kind === 'plugins' &&
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

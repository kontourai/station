import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RegistryItem } from '@kontourai/station-contracts/catalog';
import { builtinIntegrationRuntimeSpawnCommand } from '../../runtime/bootstrap/station-control-runtime-env.js';
import { IntegrationIconAssets } from '../../services/plugins/integration-icon-assets.js';
import { resolveHomeDir } from '../../utils/paths.js';
import type { IIntegrationRegistryProvider } from '../provider-interfaces.js';

export async function readDiskIntegrations(
  homeDir = resolveHomeDir(),
): Promise<RegistryItem[]> {
  const dir = join(homeDir, 'integrations');
  if (!existsSync(dir)) return [];
  const items: RegistryItem[] = [];
  const iconAssets = new IntegrationIconAssets(homeDir);
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const defPath = join(dir, entry.name, 'integration.json');
    if (!existsSync(defPath)) continue;
    try {
      const def = JSON.parse(readFileSync(defPath, 'utf-8'));
      // station#3063: the built-in files persist NO `command` — their spawn
      // identity is resolved at load time by the runtime overlay. Derive
      // binary presence from the same command the overlay actually spawns
      // with, so station-control/station-docs don't list as 'missing binary'
      // in the registry the moment the stripped schema lands on disk.
      const command =
        def.command ??
        builtinIntegrationRuntimeSpawnCommand(String(def.id ?? entry.name));
      let commandExists = false;
      if (command) {
        try {
          if (!isExecutableToken(command)) {
            throw new Error('Integration command must be one executable token');
          }
          execFileSync(
            process.platform === 'win32' ? 'where' : 'which',
            [command],
            {
              stdio: 'pipe',
              windowsHide: true,
            },
          );
          commandExists = true;
        } catch (error) {
          console.debug('Command not found for integration', error);
        }
      }
      const iconAsset = await iconAssets.resolve(entry.name);
      items.push({
        id: def.id || entry.name,
        displayName: def.displayName || entry.name,
        description: def.description || '',
        icon: typeof def.icon === 'string' ? def.icon : undefined,
        ...(iconAsset.status === 'found'
          ? { iconUrl: `/integrations/${encodeURIComponent(entry.name)}/icon` }
          : {}),
        installed: true,
        status: commandExists ? 'connected' : 'missing binary',
      });
    } catch (error) {
      console.debug(
        'Failed to read integration definition:',
        entry.name,
        error,
      );
    }
  }
  return items;
}

function isExecutableToken(command: unknown): command is string {
  return (
    typeof command === 'string' &&
    command.length > 0 &&
    command.length <= 128 &&
    /^[A-Za-z0-9._+-]+$/.test(command)
  );
}

export function mergeRegistryItems(
  diskItems: RegistryItem[],
  providerItems: RegistryItem[],
): RegistryItem[] {
  const seen = new Set<string>();
  const merged: RegistryItem[] = [];
  for (const item of diskItems) {
    if (!seen.has(item.id)) {
      seen.add(item.id);
      merged.push(item);
    }
  }
  for (const item of providerItems) {
    if (!seen.has(item.id)) {
      seen.add(item.id);
      merged.push(item);
    }
  }
  return merged;
}

export function createIntegrationRegistryProvider(
  providers: IIntegrationRegistryProvider[],
  homeDir = resolveHomeDir(),
): IIntegrationRegistryProvider {
  return {
    async listAvailable() {
      const results = await Promise.all(
        providers.map((provider) => provider.listAvailable()),
      );
      return mergeRegistryItems(
        await readDiskIntegrations(homeDir),
        results.flat(),
      );
    },
    async listInstalled() {
      const results = await Promise.all(
        providers.map((provider) => provider.listInstalled()),
      );
      return mergeRegistryItems(
        await readDiskIntegrations(homeDir),
        results.flat(),
      );
    },
    async install(id) {
      for (const provider of providers) {
        const result = await provider.install(id);
        if (result.success) return result;
      }
      return { success: false, message: `No provider could install ${id}` };
    },
    async uninstall(id) {
      for (const provider of providers) {
        const result = await provider.uninstall(id);
        if (result.success) return result;
      }
      return { success: false, message: `No provider could uninstall ${id}` };
    },
    async getToolDef(id) {
      for (const provider of providers) {
        const def = await provider.getToolDef(id);
        if (def) return def;
      }
      return null;
    },
    async sync() {
      await Promise.all(providers.map((provider) => provider.sync()));
    },
    async installByCommand(command) {
      for (const provider of providers) {
        if (provider.installByCommand) {
          const result = await provider.installByCommand(command);
          if (result.success) return result;
        }
      }
      return {
        success: false,
        message: `No provider could install command ${command}`,
      };
    },
  };
}

import { execFile } from 'node:child_process';
import type { Dirent } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { RegistryItem } from '@kontourai/station-contracts/catalog';
import type { ToolOrigin } from '@kontourai/station-contracts/tool';
import { builtinIntegrationRuntimeSpawnCommand } from '../../runtime/bootstrap/station-control-runtime-env.js';
import { IntegrationIconAssets } from '../../services/plugins/integration-icon-assets.js';
import { toolOriginLocation } from '../../services/plugins/integration-origin.js';
import { createLogger } from '../../utils/logger.js';
import { resolveHomeDir } from '../../utils/paths.js';
import type { IIntegrationRegistryProvider } from '../provider-interfaces.js';

const logger = createLogger({ name: 'integration-registry-provider' });

const execFileAsync = promisify(execFile);
const COMMAND_CACHE_TTL_MS = 30_000;
const COMMAND_CACHE_MAX_ENTRIES = 256;
const commandPresence = new Map<
  string,
  { expires: number; result: Promise<boolean> }
>();
let commandEnvironment = '';

function commandExists(command: unknown): Promise<boolean> {
  if (!isExecutableToken(command)) return Promise.resolve(false);
  // Relative PATH entries and Windows lookup also depend on cwd/PATHEXT.
  const environment = JSON.stringify([
    process.env.PATH,
    process.env.PATHEXT,
    process.cwd(),
  ]);
  if (environment !== commandEnvironment) {
    commandPresence.clear();
    commandEnvironment = environment;
  }
  const cached = commandPresence.get(command);
  if (cached && cached.expires > Date.now()) return cached.result;
  const result = execFileAsync(
    process.platform === 'win32' ? 'where' : 'which',
    [command],
    {
      windowsHide: true,
      timeout: 2_000,
      maxBuffer: 64 * 1024,
    },
  ).then(
    () => true,
    () => false,
  );
  if (commandPresence.size >= COMMAND_CACHE_MAX_ENTRIES) {
    commandPresence.delete(commandPresence.keys().next().value!);
  }
  commandPresence.set(command, {
    expires: Date.now() + COMMAND_CACHE_TTL_MS,
    result,
  });
  return result;
}

export async function readDiskIntegrations(
  homeDir = resolveHomeDir(),
): Promise<RegistryItem[]> {
  const dir = join(homeDir, 'integrations');
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const items: RegistryItem[] = [];
  const iconAssets = new IntegrationIconAssets(homeDir);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const defPath = join(dir, entry.name, 'integration.json');
    try {
      const def = JSON.parse(await readFile(defPath, 'utf-8'));
      // archive#3063: the built-in files persist NO `command` — their spawn
      // identity is resolved at load time by the runtime overlay. Derive
      // binary presence from the same command the overlay actually spawns
      // with, so station-control/station-docs don't list as 'missing binary'
      // in the registry the moment the stripped schema lands on disk.
      const command =
        def.command ??
        builtinIntegrationRuntimeSpawnCommand(String(def.id ?? entry.name));
      const present = await commandExists(command);
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
        status: present ? 'connected' : 'missing binary',
      });
    } catch (error) {
      logger.debug('Failed to read integration definition', {
        integration: entry.name,
        error,
      });
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
  providerSources: ReadonlyMap<
    IIntegrationRegistryProvider,
    string
  > = new Map(),
): IIntegrationRegistryProvider {
  const originFor = (
    provider: IIntegrationRegistryProvider,
    item: RegistryItem,
  ): ToolOrigin => ({
    kind: 'registry',
    registryId: toolOriginLocation(
      provider.registryKey || providerSources.get(provider),
    ),
    registryName:
      toolOriginLocation(
        provider.displayName ||
          provider.registryKey ||
          providerSources.get(provider),
      ) || 'Registry provider',
    itemId: item.id,
    version: item.version,
    location: toolOriginLocation(item.source),
  });
  return {
    async listAvailable() {
      const results = await Promise.all(
        providers.map(async (provider) =>
          (await provider.listAvailable()).map((item) => ({
            ...item,
            toolOrigin: originFor(provider, item),
          })),
        ),
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
    async installWithDefinition(id, expectedRegistryId) {
      for (const provider of providers) {
        const item = (await provider.listAvailable()).find(
          (entry) => entry.id === id,
        );
        if (
          !item ||
          (expectedRegistryId !== undefined &&
            originFor(provider, item).registryId !== expectedRegistryId)
        )
          continue;
        const result = await provider.install(id);
        if (!result.success) return { result };
        const definition = await provider.getToolDef(id);
        if (!definition)
          return {
            result: {
              success: false,
              message: 'The registry did not return an integration definition.',
            },
          };
        return { result, definition, origin: originFor(provider, item) };
      }
      return {
        result: { success: false, message: `No provider could install ${id}` },
      };
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

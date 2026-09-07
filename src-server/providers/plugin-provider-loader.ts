import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { PluginManifest } from '@kontourai/station-contracts/plugin';
import { publishGrantedPluginProviderGeneration } from '../services/plugins/plugin-installation-generation-fence.js';
import {
  type PluginProviderGrantSnapshot,
  withPluginProviderGrantSnapshot,
  withPluginProviderGrantsPublication,
} from '../services/plugins/plugin-permissions.js';
import type { Logger } from '../utils/logger.js';
import { assertExistingPathInside } from '../utils/path-containment.js';
import { isProviderAdapterShape } from './adapter-shape.js';
import {
  disposePreparedPluginProviders,
  type PreparedPluginProviderRegistration,
  pluginProviderRegistryGeneration,
  pluginProviderSourceGeneration,
  replacePluginProviders,
  replacePluginProvidersForSourceGeneration,
} from './registries/registry.js';

let pluginProviderImportRevision = 0;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function loadPluginProviders(
  pluginsDir: string,
  pluginName: string,
  manifest: PluginManifest,
  logger: Pick<Logger, 'error'>,
  options: { strict?: boolean } = {},
): Promise<number> {
  const expectedProviderGeneration = pluginProviderSourceGeneration(pluginName);
  const prepared = await preparePluginProviders(
    pluginsDir,
    pluginName,
    manifest,
    logger,
    options,
  );
  const outcome =
    prepared.length === 0
      ? await replacePluginProvidersForSourceGeneration(
          pluginName,
          expectedProviderGeneration,
          prepared,
          () => true,
        )
      : await publishGrantedPluginProviderGeneration({
          projectHomeDir: dirname(pluginsDir),
          pluginName,
          expectedProviderGeneration,
          prepared,
          isCurrent: () => true,
        });
  return outcome === 'activated' ? prepared.length : 0;
}

export interface PluginProviderGenerationBasis {
  readonly projectHomeDir: string;
  readonly expectedGeneration: number;
  readonly grantSnapshot: PluginProviderGrantSnapshot;
}

/** Bind the complete grant state, registry epoch, and candidate resolution. */
export async function capturePluginProviderGeneration<T>(
  projectHomeDir: string,
  resolveCandidates: () => T,
): Promise<{ basis: PluginProviderGenerationBasis; candidates: T }> {
  const captured = await withPluginProviderGrantSnapshot(
    projectHomeDir,
    () => ({
      expectedGeneration: pluginProviderRegistryGeneration(),
      candidates: resolveCandidates(),
    }),
  );
  return {
    basis: Object.freeze({
      projectHomeDir,
      expectedGeneration: captured.value.expectedGeneration,
      grantSnapshot: captured.snapshot,
    }),
    candidates: captured.value.candidates,
  };
}

/** Publishes a prepared reload through the same durable grant authority. */
export async function publishPluginProviderGeneration(
  basis: PluginProviderGenerationBasis,
  prepared: PreparedPluginProviderRegistration[],
): Promise<PreparedPluginProviderRegistration[]> {
  let registryOwnsPrepared = false;
  let unowned = prepared;
  try {
    const { projectHomeDir, expectedGeneration, grantSnapshot } = basis;
    if (typeof grantSnapshot !== 'string')
      throw new Error(
        'Plugin provider publication requires a captured grant snapshot.',
      );
    return await withPluginProviderGrantsPublication(
      projectHomeDir,
      prepared.map((entry) => entry.source),
      async (granted) => {
        // Dispose refused staging before publication. Do not transfer those
        // objects to the registry, which owns only the remaining accepted set.
        const accepted = prepared.filter((entry) => granted.has(entry.source));
        const acceptedHandles = new Set(
          accepted.map((entry) => entry.provider),
        );
        const refused = prepared.filter(
          (entry) =>
            !granted.has(entry.source) && !acceptedHandles.has(entry.provider),
        );
        unowned = accepted;
        await disposePreparedPluginProviders(refused);
        registryOwnsPrepared = true;
        await replacePluginProviders(
          accepted,
          () => pluginProviderRegistryGeneration() === expectedGeneration,
        );
        return accepted;
      },
      grantSnapshot,
    );
  } catch (error) {
    if (!registryOwnsPrepared) await disposePreparedPluginProviders(unowned);
    throw error;
  }
}

export interface PluginProviderPreparationRequest {
  pluginName: string;
  manifest: PluginManifest;
}

export class PluginProviderStagingError extends Error {
  readonly pluginName: string;
  readonly providerType?: string;

  constructor(cause: unknown, request: PluginProviderPreparationRequest) {
    super(errorMessage(cause), { cause });
    this.name = 'PluginProviderStagingError';
    this.pluginName = request.pluginName;
    this.providerType =
      request.manifest.providers?.length === 1
        ? request.manifest.providers[0].type
        : undefined;
  }
}

export async function preparePluginProviderGeneration(
  pluginsDir: string,
  requests: PluginProviderPreparationRequest[],
  logger: Pick<Logger, 'error'>,
): Promise<PreparedPluginProviderRegistration[]> {
  const prepared: PreparedPluginProviderRegistration[] = [];
  try {
    for (const request of requests) {
      try {
        prepared.push(
          ...(await preparePluginProviders(
            pluginsDir,
            request.pluginName,
            request.manifest,
            logger,
            { strict: true },
          )),
        );
      } catch (error) {
        throw new PluginProviderStagingError(error, request);
      }
    }
    return prepared;
  } catch (error) {
    try {
      await disposePreparedPluginProviders(prepared);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'Plugin provider staging and rollback both failed.',
      );
    }
    throw error;
  }
}

export async function preparePluginProviders(
  pluginsDir: string,
  pluginName: string,
  manifest: PluginManifest,
  logger: Pick<Logger, 'error'>,
  options: { strict?: boolean } = {},
): Promise<PreparedPluginProviderRegistration[]> {
  if (!manifest.providers) return [];

  const { ConfigLoader } = await import('../domain/config-loader.js');
  const configLoader = new ConfigLoader({
    projectHomeDir: dirname(pluginsDir),
  });
  const overrides = await configLoader.loadPluginOverrides();
  const pluginSettings = overrides[pluginName]?.settings || {};

  const prepared: PreparedPluginProviderRegistration[] = [];
  for (const provider of manifest.providers) {
    const pluginRoot = join(pluginsDir, pluginName);
    const modulePath = join(pluginRoot, provider.module);
    assertExistingPathInside(pluginRoot, modulePath, 'Plugin provider module');
    if (!existsSync(modulePath)) {
      if (options.strict) {
        throw new Error(`Plugin provider module not found: ${modulePath}`);
      }
      continue;
    }

    try {
      if (
        modulePath.endsWith('.json') &&
        (provider.type === 'agentRegistry' ||
          provider.type === 'integrationRegistry' ||
          provider.type === 'pluginRegistry')
      ) {
        const { JsonManifestRegistryProvider } = await import(
          './registries/json-manifest-registry.js'
        );
        const instance = new JsonManifestRegistryProvider(
          modulePath,
          dirname(pluginsDir),
          undefined,
          'warn' in logger ? (logger as Pick<Logger, 'warn'>) : undefined,
        );
        prepared.push({
          type: provider.type,
          provider:
            provider.type === 'integrationRegistry'
              ? instance.integrationRegistry()
              : instance,
          source: pluginName,
          layout: provider.layout,
        });
        continue;
      }

      const fileUrl = pathToFileURL(modulePath);
      fileUrl.searchParams.set(
        'stationPluginRevision',
        String(++pluginProviderImportRevision),
      );
      const mod = await import(fileUrl.href);
      const factory = mod.default || mod;
      let instance: unknown;
      try {
        instance =
          typeof factory === 'function' ? factory(pluginSettings) : factory;
      } catch (factoryError: unknown) {
        logger.error('Plugin provider factory threw', {
          plugin: pluginName,
          type: provider.type,
          error: errorMessage(factoryError),
        });
        if (options.strict) throw factoryError;
        continue;
      }

      if (provider.type === 'providerAdapter') {
        if (!isProviderAdapterShape(instance)) {
          const error = new Error('Invalid plugin provider adapter shape');
          if (options.strict) throw error;
          logger.error(error.message, {
            plugin: pluginName,
            type: provider.type,
          });
          continue;
        }
      }
      prepared.push({
        type: provider.type,
        provider: instance,
        source: pluginName,
        layout: provider.layout,
      });
    } catch (error: unknown) {
      if (options.strict) {
        try {
          await disposePreparedPluginProviders(prepared);
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            'Plugin provider preparation and cleanup both failed.',
          );
        }
        throw error;
      }
      logger.error('Failed to load provider', {
        plugin: pluginName,
        type: provider.type,
        error: errorMessage(error),
      });
    }
  }

  return prepared;
}

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  disposePreparedPluginProviders,
  type PreparedPluginProviderRegistration,
  replacePluginProvidersForSourceGeneration,
} from '../../providers/registries/registry.js';
import {
  computePluginContentDigest,
  withPluginContentLock,
} from './plugin-content-integrity.js';
import {
  type CapturedPluginPermissionArtifact,
  withPluginProviderGrantPublication,
} from './plugin-permissions.js';

export interface PluginInstallationGenerationFence {
  readonly installed: boolean;
  readonly installationGeneration: string | null;
}

/** Final publication seam used by retained activation inside its content lease. */
export async function publishGrantedPluginProviderGeneration(input: {
  projectHomeDir: string;
  pluginName: string;
  expectedProviderGeneration: number;
  prepared: PreparedPluginProviderRegistration[];
  isCurrent: () => boolean;
  artifact?: CapturedPluginPermissionArtifact;
}): Promise<'activated' | 'superseded'> {
  let registryOwnsPrepared = false;
  let publication:
    | { kind: 'applied'; value: 'activated' | 'superseded' }
    | { kind: 'superseded' };
  try {
    publication = await withPluginProviderGrantPublication(
      input.projectHomeDir,
      input.pluginName,
      () => {
        registryOwnsPrepared = true;
        return replacePluginProvidersForSourceGeneration(
          input.pluginName,
          input.expectedProviderGeneration,
          input.prepared,
          input.isCurrent,
        );
      },
      input.artifact,
    );
  } catch (error) {
    if (!registryOwnsPrepared)
      await disposePreparedPluginProviders(input.prepared);
    throw error;
  }
  if (publication.kind === 'superseded') {
    await disposePreparedPluginProviders(input.prepared);
    return 'superseded';
  }
  return publication.value;
}

/**
 * Holds the canonical plugin-content mutation lock from exact generation
 * validation through the caller's full effect. Reads/imports cannot therefore
 * authorize one tree and activate another while an update or removal waits.
 */
export async function withPluginInstallationGeneration<T>(input: {
  readonly pluginsDir: string;
  readonly pluginName: string;
  readonly expected: PluginInstallationGenerationFence;
  readonly effect: () => Promise<T>;
  readonly capture?: () => PluginInstallationGenerationFence;
}): Promise<
  | { readonly kind: 'applied'; readonly value: T }
  | { readonly kind: 'superseded' }
> {
  return withPluginContentLock(input.pluginsDir, input.pluginName, async () => {
    const current = input.capture?.() ?? {
      installed: existsSync(
        join(input.pluginsDir, input.pluginName, 'plugin.json'),
      ),
      installationGeneration: computePluginContentDigest(
        input.pluginsDir,
        input.pluginName,
      ),
    };
    const { installed, installationGeneration } = current;
    if (
      installed !== input.expected.installed ||
      installationGeneration !== input.expected.installationGeneration
    ) {
      return { kind: 'superseded' };
    }
    return { kind: 'applied', value: await input.effect() };
  });
}

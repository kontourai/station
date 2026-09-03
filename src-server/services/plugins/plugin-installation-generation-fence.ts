import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  computePluginContentDigest,
  withPluginContentLock,
} from './plugin-content-integrity.js';

export interface PluginInstallationGenerationFence {
  readonly installed: boolean;
  readonly installationGeneration: string | null;
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
}): Promise<
  | { readonly kind: 'applied'; readonly value: T }
  | { readonly kind: 'superseded' }
> {
  return withPluginContentLock(input.pluginsDir, input.pluginName, async () => {
    const installed = existsSync(
      join(input.pluginsDir, input.pluginName, 'plugin.json'),
    );
    const installationGeneration = computePluginContentDigest(
      input.pluginsDir,
      input.pluginName,
    );
    if (
      installed !== input.expected.installed ||
      installationGeneration !== input.expected.installationGeneration
    ) {
      return { kind: 'superseded' };
    }
    return { kind: 'applied', value: await input.effect() };
  });
}

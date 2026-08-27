import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import { join, resolve, sep } from 'node:path';
import type { PluginManifest } from '@kontourai/station-contracts/plugin';
import { buildPlugin as buildPluginBundle } from '@kontourai/station-shared/build';
import type { Logger } from '../../utils/logger.js';
import { errorMessage } from '../schemas/schemas.js';

function containedRegularFile(root: string, candidate: string): string | null {
  if (!existsSync(root)) return null;
  const rootStat = lstatSync(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) return null;
  if (!existsSync(candidate)) return null;
  const candidateStat = lstatSync(candidate);
  if (candidateStat.isSymbolicLink() || !candidateStat.isFile()) return null;
  const rootPath = realpathSync(root);
  const candidatePath = realpathSync(candidate);
  if (
    candidatePath !== rootPath &&
    !candidatePath.startsWith(`${rootPath}${sep}`)
  ) {
    return null;
  }
  const lexicalRoot = resolve(root);
  const lexicalCandidate = resolve(candidate);
  if (
    lexicalCandidate !== lexicalRoot &&
    !lexicalCandidate.startsWith(`${lexicalRoot}${sep}`)
  ) {
    return null;
  }
  return candidatePath;
}

function containedPluginRoot(pluginsDir: string, pluginRoot: string): boolean {
  if (!existsSync(pluginRoot)) return false;
  const pluginRootStat = lstatSync(pluginRoot);
  if (pluginRootStat.isSymbolicLink() || !pluginRootStat.isDirectory()) {
    return false;
  }
  const pluginsPath = realpathSync(pluginsDir);
  const pluginPath = realpathSync(pluginRoot);
  return (
    pluginPath === pluginsPath || pluginPath.startsWith(`${pluginsPath}${sep}`)
  );
}

export function assertPluginBundleAssetsContained(pluginDir: string): void {
  for (const file of ['bundle.js', 'bundle.css']) {
    const assetPath = join(pluginDir, 'dist', file);
    if (existsSync(assetPath) && !containedRegularFile(pluginDir, assetPath)) {
      throw new Error(`Plugin bundle asset escapes plugin root: ${file}`);
    }
  }
}

/** Resolve a plugin bundle file by manifest name (not folder name). */
export function resolvePluginBundle(
  pluginsDir: string,
  name: string,
  file: string,
  logger: Logger,
): string | null {
  const directPluginRoot = join(pluginsDir, name);
  if (containedPluginRoot(pluginsDir, directPluginRoot)) {
    const direct = containedRegularFile(
      directPluginRoot,
      join(directPluginRoot, 'dist', file),
    );
    if (direct) return direct;
  }
  if (!existsSync(pluginsDir)) return null;

  for (const entry of readdirSync(pluginsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const pluginRoot = join(pluginsDir, entry.name);
    if (!containedPluginRoot(pluginsDir, pluginRoot)) continue;

    try {
      const manifest = JSON.parse(
        readFileSync(join(pluginRoot, 'plugin.json'), 'utf-8'),
      ) as PluginManifest;
      if (manifest.name === name) {
        return containedRegularFile(pluginRoot, join(pluginRoot, 'dist', file));
      }
    } catch (error) {
      logger.debug('Failed to read plugin manifest for bundle resolution', {
        error,
      });
    }
  }

  return null;
}

/** Run plugin build if build script or entrypoint exists. */
export async function buildPlugin(
  pluginDir: string,
  name: string,
  logger: Logger,
): Promise<void> {
  try {
    const result = await buildPluginBundle(pluginDir);
    if (result.built) {
      logger.info(`Plugin ${name}: build complete`);
    }
  } catch (error: unknown) {
    logger.error(`Plugin ${name}: build failed`, {
      error: errorMessage(error),
    });
    throw new Error(`Build failed: ${errorMessage(error)}`);
  }
}

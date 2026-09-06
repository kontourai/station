import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import type { PluginManifest } from '@kontourai/station-contracts/plugin';
import { buildPlugin as buildPluginBundle } from '@kontourai/station-shared/build';
import type { PackageMcpAdmissionJournal } from '../../services/plugins/package-mcp-admission.js';
import { capturePluginRuntimeArtifact } from '../../services/plugins/plugin-runtime-artifact.js';
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

export function assertPluginBundleAssetsContained(pluginDir: string): void {
  for (const file of ['bundle.js', 'bundle.css']) {
    const assetPath = join(pluginDir, 'dist', file);
    if (existsSync(assetPath) && !containedRegularFile(pluginDir, assetPath)) {
      throw new Error(`Plugin bundle asset escapes plugin root: ${file}`);
    }
  }
}

/** Resolve executable bytes only from the current admitted installation. */
export function resolvePluginBundle(
  pluginsDir: string,
  name: string,
  file: 'bundle.js' | 'bundle.css',
  journal?: PackageMcpAdmissionJournal,
): { path: string; isCurrent(): boolean } | null {
  const artifact = capturePluginRuntimeArtifact(pluginsDir, name, journal);
  if (!artifact) return null;
  const path = containedRegularFile(
    artifact.packageRoot,
    join(artifact.packageRoot, 'dist', file),
  );
  return path && artifact.isCurrent()
    ? { path, isCurrent: artifact.isCurrent }
    : null;
}

/** Capture before reading and check again before delivering executable bytes. */
export async function readPluginBundle(
  pluginsDir: string,
  name: string,
  file: 'bundle.js' | 'bundle.css',
  journal?: PackageMcpAdmissionJournal,
): Promise<string | null> {
  try {
    const bundle = resolvePluginBundle(pluginsDir, name, file, journal);
    if (!bundle?.isCurrent()) return null;
    const content = await readFile(bundle.path, 'utf8');
    return bundle.isCurrent() ? content : null;
  } catch {
    return null;
  }
}

/** Run plugin build if build script or entrypoint exists. */
export async function buildPlugin(
  pluginDir: string,
  name: string,
  logger: Logger,
  manifest?: PluginManifest,
): Promise<void> {
  try {
    const result = await buildPluginBundle(pluginDir, 'production', manifest);
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

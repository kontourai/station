import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import type { PluginManifest } from '@kontourai/station-contracts/plugin';
import type { SkillExperienceIdentityV1 } from '@kontourai/station-contracts/skill-experience';
import { buildPlugin as buildPluginBundle } from '@kontourai/station-shared/build';
import type { PackageMcpAdmissionJournal } from '../../services/plugins/package-mcp-admission.js';
import { withPluginPermissionInvocation } from '../../services/plugins/plugin-permissions.js';
import { capturePluginRuntimeArtifactAsync } from '../../services/plugins/plugin-runtime-artifact.js';
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

/** Capture before reading and check again before delivering executable bytes. */
export async function readPluginBundle(
  pluginsDir: string,
  name: string,
  file: 'bundle.js' | 'bundle.css',
  journal?: PackageMcpAdmissionJournal,
  expectedExperience?: SkillExperienceIdentityV1,
): Promise<string | null> {
  try {
    const artifact = await capturePluginRuntimeArtifactAsync(
      pluginsDir,
      name,
      journal,
    );
    if (!artifact) return null;
    if (expectedExperience) {
      const current = journal?.currentInstallation(name);
      if (
        expectedExperience.pluginId !== name ||
        expectedExperience.pluginVersion !== artifact.manifest.version ||
        expectedExperience.incarnation !== artifact.generation ||
        expectedExperience.contentDigest !== artifact.digest ||
        current?.state !== 'observed' ||
        current.installation.materialization !==
          expectedExperience.materialization
      )
        return null;
    }
    const path = containedRegularFile(
      artifact.packageRoot,
      join(artifact.packageRoot, 'dist', file),
    );
    if (!path) return null;
    const deliver = async () => {
      const content = await readFile(path, 'utf8');
      return (await artifact.isCurrentAsync()) ? content : null;
    };
    return expectedExperience
      ? await withPluginPermissionInvocation(
          dirname(pluginsDir),
          name,
          'agents.invoke',
          deliver,
          artifact,
        )
      : await deliver();
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
    for (const warning of result.warnings ?? []) {
      logger.warn(`Plugin ${name}: ${warning}`);
    }
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

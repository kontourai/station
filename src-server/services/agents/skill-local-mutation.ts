/**
 * The one cross-process capability for a local Skill package.  Writers and
 * conditional readers share this exact lock name; do not wrap an owned helper
 * in this function again, since file locks are deliberately not re-entrant.
 */
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { acquireFileMutationLockAsync } from '@kontourai/station-shared/lifecycle-events';
import { resolveSkillDirectory } from './skill-metadata.js';

export async function withLocalSkillMutation<T>(
  names: string[],
  projectHomeDir: string,
  projectSlug: string | undefined,
  effect: () => Promise<T>,
): Promise<T> {
  const targets = [
    ...new Set(
      names.map((name) =>
        resolveSkillDirectory(projectHomeDir, name, projectSlug),
      ),
    ),
  ].sort((a, b) => a.localeCompare(b));
  const releases: Array<() => Promise<void>> = [];
  try {
    for (const target of targets) {
      await mkdir(dirname(target), { recursive: true });
      releases.push(await acquireFileMutationLockAsync(`${target}.mutation`));
    }
    return await effect();
  } finally {
    for (const release of releases.reverse()) await release();
  }
}

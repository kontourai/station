/**
 * The one cross-process capability for a local Skill package.  Writers and
 * conditional readers share this exact lock name; do not wrap an owned helper
 * in this function again, since file locks are deliberately not re-entrant.
 *
 * IT LOCKS DIRECTORIES, not names. The lock has to name the same thing the
 * write touches, and since #1619 a write resolves its directory from where
 * DISCOVERY found the package rather than from a name plus a project slug no
 * route supplies. Keyed on `resolveSkillDirectory(home, name, slug)`, two
 * callers holding different slugs for one package took two different locks and
 * excluded nobody.
 *
 * COMPATIBILITY: the lock file for a workspace package therefore moves from
 * `<home>/skills/<name>.mutation` to
 * `<home>/projects/<slug>/skills/<name>.mutation`. Nothing persists or reads
 * that path — it is constructed here and nowhere else, released by deletion,
 * and reclaimed by pid+birth when stale — but during an upgrade an old process
 * and a new one would take different names for the same workspace package, so
 * mutual exclusion does not hold across mixed versions for that population.
 * Machine-root packages keep a byte-identical name.
 */
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { acquireFileMutationLockAsync } from '@kontourai/station-shared/lifecycle-events';

export async function withLocalSkillMutation<T>(
  directories: string[],
  effect: () => Promise<T>,
): Promise<T> {
  const targets = [...new Set(directories)].sort((a, b) => a.localeCompare(b));
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

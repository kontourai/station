import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The repository's owned dependency bootstrap script (station#1747). It
 * installs through the pinned pnpm and arms only reviewed lifecycle hooks; a
 * raw `npm install` is not a fallback — that is the defect it replaced.
 *
 * Both `station upgrade` (packages/cli) and the server's core-update route
 * (#2673) run `npm run <this>` after `git pull`, and
 * {@link ownedDependencyInstallerUnavailable} checks this same binding, so the
 * name the check verifies and the name the callers run cannot drift apart.
 */
export const OWNED_DEPENDENCY_INSTALL_SCRIPT = 'dependencies:install';

function describeThrown(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Why the pulled tree cannot run the owned installer, or `null` when it can.
 *
 * `git pull` can leave any tree the upstream branch happens to name, so the
 * two things `npm run dependencies:install` needs are checked before it is
 * spawned: the script binding and the script itself. There is no fallback,
 * so the caller refuses and says which file is missing.
 *
 * `describeError` renders a read/parse failure. The CLI prints the raw
 * message to its own terminal (the default); the server passes its route
 * error sanitizer, because the result lands in an HTTP response.
 */
export function ownedDependencyInstallerUnavailable(
  gitRoot: string,
  describeError: (error: unknown) => string = describeThrown,
): string | null {
  const manifestPath = join(gitRoot, 'package.json');
  let script: unknown;
  try {
    script = (
      JSON.parse(readFileSync(manifestPath, 'utf-8')) as {
        scripts?: Record<string, unknown>;
      }
    ).scripts?.[OWNED_DEPENDENCY_INSTALL_SCRIPT];
  } catch (error) {
    return `${manifestPath} could not be read as JSON (${describeError(error)})`;
  }
  if (typeof script !== 'string') {
    return `${manifestPath} does not define the "${OWNED_DEPENDENCY_INSTALL_SCRIPT}" script`;
  }
  const lifecyclePath = join(gitRoot, 'scripts', 'dependency-lifecycle.mjs');
  if (!existsSync(lifecyclePath)) return `${lifecyclePath} is missing`;
  return null;
}

/**
 * The build root bounds which programs the supervisor will run as a core
 * generation. A control client holding the token can ask for a handoff to a
 * new entry; without this bound that is "run any program as the Station
 * server".
 */
import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

type EntryCheck = { entry: string } | { refused: 'entry-outside-build-root' };

const ENTRY_EXTENSION = /\.m?js$/;

/**
 * Returns a checker that accepts an entry only when its real path is a
 * regular `.js` or `.mjs` file strictly inside the build root's real path.
 * Relative entries resolve against the build root. Containment is by path
 * segment, so `/a/b2` is not inside `/a/b`, and a symlink is judged by where
 * it points. The accepted entry is returned as that real path.
 */
export function createEntryBoundary(
  buildRoot: string,
): (entry: string) => EntryCheck {
  const root = realpathSync(buildRoot);
  const refused = { refused: 'entry-outside-build-root' } as const;
  return (entry) => {
    let real: string;
    try {
      real = realpathSync(resolve(root, entry));
    } catch {
      return refused;
    }
    const rel = relative(root, real);
    // `relative` yields an absolute path across Windows drives.
    if (
      rel === '' ||
      rel === '..' ||
      rel.startsWith(`..${sep}`) ||
      isAbsolute(rel)
    ) {
      return refused;
    }
    if (!ENTRY_EXTENSION.test(real)) return refused;
    try {
      if (!statSync(real).isFile()) return refused;
    } catch {
      return refused;
    }
    return { entry: real };
  };
}

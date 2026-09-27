import { existsSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { expandTilde } from './paths.js';

export function assertPathInside(
  root: string,
  candidate: string,
  label: string,
): void {
  const rootPath = resolve(root);
  const candidatePath = resolve(candidate);
  if (
    candidatePath !== rootPath &&
    !candidatePath.startsWith(`${rootPath}${sep}`)
  ) {
    throw new Error(`${label} escapes root`);
  }
}

export function assertExistingPathInside(
  root: string,
  candidate: string,
  label: string,
): void {
  assertPathInside(root, candidate, label);
  if (!existsSync(candidate)) return;
  const rootPath = realpathSync(root);
  const candidatePath = realpathSync(candidate);
  if (
    candidatePath !== rootPath &&
    !candidatePath.startsWith(`${rootPath}${sep}`)
  ) {
    throw new Error(`${label} escapes root`);
  }
}

/**
 * #2377 slice C2a: a path in its one canonical form — tilde expanded,
 * resolved, and `realpath`ed (every symlink followed, no trailing
 * separator). Throws when the path does not exist or cannot be read.
 */
export function canonicalPath(path: string): string {
  return realpathSync.native(resolve(expandTilde(path)));
}

/**
 * Whether canonical `candidate` is canonical `root` or lies inside it, by
 * whole path segments (`/a/proj-2` is not inside `/a/proj`). Both must
 * already be canonical ({@link canonicalPath}).
 */
export function isCanonicalPathWithin(
  root: string,
  candidate: string,
): boolean {
  const rel = relative(root, candidate);
  return (
    rel === '' ||
    (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
  );
}

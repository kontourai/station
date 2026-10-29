import { lstatSync, realpathSync } from 'node:fs';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
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

/**
 * Refuse `candidate` unless the filesystem resolves it inside `root`.
 *
 * Both sides use `realpathSync.native` (#1502): the JS `realpathSync` expands
 * `..` lexically after a symlink, so a chain such as `dir/up/../outside`
 * (`up -> ..`) reports a decoy inside the root while the OS reads the file
 * outside it. When the candidate does not exist yet, its nearest existing
 * ancestor is resolved instead, so a later create under a symlinked parent
 * cannot land outside. Dangling and cyclic links fail closed. This decides
 * containment at call time only; it does not stop a link being retargeted
 * before the caller's own filesystem operation.
 */
export function assertExistingPathInside(
  root: string,
  candidate: string,
  label: string,
): void {
  assertPathInside(root, candidate, label);
  let rootPath: string;
  try {
    rootPath = realpathSync.native(root);
  } catch (error) {
    // Nothing can exist beneath a root that is absent (not merely a dangling
    // link), and the lexical check above already held.
    if (errorCode(error) === 'ENOENT' && isAbsent(root)) return;
    throw new Error(`${label} root cannot be resolved (${errorCode(error)})`);
  }
  let resolved: string;
  try {
    let existing = candidate;
    const missing: string[] = [];
    while (!lstatExists(existing)) {
      const parent = dirname(existing);
      if (parent === existing) throw new Error('no existing ancestor');
      missing.unshift(basename(existing));
      existing = parent;
    }
    resolved = join(realpathSync.native(existing), ...missing);
  } catch (error) {
    throw new Error(`${label} cannot be resolved (${errorCode(error)})`);
  }
  if (!isCanonicalPathWithin(rootPath, resolved)) {
    throw new Error(`${label} escapes root`);
  }
}

function isAbsent(path: string): boolean {
  try {
    return !lstatExists(path);
  } catch {
    return false;
  }
}

function lstatExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    const code = errorCode(error);
    if (code === 'ENOENT' || code === 'ENOTDIR') return false;
    throw error;
  }
}

function errorCode(error: unknown): string {
  return typeof (error as NodeJS.ErrnoException)?.code === 'string'
    ? (error as NodeJS.ErrnoException).code!
    : 'unknown';
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

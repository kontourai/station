import { lstat, mkdir, readdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { PluginScaffoldFile } from '@kontourai/station-shared/plugin-scaffold';
import {
  assertExistingPathInside,
  assertPathInside,
} from '../../utils/path-containment.js';

/**
 * Entries a freshly made folder may already hold without the person having
 * put anything in it: an initialized repository and Finder's metadata. Any
 * other entry means the folder holds someone's work, and a scaffold never
 * lands on top of that.
 */
export const IGNORABLE_SCAFFOLD_DIRECTORY_ENTRIES: ReadonlySet<string> =
  new Set(['.git', '.DS_Store']);

/** How many offending entries a refusal names; the count is always exact. */
const MAX_REPORTED_ENTRIES = 10;

export type PluginScaffoldWriteRefusal =
  | { code: 'working-directory-missing' }
  | { code: 'working-directory-not-a-directory' }
  | {
      code: 'working-directory-not-empty';
      /** Sorted, at most {@link MAX_REPORTED_ENTRIES}. */
      entries: string[];
      entryCount: number;
    }
  | { code: 'path-escapes-working-directory'; path: string }
  | { code: 'file-exists'; path: string; written: string[] };

export type PluginScaffoldWriteResult =
  | { ok: true; written: string[] }
  | { ok: false; refusal: PluginScaffoldWriteRefusal };

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    (error as { code?: unknown }).code === code
  );
}

/**
 * Writes a scaffold into an existing, empty directory. Refuses rather than
 * overwrites: the emptiness check runs first, and every file is still
 * created with `wx`, so a file that appears between the check and the write
 * is reported instead of replaced.
 *
 * Containment is checked twice per file: lexically before any write, and
 * against the real path of its parent after the parent exists, so a
 * symlinked subdirectory cannot carry a write out of the folder.
 */
export async function writePluginScaffold(
  workingDirectory: string,
  files: readonly PluginScaffoldFile[],
): Promise<PluginScaffoldWriteResult> {
  try {
    const stats = await lstat(workingDirectory);
    // A symlinked folder is followed once, here: the Project names this
    // path, and everything below is contained within its real target.
    if (!stats.isDirectory() && !stats.isSymbolicLink()) {
      return {
        ok: false,
        refusal: { code: 'working-directory-not-a-directory' },
      };
    }
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) {
      return { ok: false, refusal: { code: 'working-directory-missing' } };
    }
    throw error;
  }

  let root: string;
  try {
    root = await realpath(workingDirectory);
    if (!(await lstat(root)).isDirectory()) {
      return {
        ok: false,
        refusal: { code: 'working-directory-not-a-directory' },
      };
    }
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) {
      return { ok: false, refusal: { code: 'working-directory-missing' } };
    }
    throw error;
  }

  const occupied = (await readdir(root))
    .filter((entry) => !IGNORABLE_SCAFFOLD_DIRECTORY_ENTRIES.has(entry))
    .sort();
  if (occupied.length > 0) {
    return {
      ok: false,
      refusal: {
        code: 'working-directory-not-empty',
        entries: occupied.slice(0, MAX_REPORTED_ENTRIES),
        entryCount: occupied.length,
      },
    };
  }

  // Every target is proven lexically inside the folder before the first
  // write, so a bad path cannot leave a partial scaffold behind.
  const targets = files.map((file) => ({
    file,
    target: resolve(root, file.path),
  }));
  for (const { file, target } of targets) {
    try {
      assertPathInside(root, target, 'Plugin scaffold file');
    } catch {
      return {
        ok: false,
        refusal: { code: 'path-escapes-working-directory', path: file.path },
      };
    }
  }

  const written: string[] = [];
  for (const { file, target } of targets) {
    const parent = dirname(target);
    await mkdir(parent, { recursive: true });
    try {
      assertExistingPathInside(root, parent, 'Plugin scaffold directory');
    } catch {
      return {
        ok: false,
        refusal: { code: 'path-escapes-working-directory', path: file.path },
      };
    }
    try {
      await writeFile(target, file.contents, { flag: 'wx' });
    } catch (error) {
      if (hasErrorCode(error, 'EEXIST')) {
        return {
          ok: false,
          refusal: { code: 'file-exists', path: file.path, written },
        };
      }
      throw error;
    }
    written.push(file.path);
  }
  return { ok: true, written };
}

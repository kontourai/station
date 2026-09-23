import {
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  writeFile,
} from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
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

/**
 * How far the retry check walks an occupied folder before deciding it holds
 * someone's work. A scaffold is well under this; anything larger is not one.
 */
const MAX_INSPECTED_ENTRIES = 64;

export type PluginScaffoldWriteRefusal =
  | { code: 'working-directory-missing' }
  | { code: 'working-directory-not-a-directory' }
  | {
      code: 'working-directory-not-empty';
      /** Sorted, at most {@link MAX_REPORTED_ENTRIES}. */
      entries: string[];
      entryCount: number;
    }
  | {
      /**
       * The folder holds some of this exact scaffold and nothing else: an
       * earlier attempt stopped part way. Nothing is overwritten or filled in.
       */
      code: 'partial-scaffold';
      /** Scaffold files already present, byte-identical. Sorted. */
      present: string[];
      missingCount: number;
    }
  | { code: 'path-escapes-working-directory'; path: string }
  | { code: 'file-exists'; path: string; written: string[] };

export type PluginScaffoldWriteResult =
  | {
      ok: true;
      written: string[];
      /**
       * True when the folder already held exactly this scaffold, byte for
       * byte (a retry after a lost answer). Nothing was written.
       */
      alreadyPresent: boolean;
    }
  | { ok: false; refusal: PluginScaffoldWriteRefusal };

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    (error as { code?: unknown }).code === code
  );
}

function toPosix(path: string): string {
  return path.split(sep).join('/');
}

type Occupancy =
  | { kind: 'empty' }
  | { kind: 'foreign'; entries: string[] }
  | { kind: 'scaffold'; present: string[] };

/**
 * Classifies what is already in the folder against the scaffold about to be
 * written. Only regular files whose path AND bytes match the scaffold count
 * as "this scaffold"; a symlink, an extra file, a changed file, or a folder
 * the scaffold does not create makes the folder someone's work.
 */
async function inspectOccupancy(
  root: string,
  files: readonly PluginScaffoldFile[],
): Promise<Occupancy> {
  const topLevel = (await readdir(root))
    .filter((entry) => !IGNORABLE_SCAFFOLD_DIRECTORY_ENTRIES.has(entry))
    .sort();
  if (topLevel.length === 0) return { kind: 'empty' };
  const foreign = { kind: 'foreign', entries: topLevel } as const;

  const expected = new Map(files.map((file) => [file.path, file.contents]));
  const scaffoldDirectories = new Set<string>();
  for (const path of expected.keys()) {
    const segments = path.split('/');
    for (let depth = 1; depth < segments.length; depth += 1)
      scaffoldDirectories.add(segments.slice(0, depth).join('/'));
  }

  const present: string[] = [];
  const pending = [...topLevel];
  let inspected = 0;
  while (pending.length > 0) {
    const path = pending.shift()!;
    inspected += 1;
    if (inspected > MAX_INSPECTED_ENTRIES) return foreign;
    const absolute = join(root, ...path.split('/'));
    const stats = await lstat(absolute);
    if (stats.isDirectory() && scaffoldDirectories.has(path)) {
      for (const child of await readdir(absolute))
        pending.push(`${path}/${child}`);
      continue;
    }
    const contents = expected.get(path);
    if (!stats.isFile() || contents === undefined) return foreign;
    if ((await readFile(absolute, 'utf8')) !== contents) return foreign;
    present.push(path);
  }
  return { kind: 'scaffold', present: present.sort() };
}

/**
 * Creates `directory` (inside `root`) one level at a time. Every level that
 * already exists must be a real directory, not a symlink, and must still
 * resolve inside the root; a level is created only after its parent passed
 * that check. A symlinked subdirectory therefore cannot carry directory
 * creation, or the file write after it, outside the folder.
 */
export async function ensureContainedDirectory(
  root: string,
  directory: string,
): Promise<boolean> {
  const segments = relative(root, directory).split(sep).filter(Boolean);
  let current = root;
  for (const segment of segments) {
    current = join(current, segment);
    try {
      await mkdir(current);
    } catch (error) {
      if (!hasErrorCode(error, 'EEXIST')) throw error;
    }
    const stats = await lstat(current);
    if (!stats.isDirectory()) return false;
    try {
      assertExistingPathInside(root, current, 'Plugin scaffold directory');
    } catch {
      return false;
    }
  }
  return true;
}

export type PluginScaffoldFolderState =
  | 'empty'
  | 'occupied'
  | 'working-directory-missing'
  | 'working-directory-not-a-directory';

/**
 * Read-only: whether a scaffold could be written into this folder right now
 * (it exists, is a directory, and holds nothing besides `.git`/`.DS_Store`).
 * It writes nothing and names no entries.
 */
export async function inspectPluginScaffoldFolder(
  workingDirectory: string,
): Promise<PluginScaffoldFolderState> {
  let root: string;
  try {
    root = await realpath(workingDirectory);
    if (!(await lstat(root)).isDirectory())
      return 'working-directory-not-a-directory';
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) return 'working-directory-missing';
    if (hasErrorCode(error, 'ENOTDIR'))
      return 'working-directory-not-a-directory';
    throw error;
  }
  const occupied = (await readdir(root)).some(
    (entry) => !IGNORABLE_SCAFFOLD_DIRECTORY_ENTRIES.has(entry),
  );
  return occupied ? 'occupied' : 'empty';
}

/**
 * Writes a scaffold into an existing, empty directory. Refuses rather than
 * overwrites: the occupancy check runs first, and every file is still
 * created with `wx`, so a file that appears between the check and the write
 * is reported instead of replaced.
 *
 * A retry into a folder that already holds exactly this scaffold succeeds
 * without writing, so a lost answer does not strand the person on "not
 * empty"; a folder holding only part of it is named as such.
 *
 * Containment is checked lexically for every file before any write, then
 * per directory level as the tree is created.
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

  // Every target is proven lexically inside the folder before anything is
  // read or written, so a bad path cannot leave a partial scaffold behind.
  const targets = files.map((file) => ({
    file,
    target: resolve(root, file.path),
  }));
  for (const { file, target } of targets) {
    try {
      assertPathInside(root, target, 'Plugin scaffold file');
      // Only plain relative paths: the occupancy check keys on them.
      if (toPosix(relative(root, target)) !== file.path) throw new Error();
    } catch {
      return {
        ok: false,
        refusal: { code: 'path-escapes-working-directory', path: file.path },
      };
    }
  }

  const occupancy = await inspectOccupancy(root, files);
  if (occupancy.kind === 'foreign') {
    return {
      ok: false,
      refusal: {
        code: 'working-directory-not-empty',
        entries: occupancy.entries.slice(0, MAX_REPORTED_ENTRIES),
        entryCount: occupancy.entries.length,
      },
    };
  }
  if (occupancy.kind === 'scaffold') {
    if (occupancy.present.length === files.length) {
      return { ok: true, written: [], alreadyPresent: true };
    }
    return {
      ok: false,
      refusal: {
        code: 'partial-scaffold',
        present: occupancy.present,
        missingCount: files.length - occupancy.present.length,
      },
    };
  }

  const written: string[] = [];
  for (const { file, target } of targets) {
    if (!(await ensureContainedDirectory(root, resolve(target, '..')))) {
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
  return { ok: true, written, alreadyPresent: false };
}

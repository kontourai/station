/**
 * Reads a plugin Project's folder for publishing (#2374, epic #2323 S6),
 * WITHOUT git and without following a symbolic link anywhere.
 *
 * Publishing is an export: the bytes read here are the bytes committed and
 * pushed, and nothing else in the folder is read. In particular the
 * folder's own `.git` (any entry whose name folds to `.git`) is never
 * opened, listed or descended into. That repository can be written by an
 * agent or a Project member, and three review rounds of the first design
 * (which ran git in the folder) showed that neither its config, its index
 * nor its object store can be trusted, and that git's own writes follow
 * symbolic links planted inside it.
 *
 * How a file is read, and what each step defends:
 * - A directory is descended into only when `lstat` says it is a directory
 *   (a symbolic link to a directory is skipped, never followed), and its
 *   device and inode are recorded.
 * - A file is opened with `O_NOFOLLOW` (and `O_NONBLOCK`, so a file swapped
 *   for a named pipe cannot hang the read), and the OPEN descriptor must be
 *   the regular file `lstat` saw during the walk: same device, same inode.
 *   A parent directory swapped for a link between the walk and the open
 *   (and swapped back after) leads the open somewhere else, and this is the
 *   check that notices.
 * - After the read, every directory from the folder down to the file's
 *   parent is `lstat`ed again and must still be the directory the walk
 *   recorded. A folder that changes shape while it is read is refused.
 * - A regular file with another hard link is refused: its other name can be
 *   anywhere on this computer, which is the same leak a link would be.
 * - Each file is read ONCE, and those bytes are what the secret scan reads
 *   and what is committed.
 *
 * The limit, stated: Node has no `openat`, so the walk resolves paths from
 * the folder's root each time. The inode match closes the window in which a
 * swapped parent would substitute a different file; it cannot stop `open`
 * from briefly visiting a swapped path first.
 *
 * `.gitignore` rules are honoured as git would, through `IgnoreOracle`,
 * which a Station-owned repository answers from the `.gitignore` bytes this
 * walk read. An ignored directory is not descended into.
 */
import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';

/** Why an entry was left out, not refused. The UI words each. */
export type SnapshotSkipReason =
  | 'symbolic-link'
  | 'special-file'
  | 'git-metadata';

export interface SnapshotSkip {
  path: string;
  reason: SnapshotSkipReason;
}

export interface SnapshotFile {
  /** Relative, `/`-separated, validated (`unsafeRelativePathReason`). */
  path: string;
  executable: boolean;
  bytes: Buffer;
}

export type SnapshotRefusal =
  | { code: 'folder-unreadable' }
  | { code: 'unsafe-path'; paths: string[] }
  | { code: 'linked-file'; paths: string[] }
  | { code: 'folder-changed'; paths: string[] }
  | { code: 'too-many-files' }
  | { code: 'too-large' };

export type SnapshotResult =
  | { ok: true; files: SnapshotFile[]; skipped: SnapshotSkip[] }
  | { ok: false; refusal: SnapshotRefusal };

/**
 * Answers "which of these paths does `.gitignore` exclude?" as git would.
 * The walk tells it about every `.gitignore` it read (its bytes) and every
 * directory it saw, before asking about that directory's entries.
 */
export interface IgnoreOracle {
  directory(path: string): Promise<void>;
  ignoreFile(directory: string, bytes: Buffer): Promise<void>;
  ignored(paths: readonly string[]): Promise<Set<string>>;
}

export interface SnapshotLimits {
  maxFiles: number;
  maxBytes: number;
  maxDepth: number;
}

const DEFAULT_SNAPSHOT_LIMITS: SnapshotLimits = {
  maxFiles: 1000,
  maxBytes: 50 * 1024 * 1024,
  maxDepth: 32,
};

/**
 * TEST SEAMS for the moments a writer racing the publish would act: just
 * before a file is opened, and just after it was read. Production never
 * passes them.
 */
export interface SnapshotHooks {
  beforeOpen?: (path: string) => Promise<void> | void;
  afterRead?: (path: string) => Promise<void> | void;
}

// Code points that render as nothing: HFS+ ignores them when comparing
// names, so ".g" + U+200C + "it" IS ".git" on a Mac checkout.
const IGNORABLE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x200b, 0x200f],
  [0x202a, 0x202e],
  [0x2060, 0x2064],
  [0x206a, 0x206f],
  [0xfeff, 0xfeff],
];

function isIgnorable(code: number): boolean {
  return IGNORABLE_RANGES.some(([low, high]) => code >= low && code <= high);
}

/** Control characters, and U+FFFD, which is what a name that is not valid
 * UTF-8 reads as: git would receive a different name than the one on disk. */
function isUnsafeCharacter(code: number): boolean {
  return code <= 0x1f || code === 0x7f || code === 0xfffd;
}

function codePoints(text: string): number[] {
  return Array.from(text, (character) => character.codePointAt(0) ?? 0);
}

/**
 * True for a name git treats as its own directory on some filesystem: `.git`
 * in any case, with ignorable characters or trailing dots and spaces
 * (Windows drops those), and its 8.3 short name.
 */
function isGitMetadataName(name: string): boolean {
  const folded = String.fromCodePoint(
    ...codePoints(name).filter((code) => !isIgnorable(code)),
  )
    .replace(/[. ]+$/, '')
    .toLowerCase();
  return folded === '.git' || folded === 'git~1';
}

/**
 * Why a relative path cannot be published, or `null`. Checked on every path
 * that reaches git, whatever produced it.
 */
export function unsafeRelativePathReason(path: string): string | null {
  if (path === '') return 'empty path';
  if (path.startsWith('/') || /^[A-Za-z]:/.test(path)) return 'absolute path';
  if (path.includes('\\')) return 'backslash in the path';
  if (codePoints(path).some(isUnsafeCharacter)) {
    return 'control or invalid character in the name';
  }
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') {
      return 'empty, "." or ".." path segment';
    }
    if (isGitMetadataName(segment)) return '.git path segment';
  }
  return null;
}

interface Identity {
  dev: number;
  ino: number;
}

class FolderChanged extends Error {
  constructor(readonly path: string) {
    super('folder changed while it was read');
  }
}

const OPEN_FLAGS =
  constants.O_RDONLY |
  (constants.O_NOFOLLOW ?? 0) |
  (constants.O_NONBLOCK ?? 0);

function childPath(parent: string, name: string): string {
  return parent === '' ? name : `${parent}/${name}`;
}

function ancestors(path: string): string[] {
  const parts = path === '' ? [] : path.split('/');
  return parts.map((_, index) => parts.slice(0, index + 1).join('/'));
}

export async function snapshotPluginFolder(
  folder: string,
  oracle: IgnoreOracle,
  options: { limits?: Partial<SnapshotLimits>; hooks?: SnapshotHooks } = {},
): Promise<SnapshotResult> {
  const limits = { ...DEFAULT_SNAPSHOT_LIMITS, ...options.limits };
  let root: string;
  let rootIdentity: Identity;
  try {
    // The folder the operator configured may itself be reached through a
    // link they made; that is resolved once, here, and never again.
    root = await realpath(folder);
    const status = await lstat(root);
    if (!status.isDirectory()) return refusal({ code: 'folder-unreadable' });
    rootIdentity = { dev: status.dev, ino: status.ino };
  } catch {
    return refusal({ code: 'folder-unreadable' });
  }
  const absolute = (path: string) => (path === '' ? root : join(root, path));
  const directories = new Map<string, Identity>([['', rootIdentity]]);

  /** Every directory from the root to `directory` is still the one the
   * walk recorded. */
  const verifyChain = async (directory: string, subject: string) => {
    for (const path of ['', ...ancestors(directory)]) {
      const expected = directories.get(path);
      const status = await lstat(absolute(path)).catch(() => null);
      if (
        !expected ||
        !status?.isDirectory() ||
        status.dev !== expected.dev ||
        status.ino !== expected.ino
      ) {
        throw new FolderChanged(subject);
      }
    }
  };

  const files: SnapshotFile[] = [];
  const skipped: SnapshotSkip[] = [];
  const unsafe: string[] = [];
  const linked: string[] = [];
  let totalBytes = 0;

  /** Opens and reads one file the walk saw, once. */
  const readOnce = async (
    path: string,
    seen: Identity,
  ): Promise<Buffer | 'linked'> => {
    await options.hooks?.beforeOpen?.(path);
    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await open(absolute(path), OPEN_FLAGS);
    } catch {
      // ELOOP: the name is now a link. ENOENT: it is gone. Either way the
      // folder is not what was listed.
      throw new FolderChanged(path);
    }
    let bytes: Buffer;
    try {
      const status = await handle.stat();
      if (
        !status.isFile() ||
        status.dev !== seen.dev ||
        status.ino !== seen.ino
      ) {
        throw new FolderChanged(path);
      }
      if (status.nlink !== 1) return 'linked';
      bytes = await handle.readFile();
    } finally {
      await handle.close();
    }
    await options.hooks?.afterRead?.(path);
    const parent = path.includes('/')
      ? path.slice(0, path.lastIndexOf('/'))
      : '';
    await verifyChain(parent, path);
    return bytes;
  };

  try {
    let level = [''];
    for (let depth = 0; level.length > 0; depth += 1) {
      if (depth > limits.maxDepth) return refusal({ code: 'too-many-files' });
      const candidates: Array<{
        path: string;
        kind: 'file' | 'directory';
        identity: Identity;
        executable: boolean;
      }> = [];
      /** `.gitignore` bytes, read once and reused if it is published. */
      const alreadyRead = new Map<string, Buffer>();

      for (const directory of level) {
        await verifyChain(directory, directory || '.');
        const names = (await readdir(absolute(directory))).sort();
        await verifyChain(directory, directory || '.');
        for (const name of names) {
          const path = childPath(directory, name);
          if (isGitMetadataName(name)) {
            // Never opened, listed or descended into.
            skipped.push({ path, reason: 'git-metadata' });
            continue;
          }
          const status = await lstat(absolute(path)).catch(() => null);
          if (!status) {
            // A name that is not valid UTF-8 cannot be looked up again by
            // the name Node decoded; anything else vanished mid-walk.
            if (unsafeRelativePathReason(path)) unsafe.push(path);
            else throw new FolderChanged(path);
            continue;
          }
          const identity = { dev: status.dev, ino: status.ino };
          if (status.isSymbolicLink()) {
            skipped.push({ path, reason: 'symbolic-link' });
          } else if (status.isDirectory()) {
            candidates.push({
              path,
              kind: 'directory',
              identity,
              executable: false,
            });
          } else if (status.isFile()) {
            if (name === '.gitignore') {
              // Read before this level's entries are judged, because its
              // rules judge them.
              const bytes = await readOnce(path, identity);
              if (bytes === 'linked') {
                linked.push(path);
                continue;
              }
              alreadyRead.set(path, bytes);
              await oracle.ignoreFile(directory, bytes);
            }
            candidates.push({
              path,
              kind: 'file',
              identity,
              executable: (status.mode & 0o111) !== 0,
            });
          } else {
            skipped.push({ path, reason: 'special-file' });
          }
        }
      }

      for (const candidate of candidates) {
        if (candidate.kind === 'directory') {
          await oracle.directory(candidate.path);
        }
      }
      const ignored = await oracle.ignored(
        candidates.map((candidate) => candidate.path),
      );

      const next: string[] = [];
      for (const candidate of candidates) {
        if (ignored.has(candidate.path)) continue;
        if (unsafeRelativePathReason(candidate.path) !== null) {
          unsafe.push(candidate.path);
          continue;
        }
        if (candidate.kind === 'directory') {
          directories.set(candidate.path, candidate.identity);
          next.push(candidate.path);
          continue;
        }
        if (files.length >= limits.maxFiles) {
          return refusal({ code: 'too-many-files' });
        }
        const bytes =
          alreadyRead.get(candidate.path) ??
          (await readOnce(candidate.path, candidate.identity));
        if (bytes === 'linked') {
          linked.push(candidate.path);
          continue;
        }
        totalBytes += bytes.length;
        if (totalBytes > limits.maxBytes) return refusal({ code: 'too-large' });
        files.push({
          path: candidate.path,
          executable: candidate.executable,
          bytes,
        });
      }
      level = next;
    }
  } catch (error) {
    if (error instanceof FolderChanged) {
      return refusal({ code: 'folder-changed', paths: [error.path] });
    }
    return refusal({ code: 'folder-unreadable' });
  }

  if (unsafe.length > 0) return refusal({ code: 'unsafe-path', paths: unsafe });
  if (linked.length > 0) return refusal({ code: 'linked-file', paths: linked });
  return { ok: true, files, skipped };
}

function refusal(value: SnapshotRefusal): SnapshotResult {
  return { ok: false, refusal: value };
}

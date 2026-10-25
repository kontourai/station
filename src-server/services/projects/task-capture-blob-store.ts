import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  type FileHandle,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  unlink,
} from 'node:fs/promises';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import { acquireFileMutationLockAsync } from '@kontourai/station-shared/lifecycle-events';

export const TASK_CAPTURE_MAX_BLOB_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_HOME_BYTES = 512 * 1024 * 1024;
// At most 65,536 default-budget blobs, leaving room under the 100k-file backup cap.
const MIN_BLOB_CHARGE_BYTES = 8 * 1024;
const SHA256_REF = /^sha256:([a-f0-9]{64})$/;
const SHA256_HEX = /^[a-f0-9]{64}$/;
const PNG_MAGIC = Buffer.from('89504e470d0a1a0a', 'hex');
const JPEG_MAGIC = Buffer.from('ffd8ff', 'hex');

export class TaskCaptureBlobStoreError extends Error {
  constructor(
    readonly code:
      | 'blob-too-large'
      | 'home-cap-exceeded'
      | 'invalid-media-type'
      | 'invalid-digest'
      | 'digest-mismatch'
      | 'not-found'
      | 'storage-in-repository'
      | 'storage-unavailable',
    options?: ErrorOptions,
  ) {
    super(`Task capture blob refused: ${code}`, options);
    this.name = 'TaskCaptureBlobStoreError';
  }
}

function storageFailure(error: unknown): TaskCaptureBlobStoreError {
  return error instanceof TaskCaptureBlobStoreError
    ? error
    : new TaskCaptureBlobStoreError('storage-unavailable', { cause: error });
}

function digestOf(bytes: Buffer): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function assertMediaType(bytes: Buffer, mediaType: string): void {
  const magic =
    mediaType === 'image/png'
      ? PNG_MAGIC
      : mediaType === 'image/jpeg'
        ? JPEG_MAGIC
        : null;
  if (!magic || !bytes.subarray(0, magic.length).equals(magic))
    throw new TaskCaptureBlobStoreError('invalid-media-type');
}

/** Resolve missing suffixes too, without following a dangling symlink. */
async function storageLocation(path: string): Promise<string> {
  try {
    await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return join(await storageLocation(dirname(path)), basename(path));
  }
  return realpath(path);
}

async function syncDirectory(path: string): Promise<void> {
  const directory = await open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    // Same durability rule as shared/fs-windows-compat: Windows cannot fsync directories.
    if (process.platform !== 'win32') await directory.sync();
  } finally {
    await directory.close();
  }
}

/**
 * Append-only bytes; Task ownership and capture metadata belong to SQLite.
 * The composer must supply every registered Project root in forbiddenProjectRoots.
 * Blobs cannot live inside those roots (including bare repositories and aliases).
 * A home that happens to be a dotfiles repository is otherwise allowed; .git
 * discovery is not Project authority. Recreate the store when that root set changes.
 * Only put initializes storage, cached until missing; read never creates directories.
 * The home byte budget charges each blob at least 8 KiB to bound file count too.
 * Media-type matching is exact: routes must normalize request Content-Type before
 * put, and serve captures with an explicit Content-Type and
 * X-Content-Type-Options: nosniff.
 */
// UNWIRED(#4149): capture routes compose this store in the next lane.
export class TaskCaptureBlobStore {
  private readonly home: string;
  private readonly maxHomeBytes: number;
  private readonly forbiddenProjectRoots: readonly string[];
  private initialized?: Promise<string>;

  constructor(input: {
    homeDir: string;
    forbiddenProjectRoots: readonly string[];
    maxHomeBytes?: number;
  }) {
    this.home = resolve(input.homeDir);
    this.forbiddenProjectRoots = input.forbiddenProjectRoots.map((root) =>
      resolve(root),
    );
    this.maxHomeBytes = input.maxHomeBytes ?? DEFAULT_MAX_HOME_BYTES;
    if (!Number.isSafeInteger(this.maxHomeBytes) || this.maxHomeBytes < 0)
      throw new RangeError('Invalid task capture home byte cap');
  }

  async put(
    bytes: Buffer,
    mediaType: string,
  ): Promise<{ digest: `sha256:${string}`; byteLength: number }> {
    if (bytes.length > TASK_CAPTURE_MAX_BLOB_BYTES)
      throw new TaskCaptureBlobStoreError('blob-too-large');
    // Own the bytes before yielding to another writer's home lock.
    const snapshot = Buffer.from(bytes);
    assertMediaType(snapshot, mediaType);
    const digest = digestOf(snapshot);
    try {
      const root = await this.storageRoot();
      const home = dirname(dirname(root));
      // The lock survives removal of task-captures so recovery uses the same lock.
      const release = await acquireFileMutationLockAsync(
        join(home, 'task-captures.mutation'),
      );
      try {
        // Initialization is cached; path validation still refuses later redirection.
        if ((await realpath(this.home)) !== home)
          throw new TaskCaptureBlobStoreError('storage-unavailable');
        let existing = await this.existingStorage();
        if (existing === undefined) {
          this.initialized = undefined;
          existing = await this.storageRoot();
        }
        if (existing !== root)
          throw new TaskCaptureBlobStoreError('storage-unavailable');
        await this.removeTemporaryFiles(dirname(root));
        if (await this.readVerified(root, digest))
          return { digest, byteLength: snapshot.length };
        let used = 0;
        for (const name of await readdir(root)) {
          if (!SHA256_HEX.test(name)) continue;
          const stat = await lstat(join(root, name));
          if (!stat.isFile())
            throw new TaskCaptureBlobStoreError('storage-unavailable');
          used += Math.max(stat.size, MIN_BLOB_CHARGE_BYTES);
          if (used > this.maxHomeBytes)
            throw new TaskCaptureBlobStoreError('home-cap-exceeded');
        }
        if (
          Math.max(snapshot.length, MIN_BLOB_CHARGE_BYTES) >
          this.maxHomeBytes - used
        )
          throw new TaskCaptureBlobStoreError('home-cap-exceeded');
        await this.publish(root, digest, snapshot);
        return { digest, byteLength: snapshot.length };
      } finally {
        await release();
      }
    } catch (error) {
      throw storageFailure(error);
    }
  }

  async read(digest: string): Promise<Buffer> {
    if (!SHA256_REF.test(digest))
      throw new TaskCaptureBlobStoreError('invalid-digest');
    try {
      const root = await this.existingStorage();
      const bytes = root ? await this.readVerified(root, digest) : undefined;
      if (!bytes) throw new TaskCaptureBlobStoreError('not-found');
      return bytes;
    } catch (error) {
      throw storageFailure(error);
    }
  }

  private async assertOutsideProjects(root: string): Promise<void> {
    const location = await storageLocation(root);
    for (const project of this.forbiddenProjectRoots) {
      const rel = relative(await storageLocation(project), location);
      if (
        rel === '' ||
        (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
      )
        throw new TaskCaptureBlobStoreError('storage-in-repository');
    }
  }

  private storageRoot(): Promise<string> {
    this.initialized ??= this.initializeStorage().catch((error) => {
      this.initialized = undefined;
      throw error;
    });
    return this.initialized;
  }

  private async initializeStorage(): Promise<string> {
    await this.assertOutsideProjects(
      join(this.home, 'task-captures', 'sha256'),
    );
    await mkdir(this.home, { recursive: true, mode: 0o700 });
    let parent = await realpath(this.home);
    for (const name of ['task-captures', 'sha256']) {
      const directory = join(parent, name);
      try {
        await mkdir(directory, { mode: 0o700 });
        await syncDirectory(parent);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      if (!(await lstat(directory)).isDirectory())
        throw new TaskCaptureBlobStoreError('storage-unavailable');
      parent = directory;
    }
    return parent;
  }

  private async existingStorage(): Promise<string | undefined> {
    try {
      const home = await realpath(this.home);
      const captures = join(home, 'task-captures');
      const root = join(captures, 'sha256');
      await this.assertOutsideProjects(root);
      for (const directory of [captures, root]) {
        if (!(await lstat(directory)).isDirectory())
          throw new TaskCaptureBlobStoreError('storage-unavailable');
      }
      return root;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  private async removeTemporaryFiles(directory: string): Promise<void> {
    let removed = false;
    for (const name of await readdir(directory)) {
      // The shared publisher lock excludes active temporary files from this sweep.
      if (!/^\.blob-.*\.tmp$/.test(name)) continue;
      try {
        await unlink(join(directory, name));
        removed = true;
      } catch {
        // A busy crash leftover must not block later publications or cleanup.
      }
    }
    if (removed) await syncDirectory(directory);
  }

  private async readVerified(
    root: string,
    digest: string,
  ): Promise<Buffer | undefined> {
    const path = join(root, digest.slice('sha256:'.length));
    let file: FileHandle;
    try {
      if (!(await lstat(path)).isFile())
        throw new TaskCaptureBlobStoreError('storage-unavailable');
      file = await open(
        path,
        constants.O_RDONLY |
          (constants.O_NOFOLLOW ?? 0) |
          (constants.O_NONBLOCK ?? 0),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    try {
      const stat = await file.stat();
      if (!stat.isFile())
        throw new TaskCaptureBlobStoreError('storage-unavailable');
      if (stat.size > TASK_CAPTURE_MAX_BLOB_BYTES)
        throw new TaskCaptureBlobStoreError('blob-too-large');
      const chunks: Buffer[] = [];
      let length = 0;
      for (;;) {
        const chunk = Buffer.allocUnsafe(
          Math.min(1024 * 1024, TASK_CAPTURE_MAX_BLOB_BYTES + 1 - length),
        );
        const { bytesRead } = await file.read(chunk, 0, chunk.length, null);
        if (bytesRead === 0) break;
        length += bytesRead;
        if (length > TASK_CAPTURE_MAX_BLOB_BYTES)
          throw new TaskCaptureBlobStoreError('blob-too-large');
        chunks.push(chunk.subarray(0, bytesRead));
      }
      const bytes = Buffer.concat(chunks, length);
      if (digestOf(bytes) !== digest)
        throw new TaskCaptureBlobStoreError('digest-mismatch');
      return bytes;
    } finally {
      await file.close();
    }
  }

  private async publish(
    root: string,
    digest: string,
    bytes: Buffer,
  ): Promise<void> {
    const temporary = join(dirname(root), `.blob-${randomUUID()}.tmp`);
    try {
      const file = await open(
        temporary,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          (constants.O_NOFOLLOW ?? 0),
        0o600,
      );
      try {
        await file.writeFile(bytes);
        await file.sync();
      } finally {
        await file.close();
      }
      try {
        await link(temporary, join(root, digest.slice('sha256:'.length)));
      } catch (error) {
        if (
          (error as NodeJS.ErrnoException).code !== 'EEXIST' ||
          !(await this.readVerified(root, digest))
        )
          throw error;
      }
      await syncDirectory(root);
    } catch (error) {
      // Preserve the publication failure; the next locked put reclaims leftovers.
      await unlink(temporary).catch(() => {});
      throw error;
    }
    // Publication is durable; a busy temporary file is reclaimed by the next put.
    await unlink(temporary).catch(() => {});
  }
}

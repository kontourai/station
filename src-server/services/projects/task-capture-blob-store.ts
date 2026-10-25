import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fsyncDirectorySync } from '@kontourai/station-shared/fs-windows-compat';
import { acquireFileMutationLockAsync } from '@kontourai/station-shared/lifecycle-events';

export const TASK_CAPTURE_MAX_BLOB_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_HOME_BYTES = 512 * 1024 * 1024;
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
  ) {
    super(`Task capture blob refused: ${code}`);
    this.name = 'TaskCaptureBlobStoreError';
  }
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

function refuseRepository(directory: string): void {
  try {
    lstatSync(join(directory, '.git'));
    throw new TaskCaptureBlobStoreError('storage-in-repository');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

/** Append-only bytes; Task ownership and capture metadata belong to SQLite. */
// UNWIRED(#4149): capture routes compose this store in the next lane.
export class TaskCaptureBlobStore {
  private readonly home: string;
  private readonly maxHomeBytes: number;

  constructor(input: { homeDir: string; maxHomeBytes?: number }) {
    this.home = resolve(input.homeDir);
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
    const root = this.ensureStorage();
    const release = await acquireFileMutationLockAsync(
      join(dirname(root), '.mutation'),
    );
    try {
      this.ensureStorage();
      if (this.readVerified(root, digest))
        return { digest, byteLength: snapshot.length };
      let used = 0;
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        const stat = lstatSync(join(root, entry.name));
        if (!SHA256_HEX.test(entry.name) || !stat.isFile())
          throw new TaskCaptureBlobStoreError('storage-unavailable');
        used += stat.size;
        if (used > this.maxHomeBytes)
          throw new TaskCaptureBlobStoreError('home-cap-exceeded');
      }
      if (snapshot.length > this.maxHomeBytes - used)
        throw new TaskCaptureBlobStoreError('home-cap-exceeded');
      this.publish(root, digest, snapshot);
      return { digest, byteLength: snapshot.length };
    } finally {
      await release();
    }
  }

  async read(digest: string): Promise<Buffer> {
    if (!SHA256_REF.test(digest))
      throw new TaskCaptureBlobStoreError('invalid-digest');
    const bytes = this.readVerified(this.ensureStorage(), digest);
    if (!bytes) throw new TaskCaptureBlobStoreError('not-found');
    return bytes;
  }

  private ensureStorage(): string {
    mkdirSync(this.home, { recursive: true, mode: 0o700 });
    const home = realpathSync(this.home);
    // Refuse even a home nested below a Project, including symlink aliases.
    for (let folder = home; ; folder = dirname(folder)) {
      refuseRepository(folder);
      if (dirname(folder) === folder) break;
    }
    let parent = home;
    for (const name of ['task-captures', 'sha256']) {
      const directory = join(parent, name);
      try {
        mkdirSync(directory, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      if (!lstatSync(directory).isDirectory())
        throw new TaskCaptureBlobStoreError('storage-unavailable');
      refuseRepository(directory);
      fsyncDirectorySync(parent);
      parent = directory;
    }
    return parent;
  }

  private readVerified(root: string, digest: string): Buffer | undefined {
    const match = SHA256_REF.exec(digest);
    if (!match) throw new TaskCaptureBlobStoreError('invalid-digest');
    const path = join(root, match[1]);
    let descriptor: number;
    try {
      if (!lstatSync(path).isFile())
        throw new TaskCaptureBlobStoreError('storage-unavailable');
      descriptor = openSync(
        path,
        constants.O_RDONLY |
          (constants.O_NOFOLLOW ?? 0) |
          (constants.O_NONBLOCK ?? 0),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw new TaskCaptureBlobStoreError('storage-unavailable');
    }
    try {
      const stat = fstatSync(descriptor);
      if (!stat.isFile())
        throw new TaskCaptureBlobStoreError('storage-unavailable');
      if (stat.size > TASK_CAPTURE_MAX_BLOB_BYTES)
        throw new TaskCaptureBlobStoreError('blob-too-large');
      const chunks: Buffer[] = [];
      let length = 0;
      for (;;) {
        const chunk = Buffer.allocUnsafe(
          Math.min(64 * 1024, TASK_CAPTURE_MAX_BLOB_BYTES + 1 - length),
        );
        const count = readSync(descriptor, chunk, 0, chunk.length, null);
        if (count === 0) break;
        length += count;
        if (length > TASK_CAPTURE_MAX_BLOB_BYTES)
          throw new TaskCaptureBlobStoreError('blob-too-large');
        chunks.push(chunk.subarray(0, count));
      }
      const bytes = Buffer.concat(chunks, length);
      if (digestOf(bytes) !== digest)
        throw new TaskCaptureBlobStoreError('digest-mismatch');
      return bytes;
    } finally {
      closeSync(descriptor);
    }
  }

  private publish(root: string, digest: string, bytes: Buffer): void {
    const temporary = join(dirname(root), `.blob-${randomUUID()}.tmp`);
    let descriptor: number | undefined;
    try {
      descriptor = openSync(
        temporary,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          (constants.O_NOFOLLOW ?? 0),
        0o600,
      );
      writeFileSync(descriptor, bytes);
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      try {
        linkSync(temporary, join(root, digest.slice('sha256:'.length)));
      } catch (error) {
        if (
          (error as NodeJS.ErrnoException).code !== 'EEXIST' ||
          !this.readVerified(root, digest)
        )
          throw error;
      }
      fsyncDirectorySync(root);
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
      try {
        unlinkSync(temporary);
      } catch {}
    }
  }
}

import { lstat } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import { acquireFileMutationLockAsync } from '@kontourai/station-shared/lifecycle-events';
import { mutateJsonFileWithGuardedRead } from '../../domain/file-storage-helpers.js';
import {
  bindGuardedDirectories,
  type GuardedDirectoryBinding,
  readGuardedUtf8,
  revalidateGuardedDirectoryIdentities,
} from './guarded-setup-import-filesystem.js';

// 64 receipts and 64 still-live, fully bounded previews are legal durable
// state. Their metadata alone can exceed 512 KiB, so keep a ceiling that
// proves the declared retention contract without accepting an unbounded file.
const MAX_STORE_BYTES = 8 * 1024 * 1024;

/** Guarded facade over the shared JSON mutation authority. */
export class SetupImportReceiptStore {
  constructor(
    private readonly path: string,
    private readonly empty: () => unknown,
  ) {
    if (!isAbsolute(path))
      throw new Error('Setup receipt path must be absolute.');
  }

  private async readDescriptor<T>(
    directories?: GuardedDirectoryBinding[],
  ): Promise<{ value: T; binding: FileBinding }> {
    const guarded = await readGuardedUtf8(this.path, MAX_STORE_BYTES, {
      parentDirectory: dirname(this.path),
      directories,
    });
    return {
      value: JSON.parse(guarded.content) as T,
      binding: {
        dev: guarded.stat.dev,
        ino: guarded.stat.ino,
        mtimeMs: guarded.stat.mtimeMs,
        size: guarded.stat.size,
      },
    };
  }

  async read<T>(): Promise<T> {
    // A guarded descriptor read must not overlap our own atomic replacement.
    // Without this shared lock, a reader can correctly observe the old
    // descriptor and then reject the writer's committed pathname during its
    // final binding check. That is a real hostile-swap signal outside this
    // lock, but an ordinary serialized writer is safe to wait for.
    const release = await acquireFileMutationLockAsync(`${this.path}.mutation`);
    try {
      return (await this.readDescriptor<T>()).value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return this.empty() as T;
      throw error;
    } finally {
      await release();
    }
  }

  async mutate<T>(update: (current: T) => T): Promise<T> {
    let directories: GuardedDirectoryBinding[] | undefined;
    let expected: FileBinding | null = null;
    return mutateJsonFileWithGuardedRead(
      this.path,
      this.empty() as T,
      async () => {
        const parent = dirname(this.path);
        directories = await bindGuardedDirectories(parent);
        try {
          const read = await this.readDescriptor<T>(directories);
          expected = read.binding;
          return read.value;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            expected = null;
            return this.empty() as T;
          }
          throw error;
        }
      },
      update,
      {
        maxBytes: MAX_STORE_BYTES,
        label: 'Setup import receipt store',
        beforeCommit: async () => {
          if (!directories)
            throw new Error('Setup import receipt store unsafe.');
          await revalidateGuardedDirectoryIdentities(
            dirname(this.path),
            directories,
          );
          await this.assertCurrentBinding(expected);
        },
      },
    );
  }

  /**
   * The mutation lock excludes Station writers, but it is not an authority
   * over a hostile filesystem actor.  Do not publish over a pathname that was
   * replaced after the descriptor-derived read: that would discard a change
   * the transaction never evaluated.
   */
  private async assertCurrentBinding(expected: FileBinding | null) {
    try {
      const current = await lstat(this.path);
      if (
        expected === null ||
        current.isSymbolicLink() ||
        !current.isFile() ||
        current.nlink !== 1 ||
        current.dev !== expected.dev ||
        current.ino !== expected.ino ||
        current.mtimeMs !== expected.mtimeMs ||
        current.size !== expected.size
      )
        throw new Error('Setup import receipt store changed before commit.');
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code === 'ENOENT' &&
        expected === null
      )
        return;
      throw error;
    }
  }
}

type FileBinding = {
  dev: number;
  ino: number;
  mtimeMs: number;
  size: number;
};

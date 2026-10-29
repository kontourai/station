import { lstatSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fsyncDirectorySync } from '@kontourai/station-shared/fs-windows-compat';
import { acquireFileMutationLockAsync } from '@kontourai/station-shared/lifecycle-events';
import type { z } from 'zod/v3';
import {
  readPrivateJsonFile,
  writePrivateJsonFileSync,
} from '../services/notifications/private-json-file.js';

/** Private analytics state is never repaired from an older snapshot automatically. */
export class AnalyticsPrivateFile<T> {
  private readonly directory: string;
  private readonly path: string;
  constructor(
    home: string,
    name:
      | 'telemetry-incident-links.json'
      | 'analytics-saved-views.json'
      | 'analytics-source-enrollments.json'
      | 'analytics-recipients.json'
      | 'analytics-source-approvals.json',
    private readonly schema: z.ZodType<T>,
    private readonly maxBytes: number,
  ) {
    this.directory = join(home, 'security');
    this.path = join(this.directory, name);
  }
  private ensure() {
    try {
      mkdirSync(this.directory, { mode: 0o700 });
      fsyncDirectorySync(dirname(this.directory));
    } catch (error) {
      if (
        !(error instanceof Error && 'code' in error && error.code === 'EEXIST')
      )
        throw error;
    }
    const entry = lstatSync(this.directory);
    if (
      !entry.isDirectory() ||
      entry.isSymbolicLink() ||
      (process.platform !== 'win32' &&
        ((entry.mode & 0o077) !== 0 || entry.uid !== process.getuid?.()))
    )
      throw new Error('Analytics private storage unavailable');
  }
  read(initial: T): T {
    try {
      this.ensure();
      let present = false;
      try {
        const entry = lstatSync(this.path);
        present = true;
        if (process.platform !== 'win32' && entry.uid !== process.getuid?.())
          throw new Error('Foreign owner');
      } catch (error) {
        if (
          !(
            error instanceof Error &&
            'code' in error &&
            error.code === 'ENOENT'
          )
        )
          throw error;
      }
      const raw = readPrivateJsonFile(
        this.path,
        this.maxBytes,
        'Private analytics state',
      );
      return raw === null && !present
        ? this.schema.parse(initial)
        : this.schema.parse(raw);
    } catch {
      throw new Error('Analytics private storage unavailable');
    }
  }
  async withLock<R>(
    assertCurrent: () => Promise<void>,
    apply: () => Promise<R>,
  ): Promise<R> {
    await assertCurrent();
    this.ensure();
    const release = await acquireFileMutationLockAsync(`${this.path}.mutation`);
    try {
      return await apply();
    } finally {
      await release();
    }
  }

  async update<R>(
    initial: T,
    assertCurrent: () => Promise<void>,
    apply: (file: T) => R | Promise<R>,
  ): Promise<R> {
    return this.withLock(assertCurrent, async () => {
      const file = this.read(initial);
      const result = await apply(file);
      await assertCurrent();
      writePrivateJsonFileSync(
        this.path,
        this.schema.parse(file),
        this.maxBytes,
        'Private analytics state',
      );
      fsyncDirectorySync(this.directory);
      await assertCurrent();
      return result;
    });
  }
}

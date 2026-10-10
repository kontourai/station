import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../../src-server/__test-utils__/temp-dirs.js';
import {
  fsyncDirectorySync,
  fsyncFileSync,
  renameFileSyncRetrying,
  renamePathSyncRetrying,
  rmDirSyncRetrying,
} from '../fs-windows-compat.js';

const makeTempDir = trackTempDirs();

describe('fsyncFileSync (#2675 W3)', () => {
  test('flushes a writable file on every platform rule', () => {
    const dir = makeTempDir('station-fsync-file-');
    const file = join(dir, 'data');
    writeFileSync(file, 'x');
    expect(() => fsyncFileSync(file, 'win32')).not.toThrow();
    expect(() => fsyncFileSync(file, 'linux')).not.toThrow();
  });

  test('the Windows rule opens for writing, and leaves a read-only file unflushed', () => {
    const dir = makeTempDir('station-fsync-file-');
    const file = join(dir, 'data');
    writeFileSync(file, 'x');
    chmodSync(file, 0o444);
    // Read-only: POSIX flushes it through a read-only handle; the Windows
    // rule, which needs a writable handle, cannot open one, skips it and
    // says so.
    expect(() => fsyncFileSync(file, 'linux')).not.toThrow();
    const reported: string[] = [];
    expect(() =>
      fsyncFileSync(file, 'win32', (message) => reported.push(message)),
    ).not.toThrow();
    expect(reported).toEqual([
      `${file} is read-only, so it was not flushed to disk (Windows flushes only through a writable handle)`,
    ]);
    // A missing file is still an error under both.
    expect(() => fsyncFileSync(join(dir, 'missing'), 'win32')).toThrow(
      /ENOENT/,
    );
  });

  test('the Windows rule throws a refusal that is not the read-only case', () => {
    const dir = makeTempDir('station-fsync-file-');
    const locked = join(dir, 'locked');
    mkdirSync(locked);
    const file = join(locked, 'data');
    writeFileSync(file, 'x');
    // A writable file behind a directory that cannot be searched: the open
    // is refused (EACCES), and the file is not read-only, so it throws.
    chmodSync(locked, 0o000);
    const reported: string[] = [];
    try {
      expect(() =>
        fsyncFileSync(file, 'win32', (message) => reported.push(message)),
      ).toThrow(/EACCES/);
      expect(reported).toEqual([]);
    } finally {
      chmodSync(locked, 0o700);
    }
  });
});

describe('fsyncDirectorySync', () => {
  test('runs the identity check on every platform', () => {
    const dir = makeTempDir('fs-windows-compat-');
    let sawIdentity = false;
    fsyncDirectorySync(dir, (stat) => {
      sawIdentity = true;
      expect(stat.isDirectory()).toBe(true);
    });
    expect(sawIdentity).toBe(true);
  });

  test('propagates a failing identity check instead of swallowing it', () => {
    const dir = makeTempDir('fs-windows-compat-');
    expect(() =>
      fsyncDirectorySync(dir, () => {
        throw new Error('identity mismatch');
      }),
    ).toThrow('identity mismatch');
  });
});

describe('rmDirSyncRetrying', () => {
  test('removes a populated directory tree', () => {
    const dir = makeTempDir('fs-windows-compat-rm-');
    mkdirSync(join(dir, 'nested'), { recursive: true });
    writeFileSync(join(dir, 'nested', 'file.txt'), 'content');

    rmDirSyncRetrying(dir);

    expect(existsSync(dir)).toBe(false);
  });

  test('does not throw when the directory is already gone', () => {
    const dir = makeTempDir('fs-windows-compat-rm-');
    rmDirSyncRetrying(dir);
    expect(() => rmDirSyncRetrying(dir)).not.toThrow();
  });
});

test('rename retry never hides an absent source or removes the existing destination', () => {
  const root = makeTempDir('station-rename-fault-');
  const destination = join(root, 'target.json');
  writeFileSync(destination, 'original');
  const waiting = vi.spyOn(Atomics, 'wait');
  try {
    expect(() =>
      renameFileSyncRetrying(join(root, 'absent'), destination, 'win32'),
    ).toThrow(/ENOENT/);
    expect(waiting).not.toHaveBeenCalled();
    expect(readFileSync(destination, 'utf8')).toBe('original');
  } finally {
    waiting.mockRestore();
    rmDirSyncRetrying(root);
  }
});

describe('renamePathSyncRetrying (#3363)', () => {
  const refused = (code: string) =>
    Object.assign(new Error(`${code}: operation not permitted, rename`), {
      code,
    });

  test('retries a transient Windows refusal of a real directory rename until it clears', () => {
    const dir = makeTempDir('station-rename-');
    const source = join(dir, '.incoming.1');
    mkdirSync(source);
    writeFileSync(join(source, 'file'), 'x');
    let refusals = 2;
    const waits: number[] = [];
    renamePathSyncRetrying(source, join(dir, '1.0.0'), {
      platform: 'win32',
      rename: (from, to) => {
        if (refusals > 0) {
          refusals -= 1;
          throw refused('EPERM');
        }
        renameSync(from, to);
      },
      wait: (ms) => waits.push(ms),
    });
    expect(readFileSync(join(dir, '1.0.0', 'file'), 'utf8')).toBe('x');
    expect(waits).toEqual([500, 500]);
  });

  test('a refusal that persists surfaces the original error after ten tries', () => {
    const errors = ['EBUSY', 'EPERM', 'EACCES'].map(refused);
    let calls = 0;
    const thrown = (() => {
      try {
        renamePathSyncRetrying('a', 'b', {
          platform: 'win32',
          rename: () => {
            throw errors[Math.min(calls++, 2)];
          },
          wait: () => undefined,
        });
      } catch (error) {
        return error;
      }
    })();
    expect(thrown).toBe(errors[0]);
    expect(calls).toBe(10);
  });

  test('is not retried off Windows, nor for any other error', () => {
    let calls = 0;
    const once = (platform: NodeJS.Platform, code: string) => {
      calls = 0;
      expect(() =>
        renamePathSyncRetrying('a', 'b', {
          platform,
          rename: () => {
            calls += 1;
            throw refused(code);
          },
          wait: () => undefined,
        }),
      ).toThrow(code);
      return calls;
    };
    expect(once('linux', 'EPERM')).toBe(1);
    expect(once('win32', 'ENOENT')).toBe(1);
  });
});

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  fsyncDirectorySync,
  fsyncFileSync,
  renameFileSyncRetrying,
  rmDirSyncRetrying,
} from '../fs-windows-compat.js';

describe('fsyncFileSync (#2675 W3)', () => {
  test('flushes a writable file on every platform rule', () => {
    const dir = mkdtempSync(join(tmpdir(), 'station-fsync-file-'));
    const file = join(dir, 'data');
    writeFileSync(file, 'x');
    expect(() => fsyncFileSync(file, 'win32')).not.toThrow();
    expect(() => fsyncFileSync(file, 'linux')).not.toThrow();
  });

  test('the Windows rule opens for writing, and leaves a read-only file unflushed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'station-fsync-file-'));
    const file = join(dir, 'data');
    writeFileSync(file, 'x');
    chmodSync(file, 0o444);
    // Read-only: POSIX flushes it through a read-only handle; the Windows
    // rule, which needs a writable handle, cannot open one and skips it.
    expect(() => fsyncFileSync(file, 'linux')).not.toThrow();
    expect(() => fsyncFileSync(file, 'win32')).not.toThrow();
    // A missing file is still an error under both.
    expect(() => fsyncFileSync(join(dir, 'missing'), 'win32')).toThrow(
      /ENOENT/,
    );
  });
});

describe('fsyncDirectorySync', () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmDirSyncRetrying(dir);
  });

  test('runs the identity check on every platform', () => {
    dir = mkdtempSync(join(tmpdir(), 'fs-windows-compat-'));
    let sawIdentity = false;
    fsyncDirectorySync(dir, (stat) => {
      sawIdentity = true;
      expect(stat.isDirectory()).toBe(true);
    });
    expect(sawIdentity).toBe(true);
  });

  test('propagates a failing identity check instead of swallowing it', () => {
    dir = mkdtempSync(join(tmpdir(), 'fs-windows-compat-'));
    expect(() =>
      fsyncDirectorySync(dir, () => {
        throw new Error('identity mismatch');
      }),
    ).toThrow('identity mismatch');
  });
});

describe('rmDirSyncRetrying', () => {
  test('removes a populated directory tree', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fs-windows-compat-rm-'));
    mkdirSync(join(dir, 'nested'), { recursive: true });
    writeFileSync(join(dir, 'nested', 'file.txt'), 'content');

    rmDirSyncRetrying(dir);

    expect(existsSync(dir)).toBe(false);
  });

  test('does not throw when the directory is already gone', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fs-windows-compat-rm-'));
    rmDirSyncRetrying(dir);
    expect(() => rmDirSyncRetrying(dir)).not.toThrow();
  });
});

test('rename retry never hides an absent source or removes the existing destination', () => {
  const root = mkdtempSync(join(tmpdir(), 'station-rename-fault-'));
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

import {
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
  renameFileSyncRetrying,
  rmDirSyncRetrying,
} from '../fs-windows-compat.js';

describe('fsyncDirectorySync', () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmDirSyncRetrying(dir);
  });

  test('succeeds on a real directory and never throws, on every platform', () => {
    dir = mkdtempSync(join(tmpdir(), 'fs-windows-compat-'));
    expect(() => fsyncDirectorySync(dir)).not.toThrow();
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

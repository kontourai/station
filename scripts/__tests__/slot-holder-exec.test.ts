import { afterEach, describe, expect, test, vi } from 'vitest';
import { execAsSlotHolder } from '../lib/slot-holder-exec.mjs';

describe('execAsSlotHolder on Windows without a held slot', () => {
  afterEach(() => {
    process.exitCode = undefined;
  });

  test('runs the program as a plain child and keeps its exit status', async () => {
    // Hosted CI and nested checks hold no slot, so no owned Job (and no
    // coordinator identity probe) is needed for the program to run.
    const spawnSyncImpl = vi.fn(() => ({ status: 7, signal: null }));
    await execAsSlotHolder({
      file: 'node.exe',
      args: ['check.mjs', '--flag'],
      cwd: 'C:\\repo',
      label: 'test:focused',
      holdsSlot: false,
      platform: 'win32',
      spawnSyncImpl,
    });
    expect(spawnSyncImpl).toHaveBeenCalledWith(
      'node.exe',
      ['check.mjs', '--flag'],
      expect.objectContaining({ cwd: 'C:\\repo', stdio: 'inherit' }),
    );
    expect(process.exitCode).toBe(7);
  });

  test('a program ended by a signal fails', async () => {
    await execAsSlotHolder({
      file: 'node.exe',
      args: [],
      label: 'test:focused',
      holdsSlot: false,
      platform: 'win32',
      spawnSyncImpl: () => ({ status: null, signal: 'SIGTERM' }),
    });
    expect(process.exitCode).toBe(1);
  });

  test('a spawn error is thrown, never read as success', async () => {
    await expect(
      execAsSlotHolder({
        file: 'missing.exe',
        args: [],
        label: 'test:focused',
        holdsSlot: false,
        platform: 'win32',
        spawnSyncImpl: () => ({ error: new Error('spawn ENOENT') }),
      }),
    ).rejects.toThrow('spawn ENOENT');
  });
});

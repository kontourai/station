import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import {
  forgetOwnedProcess,
  recordOwnedProcess,
  sweepOrphanedOwnedProcesses,
} from '../process-utils.js';

const tempDir = trackTempDirs();

test('Windows leaves POSIX orphan records untouched and does not promise group recovery', async () => {
  const registryDir = tempDir('station-windows-owned-process-');
  const enginePid = 2_000_000_000;
  const owner = {
    pid: enginePid - 1,
    instanceId: 'previous-instance',
    bootId: 'previous-boot',
    birth: null,
  };
  const file = join(registryDir, `engine-${enginePid}.json`);
  const original = `${JSON.stringify({
    schemaVersion: 1,
    enginePid,
    engineBirth: null,
    owner,
    command: 'previous-engine',
    spawnedAt: '2026-10-30T00:00:00Z',
  })}\n`;
  writeFileSync(file, original);
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  const kill = vi.spyOn(process, 'kill');
  const log = vi.fn();
  try {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const result = await sweepOrphanedOwnedProcesses({
      registryDir,
      log,
      probeIdentity: () => ({ state: 'dead' }),
    });
    expect(readFileSync(file, 'utf8')).toBe(original);
    expect(result.reaped).toEqual([]);
    expect(result.unverifiable).toBe(0);
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining(
        'POSIX orphan sweeping is unavailable on Windows',
      ),
    );

    const record = recordOwnedProcess(enginePid + 1, owner, 'new-engine', {
      registryDir,
      log,
    });
    expect(record.enginePid).toBe(enginePid + 1);
    expect(existsSync(join(registryDir, `engine-${enginePid + 1}.json`))).toBe(
      false,
    );
    forgetOwnedProcess(enginePid, { registryDir });
    expect(readFileSync(file, 'utf8')).toBe(original);
    expect(kill).not.toHaveBeenCalled();
  } finally {
    Object.defineProperty(process, 'platform', platform);
    kill.mockRestore();
  }
});

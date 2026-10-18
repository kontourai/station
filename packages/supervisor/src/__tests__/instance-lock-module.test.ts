/**
 * The lock module in-process: epochs never go backwards, and garbage
 * collection never touches the current top.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { trackTempDirs } from '../../../../src-server/__test-utils__/temp-dirs.ts';
import {
  acquireInstanceLock,
  breakInstanceLock,
  collectOlderEpochs,
  releaseInstanceLock,
} from '../instance-lock.ts';

const makeTempDir = trackTempDirs();

function setup() {
  const runDir = join(makeTempDir('sup-lock-module-'), 'run');
  mkdirSync(runDir, { mode: 0o700 });
  const acquire = (control: string) =>
    acquireInstanceLock({
      runDir,
      instance: 't',
      control,
      description: 'instance t',
      log: () => {},
    });
  return { runDir, acquire };
}

describe('lock epochs (in-process)', () => {
  it('never reuses a released top epoch, so epochs cannot go backwards', async () => {
    const { runDir, acquire } = setup();
    const first = await acquire('/a.sock');
    expect(first.epoch).toBe(1);
    releaseInstanceLock(first);
    // The released top epoch stays on disk, marked released.
    const released = JSON.parse(
      readFileSync(join(runDir, 'instance-t.lock.1'), 'utf8'),
    );
    expect(released.releasedAt).toBeTypeOf('number');
    // A starter with a different control socket takes the next epoch, not epoch 1 again.
    const second = await acquire('/b.sock');
    expect(second.epoch).toBe(2);
    collectOlderEpochs(second, runDir, 't');
    expect(existsSync(join(runDir, 'instance-t.lock.1'))).toBe(false);
    expect(existsSync(join(runDir, 'instance-t.lock.2'))).toBe(true);
    // The live holder (this process, epoch 2) refuses a third acquisition.
    await expect(acquire('/c.sock')).rejects.toThrow(
      /holds instance t \(epoch 2, live: held by this process\)/,
    );
    // Garbage collection by an older lock never removes the current top.
    collectOlderEpochs(first, runDir, 't');
    expect(existsSync(join(runDir, 'instance-t.lock.2'))).toBe(true);
  });

  it('removes its temporary file when marking a lock released fails', async () => {
    const { runDir } = setup();
    // The top "epoch" is a non-empty directory, so the final rename fails.
    mkdirSync(join(runDir, 'instance-t.lock.1', 'inside'), { recursive: true });
    await expect(
      breakInstanceLock({
        runDir,
        instance: 't',
        force: true,
        reason: 'test',
        breakLockCommand: 'x',
      }),
    ).rejects.toThrow();
    expect(
      readdirSync(runDir).filter((name) => name.endsWith('.break')),
    ).toEqual([]);
  });
});

/**
 * Stale-generation reaping trusts a pid only when its start-time fingerprint
 * still matches the one recorded at launch.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { trackTempDirs } from '../../../../src-server/__test-utils__/temp-dirs.ts';
import {
  processFingerprint,
  reapStaleGenerations,
} from '../generation-registry.ts';

const makeTempDir = trackTempDirs();
const sleepers: ChildProcess[] = [];

afterEach(() => {
  for (const child of sleepers.splice(0)) child.kill('SIGKILL');
});

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sleeper(): ChildProcess {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
    windowsHide: true,
  });
  sleepers.push(child);
  return child;
}

describe('generation registry', () => {
  it('never kills a live process whose fingerprint does not match the record', async () => {
    const run = makeTempDir('sup-registry-');
    const registry = join(run, 'generations.json');
    const child = sleeper();
    await once(child, 'spawn');
    const pid = child.pid as number;
    writeFileSync(
      registry,
      JSON.stringify([{ pid, generation: 1, fingerprint: 'recycled' }]),
    );
    expect(await reapStaleGenerations(registry, { log: () => {} })).toEqual([]);
    expect(isAlive(pid)).toBe(true);

    const fingerprint = await processFingerprint(pid);
    expect(fingerprint).toBeTypeOf('string');
    writeFileSync(
      registry,
      JSON.stringify([{ pid, generation: 1, fingerprint }]),
    );
    const exited = once(child, 'exit');
    expect(await reapStaleGenerations(registry, { log: () => {} })).toEqual([
      pid,
    ]);
    await exited;
  }, 60_000);
});

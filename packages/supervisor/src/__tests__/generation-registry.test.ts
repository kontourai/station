/**
 * Stale-generation reaping trusts a pid only when its start-time fingerprint
 * still matches the one recorded at launch.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync, writeFileSync } from 'node:fs';
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
    expect(await reapStaleGenerations(registry, { log: () => {} })).toEqual({
      reaped: [],
      kept: [],
    });
    expect(isAlive(pid)).toBe(true);

    const fingerprint = await processFingerprint(pid);
    expect(fingerprint.status).toBe('ok');
    const value = fingerprint.status === 'ok' ? fingerprint.value : '';
    writeFileSync(
      registry,
      JSON.stringify([{ pid, generation: 1, fingerprint: value }]),
    );
    const exited = once(child, 'exit');
    expect(await reapStaleGenerations(registry, { log: () => {} })).toEqual({
      reaped: [pid],
      kept: [],
    });
    await exited;
  }, 60_000);

  it('includes the Linux boot id, so a record from before a reboot never matches', async () => {
    const stat =
      '4242 (node) S 1 4242 4242 0 -1 4194304 0 0 0 0 0 0 0 0 20 0 1 0 987654 0 0';
    const linux = (bootId: string) => ({
      platform: 'linux' as const,
      readFile: async (path: string) => {
        if (path === '/proc/sys/kernel/random/boot_id') return `${bootId}\n`;
        if (path === '/proc/4242/stat') return stat;
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      },
    });
    const before = await processFingerprint(4242, linux('boot-a'));
    const after = await processFingerprint(4242, linux('boot-b'));
    expect(before).toEqual({ status: 'ok', value: 'linux:boot-a:987654' });
    expect(after).toEqual({ status: 'ok', value: 'linux:boot-b:987654' });

    const registry = join(
      makeTempDir('sup-registry-boot-'),
      'generations.json',
    );
    writeFileSync(
      registry,
      JSON.stringify([
        { pid: 4242, generation: 1, fingerprint: 'linux:boot-a:987654' },
      ]),
    );
    const signals: string[] = [];
    const result = await reapStaleGenerations(registry, {
      log: () => {},
      fingerprint: () => processFingerprint(4242, linux('boot-b')),
      signal: (_pid, signal) => signals.push(signal),
      isRunning: () => true,
    });
    expect(result).toEqual({ reaped: [], kept: [] });
    expect(signals).toEqual([]);
  });

  it('keeps a record it cannot fingerprint and leaves the process alone', async () => {
    const registry = join(
      makeTempDir('sup-registry-unknown-'),
      'generations.json',
    );
    const record = {
      pid: 4343,
      generation: 2,
      fingerprint: 'ps:Mon Oct 13 10:00:00 2026',
    };
    writeFileSync(registry, JSON.stringify([record]));
    const signals: string[] = [];
    const logs: string[] = [];
    const result = await reapStaleGenerations(registry, {
      log: (message) => logs.push(message),
      fingerprint: async () => ({ status: 'unknown', reason: 'ps timed out' }),
      signal: (_pid, signal) => signals.push(signal),
      isRunning: () => true,
    });
    expect(signals).toEqual([]);
    expect(result).toEqual({ reaped: [], kept: [record] });
    expect(JSON.parse(readFileSync(registry, 'utf8'))).toEqual([record]);
    expect(logs.join('\n')).toContain(
      'could not fingerprint pid 4343 (ps timed out)',
    );
  });

  it('refuses to start when a matching stale generation survives SIGTERM and SIGKILL', async () => {
    const registry = join(
      makeTempDir('sup-registry-survivor-'),
      'generations.json',
    );
    writeFileSync(
      registry,
      JSON.stringify([{ pid: 4444, generation: 3, fingerprint: 'f' }]),
    );
    const signals: string[] = [];
    await expect(
      reapStaleGenerations(registry, {
        log: () => {},
        fingerprint: async () => ({ status: 'ok', value: 'f' }),
        signal: (_pid, signal) => signals.push(signal),
        isRunning: () => true,
        graceMs: 50,
        waitMs: 50,
      }),
    ).rejects.toThrow(
      /stale generation 3 \(pid 4444\) is still running after SIGKILL/,
    );
    expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
  });
});

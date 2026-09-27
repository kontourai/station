/**
 * #2675 — the lifecycle lock's own-pid birth lookup on Windows.
 *
 * The portable-archive smoke's `station start` failed closed with "process
 * birth fingerprint is required for lock ownership" because the lock probed
 * its own pid with the 1.5s arbitrary-pid timeout, which a cold Windows
 * PowerShell start exceeds. The own-pid lookup must use the own-process
 * schedule (long first budget, pwsh retry) while in-loop reclaim lookups
 * stay short, on both the sync and async drivers — and a lookup that still
 * fails must say why.
 *
 * `ownProcessBirthProbeSchedule` is the lock's only platform decision, so it
 * is pinned to win32; the cached lookups run the REAL Windows probe
 * (`lookupProcessBirthFingerprint`, platform win32) against a recording exec,
 * so the timeout/shell each lookup spawns with is what the lock requested.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { trackTempDirs } from '../../../../src-server/__test-utils__/temp-dirs.js';
import {
  acquireFileMutationLock,
  acquireFileMutationLockAsync,
} from '../lifecycle-events.js';

const harness = vi.hoisted(() => {
  type Call = { pid: number; file: string; timeout: unknown };
  const state = {
    calls: [] as Call[],
    respond: (_file: string, _attempt: number): string =>
      '2026-08-29T16:16:27.1234567Z\n',
  };
  return state;
});

const POWERSHELL =
  'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';

vi.mock('../process-identity.mjs', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../process-identity.mjs')>();
  const probe = (
    pid: number,
    dependencies: { timeoutMs?: number; windowsShell?: string } = {},
  ) =>
    actual.lookupProcessBirthFingerprint(pid, {
      ...dependencies,
      platform: 'win32',
      env: { SystemRoot: 'C:\\Windows' },
      exec: (file, _args, options) => {
        harness.calls.push({ pid, file, timeout: options?.timeout });
        return harness.respond(file, harness.calls.length - 1);
      },
    });
  return {
    ...actual,
    ownProcessBirthProbeSchedule: () =>
      actual.ownProcessBirthProbeSchedule('win32'),
    describeProcessBirthProbe: () =>
      actual.describeProcessBirthProbe('win32', { SystemRoot: 'C:\\Windows' }),
    lookupProcessBirthFingerprintCached: probe,
    lookupProcessBirthFingerprintCachedAsync: async (
      pid: number,
      dependencies?: { timeoutMs?: number; windowsShell?: string },
    ) => probe(pid, dependencies),
  };
});

const makeTempDir = trackTempDirs();
function temporaryLockPath(): string {
  return join(makeTempDir('station-own-birth-'), 'store.json.mutation');
}

afterEach(() => {
  harness.calls = [];
  harness.respond = () => '2026-08-29T16:16:27.1234567Z\n';
});

function coldStartTimeout(): never {
  const error = new Error('spawnSync powershell.exe ETIMEDOUT') as Error & {
    code: string;
    stderr: string;
  };
  error.code = 'ETIMEDOUT';
  error.stderr = 'still loading';
  throw error;
}

function missing(file: string): never {
  const error = new Error(`spawnSync ${file} ENOENT`) as Error & {
    code: string;
  };
  error.code = 'ENOENT';
  throw error;
}

const drivers = {
  sync: async (lock: string) => acquireFileMutationLock(lock),
  async: (lock: string) => acquireFileMutationLockAsync(lock),
};

describe.each(Object.entries(drivers))(
  'Windows own-pid lock birth lookup (%s driver, #2675)',
  (_name, acquire) => {
    it('gives the own-pid lookup the cold-start budget of absolute Windows PowerShell', async () => {
      const release = await acquire(temporaryLockPath());
      await release();
      expect(harness.calls[0]).toEqual({
        pid: process.pid,
        file: POWERSHELL,
        timeout: 10_000,
      });
    });

    it('retries the own-pid lookup with pwsh on the longer retry budget', async () => {
      harness.respond = (_file, attempt) =>
        attempt === 0 ? coldStartTimeout() : '2026-08-29T16:16:27.1234567Z\n';
      const release = await acquire(temporaryLockPath());
      await release();
      expect(harness.calls.slice(0, 2)).toEqual([
        { pid: process.pid, file: POWERSHELL, timeout: 10_000 },
        { pid: process.pid, file: 'pwsh.exe', timeout: 20_000 },
      ]);
    });

    it('keeps in-loop reclaim lookups on the short timeout', async () => {
      const lock = temporaryLockPath();
      writeFileSync(
        lock,
        JSON.stringify({
          pid: process.pid,
          birth: 'not-this-process',
          token: 'old',
        }),
        { mode: 0o600 },
      );
      const release = await acquire(lock);
      await release();
      // Own-pid lookups (acquire, then the reclaim guard's and release's
      // own birth) take the long budget; the stale owner's liveness checks
      // (including the fresh re-probe) stay on the 1.5s default.
      expect(harness.calls[0]?.timeout).toBe(10_000);
      const timeouts = harness.calls.map((call) => call.timeout);
      expect(timeouts.filter((timeout) => timeout === 1_500)).toHaveLength(2);
      expect(new Set(timeouts)).toEqual(new Set([10_000, 1_500]));
    });

    it('fails closed naming why each own-pid probe returned nothing', async () => {
      harness.respond = (file) =>
        file === 'pwsh.exe' ? missing(file) : coldStartTimeout();
      await expect(async () => acquire(temporaryLockPath())).rejects.toThrow(
        `process birth fingerprint is required for lock ownership: Windows PowerShell probe (${POWERSHELL}) returned no start time for pid ${process.pid} (powershell.exe timed out after 10000ms; stderr: still loading; pwsh.exe spawn failed (ENOENT))`,
      );
    });
  },
);

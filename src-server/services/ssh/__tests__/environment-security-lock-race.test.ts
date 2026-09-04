import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { EnvironmentSecurityService } from '../environment-security-service.js';

/**
 * #1475: the lock protocol is sound; its recovery READ was not. A contender
 * that loses `linkSync` calls `#recoverStaleLockIfSafe`, which `lstat`s the
 * lock and then reads it. If the owner finishes and unlinks the lock between
 * those two syscalls the read raises ENOENT — and the recovery read used to
 * wrap every failure as `Invalid environment security lock record`, which
 * `#recoverStaleLockIfSafe` cannot recognize as ENOENT, so a contender whose
 * next retry would simply have acquired the free lock failed `initialize()`
 * instead (nightly 33910685946, `concurrent first use converges on one
 * complete record`).
 *
 * The concurrent test still stands, but it only reproduces this under load.
 * The window is between two syscalls, so the deterministic way to sit inside
 * it is to fault the read itself: the seam below unlinks the lock and raises
 * ENOENT on one nominated `readFileSync` of the lock path, which is exactly
 * what the owner's `rm` does to a contender mid-read. Everything else — the
 * link race, the recovery decision, the retry, the acquisition — is the real
 * code path.
 */
const lockReadFault = vi.hoisted(() => ({
  path: null as string | null,
  onFault: null as (() => void) | null,
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    readFileSync: (path: never, options: never) => {
      if (lockReadFault.path !== null && String(path) === lockReadFault.path) {
        const faulted = lockReadFault.path;
        lockReadFault.path = null;
        lockReadFault.onFault?.();
        const error = new Error(
          `ENOENT: no such file or directory, open '${faulted}'`,
        ) as NodeJS.ErrnoException;
        error.code = 'ENOENT';
        error.errno = -2;
        error.syscall = 'open';
        error.path = faulted;
        throw error;
      }
      return actual.readFileSync(path, options);
    },
  };
});

const testHomes: string[] = [];

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'station-environment-lock-race-'));
  testHomes.push(home);
  return home;
}

function lockPathFor(homeDir: string): string {
  return join(homeDir, 'security/.environment.lock');
}

/**
 * Publishes a lock that a live owner on this host would hold right now, so
 * recovery has no licence to steal it: the only way past it is the owner
 * releasing it.
 */
function writeLiveLock(homeDir: string, contents?: string): string {
  const lockPath = lockPathFor(homeDir);
  writeFileSync(
    lockPath,
    contents ??
      JSON.stringify({
        pid: process.pid,
        nonce: '661e12df-a948-4adb-9b44-c993d616c5a5',
        createdAt: Date.now(),
        host: 'test-host',
      }),
  );
  chmodSync(lockPath, 0o600);
  const now = Date.now() / 1_000;
  utimesSync(lockPath, now, now);
  return lockPath;
}

beforeEach(() => {
  lockReadFault.path = null;
  lockReadFault.onFault = null;
});

afterEach(() => {
  lockReadFault.path = null;
  lockReadFault.onFault = null;
  for (const home of testHomes.splice(0)) {
    rmSync(home, { recursive: true, force: true });
  }
});

describe('EnvironmentSecurityService lock-release race (#1475)', () => {
  test('treats a lock released between the recovery lstat and read as free', async () => {
    const homeDir = makeHome();
    const initial = await new EnvironmentSecurityService({
      homeDir,
    }).initialize();
    const lockPath = writeLiveLock(homeDir);

    // The owner's release lands in the recovery window: after the lstat that
    // found the lock present, before the read of its record.
    lockReadFault.path = lockPath;
    lockReadFault.onFault = () => rmSync(lockPath);

    const contender = await new EnvironmentSecurityService({
      homeDir,
      hostIdentity: 'test-host',
      lockRetryMs: 2,
      lockTimeoutMs: 5_000,
    }).initialize();

    // The fault fired (so recovery really did take the ENOENT path) and the
    // contender went on to acquire the free lock and converge.
    expect(lockReadFault.path).toBeNull();
    expect(contender).toEqual(initial);
    expect(existsSync(lockPath)).toBe(false);
    expect(
      JSON.parse(
        readFileSync(join(homeDir, 'security/environment.json'), 'utf8'),
      ),
    ).toEqual(initial);
  });

  test('still fails closed on a lock record that exists and is malformed', async () => {
    const homeDir = makeHome();
    await new EnvironmentSecurityService({ homeDir }).initialize();
    const lockPath = writeLiveLock(homeDir, '{bad-json');

    await expect(
      new EnvironmentSecurityService({
        homeDir,
        hostIdentity: 'test-host',
        lockRetryMs: 2,
        lockTimeoutMs: 100,
      }).initialize(),
    ).rejects.toThrow('Invalid environment security lock record');
    expect(readFileSync(lockPath, 'utf8')).toBe('{bad-json');
  });

  test('a held lock nobody releases still blocks acquisition until the timeout', async () => {
    // Without this, the first test could pass against a service that had
    // stopped honouring the lock at all: the release, not the seam, has to be
    // what lets the contender through.
    const homeDir = makeHome();
    await new EnvironmentSecurityService({ homeDir }).initialize();
    const lockPath = writeLiveLock(homeDir);
    const published = readFileSync(lockPath, 'utf8');

    await expect(
      new EnvironmentSecurityService({
        homeDir,
        hostIdentity: 'test-host',
        lockRetryMs: 2,
        lockTimeoutMs: 15,
      }).initialize(),
    ).rejects.toThrow(/timed out/i);
    expect(readFileSync(lockPath, 'utf8')).toBe(published);
  });

  test('reports a lock that vanishes while its own owner holds it', async () => {
    // The ownership check after the operation runs while this caller holds
    // the lock, so ENOENT there is not "free" — it means someone removed the
    // lock out from under the owner, and it must stay fail-closed.
    const homeDir = makeHome();
    const lockPath = lockPathFor(homeDir);
    const service = new EnvironmentSecurityService({ homeDir });
    // Nothing reads the lock path before the post-operation ownership check
    // on an uncontended acquisition, so this fault lands there.
    lockReadFault.path = lockPath;
    lockReadFault.onFault = () => rmSync(lockPath);

    await expect(service.initialize()).rejects.toThrow(
      'Environment security lock disappeared while held',
    );
    expect(lockReadFault.path).toBeNull();
  });
});

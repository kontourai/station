import fs, {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  acquireFileMutationLeaseAsync,
  acquireFileMutationLock,
  acquireFileMutationLockAsync,
  prepareFileMutationOwner,
} from '../lifecycle-events.js';
import {
  clearProcessBirthFingerprintCache,
  lookupProcessBirthFingerprintCached,
  lookupProcessBirthFingerprintCachedAsync,
  PROCESS_BIRTH_FINGERPRINT_CACHE_TTL_MS,
} from '../process-identity.mjs';

const roots: string[] = [];

function temporaryLockPath(): string {
  const root = mkdtempSync(join(tmpdir(), 'station-async-lock-'));
  roots.push(root);
  return join(root, 'store.json.mutation');
}

beforeEach(() => {
  clearProcessBirthFingerprintCache();
});

afterEach(() => {
  // An injected own-pid birth is memoized for the process; never leak it.
  clearProcessBirthFingerprintCache();
});

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root) rmSync(root, { force: true, recursive: true });
  }
});

describe('acquireFileMutationLockAsync (#2646 event-loop yield)', () => {
  it('keeps the event loop serving timers while a contended acquisition waits on a sync holder', async () => {
    const lock = temporaryLockPath();
    const releaseSync = acquireFileMutationLock(lock);
    let ticks = 0;
    const ticker = setInterval(() => {
      ticks += 1;
    }, 10);
    const started = Date.now();
    try {
      const acquisition = acquireFileMutationLockAsync(lock, {
        timeoutMs: 5_000,
      });
      // The release itself is scheduled on the event loop: if the async
      // acquisition busy-waited synchronously (the injected fault this test
      // exists to catch), this timer could never fire and the acquisition
      // would exhaust its deadline against a lock nobody can release.
      const handoff = setTimeout(() => releaseSync(), 250);
      const releaseAsync = await acquisition;
      clearTimeout(handoff);
      const waited = Date.now() - started;
      // The sync holder really blocked the async acquirer until the handoff.
      expect(waited).toBeGreaterThanOrEqual(200);
      // The event loop kept firing (~25 nominal 10ms ticks in 250ms; >=5
      // tolerates a loaded host). A synchronous busy-wait scores 0.
      expect(ticks).toBeGreaterThanOrEqual(5);
      await releaseAsync();
      expect(existsSync(lock)).toBe(false);
    } finally {
      clearInterval(ticker);
    }
  });

  it('blocks a sync acquirer while an async holder owns the lock, with the pinned error, then hands off', async () => {
    const lock = temporaryLockPath();
    const releaseAsync = await acquireFileMutationLockAsync(lock);
    expect(() => acquireFileMutationLock(lock, { timeoutMs: 50 })).toThrow(
      'lifecycle journal lock is held by a live process',
    );
    await releaseAsync();
    const releaseSync = acquireFileMutationLock(lock, { timeoutMs: 1_000 });
    expect(JSON.parse(readFileSync(lock, 'utf8')).pid).toBe(process.pid);
    releaseSync();
    expect(existsSync(lock)).toBe(false);
  });

  it('publishes the byte-compatible on-disk owner schema in both variants', async () => {
    const lock = temporaryLockPath();
    const releaseAsync = await acquireFileMutationLockAsync(lock);
    const asyncOwner = JSON.parse(readFileSync(lock, 'utf8'));
    await releaseAsync();
    const releaseSync = acquireFileMutationLock(lock);
    const syncOwner = JSON.parse(readFileSync(lock, 'utf8'));
    releaseSync();
    expect(Object.keys(asyncOwner).sort()).toEqual(
      Object.keys(syncOwner).sort(),
    );
    expect(asyncOwner).toMatchObject({
      version: 1,
      pid: process.pid,
      birth: syncOwner.birth,
    });
  });

  it('fails closed with the pinned message and no artifacts when birth identity is unavailable', async () => {
    const lock = temporaryLockPath();
    const root = join(lock, '..');
    await expect(
      acquireFileMutationLockAsync(lock, { birthFingerprint: () => null }),
    ).rejects.toThrow(
      'process birth fingerprint is required for lock ownership',
    );
    expect(readdirSync(root)).toEqual([]);
  });

  it('reclaims a dead-owner lock on the async path exactly like the sync path', async () => {
    const lock = temporaryLockPath();
    // A same-pid owner whose recorded birth cannot be this process's real
    // fingerprint: the stale-owner reclaim (fresh-probe confirmed) must fire.
    const { writeFileSync } = await import('node:fs');
    writeFileSync(
      lock,
      JSON.stringify({
        pid: process.pid,
        birth: 'not-this-process',
        token: 'old',
      }),
      { mode: 0o600 },
    );
    const release = await acquireFileMutationLockAsync(lock, {
      timeoutMs: 1_000,
    });
    expect(JSON.parse(readFileSync(lock, 'utf8')).birth).not.toBe(
      'not-this-process',
    );
    await release();
    expect(existsSync(lock)).toBe(false);
  });
});

describe('prepared file mutation owner', () => {
  it('releases an async-acquired lease synchronously with its captured owner identity', async () => {
    const lock = temporaryLockPath();
    const lease = await acquireFileMutationLeaseAsync(lock);
    const tryRelease = Reflect.get(lease, 'tryRelease');
    expect(typeof tryRelease).toBe('function');
    expect(Reflect.apply(tryRelease, lease, [])).toBe('released');
    expect(existsSync(lock)).toBe(false);
    await lease.release();
  });

  it('retains an async-acquired lease when a claim prevents synchronous release', async () => {
    const lock = temporaryLockPath();
    const lease = await acquireFileMutationLeaseAsync(lock);
    mkdirSync(`${lock}.guard.claims`);
    writeFileSync(`${lock}.guard.claims/pending.claim`, '{}');
    expect(lease.tryRelease()).toBe('cleanup-required');
    expect(() => lease.assertCurrent()).toThrow('lease is not current');
    rmSync(`${lock}.guard.claims/pending.claim`);
    await lease.release();
    expect(existsSync(lock)).toBe(false);
    const successor = await acquireFileMutationLeaseAsync(lock);
    await lease.release();
    successor.assertCurrent();
    await successor.release();
  });
  it('does not block synchronous acquisition while empty cleanup settles', async () => {
    const lock = temporaryLockPath();
    const owner = await prepareFileMutationOwner(lock);
    const cleanup = owner.settlePendingCleanup();
    const attempt = owner.tryAcquire();
    expect(attempt.kind).toBe('acquired');
    if (attempt.kind !== 'acquired') throw new Error('missing prepared lease');
    await cleanup;
    expect(attempt.lease.tryRelease()).toBe('released');
    await owner.close();
  });
  it('interoperates with async holders and cannot invalidate a successor on repeated release', async () => {
    const lock = temporaryLockPath();
    const owner = await prepareFileMutationOwner(lock);
    const external = await acquireFileMutationLeaseAsync(lock);
    expect(owner.tryAcquire()).toEqual({ kind: 'busy' });
    await external.release();
    const first = owner.tryAcquire();
    expect(first.kind).toBe('acquired');
    if (first.kind !== 'acquired') throw new Error('missing prepared lease');
    first.lease.assertCurrent();
    expect(first.lease.tryRelease()).toBe('released');
    const next = owner.tryAcquire();
    expect(next.kind).toBe('acquired');
    if (next.kind !== 'acquired') throw new Error('missing successor lease');
    expect(first.lease.tryRelease()).toBe('released');
    await first.lease.release();
    next.lease.assertCurrent();
    expect(next.lease.tryRelease()).toBe('released');
    await owner.close();
    const final = await acquireFileMutationLeaseAsync(lock);
    await final.release();
  });

  it.each(['stale-lock', 'guard', 'claim'] as const)(
    'refuses %s without probing or reclaiming',
    async (kind) => {
      const lock = temporaryLockPath();
      const owner = await prepareFileMutationOwner(lock);
      const path =
        kind === 'stale-lock'
          ? lock
          : kind === 'guard'
            ? `${lock}.guard`
            : `${lock}.guard.claims/expired.claim`;
      if (kind === 'claim') mkdirSync(`${lock}.guard.claims`);
      const bytes = JSON.stringify({
        pid: process.pid,
        birth: 'stale',
        token: 'original',
        createdAt: 0,
        expiresAt: 0,
      });
      writeFileSync(path, bytes);
      const probe = vi.spyOn(process, 'kill');
      const wait = vi.spyOn(Atomics, 'wait');
      try {
        expect(owner.tryAcquire()).toEqual({ kind: 'busy' });
        expect(probe).not.toHaveBeenCalled();
        expect(wait).not.toHaveBeenCalled();
      } finally {
        probe.mockRestore();
        wait.mockRestore();
      }
      expect(readFileSync(path, 'utf8')).toBe(bytes);
      rmSync(path);
      const admitted = owner.tryAcquire();
      expect(admitted.kind).toBe('acquired');
      if (admitted.kind !== 'acquired')
        throw new Error('missing prepared lease');
      expect(admitted.lease.tryRelease()).toBe('released');
      await owner.close();
    },
  );

  it('retains a release blocked by claim activity for explicit async cleanup', async () => {
    const lock = temporaryLockPath();
    const owner = await prepareFileMutationOwner(lock);
    const attempt = owner.tryAcquire();
    if (attempt.kind !== 'acquired') throw new Error('missing prepared lease');
    mkdirSync(`${lock}.guard.claims`);
    writeFileSync(`${lock}.guard.claims/pending.claim`, '{}');
    expect(attempt.lease.tryRelease()).toBe('cleanup-required');
    expect(() => attempt.lease.assertCurrent()).toThrow('lease is not current');
    expect(owner.tryAcquire()).toEqual({ kind: 'cleanup-required' });
    rmSync(`${lock}.guard.claims/pending.claim`);
    await owner.settlePendingCleanup();
    expect(existsSync(lock)).toBe(false);
    await owner.close();
  });

  it('lets an async contender progress after a timer releases a prepared holder', async () => {
    const lock = temporaryLockPath();
    const owner = await prepareFileMutationOwner(lock);
    const attempt = owner.tryAcquire();
    if (attempt.kind !== 'acquired') throw new Error('missing prepared lease');
    let released: string | undefined;
    const timer = setTimeout(() => {
      released = attempt.lease.tryRelease();
    }, 50);
    try {
      const successor = await acquireFileMutationLeaseAsync(lock, {
        timeoutMs: 5_000,
      });
      expect(released).toBe('released');
      successor.assertCurrent();
      await successor.release();
    } finally {
      clearTimeout(timer);
      await owner.close();
    }
  });

  it.each([
    'staging-sync',
    'linked-error',
    'candidate-remove',
    'claim-after-link',
  ] as const)(
    'retains acquisition custody after %s until explicit cleanup',
    async (failure) => {
      const lock = temporaryLockPath();
      const owner = await prepareFileMutationOwner(lock);
      const link = fs.linkSync;
      const remove = fs.rmSync;
      const fault =
        failure === 'staging-sync'
          ? vi.spyOn(fs, 'fsyncSync').mockImplementation(() => {
              throw new Error('injected staging failure');
            })
          : failure === 'candidate-remove'
            ? vi.spyOn(fs, 'rmSync').mockImplementation((path, options) => {
                if (
                  String(path).startsWith(`${lock}.`) &&
                  String(path).endsWith('.tmp')
                )
                  throw new Error('injected candidate cleanup failure');
                return remove(path, options);
              })
            : vi.spyOn(fs, 'linkSync').mockImplementation((source, target) => {
                link(source, target);
                if (String(target) !== lock) return;
                if (failure === 'linked-error')
                  throw new Error('injected error after linking');
                mkdirSync(`${lock}.guard.claims`);
                writeFileSync(`${lock}.guard.claims/racing.claim`, '{}');
              });
      syncBuiltinESMExports();
      try {
        expect(owner.tryAcquire()).toEqual({ kind: 'cleanup-required' });
        expect(owner.tryAcquire()).toEqual({ kind: 'cleanup-required' });
        expect(existsSync(lock)).toBe(failure !== 'staging-sync');
        expect(await prepareFileMutationOwner(lock)).toBe(owner);
      } finally {
        fault.mockRestore();
        syncBuiltinESMExports();
      }
      if (failure === 'claim-after-link')
        rmSync(`${lock}.guard.claims/racing.claim`);
      await owner.settlePendingCleanup();
      expect(existsSync(lock)).toBe(false);
      expect(
        readdirSync(join(lock, '..')).filter((name) => name.endsWith('.tmp')),
      ).toEqual([]);
      const successor = await acquireFileMutationLeaseAsync(lock);
      successor.assertCurrent();
      await successor.release();
      await owner.close();
    },
  );

  it.each(['guard-read', 'guard-temporary', 'guard-quarantine'] as const)(
    'retains prepared release progress after %s failure',
    async (failure) => {
      const lock = temporaryLockPath();
      const owner = await prepareFileMutationOwner(lock);
      const other = await prepareFileMutationOwner(lock);
      const attempt = owner.tryAcquire();
      if (attempt.kind !== 'acquired')
        throw new Error('missing prepared lease');
      const open = fs.openSync;
      const remove = fs.rmSync;
      const fault =
        failure === 'guard-read'
          ? vi.spyOn(fs, 'openSync').mockImplementation((path, flags, mode) => {
              if (String(path) === `${lock}.guard`)
                throw new Error('injected guard read failure');
              return open(path, flags, mode);
            })
          : vi.spyOn(fs, 'rmSync').mockImplementation((path, options) => {
              if (
                String(path).startsWith(`${lock}.guard.`) &&
                (failure === 'guard-temporary'
                  ? String(path).endsWith('.tmp')
                  : String(path).includes('.guard.stale-'))
              )
                throw new Error('injected guard cleanup failure');
              return remove(path, options);
            });
      syncBuiltinESMExports();
      try {
        expect(attempt.lease.tryRelease()).toBe('cleanup-required');
        expect(() => attempt.lease.assertCurrent()).toThrow(
          'lease is not current',
        );
        expect(other.tryAcquire()).toEqual({ kind: 'busy' });
      } finally {
        fault.mockRestore();
        syncBuiltinESMExports();
      }
      const successor =
        failure === 'guard-quarantine'
          ? await acquireFileMutationLeaseAsync(lock)
          : undefined;
      await owner.settlePendingCleanup();
      successor?.assertCurrent();
      await successor?.release();
      await owner.close();
      await other.close();
      expect(existsSync(lock)).toBe(false);
    },
  );

  it('retains the guard descriptor when its first identity inspection fails', async () => {
    const lock = temporaryLockPath();
    const owner = await prepareFileMutationOwner(lock);
    const attempt = owner.tryAcquire();
    if (attempt.kind !== 'acquired') throw new Error('missing prepared lease');
    const open = fs.openSync;
    const stat = fs.fstatSync;
    let guardDescriptor: number | undefined;
    const openFault = vi
      .spyOn(fs, 'openSync')
      .mockImplementation((path, flags, mode) => {
        const descriptor = open(path, flags, mode);
        if (
          String(path).startsWith(`${lock}.guard.`) &&
          String(path).endsWith('.tmp')
        )
          guardDescriptor = descriptor;
        return descriptor;
      });
    const statFault = vi
      .spyOn(fs, 'fstatSync')
      .mockImplementation((...args) => {
        if (args[0] === guardDescriptor)
          throw new Error('injected guard identity unavailable');
        return stat(...args);
      });
    syncBuiltinESMExports();
    try {
      expect(attempt.lease.tryRelease()).toBe('cleanup-required');
      expect(owner.tryAcquire()).toEqual({ kind: 'cleanup-required' });
    } finally {
      openFault.mockRestore();
      statFault.mockRestore();
      syncBuiltinESMExports();
    }
    if (guardDescriptor === undefined)
      throw new Error('guard descriptor was not opened');
    const heldDescriptor = guardDescriptor;
    expect(() => stat(heldDescriptor)).not.toThrow();
    await owner.settlePendingCleanup();
    expect(() => stat(heldDescriptor)).toThrow();
    expect(existsSync(lock)).toBe(false);
    expect(
      readdirSync(join(lock, '..')).filter((name) => name.endsWith('.tmp')),
    ).toEqual([]);
    await owner.close();
  });
});

describe('held file mutation leases', () => {
  it.each(['rename', 'remove', 'read-lock', 'read-guard'] as const)(
    'retries owned guard cleanup after a post-lock-deletion %s failure',
    async (failure) => {
      const lock = temporaryLockPath();
      const lease = await acquireFileMutationLeaseAsync(lock);
      const rename = fs.renameSync;
      const remove = fs.rmSync;
      const open = fs.openSync;
      const fault =
        failure === 'rename'
          ? vi.spyOn(fs, 'renameSync').mockImplementation((source, target) => {
              if (String(source) === `${lock}.guard`)
                throw new Error('injected guard cleanup failure');
              rename(source, target);
            })
          : failure === 'remove'
            ? vi.spyOn(fs, 'rmSync').mockImplementation((path, options) => {
                if (String(path).startsWith(`${lock}.guard.stale-`))
                  throw new Error('injected guard cleanup failure');
                remove(path, options);
              })
            : vi
                .spyOn(fs, 'openSync')
                .mockImplementation((path, flags, mode) => {
                  const prefix =
                    failure === 'read-lock'
                      ? `${lock}.stale-`
                      : `${lock}.guard.stale-`;
                  if (String(path).startsWith(prefix))
                    throw new Error('injected guard cleanup failure');
                  return open(path, flags, mode);
                });
      syncBuiltinESMExports();
      try {
        await expect(lease.release()).rejects.toThrow(
          'injected guard cleanup failure',
        );
        expect(existsSync(lock)).toBe(false);
        expect(() => lease.assertCurrent()).toThrow('lease is not current');
      } finally {
        fault.mockRestore();
        syncBuiltinESMExports();
      }
      const competing =
        failure === 'rename'
          ? undefined
          : await acquireFileMutationLeaseAsync(lock);
      await lease.release();
      const successor =
        competing ?? (await acquireFileMutationLeaseAsync(lock));
      await lease.release();
      expect(successor.assertCurrent()).toBeUndefined();
      await successor.release();
      expect(readdirSync(join(lock, '..'))).toEqual([]);
    },
  );

  it('excludes existing lock callers until release and invalidates the released capability', async () => {
    const lock = temporaryLockPath();
    const lease = await acquireFileMutationLeaseAsync(lock);
    expect(lease.assertCurrent()).toBeUndefined();
    await expect(
      acquireFileMutationLockAsync(lock, { timeoutMs: 50 }),
    ).rejects.toThrow('lifecycle journal lock is held by a live process');
    expect(() => acquireFileMutationLock(lock, { timeoutMs: 50 })).toThrow(
      'lifecycle journal lock is held by a live process',
    );
    const release = lease.release();
    expect(() => lease.assertCurrent()).toThrow('lease is not current');
    await Promise.all([release, lease.release()]);
    const next = await acquireFileMutationLeaseAsync(lock);
    await lease.release();
    expect(next.assertCurrent()).toBeUndefined();
    await next.release();
    expect(existsSync(lock)).toBe(false);
  });

  it('refuses a replaced lock identity and never releases its successor', async () => {
    const lock = temporaryLockPath();
    const lease = await acquireFileMutationLeaseAsync(lock);
    rmSync(lock);
    const successor = await acquireFileMutationLeaseAsync(lock);
    expect(() => lease.assertCurrent()).toThrow('lease is not current');
    await expect(lease.release()).rejects.toThrow('ownership was lost');
    expect(successor.assertCurrent()).toBeUndefined();
    await successor.release();
  });

  it('surfaces release failure, keeps the capability invalid and permits cleanup retry', async () => {
    const lock = temporaryLockPath();
    let failRelease = true;
    const lease = await acquireFileMutationLeaseAsync(lock, {
      hooks: {
        afterGuardAcquired() {
          if (failRelease) throw new Error('injected release failure');
        },
      },
    });
    await expect(lease.release()).rejects.toThrow('injected release failure');
    expect(() => lease.assertCurrent()).toThrow('lease is not current');
    await expect(
      acquireFileMutationLockAsync(lock, { timeoutMs: 50 }),
    ).rejects.toThrow('lifecycle journal lock is held by a live process');
    failRelease = false;
    await lease.release();
    expect(existsSync(lock)).toBe(false);
  });
});

describe('process birth-fingerprint cache (#2646 probe cost)', () => {
  it('serves N lookups within the TTL from one spawned probe', () => {
    let now = 0;
    const exec = vi.fn(() => 'Mon Jul  6 12:00:00 2026\n');
    const dependencies = { platform: 'darwin' as const, exec, now: () => now };
    expect(lookupProcessBirthFingerprintCached(4242, dependencies)).toBe(
      'Mon Jul  6 12:00:00 2026',
    );
    lookupProcessBirthFingerprintCached(4242, dependencies);
    lookupProcessBirthFingerprintCached(4242, dependencies);
    expect(exec).toHaveBeenCalledTimes(1);
    now = PROCESS_BIRTH_FINGERPRINT_CACHE_TTL_MS + 1;
    lookupProcessBirthFingerprintCached(4242, dependencies);
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it('fresh: true bypasses and refreshes the cache', () => {
    const exec = vi.fn(() => 'birth-a\n');
    const dependencies = { platform: 'darwin' as const, exec };
    lookupProcessBirthFingerprintCached(4243, dependencies);
    lookupProcessBirthFingerprintCached(4243, { ...dependencies, fresh: true });
    expect(exec).toHaveBeenCalledTimes(2);
    // The fresh result refreshed the entry for subsequent cached reads.
    lookupProcessBirthFingerprintCached(4243, dependencies);
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it('never caches a null (a dead or deadline-missed pid re-probes)', () => {
    const exec = vi.fn(() => '');
    const dependencies = { platform: 'darwin' as const, exec };
    expect(lookupProcessBirthFingerprintCached(4244, dependencies)).toBeNull();
    expect(lookupProcessBirthFingerprintCached(4244, dependencies)).toBeNull();
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it('deduplicates concurrent async probes for one pid into a single spawn', async () => {
    const exec = vi.fn(async () => {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
      return 'birth-async\n';
    });
    const dependencies = { platform: 'darwin' as const, exec };
    const results = await Promise.all([
      lookupProcessBirthFingerprintCachedAsync(4245, dependencies),
      lookupProcessBirthFingerprintCachedAsync(4245, dependencies),
      lookupProcessBirthFingerprintCachedAsync(4245, dependencies),
    ]);
    expect(results).toEqual(['birth-async', 'birth-async', 'birth-async']);
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it('shares one cache between the sync and async lookups', async () => {
    const execSync = vi.fn(() => 'shared-birth\n');
    const execAsync = vi.fn(async () => 'never-used\n');
    expect(
      lookupProcessBirthFingerprintCached(4246, {
        platform: 'darwin',
        exec: execSync,
      }),
    ).toBe('shared-birth');
    await expect(
      lookupProcessBirthFingerprintCachedAsync(4246, {
        platform: 'darwin',
        exec: execAsync,
      }),
    ).resolves.toBe('shared-birth');
    expect(execAsync).not.toHaveBeenCalled();
  });

  it('stamps a probe slower than the TTL with its finish time, not its start (#2675)', () => {
    let now = 0;
    // A cold Windows PowerShell start: the probe itself outlasts the TTL.
    const exec = vi.fn(() => {
      now += PROCESS_BIRTH_FINGERPRINT_CACHE_TTL_MS + 3_000;
      return 'slow-birth\n';
    });
    const dependencies = { platform: 'darwin' as const, exec, now: () => now };
    expect(lookupProcessBirthFingerprintCached(4247, dependencies)).toBe(
      'slow-birth',
    );
    now += PROCESS_BIRTH_FINGERPRINT_CACHE_TTL_MS - 1;
    expect(lookupProcessBirthFingerprintCached(4247, dependencies)).toBe(
      'slow-birth',
    );
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it("memoizes this process's own birth for its lifetime, past the TTL and through fresh (#2675)", async () => {
    let now = 0;
    const exec = vi.fn(() => 'own-birth\n');
    const dependencies = { platform: 'darwin' as const, exec, now: () => now };
    expect(lookupProcessBirthFingerprintCached(process.pid, dependencies)).toBe(
      'own-birth',
    );
    now += PROCESS_BIRTH_FINGERPRINT_CACHE_TTL_MS * 100;
    expect(
      lookupProcessBirthFingerprintCached(process.pid, {
        ...dependencies,
        fresh: true,
      }),
    ).toBe('own-birth');
    const execAsync = vi.fn(async () => 'never-used\n');
    await expect(
      lookupProcessBirthFingerprintCachedAsync(process.pid, {
        platform: 'darwin',
        exec: execAsync,
        fresh: true,
      }),
    ).resolves.toBe('own-birth');
    expect(exec).toHaveBeenCalledTimes(1);
    expect(execAsync).not.toHaveBeenCalled();
    // Other pids keep the TTL: memoization is for the immutable own birth only.
    lookupProcessBirthFingerprintCached(4248, dependencies);
    now += PROCESS_BIRTH_FINGERPRINT_CACHE_TTL_MS + 1;
    lookupProcessBirthFingerprintCached(4248, dependencies);
    expect(exec).toHaveBeenCalledTimes(3);
    clearProcessBirthFingerprintCache();
  });

  it('never joins an in-flight async probe that has a different budget or shell (#2675)', async () => {
    const calls: Array<{ file: string; timeout: unknown }> = [];
    const exec = vi.fn(
      async (
        file: string,
        _args: readonly string[],
        options?: Record<string, unknown>,
      ) => {
        calls.push({ file, timeout: options?.timeout });
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
        return '2026-08-29T16:16:27.1234567Z\n';
      },
    );
    const windows = {
      platform: 'win32' as const,
      env: { SystemRoot: 'C:\\Windows' },
      // PowerShell 7 absent from its install path: the bare name below.
      fileExists: () => false,
      exec,
    };
    await Promise.all([
      // A short arbitrary-pid probe is in flight...
      lookupProcessBirthFingerprintCachedAsync(4249, windows),
      // ...when a long-budget own-process-style lookup asks for the same pid.
      lookupProcessBirthFingerprintCachedAsync(4249, {
        ...windows,
        timeoutMs: 10_000,
      }),
      lookupProcessBirthFingerprintCachedAsync(4249, {
        ...windows,
        timeoutMs: 20_000,
        windowsShell: 'pwsh.exe',
      }),
      // Same budget and shell still coalesce.
      lookupProcessBirthFingerprintCachedAsync(4249, {
        ...windows,
        timeoutMs: 10_000,
      }),
    ]);
    expect(calls.map((call) => call.timeout)).toEqual([1_500, 10_000, 20_000]);
    expect(calls[2]?.file).toBe('pwsh.exe');
  });
});

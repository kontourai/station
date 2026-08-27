import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  acquireFileMutationLock,
  acquireFileMutationLockAsync,
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
});

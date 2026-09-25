import * as fs from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';

const makeTempDir = trackTempDirs();

/**
 * A waiter's claim attempt, run at a chosen instant inside the owner's
 * release. It is the same step the lease loop takes: rename a staged,
 * already-populated claim directory onto the lock path.
 */
let competitor: { staged: string; path: string; claimed?: boolean } | null =
  null;

/** Runs just before the owner retires the lock: a misjudged reclaim. */
let beforeRetire: (() => void) | null = null;

vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  // Model a recursive delete the way it actually runs: children first, then
  // the directory itself. The competitor attempts its claim in between,
  // which is the one window the real race needs (#2648).
  const rmSync: typeof real.rmSync = (target, options) => {
    const path = String(target);
    if (competitor && options?.recursive && real.existsSync(path)) {
      for (const entry of real.readdirSync(path)) {
        real.rmSync(join(path, entry), { recursive: true, force: true });
      }
      try {
        real.renameSync(competitor.staged, competitor.path);
        competitor.claimed = true;
      } catch {}
      real.rmdirSync(path);
      return;
    }
    real.rmSync(target, options);
  };
  const renameSync: typeof real.renameSync = (from, to) => {
    if (beforeRetire && String(to).includes('.retired-')) {
      const hook = beforeRetire;
      beforeRetire = null;
      hook();
    }
    real.renameSync(from, to);
  };
  return {
    ...real,
    default: { ...real, rmSync, renameSync },
    rmSync,
    renameSync,
  };
});

afterEach(() => {
  competitor = null;
  beforeRetire = null;
});

describe('desktop runtime listener lease', () => {
  it('releases without leaving the lock path empty for a waiter to claim mid-delete (#2648)', async () => {
    const { withDesktopRuntimeListenerLease } = await import(
      '../lib/desktop-runtime-port-lease.mjs'
    );
    const root = makeTempDir('station-lease-release-');
    const path = join(root, 'listeners.lock');
    const staged = join(root, 'listeners.lock.claim-competitor');
    fs.mkdirSync(staged);
    fs.writeFileSync(
      join(staged, 'lease.json'),
      JSON.stringify({ owner: { nonce: 'competitor' } }),
    );

    await expect(
      withDesktopRuntimeListenerLease(
        async () => {
          competitor = { staged, path };
        },
        { path },
      ),
    ).resolves.toBeUndefined();

    // The waiter did get its turn, and its claim survived the release: the
    // owner deleted only its own directory.
    expect(competitor?.claimed).toBe(true);
    expect(
      JSON.parse(fs.readFileSync(join(path, 'lease.json'), 'utf8')).owner.nonce,
    ).toBe('competitor');
    // And the owner's retired copy is gone, not left beside the lock.
    expect(
      fs.readdirSync(root).filter((name) => name.includes('.retired-')),
    ).toEqual([]);
  });
  it('returns the work result when the lock vanishes between the read and the retire', async () => {
    const { withDesktopRuntimeListenerLease } = await import(
      '../lib/desktop-runtime-port-lease.mjs'
    );
    const root = makeTempDir('station-lease-gone-');
    const path = join(root, 'listeners.lock');
    await expect(
      withDesktopRuntimeListenerLease(
        async () => {
          // The only window the ENOENT branch covers: our lease was read,
          // then the directory went before the retiring rename.
          beforeRetire = () =>
            fs.rmSync(path, { recursive: true, force: true });
          return 'done';
        },
        { path },
      ),
    ).resolves.toBe('done');
    // The hook fired, so the release really reached that window.
    expect(beforeRetire).toBeNull();
    expect(fs.existsSync(path)).toBe(false);
  });

  it('never deletes a lock another owner took between the read and the retire', async () => {
    const { withDesktopRuntimeListenerLease } = await import(
      '../lib/desktop-runtime-port-lease.mjs'
    );
    const root = makeTempDir('station-lease-replaced-');
    const path = join(root, 'listeners.lock');
    const other = JSON.stringify({ owner: { nonce: 'other' } });
    await expect(
      withDesktopRuntimeListenerLease(
        async () => {
          beforeRetire = () =>
            fs.writeFileSync(join(path, 'lease.json'), other);
          return 'done';
        },
        { path },
      ),
    ).resolves.toBe('done');
    // The hook fired, so the release really reached that window.
    expect(beforeRetire).toBeNull();
    expect(fs.readFileSync(join(path, 'lease.json'), 'utf8')).toBe(other);
  });
});

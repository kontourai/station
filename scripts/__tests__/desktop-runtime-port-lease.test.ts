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
  return { ...real, default: { ...real, rmSync }, rmSync };
});

afterEach(() => {
  competitor = null;
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
  });
});

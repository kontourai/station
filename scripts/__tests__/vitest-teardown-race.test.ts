import { rm } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';
import setup, { removeRunRoot } from '../../vitest.global-setup.js';

const makeTempDir = trackTempDirs();

// setup() is exercised for its returned teardown only: its temp root is
// redirected to a scratch directory and the day-old sweep is stubbed, so the
// call touches neither the real run root nor other runs' leftovers.
const scratch = vi.hoisted(() => ({ root: '' }));
vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs/promises')>()),
  rm: vi.fn(),
}));
vi.mock('@kontourai/station-shared/temp-dir', () => ({
  stationTempRoot: () => scratch.root,
  sweepStationTempRoot: async () => 0,
}));

/**
 * The run root is removed by `vitest.global-setup.ts` while pooled workers may
 * still be writing under it, so one outliving teardown is expected.
 *
 * `rm(..., { force: true })` suppresses ENOENT, not ENOTEMPTY. When the
 * directory gained an entry between the walk and the final rmdir, the throw
 * surfaced as a *collect error against whichever test file happened to be in
 * flight*, so an unrelated test was reported as broken. That cost three
 * investigation cycles in one session before anyone read the stack.
 */

function failingRm(code: string) {
  return vi.fn<typeof rm>(async () => {
    throw Object.assign(new Error(`${code}: run root`), { code });
  });
}

describe('run-root teardown', () => {
  it('asks for retries rather than failing on the first contended rmdir', async () => {
    const remove = vi.fn<typeof rm>(async () => {});
    await removeRunRoot('/run-root', remove);
    expect(remove).toHaveBeenCalledWith(
      '/run-root',
      expect.objectContaining({ recursive: true, force: true }),
    );
    expect(remove.mock.calls[0][1]?.maxRetries).toBeGreaterThan(0);
  });

  // Failing here would report an infrastructure race as a test failure; the
  // day-old sweep reclaims the root instead.
  it.each(['ENOTEMPTY', 'EBUSY'])(
    'tolerates a root still contended (%s) after the retries',
    async (code) => {
      await expect(
        removeRunRoot('/run-root', failingRm(code)),
      ).resolves.toBeUndefined();
    },
  );

  // The helper is only worth its tests if setup() still tears down through it.
  it('setup returns a teardown that tolerates a contended run root', async () => {
    const saved = {
      host: process.env.STATION_VITEST_HOST_TMPDIR,
      runRoot: process.env.STATION_VITEST_RUN_ROOT,
    };
    scratch.root = makeTempDir('station-teardown-wiring-');
    const remove = vi.mocked(rm);
    remove.mockReset();
    remove.mockRejectedValue(
      Object.assign(new Error('EBUSY: run root'), { code: 'EBUSY' }),
    );
    try {
      const teardown = await setup();
      const runRoot = process.env.STATION_VITEST_RUN_ROOT;
      expect(runRoot?.startsWith(scratch.root)).toBe(true);
      await expect(teardown()).resolves.toBeUndefined();
      expect(remove).toHaveBeenCalledWith(
        runRoot,
        expect.objectContaining({ recursive: true, force: true }),
      );
      expect(remove.mock.calls[0][1]?.maxRetries).toBeGreaterThan(0);
    } finally {
      for (const [key, value] of [
        ['STATION_VITEST_HOST_TMPDIR', saved.host],
        ['STATION_VITEST_RUN_ROOT', saved.runRoot],
      ] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  // A genuinely undeletable root is still worth surfacing.
  it('rethrows any other removal failure', async () => {
    await expect(
      removeRunRoot('/run-root', failingRm('EACCES')),
    ).rejects.toMatchObject({ code: 'EACCES' });
  });
});

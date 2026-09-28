import type { rm } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { removeRunRoot } from '../../vitest.global-setup.js';

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

  // A genuinely undeletable root is still worth surfacing.
  it('rethrows any other removal failure', async () => {
    await expect(
      removeRunRoot('/run-root', failingRm('EACCES')),
    ).rejects.toMatchObject({ code: 'EACCES' });
  });
});

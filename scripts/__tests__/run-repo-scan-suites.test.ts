import { describe, expect, it, vi } from 'vitest';
import { runRepoScans } from '../run-repo-scan-suites.mjs';
import { REPO_SCAN_SUITES } from '../test-impact-manifest.mjs';

describe('repo-scans runner (#2176)', () => {
  it('hands the focused runner exactly REPO_SCAN_SUITES, once', async () => {
    const run = vi.fn(async (_args: string[]) => 0);
    await runRepoScans({ run });
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]?.[0]).toEqual([...REPO_SCAN_SUITES]);
    // A copy, so the runner cannot mutate the frozen list it was given.
    expect(run.mock.calls[0]?.[0]).not.toBe(REPO_SCAN_SUITES);
  });

  it.each([0, 1, 2])(
    'returns the focused runner exit code %i unchanged',
    async (code) => {
      await expect(runRepoScans({ run: async () => code })).resolves.toBe(code);
    },
  );

  it('propagates a runner that throws rather than reporting success', async () => {
    await expect(
      runRepoScans({
        run: async () => {
          throw new Error('vitest did not start');
        },
      }),
    ).rejects.toThrow('vitest did not start');
  });
});

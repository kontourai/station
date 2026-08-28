/**
 * archive#1501 review, FIX 3 — the checkout remote read is BOUNDED.
 *
 * Separate file because it replaces `git-exec.js` wholesale: the sibling
 * `checkout-remote-reader.test.ts` drives a real `git`, and the two mocking
 * regimes cannot share a module graph.
 *
 * What it pins is the wedge, not the plumbing. The fake `execGit` below
 * **never settles** when it is given no `timeout`, exactly as a `git` blocked
 * reading `.git/config` on a stale network mount does not exit. Without the
 * bound in `readCheckoutRemotes`, the first test does not fail with a wrong
 * value — it hangs until Vitest kills it, which is precisely the production
 * symptom: `AttachedSessionFollowService.poll()` never settles, `activePoll`
 * is never cleared, and attached-session discovery stops permanently.
 */

import { describe, expect, test, vi } from 'vitest';

const execGitMock = vi.hoisted(() =>
  vi.fn(
    async (
      _args: string[],
      opts: { timeout?: number } = {},
    ): Promise<{ stdout: string; stderr: string }> => {
      const timeout = opts.timeout;
      if (typeof timeout !== 'number' || timeout <= 0) {
        // No bound was requested: model the wedged child faithfully.
        return await new Promise(() => {});
      }
      // Model `execFile`'s timeout: SIGTERM the child, surface a `killed`
      // error with no exit code.
      return await new Promise((_resolve, reject) => {
        setTimeout(() => {
          reject(
            Object.assign(new Error('Command failed: git remote -v'), {
              killed: true,
              signal: 'SIGTERM',
            }),
          );
        }, timeout);
      });
    },
  ),
);

vi.mock('../../../utils/git-exec.js', () => ({
  execGit: execGitMock,
  execGitSync: vi.fn(),
  spawnGit: vi.fn(),
  gitEnv: (extra?: NodeJS.ProcessEnv) => ({ ...extra }),
}));

const { DEFAULT_CHECKOUT_REMOTE_TIMEOUT_MS, readCheckoutRemotes } =
  await import('../checkout-remote-reader.js');

describe('readCheckoutRemotes is bounded', () => {
  test('a git that never exits is terminated and reported UNVERIFIABLE, not awaited forever', async () => {
    const result = await readCheckoutRemotes('/mnt/stale-nfs/checkout', {
      timeoutMs: 25,
    });

    expect(result.ok).toBe(false);
    // The reason must name the timeout: an operator reading "command failed"
    // looks for a broken repo, not for a wedged mount.
    expect(result.ok === false && result.reason).toContain('25ms');
    expect(result.ok === false && result.reason).toContain(
      '/mnt/stale-nfs/checkout',
    );
  });

  test('a killed read is NEVER downgraded to "this directory has no remotes"', async () => {
    // The whole point of the discriminated union: an empty remote set means
    // `drifted` to the resolver. A timeout must never produce one.
    const result = await readCheckoutRemotes('/mnt/stale-nfs/checkout', {
      timeoutMs: 25,
    });
    expect(result).not.toEqual({ ok: true, remotes: [] });
  });

  test('the bound applies with no options passed — every caller inherits it', async () => {
    execGitMock.mockClear();
    // Do not await: the default is five seconds and the assertion is about
    // what was REQUESTED of the child, not about waiting for it.
    void readCheckoutRemotes('/mnt/stale-nfs/checkout');
    await Promise.resolve();

    expect(execGitMock).toHaveBeenCalledWith(
      ['remote', '-v'],
      expect.objectContaining({ timeout: DEFAULT_CHECKOUT_REMOTE_TIMEOUT_MS }),
    );
    expect(DEFAULT_CHECKOUT_REMOTE_TIMEOUT_MS).toBeGreaterThan(0);
  });
});

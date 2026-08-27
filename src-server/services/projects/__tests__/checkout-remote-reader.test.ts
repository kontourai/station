import { chmodSync, mkdtempSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { execGitSync } from '../../../utils/git-exec.js';
import { readCheckoutRemotes } from '../checkout-remote-reader.js';

const tmpRoots: string[] = [];

afterEach(() => {
  while (tmpRoots.length > 0) {
    const dir = tmpRoots.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'station-ppi-remotes-'));
  tmpRoots.push(dir);
  return dir;
}

describe('readCheckoutRemotes', () => {
  test('reads every remote of a real checkout once, verbatim', async () => {
    const dir = tempDir();
    execGitSync(['init', '-q'], { cwd: dir });
    execGitSync(
      ['remote', 'add', 'origin', 'git@github.com:kontourai/station.git'],
      { cwd: dir },
    );
    execGitSync(
      ['remote', 'add', 'upstream', 'https://github.com/brian/station.git'],
      { cwd: dir },
    );

    const result = await readCheckoutRemotes(dir);
    expect(result).toEqual({
      ok: true,
      remotes: [
        { name: 'origin', url: 'git@github.com:kontourai/station.git' },
        { name: 'upstream', url: 'https://github.com/brian/station.git' },
      ],
    });
  });

  test('a real directory that is not a repository truthfully advertises no remotes', async () => {
    const result = await readCheckoutRemotes(tempDir());
    expect(result).toEqual({ ok: true, remotes: [] });
  });

  /**
   * Exit 128 is "git refused", not "not a repository". Measured on git 2.50.1,
   * ALL of these exit 128: a plain non-repo directory; a repo with an
   * unreadable `.git/config`; a repo with an unreadable `.git`; a repo with
   * `.git/HEAD` removed; a repo with a malformed `.git/config`. Accepting the
   * code alone turns four failures into a successful observation of zero
   * remotes — which the backfill then persists as `local-only` forever and the
   * resolver reports as `drifted` ("advertises no remotes"), a confident claim
   * that a repository's identity changed about a repository that never
   * changed.
   */
  const canDropPermissions =
    process.platform !== 'win32' && process.getuid?.() !== 0;

  test.runIf(canDropPermissions)(
    'a real repo whose .git/config cannot be READ is unverifiable, never an empty remote set',
    async () => {
      const dir = tempDir();
      execGitSync(['init', '-q'], { cwd: dir });
      execGitSync(
        ['remote', 'add', 'origin', 'git@github.com:kontourai/station.git'],
        { cwd: dir },
      );
      // Same directory, same repo, one permission bit apart.
      expect(await readCheckoutRemotes(dir)).toEqual({
        ok: true,
        remotes: [
          { name: 'origin', url: 'git@github.com:kontourai/station.git' },
        ],
      });

      const config = join(dir, '.git', 'config');
      chmodSync(config, 0o000);
      try {
        const result = await readCheckoutRemotes(dir);
        expect(result.ok).toBe(false);
        expect(result.ok === false && result.reason).toContain('.git');
      } finally {
        chmodSync(config, 0o644);
      }
    },
  );

  test('a repo missing .git/HEAD is unverifiable, not a directory with no remotes', async () => {
    const dir = tempDir();
    execGitSync(['init', '-q'], { cwd: dir });
    execGitSync(
      ['remote', 'add', 'origin', 'git@github.com:kontourai/station.git'],
      { cwd: dir },
    );
    unlinkSync(join(dir, '.git', 'HEAD'));

    const result = await readCheckoutRemotes(dir);
    expect(result.ok).toBe(false);
  });

  test('a directory that cannot be read reports UNVERIFIABLE, never an empty remote set', async () => {
    // The difference is load-bearing: an empty set means "drifted" to the
    // resolver, so a failure to run git must never be reported as one.
    const dir = tempDir();
    rmSync(dir, { recursive: true, force: true });
    const result = await readCheckoutRemotes(dir);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain(dir);
  });
});

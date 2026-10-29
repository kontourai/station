import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { execGitSync } from '../../../utils/git-exec.js';

/**
 * The two file-system seams no real repository can be made to hit on cue:
 * a folder swapped while a record is read, and a call that never returns.
 * Everything else passes through to the real file system.
 */
const seams = vi.hoisted(() => ({
  /** Path suffix whose identity changes after its first `lstat`. */
  swapAfterFirstLstat: undefined as string | undefined,
  /** `realpath` never settles. */
  wedged: false,
  /**
   * Path suffix `lstat` always reports with another identity, so every walk
   * agrees with itself but not with the file actually opened.
   */
  substituted: undefined as string | undefined,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const seen = new Set<string>();
  return {
    ...actual,
    realpath: (async (...args: Parameters<typeof actual.realpath>) =>
      seams.wedged
        ? new Promise(() => {})
        : actual.realpath(...args)) as typeof actual.realpath,
    lstat: (async (...args: Parameters<typeof actual.lstat>) => {
      const stat = await actual.lstat(...args);
      const path = String(args[0]);
      if (seams.substituted && path.endsWith(seams.substituted))
        return Object.assign(stat, { ino: Number(stat.ino) + 1 });
      const suffix = seams.swapAfterFirstLstat;
      if (suffix && path.endsWith(suffix)) {
        if (seen.has(path))
          return Object.assign(stat, { ino: Number(stat.ino) + 1 });
        seen.add(path);
      }
      return stat;
    }) as typeof actual.lstat,
  };
});

const { createProjectCheckoutFreshnessReader } = await import(
  '../project-checkout-freshness.js'
);

const temp = trackTempDirs();
afterEach(() => {
  seams.swapAfterFirstLstat = undefined;
  seams.wedged = false;
  seams.substituted = undefined;
});

const DAY_MS = 24 * 60 * 60 * 1000;

function git(cwd: string, args: string[], date?: Date) {
  const stamp = date
    ? `@${Math.floor(date.getTime() / 1000)} +0000`
    : undefined;
  return execGitSync(
    ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args],
    {
      cwd,
      encoding: 'utf-8',
      hardening: { allowFileProtocol: true },
      ...(stamp
        ? { env: { GIT_AUTHOR_DATE: stamp, GIT_COMMITTER_DATE: stamp } }
        : {}),
    },
  )
    .toString()
    .trim();
}

/** A checkout one commit behind, fetched five days ago. */
function behindSinceFiveDays(): string {
  const root = temp('station-freshness-seams-');
  const upstream = join(root, 'upstream.git');
  const other = join(root, 'other');
  const checkout = join(root, 'checkout');
  git(root, ['init', '-q', '--bare', '-b', 'main', upstream]);
  git(root, ['clone', '-q', upstream, other]);
  git(other, ['checkout', '-q', '-b', 'main']);
  git(other, ['commit', '-q', '--allow-empty', '-m', 'first']);
  git(other, ['push', '-q', 'origin', 'main']);
  git(root, ['clone', '-q', upstream, checkout]);
  git(
    other,
    ['commit', '-q', '--allow-empty', '-m', 'second'],
    new Date(Date.now() - 6 * DAY_MS),
  );
  git(other, ['push', '-q', 'origin', 'main']);
  git(checkout, ['fetch', '-q'], new Date(Date.now() - 5 * DAY_MS));
  return checkout;
}

describe('project checkout freshness file-system seams', () => {
  test('a reflog folder swapped while it is read is not believed', async () => {
    const checkout = behindSinceFiveDays();
    const thresholds = { commits: 50, days: 3 };
    // Baseline: the reflog dates the move past HEAD five days ago.
    await expect(
      createProjectCheckoutFreshnessReader().read(checkout, thresholds),
    ).resolves.toMatchObject({ status: 'stale', staleBecause: ['age'] });
    // The same folder reports another identity on the walk after the read,
    // as a swapped-in link target would.
    seams.swapAfterFirstLstat = join('logs', 'refs', 'remotes', 'origin');
    const result = await createProjectCheckoutFreshnessReader().read(
      checkout,
      thresholds,
    );
    // Without the reflog only the six-day-old committer date remains; with
    // it, behindSince would be the fetch five days ago.
    expect(result).toMatchObject({ behind: 1 });
    const since =
      result.status === 'unknown'
        ? Number.NaN
        : Date.parse(result.behindSince ?? '');
    expect(Date.now() - since).toBeGreaterThan(5.5 * DAY_MS);
  });

  test('a reflog opened as a different file from the one walked is not believed', async () => {
    const checkout = behindSinceFiveDays();
    // Both walks see one file; the descriptor opened is another, as when a
    // file is swapped in between the walk and the open and back before the
    // second walk.
    seams.substituted = join('logs', 'refs', 'remotes', 'origin', 'main');
    const result = await createProjectCheckoutFreshnessReader().read(checkout, {
      commits: 50,
      days: 3,
    });
    expect(result).toMatchObject({ behind: 1 });
    const since =
      result.status === 'unknown'
        ? Number.NaN
        : Date.parse(result.behindSince ?? '');
    // Only the six-day-old committer date remains without the reflog.
    expect(Date.now() - since).toBeGreaterThan(5.5 * DAY_MS);
  });

  test('a read that never returns is answered unreadable at the deadline and tried again later', async () => {
    const checkout = behindSinceFiveDays();
    const reader = createProjectCheckoutFreshnessReader({ deadlineMs: 2_000 });
    seams.wedged = true;
    await expect(
      reader.read(checkout, { commits: 50, days: 3 }),
    ).resolves.toMatchObject({ status: 'unknown', reason: 'unreadable' });
    seams.wedged = false;
    await expect(
      reader.read(checkout, { commits: 50, days: 3 }),
    ).resolves.toMatchObject({ status: 'stale', behind: 1 });
  });
});

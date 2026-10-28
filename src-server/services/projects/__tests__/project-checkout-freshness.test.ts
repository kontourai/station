import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { execGitSync } from '../../../utils/git-exec.js';
import { createProjectCheckoutFreshnessReader } from '../project-checkout-freshness.js';

const roots: string[] = [];
afterEach(() => {
  while (roots.length > 0) {
    const dir = roots.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

const THRESHOLDS = { commits: 3, days: 3 };
const DAY_MS = 24 * 60 * 60 * 1000;

function git(cwd: string, args: string[], date?: Date): string {
  const stamp = date
    ? `@${Math.floor(date.getTime() / 1000)} +0000`
    : undefined;
  return execGitSync(
    ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args],
    {
      cwd,
      encoding: 'utf-8',
      // The fixture's upstream is a local bare repository.
      hardening: { allowFileProtocol: true },
      ...(stamp
        ? { env: { GIT_AUTHOR_DATE: stamp, GIT_COMMITTER_DATE: stamp } }
        : {}),
    },
  )
    .toString()
    .trim();
}

/**
 * A bare upstream, a clone tracking its `main` (the Project's checkout), and
 * a second clone that pushes new work to the upstream.
 */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'station-checkout-freshness-'));
  roots.push(root);
  const upstream = join(root, 'upstream.git');
  const checkout = join(root, 'checkout');
  const other = join(root, 'other');
  git(root, ['init', '-q', '--bare', '-b', 'main', upstream]);
  git(root, ['clone', '-q', upstream, other]);
  git(other, ['checkout', '-q', '-b', 'main']);
  git(other, ['commit', '-q', '--allow-empty', '-m', 'first']);
  git(other, ['push', '-q', 'origin', 'main']);
  git(root, ['clone', '-q', upstream, checkout]);
  const land = (count: number, date?: Date) => {
    for (let i = 0; i < count; i += 1)
      git(
        other,
        ['commit', '-q', '--allow-empty', '-m', `upstream ${i}`],
        date,
      );
    git(other, ['push', '-q', 'origin', 'main']);
  };
  return { root, upstream, checkout, other, land };
}

describe('project checkout freshness', () => {
  test('a checkout at its upstream is not stale and names its branch', async () => {
    const { checkout } = fixture();
    const result = await createProjectCheckoutFreshnessReader().read(
      checkout,
      THRESHOLDS,
    );
    expect(result).toMatchObject({
      status: 'not-stale',
      staleBecause: [],
      branch: 'main',
      upstream: 'origin/main',
      behind: 0,
      ahead: 0,
      thresholds: THRESHOLDS,
      updateCommand: `git -C ${checkout} pull --ff-only`,
    });
  });

  test('counts only commits the last fetch brought in: no fetch, no behind', async () => {
    const { checkout, land } = fixture();
    land(5);
    const result = await createProjectCheckoutFreshnessReader().read(
      checkout,
      THRESHOLDS,
    );
    expect(result).toMatchObject({ status: 'not-stale', behind: 0 });
  });

  test('behind by the commit threshold after a fetch is stale for commits, and the fetch time is reported', async () => {
    const { checkout, land } = fixture();
    land(3);
    git(checkout, ['fetch', '-q']);
    const fetchedAt = statSync(join(checkout, '.git', 'FETCH_HEAD')).mtime;
    const result = await createProjectCheckoutFreshnessReader().read(
      checkout,
      THRESHOLDS,
    );
    expect(result).toMatchObject({
      status: 'stale',
      staleBecause: ['commits'],
      behind: 3,
      ahead: 0,
      upstreamFetchedAt: fetchedAt.toISOString(),
    });
  });

  test('one commit below the threshold is not stale', async () => {
    const { checkout, land } = fixture();
    land(2);
    git(checkout, ['fetch', '-q']);
    const result = await createProjectCheckoutFreshnessReader().read(
      checkout,
      THRESHOLDS,
    );
    expect(result).toMatchObject({ status: 'not-stale', behind: 2 });
  });

  test('one missing commit that landed upstream longer ago than the day threshold is stale for age', async () => {
    const { checkout, land } = fixture();
    const landed = new Date(Date.now() - 4 * DAY_MS);
    land(1, landed);
    git(checkout, ['fetch', '-q']);
    const result = await createProjectCheckoutFreshnessReader().read(
      checkout,
      THRESHOLDS,
    );
    expect(result).toMatchObject({
      status: 'stale',
      staleBecause: ['age'],
      behind: 1,
      oldestMissingCommitAt: new Date(
        Math.floor(landed.getTime() / 1000) * 1000,
      ).toISOString(),
    });
  });

  test('ahead and behind are both reported for a diverged checkout', async () => {
    const { checkout, land } = fixture();
    land(4);
    git(checkout, ['commit', '-q', '--allow-empty', '-m', 'local']);
    git(checkout, ['fetch', '-q']);
    const result = await createProjectCheckoutFreshnessReader().read(
      checkout,
      THRESHOLDS,
    );
    expect(result).toMatchObject({ status: 'stale', behind: 4, ahead: 1 });
  });

  test('a branch with no upstream is unknown, not an error', async () => {
    const { checkout } = fixture();
    git(checkout, ['checkout', '-q', '-b', 'local-only']);
    const result = await createProjectCheckoutFreshnessReader().read(
      checkout,
      THRESHOLDS,
    );
    expect(result).toMatchObject({ status: 'unknown', reason: 'no-upstream' });
  });

  test('a detached HEAD is unknown', async () => {
    const { checkout } = fixture();
    git(checkout, ['checkout', '-q', '--detach']);
    const result = await createProjectCheckoutFreshnessReader().read(
      checkout,
      THRESHOLDS,
    );
    expect(result).toMatchObject({
      status: 'unknown',
      reason: 'detached-head',
    });
  });

  test('a directory outside any repository is unknown', async () => {
    const { root } = fixture();
    const plain = join(root, 'plain');
    mkdirSync(plain);
    const result = await createProjectCheckoutFreshnessReader().read(
      plain,
      THRESHOLDS,
    );
    expect(result).toMatchObject({
      status: 'unknown',
      reason: 'not-a-repository',
    });
  });

  test('a missing directory and an unset one are unknown', async () => {
    const { root } = fixture();
    const reader = createProjectCheckoutFreshnessReader();
    await expect(
      reader.read(join(root, 'gone'), THRESHOLDS),
    ).resolves.toMatchObject({
      status: 'unknown',
      reason: 'missing-directory',
    });
    await expect(reader.read(undefined, THRESHOLDS)).resolves.toMatchObject({
      status: 'unknown',
      reason: 'no-working-directory',
    });
  });

  test('a fetch made in a sibling worktree counts as the shared upstream ref’s fetch time', async () => {
    const { root, checkout, land } = fixture();
    const worktree = join(root, 'worktree');
    git(checkout, [
      'worktree',
      'add',
      '-q',
      worktree,
      '-b',
      'feature',
      'origin/main',
    ]);
    git(worktree, ['branch', '-q', '--set-upstream-to=origin/main']);
    land(3);
    git(checkout, ['fetch', '-q']);
    const old = new Date(Date.now() - 10 * DAY_MS);
    // The worktree's own FETCH_HEAD, if any, is older than the main checkout's.
    const mainFetch = statSync(join(checkout, '.git', 'FETCH_HEAD')).mtime;
    utimesSync(join(checkout, '.git', 'FETCH_HEAD'), old, mainFetch);
    const result = await createProjectCheckoutFreshnessReader().read(
      worktree,
      THRESHOLDS,
    );
    expect(result).toMatchObject({
      status: 'stale',
      branch: 'feature',
      behind: 3,
      upstreamFetchedAt: mainFetch.toISOString(),
    });
  });

  test('a directory path with spaces is quoted in the update command', async () => {
    const { root } = fixture();
    const spaced = join(root, 'my checkout');
    git(root, ['clone', '-q', join(root, 'upstream.git'), spaced]);
    const result = await createProjectCheckoutFreshnessReader().read(
      spaced,
      THRESHOLDS,
    );
    expect(result).toMatchObject({
      updateCommand: `git -C '${spaced}' pull --ff-only`,
    });
  });

  test('reuses facts within the window, reads again after it, and applies new thresholds at once', async () => {
    const { checkout, land } = fixture();
    let clock = Date.now();
    const reader = createProjectCheckoutFreshnessReader({
      now: () => new Date(clock),
      ttlMs: 1_000,
    });
    land(1);
    git(checkout, ['fetch', '-q']);
    await expect(reader.read(checkout, THRESHOLDS)).resolves.toMatchObject({
      status: 'not-stale',
      behind: 1,
    });
    land(3);
    git(checkout, ['fetch', '-q']);
    // Within the window: the remembered facts, judged by the new thresholds.
    await expect(
      reader.read(checkout, { commits: 1, days: 3 }),
    ).resolves.toMatchObject({
      status: 'stale',
      staleBecause: ['commits'],
      behind: 1,
    });
    clock += 1_001;
    await expect(reader.read(checkout, THRESHOLDS)).resolves.toMatchObject({
      status: 'stale',
      behind: 4,
    });
  });
});

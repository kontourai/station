import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  utimesSync,
} from 'node:fs';
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
/** git records whole seconds. */
const whole = (date: Date) =>
  new Date(Math.floor(date.getTime() / 1000) * 1000).toISOString();

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

  test('one missing commit this checkout has known about for longer than the day threshold is stale for age', async () => {
    const { checkout, land } = fixture();
    const landed = new Date(Date.now() - 5 * DAY_MS);
    land(1, landed);
    // git stamps the reflog entry with the committer date: this fetch is
    // recorded four days ago.
    const fetched = new Date(Date.now() - 4 * DAY_MS);
    git(checkout, ['fetch', '-q'], fetched);
    const result = await createProjectCheckoutFreshnessReader().read(checkout, {
      commits: 3,
      days: 3,
    });
    expect(result).toMatchObject({
      status: 'stale',
      behind: 1,
      behindSince: whole(fetched),
    });
    expect(result.status === 'stale' && result.staleBecause).toContain('age');
  });

  test('an old commit fast-forwarded and fetched just now is not stale for age', async () => {
    const { checkout, land } = fixture();
    // Its committer date is thirty days old, but it reached the upstream,
    // and this checkout, only now.
    land(1, new Date(Date.now() - 30 * DAY_MS));
    git(checkout, ['fetch', '-q']);
    const result = await createProjectCheckoutFreshnessReader().read(
      checkout,
      THRESHOLDS,
    );
    expect(result).toMatchObject({
      status: 'not-stale',
      staleBecause: [],
      behind: 1,
    });
  });

  test('without a reflog, age follows the first-parent line, not a merged branch’s older commits', async () => {
    const { checkout, other } = fixture();
    git(other, ['checkout', '-q', '-b', 'feature']);
    git(
      other,
      ['commit', '-q', '--allow-empty', '-m', 'old work'],
      new Date(Date.now() - 10 * DAY_MS),
    );
    git(other, ['checkout', '-q', 'main']);
    git(
      other,
      ['merge', '-q', '--no-ff', '-m', 'merge feature', 'feature'],
      new Date(Date.now() - DAY_MS),
    );
    git(other, ['push', '-q', 'origin', 'main']);
    git(checkout, ['fetch', '-q']);
    rmSync(join(checkout, '.git', 'logs', 'refs', 'remotes', 'origin', 'main'));
    const result = await createProjectCheckoutFreshnessReader().read(checkout, {
      commits: 50,
      days: 3,
    });
    expect(result).toMatchObject({ status: 'not-stale', behind: 2 });
  });

  test('a last fetch older than the day threshold is stale for fetch age, even with nothing behind', async () => {
    const { checkout } = fixture();
    git(checkout, ['fetch', '-q']);
    const old = new Date(Date.now() - 5 * DAY_MS);
    utimesSync(join(checkout, '.git', 'FETCH_HEAD'), old, old);
    const reflog = join(
      checkout,
      '.git',
      'logs',
      'refs',
      'remotes',
      'origin',
      'main',
    );
    if (existsSync(reflog)) utimesSync(reflog, old, old);
    const result = await createProjectCheckoutFreshnessReader().read(
      checkout,
      THRESHOLDS,
    );
    expect(result).toMatchObject({
      status: 'stale',
      staleBecause: ['fetch-age'],
      behind: 0,
      upstreamFetchedAt: old.toISOString(),
    });
  });

  test('a local branch as upstream reports no fetch time', async () => {
    const { checkout, land } = fixture();
    land(1);
    git(checkout, ['fetch', '-q']);
    git(checkout, ['branch', '-q', 'local-base', 'origin/main']);
    git(checkout, ['checkout', '-q', '-b', 'feature', 'main']);
    git(checkout, ['branch', '-q', '--set-upstream-to=local-base']);
    const result = await createProjectCheckoutFreshnessReader().read(
      checkout,
      THRESHOLDS,
    );
    expect(result).toMatchObject({ upstream: 'local-base', behind: 1 });
    expect(result).not.toHaveProperty('upstreamFetchedAt');
  });

  test('an upstream whose ref is missing, or whose remote does not exist, is no-upstream', async () => {
    const { checkout } = fixture();
    const reader = createProjectCheckoutFreshnessReader({ ttlMs: 0 });
    git(checkout, ['config', 'branch.main.remote', 'nowhere']);
    await expect(reader.read(checkout, THRESHOLDS)).resolves.toMatchObject({
      status: 'unknown',
      reason: 'no-upstream',
    });
    git(checkout, ['config', 'branch.main.remote', 'origin']);
    git(checkout, ['update-ref', '-d', 'refs/remotes/origin/main']);
    await expect(reader.read(checkout, THRESHOLDS)).resolves.toMatchObject({
      status: 'unknown',
      reason: 'no-upstream',
    });
  });

  test('a repository whose own config Station does not run git with is config-refused', async () => {
    const { checkout } = fixture();
    git(checkout, ['config', 'credential.helper', 'store']);
    const result = await createProjectCheckoutFreshnessReader().read(
      checkout,
      THRESHOLDS,
    );
    expect(result).toMatchObject({
      status: 'unknown',
      reason: 'config-refused',
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
    // The worktree has no FETCH_HEAD of its own. Give the shared records
    // distinct times: the main checkout's FETCH_HEAD is the newest.
    const reflogAt = new Date(Date.now() - 10 * DAY_MS);
    const mainFetch = new Date(Date.now() - 2 * DAY_MS);
    utimesSync(
      join(checkout, '.git', 'logs', 'refs', 'remotes', 'origin', 'main'),
      reflogAt,
      reflogAt,
    );
    utimesSync(join(checkout, '.git', 'FETCH_HEAD'), mainFetch, mainFetch);
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

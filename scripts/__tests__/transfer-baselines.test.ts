import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  findPathsInUse,
  listRegisteredWorktrees,
  pruneStaleTransferBaselines,
  TRANSFER_BASELINE_PREFIX,
  TRANSFER_BASELINE_PRUNE_ENV,
} from '../lib/transfer-baselines.mjs';
import { runTransferGate } from '../orchestration-transfer-gate.mjs';

// The managed per-file root is reclaimed by Vitest global teardown, even when
// a pooled worker is interrupted. Raw OS temp paths bypass that owner.
if (!process.env.STATION_ROOT)
  throw new Error(
    'Transfer baseline fixtures require the managed Vitest root.',
  );
const fixtureParent = process.env.STATION_ROOT;

const posix = process.platform !== 'win32';

function git(root: string, args: string[]) {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    windowsHide: true,
  }).trim();
}

const children: ChildProcess[] = [];
afterEach(() => {
  for (const child of children.splice(0)) child.kill('SIGKILL');
});

/** A child process whose cwd is `cwd` and whose argv never names it. */
async function holdCwd(cwd: string) {
  const child = spawn(
    process.execPath,
    ['-e', 'process.stdout.write("up\\n"); setInterval(() => {}, 1000)'],
    { cwd, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true },
  );
  children.push(child);
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.stdout?.once('data', () => resolve());
  });
  return child;
}

/**
 * A primary checkout with three commits (old1, old2, tip), `origin/main` at
 * the tip, and a sibling `station-worktrees/` holding real linked worktrees.
 */
function fixture() {
  const root = realpathSync(
    mkdtempSync(join(fixtureParent, 'station-transfer-baselines-')),
  );
  const primary = join(root, 'station');
  git(root, ['init', primary]);
  git(primary, ['config', 'user.email', 'transfer-baselines@example.test']);
  git(primary, ['config', 'user.name', 'Transfer baselines test']);
  const commit = (label: string) => {
    writeFileSync(join(primary, 'subject.txt'), `${label}\n`);
    git(primary, ['add', 'subject.txt']);
    git(primary, ['commit', '-m', label]);
    return git(primary, ['rev-parse', 'HEAD']);
  };
  const old1 = commit('old1');
  const old2 = commit('old2');
  const tip = commit('tip');
  git(primary, ['update-ref', 'refs/remotes/origin/main', tip]);
  const lanes = join(root, 'station-worktrees');
  mkdirSync(lanes, { recursive: true });
  const baselinePath = (sha: string, parent = lanes) =>
    join(parent, `${TRANSFER_BASELINE_PREFIX}${sha.slice(0, 12)}`);
  const addDetached = (path: string, sha: string) => {
    git(primary, ['worktree', 'add', '--detach', path, sha]);
    return path;
  };
  return { root, primary, lanes, old1, old2, tip, baselinePath, addDetached };
}

function registered(primary: string) {
  return listRegisteredWorktrees(primary).map((entry) => entry.path);
}

describe.skipIf(!posix)('transfer baseline pruning (#2355)', () => {
  test('prunes a stale baseline (even with a read-only directory) and keeps the tip, a live one, and every non-baseline', async () => {
    const f = fixture();
    const stale = f.addDetached(f.baselinePath(f.old1), f.old1);
    const tipBaseline = f.addDetached(f.baselinePath(f.tip), f.tip);
    const live = f.addDetached(f.baselinePath(f.old2), f.old2);
    // Known-bad controls: stale by HEAD, but not a tree this gate owns.
    const reviewPin = f.addDetached(join(f.lanes, 'review-pin-old1'), f.old1);
    const renamedParent = join(f.root, 'elsewhere');
    mkdirSync(renamedParent);
    const repointed = f.addDetached(
      f.baselinePath(f.old1, renamedParent),
      f.old2,
    );
    const branchLane = join(
      f.lanes,
      `${TRANSFER_BASELINE_PREFIX}${f.old2.slice(0, 12)}-branch`,
    );
    git(f.primary, ['worktree', 'add', '-b', 'lane', branchLane, f.old2]);
    // A baseline-named directory git does not know about.
    const unregistered = join(
      f.root,
      `${TRANSFER_BASELINE_PREFIX}${'0'.repeat(12)}`,
    );
    mkdirSync(unregistered);

    // Installs can leave read-only directories that defeat a plain removal.
    const readOnly = join(stale, 'node_modules', 'locked-pkg');
    mkdirSync(join(readOnly, 'inner'), { recursive: true });
    writeFileSync(join(readOnly, 'inner', 'file.js'), 'x\n');
    chmodSync(join(readOnly, 'inner'), 0o555);
    chmodSync(readOnly, 0o555);

    await holdCwd(live);

    const lines: string[] = [];
    const outcome = pruneStaleTransferBaselines({
      repoRoot: f.primary,
      keepShas: [f.tip],
      env: {},
      log: (line: string) => lines.push(line),
    });

    expect(outcome.skipped).toBeNull();
    expect(outcome.failed).toEqual([]);
    expect(outcome.pruned).toEqual([stale]);
    expect(existsSync(stale)).toBe(false);
    expect(lines).toContain(`Pruned stale transfer baseline: ${stale}`);

    expect(outcome.kept.map((entry) => entry.path)).toEqual([live]);
    expect(outcome.kept[0].reason).toMatch(/cwd inside/);

    const after = registered(f.primary);
    for (const survivor of [
      tipBaseline,
      live,
      reviewPin,
      repointed,
      branchLane,
    ])
      expect(after).toContain(survivor);
    expect(after).not.toContain(stale);
    expect(existsSync(unregistered)).toBe(true);
  });

  test('a process naming the baseline in its argv (the capture child shape) keeps it', async () => {
    const f = fixture();
    const stale = f.addDetached(f.baselinePath(f.old1), f.old1);
    const child = spawn(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1000)', stale],
      { cwd: f.root, stdio: 'ignore', windowsHide: true },
    );
    children.push(child);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const inUse = findPathsInUse([stale]);
    expect(inUse?.get(stale)).toBe(`process ${child.pid} names it`);
  });

  test(`${TRANSFER_BASELINE_PRUNE_ENV}=0 opts out: nothing is removed`, () => {
    const f = fixture();
    const stale = f.addDetached(f.baselinePath(f.old1), f.old1);
    const outcome = pruneStaleTransferBaselines({
      repoRoot: f.primary,
      keepShas: [f.tip],
      env: { [TRANSFER_BASELINE_PRUNE_ENV]: '0' },
      log: () => {},
    });
    expect(outcome.pruned).toEqual([]);
    expect(outcome.skipped).toMatch(TRANSFER_BASELINE_PRUNE_ENV);
    expect(registered(f.primary)).toContain(stale);
  });

  test('an unreadable process table removes nothing', () => {
    const f = fixture();
    const stale = f.addDetached(f.baselinePath(f.old1), f.old1);
    const outcome = pruneStaleTransferBaselines({
      repoRoot: f.primary,
      keepShas: [f.tip],
      env: {},
      log: () => {},
      pathsInUse: () => null,
    });
    expect(outcome.pruned).toEqual([]);
    expect(registered(f.primary)).toContain(stale);
  });

  test('Windows skips pruning rather than guessing at liveness', () => {
    const f = fixture();
    const stale = f.addDetached(f.baselinePath(f.old1), f.old1);
    const outcome = pruneStaleTransferBaselines({
      repoRoot: f.primary,
      keepShas: [f.tip],
      env: {},
      platform: 'win32',
      log: () => {},
    });
    expect(outcome.pruned).toEqual([]);
    expect(registered(f.primary)).toContain(stale);
  });
});

describe.skipIf(!posix)('--prepare-baseline reuse and pruning (#2355)', () => {
  const quiet = <T>(run: () => T): T => {
    const original = console.log;
    console.log = () => {};
    try {
      return run();
    } finally {
      console.log = original;
    }
  };

  test('reuses a verified baseline at the exact base instead of creating another, and prunes the stale one', () => {
    const f = fixture();
    const existing = f.addDetached(f.baselinePath(f.tip), f.tip);
    const stale = f.addDetached(f.baselinePath(f.old1), f.old1);
    const requested = join(f.root, 'requested-baseline');
    const verified: string[] = [];

    const result = quiet(() =>
      runTransferGate({
        candidateRoot: f.primary,
        baselineRoot: requested,
        base: f.tip,
        outputDir: '.kontourai/orchestration-transfer-gate',
        prepareBaseline: true,
        prepareDependencies: {
          verifyReusable: (root: string) => {
            verified.push(root);
          },
        },
      } as any),
    ) as any;

    expect(result).toMatchObject({ baselineRoot: existing, reused: true });
    expect(verified).toEqual([existing]);
    expect(existsSync(requested)).toBe(false);
    expect(registered(f.primary)).not.toContain(stale);
    expect(registered(f.primary)).toContain(existing);
  });

  test('a baseline whose dependencies do not verify is not reused; a fresh one is created', () => {
    const f = fixture();
    const existing = f.addDetached(f.baselinePath(f.tip), f.tip);
    const requested = join(f.root, 'requested-baseline');

    // Default verifier: this fixture has no lockfile or dependency lifecycle,
    // so the real checks must refuse it rather than reuse it.
    const result = quiet(() =>
      runTransferGate({
        candidateRoot: f.primary,
        baselineRoot: requested,
        base: f.tip,
        outputDir: '.kontourai/orchestration-transfer-gate',
        prepareBaseline: true,
      }),
    ) as any;

    expect(result).toMatchObject({ baselineRoot: requested, reused: false });
    expect(git(requested, ['rev-parse', 'HEAD'])).toBe(f.tip);
    // Both are at the tip, so neither is pruned.
    expect(registered(f.primary)).toEqual(
      expect.arrayContaining([existing, requested]),
    );
  });

  test('an explicit older --base keeps both that base and the origin/main tip', () => {
    const f = fixture();
    const tipBaseline = f.addDetached(f.baselinePath(f.tip), f.tip);
    const stale = f.addDetached(f.baselinePath(f.old1), f.old1);
    const requested = f.baselinePath(f.old2);

    quiet(() =>
      runTransferGate({
        candidateRoot: f.primary,
        baselineRoot: requested,
        base: f.old2,
        outputDir: '.kontourai/orchestration-transfer-gate',
        prepareBaseline: true,
      }),
    );

    const after = registered(f.primary);
    expect(after).toEqual(expect.arrayContaining([tipBaseline, requested]));
    expect(after).not.toContain(stale);
  });
});

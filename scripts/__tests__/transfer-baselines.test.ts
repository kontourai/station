import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  utimesSync,
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
  touchTransferBaselineMarker,
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
  // Worktrees are backdated past the recent-use window unless `fresh`, so a
  // test about liveness is not silently answered by the creation time.
  const addDetached = (path: string, sha: string, { fresh = false } = {}) => {
    git(primary, ['worktree', 'add', '--detach', path, sha]);
    if (!fresh) backdate(path);
    return path;
  };
  return { root, primary, lanes, old1, old2, tip, baselinePath, addDetached };
}

/** Push a worktree's creation evidence (`.git` file, admin dir) 2h back. */
function backdate(path: string) {
  const old = new Date(Date.now() - 2 * 60 * 60_000);
  const admin = git(path, ['rev-parse', '--absolute-git-dir']);
  for (const target of [join(path, '.git'), admin])
    utimesSync(target, old, old);
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
    // T1: exact canonical name AND a HEAD that matches it, at a stale SHA,
    // but checked out on a branch: someone's work, not a regenerable baseline.
    const branchedParent = join(f.root, 'branched');
    mkdirSync(branchedParent);
    const branchedCanonical = f.baselinePath(f.old1, branchedParent);
    git(f.primary, [
      'worktree',
      'add',
      '-b',
      'kept-branch',
      branchedCanonical,
      f.old1,
    ]);
    backdate(branchedCanonical);
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
      branchedCanonical,
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

  test('finishes a removal git abandoned after unregistering the tree (a file written mid-removal)', () => {
    const f = fixture();
    const stale = f.addDetached(f.baselinePath(f.old1), f.old1);
    const keep = f.addDetached(f.baselinePath(f.old2), f.old2);
    const outcome = pruneStaleTransferBaselines({
      repoRoot: f.primary,
      keepShas: [f.tip, f.old2],
      env: {},
      log: () => {},
      // Real git removal, then the observed macOS race: Finder recreates
      // .DS_Store, so git's final rmdir fails after it unregistered the tree.
      runGitRemove: (repoRoot: string, path: string) => {
        git(repoRoot, ['worktree', 'remove', '--force', path]);
        mkdirSync(path, { recursive: true });
        writeFileSync(join(path, '.DS_Store'), 'x');
        return {
          status: 128,
          stderr: `error: failed to delete '${path}': Directory not empty`,
        };
      },
    });
    expect(outcome.failed).toEqual([]);
    expect(outcome.pruned).toEqual([stale]);
    expect(existsSync(stale)).toBe(false);
    expect(registered(f.primary)).toContain(keep);
  });

  test('a failed removal of a tree git still lists is reported, not forced', () => {
    const f = fixture();
    const stale = f.addDetached(f.baselinePath(f.old1), f.old1);
    const outcome = pruneStaleTransferBaselines({
      repoRoot: f.primary,
      keepShas: [f.tip],
      env: {},
      log: () => {},
      runGitRemove: () => ({ status: 128, stderr: 'error: simulated' }),
    });
    expect(outcome.pruned).toEqual([]);
    expect(outcome.failed).toEqual([
      { path: stale, error: 'error: simulated' },
    ]);
    expect(existsSync(join(stale, 'subject.txt'))).toBe(true);
    expect(registered(f.primary)).toContain(stale);
  });

  test.skipIf(process.platform === 'linux')(
    'a failing lsof with partial output is unknown liveness, not an empty table',
    () => {
      const f = fixture();
      const stale = f.addDetached(f.baselinePath(f.old1), f.old1);
      const bin = join(f.root, 'fake-bin');
      mkdirSync(bin);
      // Partial listing that omits every process, then a failure exit.
      writeFileSync(
        join(bin, 'lsof'),
        '#!/bin/sh\nprintf "p1\\nn/\\n"\nexit 1\n',
        { mode: 0o755 },
      );
      const priorPath = process.env.PATH;
      process.env.PATH = `${bin}:${priorPath}`;
      try {
        expect(findPathsInUse([stale])).toBeNull();
      } finally {
        process.env.PATH = priorPath;
      }
    },
  );

  test('liveness is re-probed before each removal, so a tree taken into use mid-loop is kept', () => {
    const f = fixture();
    const first = f.addDetached(f.baselinePath(f.old1), f.old1);
    const second = f.addDetached(f.baselinePath(f.old2), f.old2);
    const probes: string[][] = [];
    const outcome = pruneStaleTransferBaselines({
      repoRoot: f.primary,
      keepShas: [f.tip],
      env: {},
      log: () => {},
      // Nothing is in use at the first probe; by the second, a session has
      // started using the second tree.
      pathsInUse: (paths: string[]) => {
        probes.push(paths);
        return new Map(
          probes.length > 1 ? paths.map((p) => [p, 'started meanwhile']) : [],
        );
      },
    });
    // `git worktree list` order follows admin-dir names, so do not assume
    // which tree comes first: one probe per removal, each naming one tree.
    expect(probes).toHaveLength(2);
    expect(probes.map((paths) => paths.length)).toEqual([1, 1]);
    expect(probes.flat().sort()).toEqual([first, second].sort());
    const [probedFirst, probedSecond] = probes.flat();
    expect(outcome.pruned).toEqual([probedFirst]);
    expect(outcome.kept).toEqual([
      { path: probedSecond, reason: 'started meanwhile' },
    ]);
    expect(registered(f.primary)).toContain(probedSecond);
  });

  test('a stale baseline a sibling gate marked recently, or one just created, is kept (review M1)', () => {
    const f = fixture();
    // Old worktree, but a gate in another session is using it right now via
    // STATION_TRANSFER_BASELINE_ROOT: no cwd, no argv, only the marker.
    const marked = f.addDetached(f.baselinePath(f.old1), f.old1);
    expect(touchTransferBaselineMarker(marked)).toBe(true);
    // Created moments ago by another session that is still installing.
    const fresh = f.addDetached(f.baselinePath(f.old2), f.old2, {
      fresh: true,
    });
    const outcome = pruneStaleTransferBaselines({
      repoRoot: f.primary,
      keepShas: [f.tip],
      env: {},
      log: () => {},
      pathsInUse: () => new Map(),
    });
    expect(outcome.pruned).toEqual([]);
    expect(outcome.kept.map((entry) => entry.path).sort()).toEqual(
      [marked, fresh].sort(),
    );
    for (const entry of outcome.kept)
      expect(entry.reason).toMatch(/^used or created \d+ min ago$/);
    // The marker must not dirty the tree the gate refuses when dirty.
    expect(git(marked, ['status', '--porcelain'])).toBe('');
  });

  test('the gate marks its baseline at the start of a run, before any root check', () => {
    const f = fixture();
    const baseline = f.addDetached(f.baselinePath(f.old1), f.old1);
    expect(() =>
      runTransferGate({
        candidateRoot: f.primary,
        baselineRoot: baseline,
        base: f.tip,
        outputDir: '.kontourai/orchestration-transfer-gate',
        prepareBaseline: false,
      }),
    ).toThrow(/baseline root is/);
    const outcome = pruneStaleTransferBaselines({
      repoRoot: f.primary,
      keepShas: [f.tip],
      env: {},
      log: () => {},
      pathsInUse: () => new Map(),
    });
    expect(outcome.pruned).toEqual([]);
    expect(outcome.kept[0]?.reason).toMatch(/^used or created/);
  });

  test('a process whose environment points STATION_TRANSFER_BASELINE_ROOT at the baseline keeps it (the pre-push shape)', async () => {
    const f = fixture();
    const stale = f.addDetached(f.baselinePath(f.old1), f.old1);
    // Node, not a platform binary: macOS hides a SIP-protected binary's
    // environment from ps -E, and the gate runs under node anyway.
    const child = spawn(
      process.execPath,
      ['-e', 'process.stdout.write("up\\n"); setInterval(() => {}, 1000)'],
      {
        cwd: f.root,
        env: { ...process.env, STATION_TRANSFER_BASELINE_ROOT: stale },
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      },
    );
    children.push(child);
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.stdout?.once('data', () => resolve());
    });
    const inUse = findPathsInUse([stale]);
    expect(inUse?.get(stale)).toBe(
      `process ${child.pid} has STATION_TRANSFER_BASELINE_ROOT set to it`,
    );
    // Boundaries: a longer sibling name is not this tree; a subpath is.
    const probe = (text: string) =>
      findPathsInUse([stale], {
        cwds: [],
        commands: [],
        environments: [{ pid: 1, text }],
      })?.has(stale);
    expect(probe(`A=1 STATION_TRANSFER_BASELINE_ROOT=${stale}-other B=2`)).toBe(
      false,
    );
    expect(probe(`STATION_TRANSFER_BASELINE_ROOT=${stale}/sub`)).toBe(true);
    expect(probe(`STATION_TRANSFER_BASELINE_ROOT=${stale} B=2`)).toBe(true);
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

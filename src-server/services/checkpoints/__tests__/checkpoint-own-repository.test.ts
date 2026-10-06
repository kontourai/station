/**
 * Checkpoints run git in a Project's folder, which is member-writable: a
 * `.git` there can be swapped for a link to another repository, and its
 * config can be rewritten, WHILE a capture or a restore is running. These
 * tests make that change at a chosen git call (the runner is wrapped, and
 * otherwise real), and prove each plant live with plain git.
 */
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { CheckpointIndexStore } from '../checkpoint-index-store.js';
import { CheckpointRefStore } from '../checkpoint-ref-store.js';
import { CheckpointRestoreService } from '../checkpoint-restore.js';

const hooks = vi.hoisted(() => ({
  beforeGit: undefined as ((args: string[]) => void) | undefined,
}));

vi.mock('../../../utils/git-exec.js', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('../../../utils/git-exec.js')>();
  return {
    ...original,
    execGit: ((args, options) => {
      hooks.beforeGit?.(args);
      return original.execGit(args, options);
    }) as typeof original.execGit,
  };
});

const makeTempDir = trackTempDirs();
let root: string;
let project: string;
let outside: string;

/** Plain git, NOT Station's runner. */
function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 20_000,
    windowsHide: true,
  }).trim();
}

function repo(dir: string, files: Record<string, string>): string {
  mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q', '-b', 'main']);
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content);
  }
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'initial']);
  return dir;
}

/** Everything a capture or restore could change in the outside repository:
 * its refs, its work tree, the checkpoint folders, and its object count (a
 * capture builds objects before it writes a ref). */
function outsideState(): string {
  return [
    git(outside, ['for-each-ref']),
    git(outside, ['status', '--porcelain']),
    String(existsSync(join(outside, '.git', 'STATION_CHECKPOINTS'))),
    String(existsSync(join(outside, '.git', 'logs', 'STATION_CHECKPOINTS'))),
    git(outside, ['count-objects', '-v']),
  ].join('\n');
}

/** Swaps the Project's `.git` for a link to the outside repository's. */
function swapGitForLink(): void {
  renameSync(join(project, '.git'), join(project, '.git-real'));
  symlinkSync(join(outside, '.git'), join(project, '.git'));
}

/** A program that records it ran, and the config that makes it a filter. */
function plantedFilter(): { config: string; ran: () => number } {
  const marker = join(root, 'ran.log');
  const program = join(root, 'program.sh');
  writeFileSync(program, `#!/bin/sh\necho ran >> '${marker}'\ncat\n`, {
    mode: 0o755,
  });
  return {
    config: `[filter "evil"]\n\tclean = ${program}\n\tsmudge = ${program}\n`,
    ran: () =>
      existsSync(marker)
        ? readFileSync(marker, 'utf-8').split('\n').filter(Boolean).length
        : 0,
  };
}

const capture = (checkpointId = 'cp-1') =>
  new CheckpointRefStore().capture({
    repoDir: project,
    threadId: 'thread-1',
    checkpointId,
    kind: 'settle',
    turnId: 'turn-1',
  });

beforeEach(() => {
  hooks.beforeGit = undefined;
  root = realpathSync(makeTempDir('station-checkpoint-own-'));
  const global = join(root, 'global.gitconfig');
  writeFileSync(
    global,
    '[user]\n\tname = Station Operator\n\temail = operator@station.test\n',
  );
  writeFileSync(join(root, 'system.gitconfig'), '');
  vi.stubEnv('GIT_CONFIG_GLOBAL', global);
  vi.stubEnv('GIT_CONFIG_SYSTEM', join(root, 'system.gitconfig'));
  outside = repo(join(root, 'outside'), { 'secret.txt': 'SECRET\n' });
  project = repo(join(root, 'project'), {
    'a.txt': 'one\n',
    '.gitattributes': '*.txt filter=evil\n',
  });
  return () => vi.unstubAllEnvs();
});

describe.skipIf(process.platform === 'win32')('checkpoint capture', () => {
  test('a .git swapped for a link to another repository during the capture: no ref is written there', async () => {
    writeFileSync(join(project, 'a.txt'), 'two\n');
    const before = outsideState();
    hooks.beforeGit = (args) => {
      if (
        args.includes('commit-tree') &&
        !existsSync(join(project, '.git-real'))
      )
        swapGitForLink();
    };

    const result = await capture();

    expect(existsSync(join(project, '.git-real')), 'the swap happened').toBe(
      true,
    );
    expect(result.status).toBe('degraded');
    expect(outsideState()).toBe(before);
    // Live: through the swapped `.git`, plain git writes there.
    git(project, ['update-ref', 'refs/heads/planted', 'HEAD']);
    expect(git(outside, ['for-each-ref'])).toContain('refs/heads/planted');
  });

  test('a .git swapped for a link to another repository while the capture builds its objects: none lands there', async () => {
    writeFileSync(join(project, 'a.txt'), 'two\n');
    writeFileSync(join(project, 'new.txt'), 'untracked, so a new blob\n');
    const before = outsideState();
    hooks.beforeGit = (args) => {
      // Before `add -A`, which writes the first new objects: from here
      // every object git builds would go through the swapped `.git`.
      if (args.includes('add') && !existsSync(join(project, '.git-real')))
        swapGitForLink();
    };

    const result = await capture();

    expect(existsSync(join(project, '.git-real')), 'the swap happened').toBe(
      true,
    );
    expect(result.status).toBe('degraded');
    expect(outsideState()).toBe(before);
    // Live: through the swapped `.git`, plain git writes an object there.
    git(project, ['hash-object', '-w', 'new.txt']);
    expect(outsideState()).not.toBe(before);
  });

  test('config rewritten to name a clean filter during the capture: the filter does not run', async () => {
    writeFileSync(join(project, 'a.txt'), 'two\n');
    const { config, ran } = plantedFilter();
    const path = join(project, '.git', 'config');
    const clean = readFileSync(path, 'utf-8');
    hooks.beforeGit = (args) => {
      // In place, after Station judged the config, before `add` reads files.
      if (args.includes('read-tree')) writeFileSync(path, clean + config);
    };

    const result = await capture();

    expect(ran(), 'the planted filter ran').toBe(0);
    expect(result.status).toBe('captured');
    // Control: plain git, reading that config, runs it.
    writeFileSync(join(project, 'a.txt'), 'three\n');
    git(project, ['add', '-A']);
    expect(ran(), 'control: plain git runs the filter').toBeGreaterThan(0);
  });

  test("a nested repository's commit is not recorded, whatever its .git names", async () => {
    const outsideHead = git(outside, ['rev-parse', 'HEAD']);
    mkdirSync(join(project, 'sub2'));
    writeFileSync(
      join(project, 'sub2', '.git'),
      `gitdir: ${join(outside, '.git')}\n`,
    );
    writeFileSync(join(project, 'a.txt'), 'two\n');
    // Live: plain `git add` would record the outside repository's commit.
    expect(git(project, ['add', '-A', '-n', '.'])).toContain("add 'sub2/'");

    const result = await capture();

    if (result.status !== 'captured') throw new Error(JSON.stringify(result));
    const tree = git(project, ['ls-tree', '-r', result.checkpoint.commitSha]);
    expect(tree).toContain('a.txt');
    expect(tree).not.toContain('sub2');
    expect(tree).not.toContain(outsideHead);
  });

  test('a thread folder linked to another folder: nothing there is listed or removed', async () => {
    const elsewhere = join(root, 'elsewhere');
    mkdirSync(elsewhere);
    writeFileSync(join(elsewhere, 'cp-1'), 'not a ref\n');
    mkdirSync(join(project, '.git', 'STATION_CHECKPOINTS'));
    symlinkSync(
      elsewhere,
      join(project, '.git', 'STATION_CHECKPOINTS', 'thread-1'),
    );
    const store = new CheckpointRefStore();
    const input = { repoDir: project, threadId: 'thread-1' };

    expect(await store.listCheckpoints(input)).toEqual([]);
    expect(
      await store.deleteCheckpoint({ ...input, checkpointId: 'cp-1' }),
    ).toBe('missing');
    expect(await store.pruneThreadCheckpoints(input)).toBe(0);
    await expect(
      store.deleteCheckpointForRetention({ ...input, checkpointId: 'cp-1' }),
    ).rejects.toThrow();
    expect(existsSync(join(elsewhere, 'cp-1'))).toBe(true);
  });

  test('a commondir naming another repository: no checkpoint is removed there', async () => {
    // The outside repository has a checkpoint of its own.
    mkdirSync(join(outside, '.git', 'STATION_CHECKPOINTS', 'thread-1'), {
      recursive: true,
    });
    writeFileSync(
      join(outside, '.git', 'STATION_CHECKPOINTS', 'thread-1', 'cp-1'),
      `${git(outside, ['rev-parse', 'HEAD'])}\n`,
    );
    writeFileSync(
      join(project, '.git', 'commondir'),
      `${join(outside, '.git')}\n`,
    );
    // Live: git's common directory for the Project is now the outside one.
    expect(
      realpathSync(
        git(project, [
          'rev-parse',
          '--path-format=absolute',
          '--git-common-dir',
        ]),
      ),
    ).toBe(join(outside, '.git'));
    const store = new CheckpointRefStore();
    const input = { repoDir: project, threadId: 'thread-1' };

    expect(
      await store.deleteCheckpoint({ ...input, checkpointId: 'cp-1' }),
    ).toBe('missing');
    expect(await store.pruneThreadCheckpoints(input)).toBe(0);
    expect(
      existsSync(
        join(outside, '.git', 'STATION_CHECKPOINTS', 'thread-1', 'cp-1'),
      ),
    ).toBe(true);
  });
});

describe.skipIf(process.platform === 'win32')('checkpoint restore', () => {
  async function captured() {
    writeFileSync(join(project, 'a.txt'), 'checkpoint bytes\n');
    const result = await capture();
    if (result.status !== 'captured') throw new Error(JSON.stringify(result));
    const home = join(root, 'home');
    mkdirSync(home);
    const index = new CheckpointIndexStore(home);
    index.recordTurnPhase('thread-1', 'turn-1', () => ({
      settle: { status: 'captured', ...result.checkpoint },
    }));
    writeFileSync(join(project, 'a.txt'), 'later bytes\n');
    writeFileSync(join(project, 'later-untracked.txt'), 'remove me\n');
    const service = new CheckpointRestoreService(
      index,
      new CheckpointRefStore(),
      home,
    );
    const preview = await service.preview({
      threadId: 'thread-1',
      turnId: 'turn-1',
      phase: 'settle',
      ownerKey: 'owner',
    });
    return () =>
      service.restore({
        threadId: 'thread-1',
        turnId: 'turn-1',
        previewId: preview.previewId,
        expectedCurrentTreeSha: preview.currentTreeSha,
        ownerKey: 'owner',
        confirmed: true,
      });
  }

  test('a .git swapped for a link to another repository during the restore: nothing is cleaned or checked out', async () => {
    const restore = await captured();
    const before = outsideState();
    let seeded = 0;
    hooks.beforeGit = (args) => {
      // The second time a temporary index is seeded from HEAD is the
      // materialize step, just before the work tree is cleaned.
      if (args.includes('read-tree') && args.includes('HEAD')) {
        seeded += 1;
        if (seeded === 2) swapGitForLink();
      }
    };

    await expect(restore()).rejects.toMatchObject({
      reason: 'workspace_changed',
    });

    expect(existsSync(join(project, '.git-real')), 'the swap happened').toBe(
      true,
    );
    expect(readFileSync(join(project, 'a.txt'), 'utf-8')).toBe('later bytes\n');
    expect(existsSync(join(project, 'later-untracked.txt'))).toBe(true);
    expect(outsideState()).toBe(before);
  });

  test('config rewritten to name a smudge filter during the restore: the filter does not run', async () => {
    const restore = await captured();
    const { config, ran } = plantedFilter();
    const path = join(project, '.git', 'config');
    const clean = readFileSync(path, 'utf-8');
    hooks.beforeGit = (args) => {
      if (args.includes('clean')) writeFileSync(path, clean + config);
    };

    // The files are written with the config that was judged; the check
    // that follows meets the rewritten one and refuses it.
    await expect(restore()).rejects.toMatchObject({
      reason: 'repository_config_refused',
    });

    expect(ran(), 'the planted filter ran').toBe(0);
    expect(readFileSync(join(project, 'a.txt'), 'utf-8')).toBe(
      'checkpoint bytes\n',
    );
    // Control: plain git, reading that config, runs it on a checkout.
    git(project, ['checkout', '-q', '-f', 'HEAD', '--', 'a.txt']);
    expect(ran(), 'control: plain git runs the filter').toBeGreaterThan(0);
  });
});

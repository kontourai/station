/**
 * #4507: work written after finalization's checks pass is still kept.
 *
 * The real git runner does every command against a real repository; the
 * wrapper only runs a step of the test immediately before one named
 * command, which is the window between the checks and the removal.
 */
import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { requireLiveRepository } from '../git-read-repository.js';
import {
  type GitCommandRunner,
  SpawnGitCommandRunner,
  WorktreeProvisioningService,
} from '../worktree-provisioning-service.js';

const makeTempDir = trackTempDirs();
const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Station Test',
  GIT_AUTHOR_EMAIL: 'test@station.invalid',
  GIT_COMMITTER_NAME: 'Station Test',
  GIT_COMMITTER_EMAIL: 'test@station.invalid',
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: ENV,
    windowsHide: true,
  });
}

/** The real runner, running `before` just ahead of the first matching command. */
function racingRunner(
  matches: (args: string[]) => boolean,
  before: () => void,
): GitCommandRunner {
  const real = new SpawnGitCommandRunner();
  let fired = false;
  return {
    run: (args, options) => {
      if (!fired && matches(args)) {
        fired = true;
        before();
      }
      return real.run(args, options);
    },
  };
}

async function taskWorktree() {
  const parent = realpathSync(makeTempDir('task-worktree-race-'));
  const repo = join(parent, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '--quiet', '--initial-branch=main');
  writeFileSync(join(repo, 'README.md'), 'project\n');
  git(repo, 'add', 'README.md');
  git(repo, 'commit', '--quiet', '-m', 'initial');
  const { metadata } = await new WorktreeProvisioningService().provisionForTask(
    {
      repoPath: repo,
      taskId: 'task-race',
      providerKind: 'codex',
      isolation: { mode: 'worktree' },
    },
  );
  return { parent, repo, metadata };
}

describe('Task worktree removal races (#4507)', () => {
  test('a file written after the checks keeps the worktree', async () => {
    const { metadata } = await taskWorktree();
    const service = new WorktreeProvisioningService(
      racingRunner(
        (args) => args.includes('worktree') && args.includes('remove'),
        () => writeFileSync(join(metadata.path, 'late.txt'), 'late work\n'),
      ),
    );

    const outcome = await service.finalizeForTask({
      metadata,
      taskId: 'task-race',
      terminalState: 'completed',
    });

    expect(outcome).toMatchObject({ outcome: 'kept', reason: 'uncommitted' });
    expect(existsSync(join(metadata.path, 'late.txt'))).toBe(true);
  });

  test('a commit made after the checks keeps the branch', async () => {
    const { repo, metadata } = await taskWorktree();
    const ref = `refs/heads/${metadata.branch}`;
    let moved = '';
    const service = new WorktreeProvisioningService(
      racingRunner(
        (args) => args.includes('update-ref'),
        () => {
          // A commit on the Task's branch, made from elsewhere once its
          // worktree is gone.
          const tree = git(repo, 'rev-parse', `${ref}^{tree}`).trim();
          moved = git(
            repo,
            'commit-tree',
            tree,
            '-p',
            ref,
            '-m',
            'late commit',
          ).trim();
          git(repo, 'update-ref', ref, moved);
        },
      ),
    );

    const outcome = await service.finalizeForTask({
      metadata,
      taskId: 'task-race',
      terminalState: 'completed',
    });

    expect(outcome).toMatchObject({ outcome: 'kept', reason: 'unpushed' });
    expect(git(repo, 'rev-parse', ref).trim()).toBe(moved);
  });

  test('with nothing in the window, the worktree and branch are removed', async () => {
    const { repo, metadata } = await taskWorktree();

    const outcome = await new WorktreeProvisioningService().finalizeForTask({
      metadata,
      taskId: 'task-race',
      terminalState: 'completed',
    });

    expect(outcome).toEqual({ outcome: 'removed' });
    expect(existsSync(metadata.path)).toBe(false);
    expect(git(repo, 'branch', '--list', metadata.branch).trim()).toBe('');
  });

  // #2411 for finalization: `status` and a non-forced `worktree remove` run
  // clean filters, and the repository's config is member-writable. A filter
  // planted after the worktree was made must not run as the operator.
  test('a clean filter planted in the repository config is not run, and the worktree is kept', async () => {
    const { parent, repo, metadata } = await taskWorktree();
    const marker = join(parent, 'FILTER-RAN');
    git(repo, 'config', 'filter.evil.clean', `sh -c 'touch ${marker}; cat'`);
    writeFileSync(join(repo, '.git', 'info', 'attributes'), '* filter=evil\n');
    // Racy stat data, so git would re-read (and filter) the file.
    const later = new Date(Date.now() + 5_000);
    utimesSync(join(metadata.path, 'README.md'), later, later);

    const outcome = await new WorktreeProvisioningService().finalizeForTask({
      metadata,
      taskId: 'task-race',
      terminalState: 'completed',
    });

    expect(existsSync(marker)).toBe(false);
    expect(outcome).toMatchObject({ outcome: 'kept', reason: 'unsafe-config' });
    expect(existsSync(metadata.path)).toBe(true);
  });

  // Where links need privilege (Windows), the judged copy holds a COPY of
  // `packed-refs`. Finalization deletes the branch against the real git
  // directory, so a packed branch is deleted for real with the copy in
  // place (simulated by replacing the copy's link with a copy). Not a
  // revert detector on every git: macOS git 2.54 also rewrote the real
  // packed-refs through the copy; the next test pins the after-check.
  test('a packed Task branch is deleted for real with a copied packed-refs in the judged copy', async () => {
    const { repo, metadata } = await taskWorktree();
    git(repo, 'pack-refs', '--all');
    const copiedPackedRefs = async (
      folder: string,
      root: string,
      options: { newWorktree?: true },
    ) => {
      const opened = await requireLiveRepository(folder, root, options);
      const packed = join(opened.env.GIT_COMMON_DIR, 'packed-refs');
      if (existsSync(packed) && lstatSync(packed).isSymbolicLink()) {
        const target = readlinkSync(packed);
        rmSync(packed);
        copyFileSync(target, packed);
      }
      return opened;
    };
    const service = new WorktreeProvisioningService(
      new SpawnGitCommandRunner(),
      copiedPackedRefs,
    );

    const outcome = await service.finalizeForTask({
      metadata,
      taskId: 'task-race',
      terminalState: 'completed',
    });

    expect(outcome).toEqual({ outcome: 'removed' });
    expect(git(repo, 'branch', '--list', metadata.branch).trim()).toBe('');
  });

  test('a branch still present after its deletion is reported kept, never removed', async () => {
    const { repo, metadata } = await taskWorktree();
    const real = new SpawnGitCommandRunner();
    // update-ref says it deleted the branch, and did not.
    const lying: GitCommandRunner = {
      run: (args, options) =>
        args.includes('update-ref')
          ? Promise.resolve({ stdout: '', stderr: '', code: 0 })
          : real.run(args, options),
    };

    const outcome = await new WorktreeProvisioningService(
      lying,
    ).finalizeForTask({
      metadata,
      taskId: 'task-race',
      terminalState: 'completed',
    });

    expect(outcome).toMatchObject({ outcome: 'kept', reason: 'failed' });
    expect(git(repo, 'branch', '--list', metadata.branch).trim()).not.toBe('');
  });

  test('a refused include keeps the worktree and is described as included configuration', async () => {
    const { parent, repo, metadata } = await taskWorktree();
    const marker = join(parent, 'INCLUDED-FILTER-RAN');
    const included = join(parent, 'included.gitconfig');
    writeFileSync(
      included,
      `[filter "evil"]\n\tclean = sh -c 'touch ${marker}; cat'\n`,
    );
    git(repo, 'config', 'include.path', included);
    writeFileSync(join(repo, '.git', 'info', 'attributes'), '* filter=evil\n');

    const outcome = await new WorktreeProvisioningService().finalizeForTask({
      metadata,
      taskId: 'task-race',
      terminalState: 'completed',
    });

    expect(existsSync(marker)).toBe(false);
    expect(outcome).toMatchObject({ outcome: 'kept', reason: 'unsafe-config' });
    const detail = (outcome as { detail?: string }).detail ?? '';
    expect(detail).toContain('pulls in configuration from another file');
    expect(detail).not.toContain('which git would run');
  });
});

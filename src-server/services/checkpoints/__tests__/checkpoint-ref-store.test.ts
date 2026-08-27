/**
 * station#2802 slice 1 — checkpoint ref store coverage against REAL
 * throwaway git repositories.
 *
 * The properties that matter most here are the ones only a real git can
 * falsify: that a capture never touches the user's index or HEAD, that
 * untracked-but-not-ignored files land in the snapshot tree while ignored
 * ones do not, and that the hidden refs are invisible to `git branch`,
 * `git tag`, and `git log --all`. Fixture shape follows
 * `scripts/__tests__/rename-inventory.test.ts` (throwaway repo per case,
 * git driven through execFileSync with windowsHide).
 */

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { CheckpointRefStore } from '../checkpoint-ref-store.js';

const scratchDirs: string[] = [];

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd: dir,
    encoding: 'utf-8',
    windowsHide: true,
  });
}

function newRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'station-checkpoint-store-'));
  scratchDirs.push(dir);
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'checkpoint@test.invalid');
  git(dir, 'config', 'user.name', 'checkpoint test');
  writeFileSync(join(dir, 'committed.txt'), 'committed\n');
  writeFileSync(join(dir, '.gitignore'), '*.ign\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'base');
  return dir;
}

function userIndexPath(dir: string): string {
  return join(dir, '.git', 'index');
}

afterAll(() => {
  for (const dir of scratchDirs) {
    execFileSync('rm', ['-rf', dir]);
  }
});

describe('CheckpointRefStore.capture', () => {
  it('snapshots modified, untracked, and ignored-excluded state without touching the user index or HEAD', async () => {
    const dir = newRepo();
    const store = new CheckpointRefStore();
    const headBefore = git(dir, 'rev-parse', 'HEAD').trim();
    const indexBefore = readFileSync(userIndexPath(dir));
    const branchesBefore = git(dir, 'branch', '--format=%(refname)').trim();

    writeFileSync(join(dir, 'committed.txt'), 'committed\nmodified\n');
    writeFileSync(join(dir, 'untracked.txt'), 'untracked content\n');
    writeFileSync(join(dir, 'ignored.ign'), 'should not be captured\n');

    const result = await store.capture({
      repoDir: dir,
      threadId: 'thread-1',
      checkpointId: 'cp-1',
      kind: 'baseline',
      turnId: 'turn-1',
    });

    expect(result.status).toBe('captured');
    if (result.status !== 'captured') return;
    // git's --show-toplevel reports the real path (on macOS tmpdirs resolve
    // through /private), matching how the coding routes realpath workspaces.
    expect(result.checkpoint.repoRoot).toBe(realpathSync(dir));

    // The snapshot tree carries the modified tracked file and the
    // untracked file, but not the ignored one.
    const listing = git(
      dir,
      'ls-tree',
      '-r',
      '--name-only',
      result.checkpoint.treeSha,
    );
    expect(listing).toContain('committed.txt');
    expect(listing).toContain('untracked.txt');
    expect(listing).toContain('.gitignore');
    expect(listing).not.toContain('ignored.ign');
    const blob = git(dir, 'show', `${result.checkpoint.treeSha}:committed.txt`);
    expect(blob).toContain('modified');

    // The user's index is byte-identical, HEAD unmoved, no branch created.
    expect(readFileSync(userIndexPath(dir))).toEqual(indexBefore);
    expect(git(dir, 'rev-parse', 'HEAD').trim()).toBe(headBefore);
    expect(git(dir, 'branch', '--format=%(refname)').trim()).toBe(
      branchesBefore,
    );
    // Nothing was staged by the capture.
    expect(git(dir, 'status', '--porcelain')).not.toContain('A  ');
    // The checkpoint commit's parent is HEAD; it is not on any branch.
    expect(
      git(dir, 'rev-parse', `${result.checkpoint.commitSha}^`).trim(),
    ).toBe(headBefore);
    expect(
      git(dir, 'branch', '--contains', result.checkpoint.commitSha).trim(),
    ).toBe('');
  });

  it('captures a clean tree cheaply and successfully', async () => {
    const dir = newRepo();
    const store = new CheckpointRefStore();
    const headTree = git(dir, 'rev-parse', 'HEAD^{tree}').trim();

    const started = Date.now();
    const result = await store.capture({
      repoDir: dir,
      threadId: 'thread-clean',
      checkpointId: 'cp-clean',
      kind: 'settle',
      turnId: 'turn-clean',
    });
    expect(Date.now() - started).toBeLessThan(5_000);

    expect(result.status).toBe('captured');
    if (result.status !== 'captured') return;
    // A clean tree snapshots to exactly HEAD's tree.
    expect(result.checkpoint.treeSha).toBe(headTree);
  });

  it('hides checkpoint refs from git branch, git tag, and git log --all', async () => {
    const dir = newRepo();
    const store = new CheckpointRefStore();
    writeFileSync(join(dir, 'off-branch-change.txt'), 'change\n');

    const result = await store.capture({
      repoDir: dir,
      threadId: 'thread-hidden',
      checkpointId: 'cp-hidden',
      kind: 'baseline',
      turnId: 'turn-hidden',
    });
    expect(result.status).toBe('captured');
    if (result.status !== 'captured') return;

    expect(git(dir, 'branch', '-a')).not.toContain('STATION_CHECKPOINTS');
    expect(git(dir, 'tag')).toBe('');
    // THE regression assertion: `--all` traverses every ref under refs/ —
    // a checkpoint stored anywhere in refs/ (e.g. refs/station/...) would
    // surface its commit here as an extra line beyond the base commit.
    const logAll = git(dir, 'log', '--all', '--oneline');
    expect(logAll.trim().split('\n')).toHaveLength(1);
    expect(logAll).not.toContain('station checkpoint');
    expect(git(dir, 'for-each-ref')).not.toContain('STATION_CHECKPOINTS');
  });

  it('degrades with a typed reason on an empty repository (unborn HEAD)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'station-checkpoint-empty-'));
    scratchDirs.push(dir);
    git(dir, 'init', '-q', '-b', 'main');
    writeFileSync(join(dir, 'file.txt'), 'never committed\n');

    const result = await new CheckpointRefStore().capture({
      repoDir: dir,
      threadId: 't',
      checkpointId: 'c',
      kind: 'baseline',
      turnId: 'turn-1',
    });
    expect(result).toMatchObject({ status: 'degraded', reason: 'unborn_head' });
    expect(existsSync(join(dir, '.git', 'STATION_CHECKPOINTS'))).toBe(false);
  });

  it('degrades with a typed reason on a detached HEAD', async () => {
    const dir = newRepo();
    git(dir, 'checkout', '-q', '--detach', 'HEAD');

    const result = await new CheckpointRefStore().capture({
      repoDir: dir,
      threadId: 't',
      checkpointId: 'c',
      kind: 'baseline',
      turnId: 'turn-1',
    });
    expect(result).toMatchObject({
      status: 'degraded',
      reason: 'detached_head',
    });
  });

  it('degrades with a typed reason mid-rebase', async () => {
    const dir = newRepo();
    git(dir, 'checkout', '-q', '-b', 'feature');
    writeFileSync(join(dir, 'committed.txt'), 'feature change\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'feature');
    git(dir, 'checkout', '-q', 'main');
    writeFileSync(join(dir, 'committed.txt'), 'main change\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'main');
    git(dir, 'checkout', '-q', 'feature');
    // Rebase onto main conflicts on committed.txt → repository is left
    // mid-rebase with rebase-merge/ present.
    const spawned = execFileSync(
      'sh',
      ['-c', `cd ${JSON.stringify(dir)} && git rebase main; true`],
      { encoding: 'utf-8', windowsHide: true },
    );
    expect(spawned).toMatch(/CONFLICT|rebase/i);

    const result = await new CheckpointRefStore().capture({
      repoDir: dir,
      threadId: 't',
      checkpointId: 'c',
      kind: 'settle',
      turnId: 'turn-1',
    });
    expect(result).toMatchObject({
      status: 'degraded',
      reason: 'rebase_in_progress',
    });
  });

  it('returns a typed not_a_git_repository result for a plain directory', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'station-checkpoint-nogit-'));
    scratchDirs.push(dir);
    writeFileSync(join(dir, 'file.txt'), 'not a repo\n');

    const result = await new CheckpointRefStore().capture({
      repoDir: dir,
      threadId: 't',
      checkpointId: 'c',
      kind: 'baseline',
      turnId: 'turn-1',
    });
    expect(result.status).toBe('degraded');
    if (result.status !== 'degraded') return;
    expect(result.reason).toBe('not_a_git_repository');
  });

  it('rejects unsafe ref segments before touching the filesystem', async () => {
    const dir = newRepo();
    const result = await new CheckpointRefStore().capture({
      repoDir: dir,
      threadId: '../evil',
      checkpointId: 'c',
      kind: 'baseline',
      turnId: 'turn-1',
    });
    expect(result.status).toBe('degraded');
    expect(existsSync(join(dir, '.git', 'STATION_CHECKPOINTS'))).toBe(false);
  });
});

describe('CheckpointRefStore read/list/delete', () => {
  it('reads a captured checkpoint back through the ref', async () => {
    const dir = newRepo();
    const store = new CheckpointRefStore();
    writeFileSync(join(dir, 'r.txt'), 'read me\n');
    const captured = await store.capture({
      repoDir: dir,
      threadId: 'thread-read',
      checkpointId: 'cp-read',
      kind: 'baseline',
      turnId: 'turn-read',
    });
    expect(captured.status).toBe('captured');
    if (captured.status !== 'captured') return;

    const read = await store.readCheckpoint({
      repoDir: dir,
      threadId: 'thread-read',
      checkpointId: 'cp-read',
    });
    expect(read.status).toBe('ok');
    if (read.status !== 'ok' || !read.checkpoint) return;
    expect(read.checkpoint.commitSha).toBe(captured.checkpoint.commitSha);
    expect(read.checkpoint.treeSha).toBe(captured.checkpoint.treeSha);
  });

  it('distinguishes a missing ref from a pruned object', async () => {
    const dir = newRepo();
    const store = new CheckpointRefStore();
    const captured = await store.capture({
      repoDir: dir,
      threadId: 'thread-prune',
      checkpointId: 'cp-prune',
      kind: 'baseline',
      turnId: 'turn-prune',
    });
    expect(captured.status).toBe('captured');

    const missing = await store.readCheckpoint({
      repoDir: dir,
      threadId: 'thread-prune',
      checkpointId: 'never-captured',
    });
    expect(missing.status).toBe('missing');

    // Fabricate the post-gc state: the ref file survives but points at an
    // object that no longer exists in the object database.
    const refPath = join(
      dir,
      '.git',
      'STATION_CHECKPOINTS',
      'thread-prune',
      'cp-prune',
    );
    writeFileSync(refPath, `${'0'.repeat(40)}\n`);
    const pruned = await store.readCheckpoint({
      repoDir: dir,
      threadId: 'thread-prune',
      checkpointId: 'cp-prune',
    });
    expect(pruned.status).toBe('object_pruned');
  });

  it('lists a thread\u2019s checkpoints and deletes one (ref and reflog)', async () => {
    const dir = newRepo();
    const store = new CheckpointRefStore();
    for (const id of ['cp-a', 'cp-b']) {
      writeFileSync(join(dir, `${id}.txt`), `${id}\n`);
      const captured = await store.capture({
        repoDir: dir,
        threadId: 'thread-list',
        checkpointId: id,
        kind: 'baseline',
        turnId: `turn-${id}`,
      });
      expect(captured.status).toBe('captured');
    }

    const listed = await store.listCheckpoints({
      repoDir: dir,
      threadId: 'thread-list',
    });
    expect(listed.map((entry) => entry.checkpointId).sort()).toEqual([
      'cp-a',
      'cp-b',
    ]);

    expect(
      await store.deleteCheckpoint({
        repoDir: dir,
        threadId: 'thread-list',
        checkpointId: 'cp-a',
      }),
    ).toBe('deleted');
    expect(
      existsSync(
        join(dir, '.git', 'logs', 'STATION_CHECKPOINTS', 'thread-list', 'cp-a'),
      ),
    ).toBe(false);
    expect(
      (
        await store.listCheckpoints({ repoDir: dir, threadId: 'thread-list' })
      ).map((entry) => entry.checkpointId),
    ).toEqual(['cp-b']);
    expect(
      await store.deleteCheckpoint({
        repoDir: dir,
        threadId: 'thread-list',
        checkpointId: 'cp-a',
      }),
    ).toBe('missing');

    const prunedCount = await store.pruneThreadCheckpoints({
      repoDir: dir,
      threadId: 'thread-list',
    });
    expect(prunedCount).toBe(1);
    expect(
      await store.listCheckpoints({ repoDir: dir, threadId: 'thread-list' }),
    ).toEqual([]);
  });
});

describe('CheckpointRefStore git-side self-description (fix round M6/L1)', () => {
  it('records turnId, phase, and exact capturedAt in the commit message', async () => {
    const dir = newRepo();
    const store = new CheckpointRefStore();
    writeFileSync(join(dir, 'm.txt'), 'message\n');
    const captured = await store.capture({
      repoDir: dir,
      threadId: 'thread-msg',
      checkpointId: 'cp-msg',
      kind: 'settle',
      turnId: 'turn-msg-42',
    });
    expect(captured.status).toBe('captured');
    if (captured.status !== 'captured') return;

    const body = git(
      dir,
      'show',
      '-s',
      '--format=%B',
      captured.checkpoint.commitSha,
    );
    expect(body).toContain('turn=turn-msg-42');
    expect(body).toContain('phase=settle');
    expect(body).toContain(`captured-at=${captured.checkpoint.capturedAt}`);

    // The reflog message answers "which turn" without reading the commit.
    const reflog = readFileSync(
      join(dir, '.git', 'logs', 'STATION_CHECKPOINTS', 'thread-msg', 'cp-msg'),
      'utf-8',
    );
    expect(reflog).toContain('turn=turn-msg-42');

    // THE index-is-rebuildable claim: turn + timestamp survive in git alone.
    const read = await store.readCheckpoint({
      repoDir: dir,
      threadId: 'thread-msg',
      checkpointId: 'cp-msg',
    });
    expect(read.status).toBe('ok');
    if (read.status !== 'ok' || !read.checkpoint) return;
    // L1: EXACT round-trip, milliseconds included — %aI would truncate to
    // seconds and the trailer is what preserves the precision.
    expect(read.checkpoint.capturedAt).toBe(captured.checkpoint.capturedAt);
    expect(read.checkpoint.capturedAt).toMatch(/\.\d{3}Z$/);
  });

  it('sorts a baseline/settle pair inside one second deterministically', async () => {
    const dir = newRepo();
    const store = new CheckpointRefStore();
    // Two captures within the same second (git dates identical) — only the
    // captured-at trailer keeps them distinguishable and ordered.
    const first = await store.capture({
      repoDir: dir,
      threadId: 'thread-order',
      checkpointId: 'cp-first',
      kind: 'baseline',
      turnId: 'turn-a',
    });
    const second = await store.capture({
      repoDir: dir,
      threadId: 'thread-order',
      checkpointId: 'cp-second',
      kind: 'settle',
      turnId: 'turn-a',
    });
    expect(first.status).toBe('captured');
    expect(second.status).toBe('captured');
    const listed = await store.listCheckpoints({
      repoDir: dir,
      threadId: 'thread-order',
    });
    expect(listed.map((entry) => entry.checkpointId)).toEqual([
      'cp-first',
      'cp-second',
    ]);
  });
});

describe('CheckpointRefStore linked-worktree rebase detection (fix round M1)', () => {
  it('a mid-rebase MAIN worktree does not block captures in a sibling LINKED worktree', async () => {
    const main = newRepo();
    git(main, 'checkout', '-q', '-b', 'feature');
    writeFileSync(join(main, 'committed.txt'), 'feature change\n');
    git(main, 'add', '-A');
    git(main, 'commit', '-q', '-m', 'feature');
    git(main, 'checkout', '-q', 'main');
    writeFileSync(join(main, 'committed.txt'), 'main change\n');
    git(main, 'add', '-A');
    git(main, 'commit', '-q', '-m', 'main');

    const linked = join(dirname(main), 'station-cp-linked-wt');
    scratchDirs.push(linked);
    git(main, 'worktree', 'add', '-q', linked, '-b', 'linked-branch');

    // Rebase (conflicting) in the MAIN worktree — rebase-merge/ appears in
    // the SHARED common dir, where the old commonDir probe looked.
    git(main, 'checkout', '-q', 'feature');
    const spawned = execFileSync(
      'sh',
      ['-c', `cd ${JSON.stringify(main)} && git rebase main; true`],
      { encoding: 'utf-8', windowsHide: true },
    );
    expect(spawned).toMatch(/CONFLICT|rebase/i);

    // The linked worktree is NOT mid-rebase: its capture must succeed.
    // (The pre-fix probe read commonDir/rebase-merge and skipped every
    // sibling worktree of any mid-rebase checkout — one rebase parked in
    // the main worktree silently disabled all ~100 siblings.)
    writeFileSync(join(linked, 'linked.txt'), 'linked\n');
    const result = await new CheckpointRefStore().capture({
      repoDir: linked,
      threadId: 'thread-linked',
      checkpointId: 'cp-linked',
      kind: 'baseline',
      turnId: 'turn-1',
    });
    expect(result).toMatchObject({ status: 'captured' });
  });

  it('a genuine rebase IN a linked worktree is reported as rebase_in_progress, not detached_head', async () => {
    const main = newRepo();
    git(main, 'checkout', '-q', '-b', 'feature');
    writeFileSync(join(main, 'committed.txt'), 'feature change\n');
    git(main, 'add', '-A');
    git(main, 'commit', '-q', '-m', 'feature');
    git(main, 'checkout', '-q', 'main');
    writeFileSync(join(main, 'committed.txt'), 'main change\n');
    git(main, 'add', '-A');
    git(main, 'commit', '-q', '-m', 'main');

    const linked = join(dirname(main), 'station-cp-linked-wt2');
    scratchDirs.push(linked);
    // Branch from `feature` (which diverged from main) so the linked
    // worktree's own rebase onto main actually conflicts.
    git(
      main,
      'worktree',
      'add',
      '-q',
      linked,
      '-b',
      'linked-branch',
      'feature',
    );
    writeFileSync(join(linked, 'committed.txt'), 'linked change\n');
    git(linked, 'add', '-A');
    git(linked, 'commit', '-q', '-m', 'linked');
    // Conflicting rebase INSIDE the linked worktree: its rebase state lives
    // at <common>/worktrees/<name>/rebase-merge, invisible to the old
    // commonDir probe — which then fell through to detached_head.
    const spawned = execFileSync(
      'sh',
      ['-c', `cd ${JSON.stringify(linked)} && git rebase main; true`],
      { encoding: 'utf-8', windowsHide: true },
    );
    expect(spawned).toMatch(/CONFLICT|rebase/i);

    const result = await new CheckpointRefStore().capture({
      repoDir: linked,
      threadId: 't',
      checkpointId: 'c',
      kind: 'baseline',
      turnId: 'turn-1',
    });
    expect(result).toMatchObject({
      status: 'degraded',
      reason: 'rebase_in_progress',
    });
  });
});

describe('CheckpointRefStore git timeout (fix round M2)', () => {
  it('degrades to a typed git_timeout record when a clean filter wedges git add', async () => {
    const dir = newRepo();
    // A clean filter that sleeps far longer than the injected timeout —
    // the git-lfs-with-unreachable-endpoint shape.
    const filterScript = join(dir, 'slow-clean.sh');
    writeFileSync(filterScript, '#!/bin/sh\nsleep 30\nexec cat\n');
    execFileSync('chmod', ['+x', filterScript]);
    git(dir, 'config', 'filter.slow.clean', `sh ${filterScript}`);
    git(dir, 'config', 'filter.slow.smudge', 'cat');
    git(dir, 'config', 'filter.slow.required', 'true');
    // Untracked on purpose: setup must not run the clean filter — only the
    // capture's `git add -A` reaches it.
    writeFileSync(join(dir, 'slow.bin'), 'payload\n');
    writeFileSync(join(dir, '.gitattributes'), '*.bin filter=slow\n');

    const started = Date.now();
    const result = await new CheckpointRefStore({ gitTimeoutMs: 500 }).capture({
      repoDir: dir,
      threadId: 't',
      checkpointId: 'c',
      kind: 'baseline',
      turnId: 'turn-1',
    });
    // Bounded: the timeout fired, not the sleep.
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(result).toMatchObject({ status: 'degraded', reason: 'git_timeout' });
    if (result.status !== 'degraded') return;
    expect(result.reason).toBe('git_timeout');
  });
});

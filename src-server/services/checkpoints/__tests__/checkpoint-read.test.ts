/**
 * station#2802 fix round (M3) — the read path must observe the retention
 * bound. Served `captured` records carry a computed objectStatus derived
 * from the LIVE git object store, so an index record whose checkpoint
 * commit was pruned (post `gc.reflogExpire`) can never present as an
 * intact checkpoint.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { CheckpointIndexStore } from '../checkpoint-index-store.js';
import { listThreadRecordsWithObjectStatus } from '../checkpoint-read.js';
import { CheckpointRefStore } from '../checkpoint-ref-store.js';

const scratch: string[] = [];

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd: dir,
    encoding: 'utf-8',
    windowsHide: true,
  });
}

function newRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'station-cp-read-'));
  scratch.push(dir);
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'checkpoint@test.invalid');
  git(dir, 'config', 'user.name', 'checkpoint test');
  writeFileSync(join(dir, 'committed.txt'), 'committed\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'base');
  return dir;
}

afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

describe('listThreadRecordsWithObjectStatus', () => {
  it('derives a deterministic baseline-to-settle changed-file summary from real git trees', async () => {
    const repo = newRepo();
    const home = mkdtempSync(join(tmpdir(), 'station-cp-read-home-'));
    scratch.push(home);
    const indexStore = new CheckpointIndexStore(home);
    const refStore = new CheckpointRefStore();

    writeFileSync(join(repo, 'modified.txt'), 'before\n');
    writeFileSync(join(repo, 'deleted.txt'), 'delete me\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'fixtures');
    const baseline = await refStore.capture({
      repoDir: repo,
      threadId: 'thread-diff',
      checkpointId: 'baseline',
      kind: 'baseline',
      turnId: 'turn-diff',
    });
    expect(baseline.status).toBe('captured');

    writeFileSync(join(repo, 'added.txt'), 'added\n');
    writeFileSync(join(repo, 'modified.txt'), 'after\n');
    rmSync(join(repo, 'deleted.txt'));
    git(repo, 'mv', 'committed.txt', 'renamed.txt');
    const settle = await refStore.capture({
      repoDir: repo,
      threadId: 'thread-diff',
      checkpointId: 'settle',
      kind: 'settle',
      turnId: 'turn-diff',
    });
    expect(settle.status).toBe('captured');
    if (baseline.status !== 'captured' || settle.status !== 'captured') return;

    indexStore.recordTurnPhase('thread-diff', 'turn-diff', () => ({
      baseline: { status: 'captured', ...baseline.checkpoint },
      settle: { status: 'captured', ...settle.checkpoint },
    }));
    const [record] = await listThreadRecordsWithObjectStatus(
      indexStore,
      refStore,
      'thread-diff',
    );
    expect(record?.changedFiles).toEqual({
      status: 'available',
      files: [
        { path: 'added.txt', status: 'added' },
        { path: 'deleted.txt', status: 'deleted' },
        { path: 'modified.txt', status: 'modified' },
        {
          path: 'renamed.txt',
          previousPath: 'committed.txt',
          status: 'renamed',
        },
      ],
    });
  });

  it('annotates captured phases with live object existence', async () => {
    const repo = newRepo();
    const home = mkdtempSync(join(tmpdir(), 'station-cp-read-home-'));
    scratch.push(home);
    const indexStore = new CheckpointIndexStore(home);
    const refStore = new CheckpointRefStore();

    writeFileSync(join(repo, 'change.txt'), 'change\n');
    const captured = await refStore.capture({
      repoDir: repo,
      threadId: 'thread-1',
      checkpointId: 'cp-1',
      kind: 'baseline',
      turnId: 'turn-1',
    });
    expect(captured.status).toBe('captured');
    indexStore.recordTurnPhase('thread-1', 'turn-1', () => ({
      baseline: {
        status: 'captured',
        checkpointId: 'cp-1',
        commitSha:
          captured.status === 'captured' ? captured.checkpoint.commitSha : '',
        treeSha:
          captured.status === 'captured' ? captured.checkpoint.treeSha : '',
        repoRoot:
          captured.status === 'captured' ? captured.checkpoint.repoRoot : repo,
        capturedAt: '2026-08-15T00:00:00.000Z',
      },
      settle: {
        status: 'not_applicable',
        reason: 'no_project_working_directory',
        recordedAt: '2026-08-15T00:00:01.000Z',
      },
    }));

    const served = await listThreadRecordsWithObjectStatus(
      indexStore,
      refStore,
      'thread-1',
    );
    expect(served).toHaveLength(1);
    // Intact checkpoint → ok; non-captured phases carry no claim about git
    // state and are served verbatim.
    expect(served[0]?.baseline).toMatchObject({
      status: 'captured',
      objectStatus: 'ok',
    });
    expect(served[0]?.settle).toMatchObject({
      status: 'not_applicable',
    });
    expect(served[0]?.settle).not.toHaveProperty('objectStatus');
    expect(served[0]?.changedFiles).toEqual({
      status: 'unavailable',
      reason: 'checkpoint_missing',
    });

    // Produce the REAL post-retention state rather than fabricating one.
    // Rewriting the ref file to a zero sha does not reproduce it: the served
    // status is derived from whether the INDEX's recorded commitSha still
    // resolves, and that object would still be present — so the fabricated
    // state yields `ok`, correctly, and proves nothing. Expiring the reflog
    // (the only thing pinning a checkpoint outside refs/) and pruning is
    // what actually removes the object while leaving the ref file behind,
    // which is precisely the state this annotation exists to detect.
    const refPath = join(
      repo,
      '.git',
      'STATION_CHECKPOINTS',
      'thread-1',
      'cp-1',
    );
    git(repo, 'config', 'gc.reflogExpire', 'now');
    git(repo, 'config', 'gc.reflogExpireUnreachable', 'now');
    git(repo, 'reflog', 'expire', '--expire=now', '--all');
    git(repo, 'gc', '--prune=now', '--quiet');
    const pruned = await listThreadRecordsWithObjectStatus(
      indexStore,
      refStore,
      'thread-1',
    );
    expect(pruned[0]?.baseline).toMatchObject({
      status: 'captured',
      objectStatus: 'object_pruned',
    });

    // Ref deleted entirely (prune) → missing, still not presented as intact.
    rmSync(refPath, { force: true });
    const missing = await listThreadRecordsWithObjectStatus(
      indexStore,
      refStore,
      'thread-1',
    );
    expect(missing[0]?.baseline).toMatchObject({
      status: 'captured',
      objectStatus: 'missing',
    });
  });

  it('bounds record fanout, concurrent diffs, and per-turn changed-file output', async () => {
    const records = Array.from({ length: 12 }, (_, index) => ({
      threadId: 'thread-bounded',
      turnId: `turn-${index}`,
      updatedAt: `2026-08-15T00:00:${String(index).padStart(2, '0')}.000Z`,
      baseline: {
        status: 'captured' as const,
        checkpointId: `base-${index}`,
        commitSha: 'a'.repeat(40),
        treeSha: 'b'.repeat(40),
        repoRoot: '/bounded/repo',
        capturedAt: '2026-08-15T00:00:00.000Z',
      },
      settle: {
        status: 'captured' as const,
        checkpointId: `settle-${index}`,
        commitSha: 'c'.repeat(40),
        treeSha: 'd'.repeat(40),
        repoRoot: '/bounded/repo',
        capturedAt: '2026-08-15T00:00:01.000Z',
      },
    }));
    let active = 0;
    let peak = 0;
    const runGit = vi.fn(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return {
        stdout: 'R100\0old-one\0new-one\0R100\0old-two\0new-two\0',
        stderr: '',
      };
    });
    const served = await listThreadRecordsWithObjectStatus(
      { listThread: () => records },
      {
        verifyThreadCheckpoints: async ({
          checkpoints,
        }: {
          checkpoints: Array<{ checkpointId: string }>;
        }) =>
          new Map(checkpoints.map(({ checkpointId }) => [checkpointId, 'ok'])),
      } as never,
      'thread-bounded',
      { maxRecords: 8, diffConcurrency: 2, maxChangedFiles: 1, runGit },
    );

    expect(served).toHaveLength(8);
    expect(runGit).toHaveBeenCalledTimes(8);
    expect(peak).toBeLessThanOrEqual(2);
    expect(
      served.every(
        (record) =>
          record.changedFiles.status === 'unavailable' &&
          record.changedFiles.reason === 'diff_output_limit_exceeded',
      ),
    ).toBe(true);
  });
});

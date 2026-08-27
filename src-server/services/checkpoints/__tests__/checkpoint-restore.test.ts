import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireFileMutationLockAsync } from '@kontourai/station-shared/lifecycle-events';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { execGit } from '../../../utils/git-exec.js';
import { CheckpointIndexStore } from '../checkpoint-index-store.js';
import { CheckpointRefStore } from '../checkpoint-ref-store.js';
import {
  CheckpointRestoreService,
  RESTORE_LOCK_TIMEOUT_MS,
} from '../checkpoint-restore.js';

const dirs: string[] = [];
async function temp(name: string) {
  const dir = await mkdtemp(join(tmpdir(), name));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function fixture() {
  const repo = await temp('station-restore-repo-');
  const home = await temp('station-restore-home-');
  await execGit(['init', '-b', 'main'], { cwd: repo });
  await writeFile(join(repo, 'tracked.txt'), Buffer.from([0, 1, 2, 255]));
  await writeFile(join(repo, '.gitignore'), 'ignored.txt\n');
  await execGit(['add', '.'], { cwd: repo });
  await execGit(
    [
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.com',
      'commit',
      '-m',
      'initial',
    ],
    { cwd: repo },
  );
  await writeFile(join(repo, 'tracked.txt'), 'checkpoint bytes');
  await writeFile(join(repo, 'captured-untracked.txt'), 'captured untracked');
  const refs = new CheckpointRefStore();
  const captured = await refs.capture({
    repoDir: repo,
    threadId: 'thread-1',
    checkpointId: 'cp-1',
    turnId: 'turn-1',
    kind: 'settle',
  });
  if (captured.status !== 'captured') throw new Error('capture failed');
  const index = new CheckpointIndexStore(home);
  index.recordTurnPhase('thread-1', 'turn-1', () => ({
    settle: { status: 'captured', ...captured.checkpoint },
  }));
  return { repo, home, refs, index, checkpoint: captured.checkpoint };
}

describe('CheckpointRestoreService', () => {
  test('restores captured bytes without moving HEAD or changing the user index, audits once, and repeats as a no-op', async () => {
    const { repo, home, refs, index, checkpoint } = await fixture();
    const head = (
      await execGit(['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf-8' })
    ).stdout.trim();
    await execGit(['add', 'tracked.txt'], { cwd: repo });
    const staged = (
      await execGit(['write-tree'], { cwd: repo, encoding: 'utf-8' })
    ).stdout.trim();
    await writeFile(join(repo, 'tracked.txt'), 'later bytes');
    await writeFile(join(repo, 'later-untracked.txt'), 'remove me');
    await writeFile(join(repo, 'ignored.txt'), 'preserve me');
    const service = new CheckpointRestoreService(index, refs, home);
    const secondInstance = new CheckpointRestoreService(index, refs, home);
    const request = {
      threadId: 'thread-1',
      turnId: 'turn-1',
      phase: 'settle',
      confirmed: true,
    } as const;
    const [first, concurrent] = await Promise.all([
      service.restore(request),
      secondInstance.restore(request),
    ]);
    expect(first.restored).toBe(true);
    expect(concurrent).toMatchObject({ id: first.id, restored: false });
    expect(await readFile(join(repo, 'tracked.txt'), 'utf-8')).toBe(
      'checkpoint bytes',
    );
    expect(await readFile(join(repo, 'captured-untracked.txt'), 'utf-8')).toBe(
      'captured untracked',
    );
    await expect(readFile(join(repo, 'later-untracked.txt'))).rejects.toThrow();
    expect(await readFile(join(repo, 'ignored.txt'), 'utf-8')).toBe(
      'preserve me',
    );
    expect(
      (
        await execGit(['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf-8' })
      ).stdout.trim(),
    ).toBe(head);
    expect(
      (
        await execGit(['write-tree'], { cwd: repo, encoding: 'utf-8' })
      ).stdout.trim(),
    ).toBe(staged);
    const second = await service.restore({
      threadId: 'thread-1',
      turnId: 'turn-1',
      phase: 'settle',
      confirmed: true,
    });
    expect(second).toMatchObject({
      id: first.id,
      restored: false,
      treeSha: checkpoint.treeSha,
    });
    const audit = JSON.parse(
      await readFile(join(home, 'checkpoint-restores.json'), 'utf-8'),
    );
    expect(audit.events).toHaveLength(1);
    expect(secondInstance.listEvents('thread-1')).toEqual(audit.events);
    expect(secondInstance.listEvents('other-thread')).toEqual([]);
  });

  test('fails closed for missing, failed, pruned, and mismatched checkpoint identity', async () => {
    const { home, refs, index } = await fixture();
    const service = new CheckpointRestoreService(index, refs, home);
    await expect(
      service.restore({
        threadId: 'other-thread',
        turnId: 'turn-1',
        phase: 'settle',
        confirmed: true,
      }),
    ).rejects.toMatchObject({ reason: 'checkpoint_missing' });
    index.recordTurnPhase('thread-failed', 'turn-failed', () => ({
      settle: {
        status: 'failed',
        error: 'boom',
        recordedAt: new Date().toISOString(),
      },
    }));
    await expect(
      service.restore({
        threadId: 'thread-failed',
        turnId: 'turn-failed',
        phase: 'settle',
        confirmed: true,
      }),
    ).rejects.toMatchObject({ reason: 'checkpoint_failed' });
    const pruned = new CheckpointRestoreService(
      index,
      { readCheckpoint: async () => ({ status: 'object_pruned' as const }) },
      home,
    );
    await expect(
      pruned.restore({
        threadId: 'thread-1',
        turnId: 'turn-1',
        phase: 'settle',
        confirmed: true,
      }),
    ).rejects.toMatchObject({ reason: 'checkpoint_pruned' });
    const mismatch = new CheckpointRestoreService(
      index,
      {
        readCheckpoint: async () => ({
          status: 'ok' as const,
          checkpoint: {
            checkpointId: 'cp-1',
            commitSha: 'f'.repeat(40),
            treeSha: 'e'.repeat(40),
            repoRoot: '/tmp',
            capturedAt: '',
          },
        }),
      },
      home,
    );
    await expect(
      mismatch.restore({
        threadId: 'thread-1',
        turnId: 'turn-1',
        phase: 'settle',
        confirmed: true,
      }),
    ).rejects.toMatchObject({ reason: 'checkpoint_identity_mismatch' });
  });

  test('uses a restore-sized lock deadline beyond the generic ten-second default', async () => {
    const { home, refs, index } = await fixture();
    const acquire = vi.fn(acquireFileMutationLockAsync);
    const service = new CheckpointRestoreService(index, refs, home, {
      acquireLock: acquire,
    });
    await service.restore({
      threadId: 'thread-1',
      turnId: 'turn-1',
      phase: 'settle',
      confirmed: true,
    });
    expect(RESTORE_LOCK_TIMEOUT_MS).toBeGreaterThan(10_000);
    expect(acquire).toHaveBeenCalledWith(expect.any(String), {
      timeoutMs: RESTORE_LOCK_TIMEOUT_MS,
    });
  });
});

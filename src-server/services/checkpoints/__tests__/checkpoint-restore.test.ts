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

async function restore(
  service: CheckpointRestoreService,
  input: { threadId: string; turnId: string; phase: 'baseline' | 'settle' },
) {
  const preview = await service.preview({ ...input, ownerKey: 'owner-1' });
  return service.restore({
    threadId: input.threadId,
    turnId: input.turnId,
    previewId: preview.previewId,
    expectedCurrentTreeSha: preview.currentTreeSha,
    ownerKey: 'owner-1',
    confirmed: true,
  });
}
afterEach(async () => {
  vi.restoreAllMocks();
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
    const request = {
      threadId: 'thread-1',
      turnId: 'turn-1',
      phase: 'settle',
    } as const;
    const first = await restore(service, request);
    expect(first.restored).toBe(true);
    await expect(
      execGit(['cat-file', '-e', `${first.recoveryRef}^{tree}`], { cwd: repo }),
    ).resolves.toBeDefined();
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
    const second = await restore(service, {
      threadId: 'thread-1',
      turnId: 'turn-1',
      phase: 'settle',
    });
    expect(second).toMatchObject({
      restored: false,
      treeSha: checkpoint.treeSha,
    });
    const audit = JSON.parse(
      await readFile(join(home, 'checkpoint-restores.json'), 'utf-8'),
    );
    expect(audit.events).toHaveLength(2);
    expect(service.listEvents('thread-1')).toEqual(audit.events);
    expect(service.listEvents('other-thread')).toEqual([]);
  });

  test('fails closed for missing, failed, pruned, and mismatched checkpoint identity', async () => {
    const { home, refs, index } = await fixture();
    const service = new CheckpointRestoreService(index, refs, home);
    await expect(
      service.preview({
        threadId: 'other-thread',
        turnId: 'turn-1',
        phase: 'settle',
        ownerKey: 'owner-1',
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
      service.preview({
        threadId: 'thread-failed',
        turnId: 'turn-failed',
        phase: 'settle',
        ownerKey: 'owner-1',
      }),
    ).rejects.toMatchObject({ reason: 'checkpoint_failed' });
    const pruned = new CheckpointRestoreService(
      index,
      { readCheckpoint: async () => ({ status: 'object_pruned' as const }) },
      home,
    );
    await expect(
      pruned.preview({
        threadId: 'thread-1',
        turnId: 'turn-1',
        phase: 'settle',
        ownerKey: 'owner-1',
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
      mismatch.preview({
        threadId: 'thread-1',
        turnId: 'turn-1',
        phase: 'settle',
        ownerKey: 'owner-1',
      }),
    ).rejects.toMatchObject({ reason: 'checkpoint_identity_mismatch' });
  });

  test('uses a restore-sized lock deadline beyond the generic ten-second default', async () => {
    const { home, refs, index } = await fixture();
    const acquire = vi.fn(acquireFileMutationLockAsync);
    const service = new CheckpointRestoreService(index, refs, home, {
      acquireLock: acquire,
    });
    await restore(service, {
      threadId: 'thread-1',
      turnId: 'turn-1',
      phase: 'settle',
    });
    expect(RESTORE_LOCK_TIMEOUT_MS).toBeGreaterThan(10_000);
    expect(acquire).toHaveBeenCalledWith(expect.any(String), {
      timeoutMs: RESTORE_LOCK_TIMEOUT_MS,
    });
  });

  test('binds one-use preview to owner and exact current tree', async () => {
    const { repo, home, refs, index } = await fixture();
    const service = new CheckpointRestoreService(index, refs, home);
    const preview = await service.preview({
      threadId: 'thread-1',
      turnId: 'turn-1',
      phase: 'settle',
      ownerKey: 'owner-1',
    });
    await writeFile(join(repo, 'tracked.txt'), 'intervening edit');
    await expect(
      service.restore({
        threadId: 'thread-1',
        turnId: 'turn-1',
        previewId: preview.previewId,
        expectedCurrentTreeSha: preview.currentTreeSha,
        ownerKey: 'owner-1',
        confirmed: true,
      }),
    ).rejects.toMatchObject({ reason: 'workspace_changed' });
    await expect(
      service.restore({
        threadId: 'thread-1',
        turnId: 'turn-1',
        previewId: preview.previewId,
        expectedCurrentTreeSha: preview.currentTreeSha,
        ownerKey: 'owner-1',
        confirmed: true,
      }),
    ).rejects.toMatchObject({ reason: 'preview_invalid' });
  });

  test('refuses a preview presented by a different owner', async () => {
    const { home, refs, index } = await fixture();
    const service = new CheckpointRestoreService(index, refs, home);
    const preview = await service.preview({
      threadId: 'thread-1',
      turnId: 'turn-1',
      phase: 'settle',
      ownerKey: 'owner-1',
    });

    await expect(
      service.restore({
        threadId: 'thread-1',
        turnId: 'turn-1',
        previewId: preview.previewId,
        expectedCurrentTreeSha: preview.currentTreeSha,
        ownerKey: 'owner-2',
        confirmed: true,
      }),
    ).rejects.toMatchObject({ reason: 'preview_invalid' });
  });

  test('refuses a preview after its advertised expiry', async () => {
    const { home, refs, index } = await fixture();
    const service = new CheckpointRestoreService(index, refs, home);
    const preview = await service.preview({
      threadId: 'thread-1',
      turnId: 'turn-1',
      phase: 'settle',
      ownerKey: 'owner-1',
    });
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse(preview.expiresAt));

    await expect(
      service.restore({
        threadId: 'thread-1',
        turnId: 'turn-1',
        previewId: preview.previewId,
        expectedCurrentTreeSha: preview.currentTreeSha,
        ownerKey: 'owner-1',
        confirmed: true,
      }),
    ).rejects.toMatchObject({ reason: 'preview_invalid' });
  });

  /**
   * #2410: preview snapshots the tree with `add -A` (a clean filter runs) and
   * restore materializes it with `read-tree -u` (a smudge filter runs). A
   * repository whose own config defines a filter is refused before either.
   */
  async function plantFilter(repo: string) {
    const marker = `${repo}.filter-ran`;
    dirs.push(marker);
    await execGit(
      ['config', 'filter.marker.clean', `sh -c 'touch "${marker}"; cat'`],
      { cwd: repo },
    );
    await execGit(
      ['config', 'filter.marker.smudge', `sh -c 'touch "${marker}"; cat'`],
      { cwd: repo },
    );
    await writeFile(join(repo, '.gitattributes'), '*.txt filter=marker\n');
    return marker;
  }

  test('refuses a restore preview in a repository whose own config defines a filter, running nothing', async () => {
    const { repo, home, refs, index } = await fixture();
    const marker = await plantFilter(repo);
    const service = new CheckpointRestoreService(index, refs, home);

    await expect(
      service.preview({
        threadId: 'thread-1',
        turnId: 'turn-1',
        phase: 'settle',
        ownerKey: 'owner-1',
      }),
    ).rejects.toMatchObject({ reason: 'repository_config_refused' });
    await expect(readFile(marker)).rejects.toThrow();
  });

  test('refuses the restore itself when a filter was planted after the preview', async () => {
    const { repo, home, refs, index } = await fixture();
    await writeFile(join(repo, 'tracked.txt'), 'later bytes');
    const service = new CheckpointRestoreService(index, refs, home);
    const preview = await service.preview({
      threadId: 'thread-1',
      turnId: 'turn-1',
      phase: 'settle',
      ownerKey: 'owner-1',
    });
    const marker = await plantFilter(repo);

    await expect(
      service.restore({
        threadId: 'thread-1',
        turnId: 'turn-1',
        previewId: preview.previewId,
        expectedCurrentTreeSha: preview.currentTreeSha,
        ownerKey: 'owner-1',
        confirmed: true,
      }),
    ).rejects.toMatchObject({ reason: 'repository_config_refused' });
    await expect(readFile(marker)).rejects.toThrow();
    expect(await readFile(join(repo, 'tracked.txt'), 'utf-8')).toBe(
      'later bytes',
    );
  });
});

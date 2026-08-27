import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CheckpointIndexStore,
  type TurnCheckpointRecord,
} from '../checkpoint-index-store.js';
import {
  type CapturedCheckpoint,
  CheckpointRefStore,
} from '../checkpoint-ref-store.js';
import { CheckpointRetentionService } from '../checkpoint-retention.js';

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function home(): string {
  const dir = mkdtempSync(join(tmpdir(), 'station-retention-'));
  scratch.push(dir);
  return dir;
}

function checkpoint(
  id: string,
  capturedAt: string,
  repoRoot = '/repo',
): CapturedCheckpoint {
  return {
    checkpointId: id,
    commitSha: `commit-${id}`,
    treeSha: `tree-${id}`,
    repoRoot,
    capturedAt,
  };
}

function record(
  turnId: string,
  baseline: CapturedCheckpoint,
  settle: CapturedCheckpoint,
): TurnCheckpointRecord {
  return {
    threadId: 'thread-1',
    turnId,
    baseline: { status: 'captured', ...baseline },
    settle: { status: 'captured', ...settle },
    updatedAt: settle.capturedAt,
  };
}

describe('CheckpointRetentionService', () => {
  it('reclaims excess real Git refs and keeps the live baseline readable', async () => {
    const root = home();
    const repo = join(root, 'repo');
    const stationHome = join(root, 'home');
    mkdirSync(repo);
    execFileSync('git', ['init', '--quiet'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], {
      cwd: repo,
    });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo });
    writeFileSync(join(repo, 'tracked.txt'), 'base\n');
    execFileSync('git', ['add', '-A'], { cwd: repo });
    execFileSync('git', ['commit', '--quiet', '-m', 'base'], { cwd: repo });
    const refs = new CheckpointRefStore();
    const index = new CheckpointIndexStore(stationHome);
    const captured: CapturedCheckpoint[] = [];
    for (let i = 1; i <= 3; i += 1) {
      writeFileSync(join(repo, 'tracked.txt'), `change-${i}\n`);
      const result = await refs.capture({
        repoDir: repo,
        threadId: 'thread-1',
        checkpointId: `cp-${i}`,
        kind: i === 2 ? 'baseline' : 'settle',
        turnId: `turn-${i}`,
      });
      expect(result.status).toBe('captured');
      if (result.status !== 'captured') throw new Error('capture failed');
      captured.push(result.checkpoint);
      index.recordTurnPhase('thread-1', `turn-${i}`, () =>
        i === 2
          ? { baseline: { status: 'captured', ...result.checkpoint } }
          : { settle: { status: 'captured', ...result.checkpoint } },
      );
    }
    const service = new CheckpointRetentionService(index, refs, stationHome, {
      maxRefsPerThread: 2,
    });
    await expect(service.sweepThread('thread-1')).resolves.toMatchObject({
      status: 'reclaimed',
      removed: 1,
    });
    await expect(
      refs.readCheckpoint({
        repoDir: repo,
        threadId: 'thread-1',
        checkpointId: captured[1].checkpointId,
      }),
    ).resolves.toMatchObject({ status: 'ok' });
    await expect(
      refs.listCheckpointsForRetention({ repoDir: repo, threadId: 'thread-1' }),
    ).resolves.toHaveLength(2);
  });

  it('bounds refs while protecting the newest live baseline', async () => {
    const oldSettle = checkpoint('old-settle', '2026-01-01T00:00:00.000Z');
    const liveBaseline = checkpoint(
      'live-baseline',
      '2026-01-02T00:00:00.000Z',
    );
    const newSettle = checkpoint('new-settle', '2026-01-03T00:00:00.000Z');
    const refs = [oldSettle, liveBaseline, newSettle];
    const deleteCheckpointForRetention = vi.fn(async ({ checkpointId }) => {
      refs.splice(
        refs.findIndex((entry) => entry.checkpointId === checkpointId),
        1,
      );
      return 'deleted' as const;
    });
    const service = new CheckpointRetentionService(
      {
        listThreadDiscovery: () => ({
          status: 'ok',
          records: [
            record('turn-1', liveBaseline, oldSettle),
            record('turn-2', liveBaseline, newSettle),
          ],
        }),
      },
      {
        listCheckpointsForRetention: async () => [...refs],
        deleteCheckpointForRetention,
      },
      home(),
      { maxRefsPerThread: 2 },
    );

    await expect(service.sweepThread('thread-1')).resolves.toMatchObject({
      status: 'reclaimed',
      removed: 1,
    });
    expect(deleteCheckpointForRetention).toHaveBeenCalledWith(
      expect.objectContaining({ checkpointId: 'old-settle' }),
    );
    expect(refs.map((entry) => entry.checkpointId)).toContain('live-baseline');
    await expect(service.sweepThread('thread-1')).resolves.toMatchObject({
      status: 'no_op',
      removed: 0,
    });
  });

  it('defers without deleting when discovery or a repository is incomplete', async () => {
    const deleteCheckpointForRetention = vi.fn();
    const service = new CheckpointRetentionService(
      {
        listThreadDiscovery: () => ({
          status: 'failed',
          reason: 'corrupt_discovery',
        }),
      },
      {
        listCheckpointsForRetention: async () => {
          throw new Error('repository unreachable');
        },
        deleteCheckpointForRetention,
      },
      home(),
      { maxRefsPerThread: 1 },
    );
    await expect(service.sweepThread('thread-1')).resolves.toMatchObject({
      status: 'deferred',
      removed: 0,
    });
    expect(deleteCheckpointForRetention).not.toHaveBeenCalled();
  });

  it('records partial multi-repo failure and safely completes on retry', async () => {
    const repoA = [
      checkpoint('a-old', '2026-01-01T00:00:00.000Z', '/repo/a'),
      checkpoint('a-live', '2026-01-04T00:00:00.000Z', '/repo/a'),
    ];
    const repoB = [
      checkpoint('b-old', '2026-01-02T00:00:00.000Z', '/repo/b'),
      checkpoint('b-new', '2026-01-03T00:00:00.000Z', '/repo/b'),
    ];
    let failOnce = true;
    const remove = vi.fn(async ({ repoDir, checkpointId }) => {
      if (checkpointId === 'b-old' && failOnce) {
        failOnce = false;
        throw new Error('injected delete failure');
      }
      const refs = repoDir === '/repo/a' ? repoA : repoB;
      const index = refs.findIndex(
        (entry) => entry.checkpointId === checkpointId,
      );
      if (index < 0) return 'missing' as const;
      refs.splice(index, 1);
      return 'deleted' as const;
    });
    const records = [
      record('turn-a', repoA[1], repoA[0]),
      record('turn-b', repoA[1], repoB[0]),
      record('turn-c', repoA[1], repoB[1]),
    ];
    const service = new CheckpointRetentionService(
      { listThreadDiscovery: () => ({ status: 'ok', records }) },
      {
        listCheckpointsForRetention: async ({ repoDir }) =>
          repoDir === '/repo/a' ? [...repoA] : [...repoB],
        deleteCheckpointForRetention: remove,
      },
      home(),
      { maxRefsPerThread: 2 },
    );
    await expect(service.sweepThread('thread-1')).resolves.toMatchObject({
      status: 'failed',
      removed: 1,
    });
    await expect(service.sweepThread('thread-1')).resolves.toMatchObject({
      status: 'reclaimed',
      removed: 1,
    });
    expect([...repoA, ...repoB].map((entry) => entry.checkpointId)).toEqual([
      'a-live',
      'b-new',
    ]);
  });

  it('writes mutation intent before unlink and preserves it when completion audit fails', async () => {
    const old = checkpoint('old', '2026-01-01T00:00:00.000Z');
    const live = checkpoint('live', '2026-01-02T00:00:00.000Z');
    const refs = [old, live];
    let document: {
      version: 1;
      events: Array<{
        id: string;
        threadId: string;
        status: 'no_op' | 'reclaimed' | 'deferred' | 'failed';
        removed: number;
        recordedAt: string;
        detail?: string;
      }>;
    } = { version: 1, events: [] };
    let writes = 0;
    const auditStore = {
      read: () => structuredClone(document),
      write: (next: typeof document) => {
        writes += 1;
        if (writes === 2) throw new Error('injected audit completion failure');
        document = structuredClone(next);
      },
    };
    const service = new CheckpointRetentionService(
      {
        listThreadDiscovery: () => ({
          status: 'ok',
          records: [record('turn-1', live, old)],
        }),
      },
      {
        listCheckpointsForRetention: async () => [...refs],
        deleteCheckpointForRetention: async ({ checkpointId }) => {
          refs.splice(
            refs.findIndex((entry) => entry.checkpointId === checkpointId),
            1,
          );
          return 'deleted';
        },
      },
      home(),
      { maxRefsPerThread: 1, auditStore },
    );
    await expect(service.sweepThread('thread-1')).rejects.toThrow(
      /audit completion failure/,
    );
    expect(document.events).toHaveLength(1);
    expect(document.events[0]).toMatchObject({
      status: 'failed',
      detail: 'retention_in_progress',
    });
    await expect(service.sweepThread('thread-1')).resolves.toMatchObject({
      status: 'no_op',
    });
    expect(document.events.map((event) => event.status)).toEqual([
      'failed',
      'no_op',
    ]);
  });
});

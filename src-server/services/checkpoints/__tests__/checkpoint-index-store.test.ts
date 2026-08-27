/**
 * station#2802 slice 1 + fix round — checkpoint index store coverage.
 *
 * Exercises the real JsonFileStore-backed persistence over temp
 * directories: the recordTurnPhase read-decide-write surface (including its
 * defensive-copy contract), the read/list copies handed to callers, and
 * the documented trim bounds. The fix round (H2) made the store ONE FILE
 * PER THREAD — these tests pin that layout: a write touches only its own
 * thread's file, and a corrupt file resets only its own thread.
 */

import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CheckpointIndexStore } from '../checkpoint-index-store.js';

function newStore(
  options?: ConstructorParameters<typeof CheckpointIndexStore>[1],
): { store: CheckpointIndexStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'station-cp-index-'));
  return { store: new CheckpointIndexStore(dir, options), dir };
}

describe('CheckpointIndexStore', () => {
  it('records phases through the updater and reads them back', () => {
    const { store } = newStore();
    store.recordTurnPhase('t-1', 'turn-1', () => ({
      baseline: {
        status: 'captured',
        checkpointId: 'cp-1',
        commitSha: 'sha-1',
        treeSha: 'tree-1',
        repoRoot: '/repo',
        capturedAt: '2026-08-15T00:00:00.000Z',
      },
    }));
    store.recordTurnPhase('t-1', 'turn-1', (current) => ({
      ...current,
      settle: {
        status: 'captured',
        checkpointId: 'cp-2',
        commitSha: 'sha-2',
        treeSha: 'tree-2',
        repoRoot: '/repo',
        capturedAt: '2026-08-15T00:01:00.000Z',
      },
    }));

    const record = store.readTurn('t-1', 'turn-1');
    expect(record?.threadId).toBe('t-1');
    expect(record?.turnId).toBe('turn-1');
    expect(record?.baseline?.status).toBe('captured');
    expect(record?.settle?.status).toBe('captured');
    // The updater's baseline survived the second write (no clobbering).
    if (record?.baseline?.status === 'captured') {
      expect(record.baseline.commitSha).toBe('sha-1');
    }
  });

  it('hands the updater a defensive copy and returns copies to readers', () => {
    const { store } = newStore();
    store.recordTurnPhase('t-1', 'turn-1', () => ({
      baseline: {
        status: 'skipped',
        reason: 'unborn_head',
        recordedAt: '2026-08-15T00:00:00.000Z',
      },
    }));

    let seen: ReturnType<CheckpointIndexStore['readTurn']>;
    store.recordTurnPhase('t-1', 'turn-1', (current) => {
      // Mutating the handed record while returning an INDEPENDENT write:
      // the mutation must not leak into the store, because the store is the
      // only writer and the handed object is a private defensive copy.
      if (current?.baseline && current.baseline.status === 'skipped') {
        (current.baseline as { reason: string }).reason = 'MUTATED';
      }
      seen = current;
      return {
        settle: {
          status: 'failed',
          error: 'later failure',
          recordedAt: '2026-08-15T00:01:00.000Z',
        },
      };
    });
    expect(seen?.baseline?.status).toBe('skipped');

    // The settle write landed and the baseline the updater mutated but did
    // not return stayed pristine.
    const readBack = store.readTurn('t-1', 'turn-1');
    expect(readBack?.settle?.status).toBe('failed');
    if (readBack?.baseline?.status === 'skipped') {
      expect(readBack.baseline.reason).toBe('unborn_head');
    }
    // A reader mutating its copy cannot corrupt the store.
    if (readBack?.baseline) {
      (readBack.baseline as { reason: string }).reason = 'READER MUTATION';
    }
    const again = store.readTurn('t-1', 'turn-1');
    if (again?.baseline?.status === 'skipped') {
      expect(again.baseline.reason).toBe('unborn_head');
    }
  });

  it('lists a thread\u2019s turns in write order and persists across store instances', () => {
    const { store, dir } = newStore();
    for (const turn of ['turn-a', 'turn-b']) {
      store.recordTurnPhase('t-1', turn, () => ({
        baseline: {
          status: 'not_applicable',
          reason: 'no_project_working_directory',
          recordedAt: `2026-08-15T00:00:${turn === 'turn-a' ? '00' : '01'}.000Z`,
        },
      }));
    }
    expect(store.listThread('t-1').map((record) => record.turnId)).toEqual([
      'turn-a',
      'turn-b',
    ]);
    expect(store.listThread('t-other')).toEqual([]);

    // A fresh instance over the same directory sees the same records.
    const reopened = new CheckpointIndexStore(dir);
    expect(reopened.listThread('t-1')).toHaveLength(2);
    // H2: the index is per-thread files under turn-checkpoints/, not one
    // whole-home document.
    expect(existsSync(join(dir, 'turn-checkpoints', 't-1.json'))).toBe(true);
    expect(existsSync(join(dir, 'turn-checkpoints.json'))).toBe(false);
  });

  it('writes one thread without rewriting another thread\u2019s file (fix round H2)', () => {
    const { store, dir } = newStore();
    store.recordTurnPhase('t-1', 'turn-1', () => ({
      baseline: {
        status: 'not_applicable',
        reason: 'no_project_working_directory',
        recordedAt: '2026-08-15T00:00:00.000Z',
      },
    }));
    const fileA = join(dir, 'turn-checkpoints', 't-1.json');
    const bytesA = readFileSync(fileA, 'utf-8');

    store.recordTurnPhase('t-2', 'turn-1', () => ({
      baseline: {
        status: 'not_applicable',
        reason: 'no_project_working_directory',
        recordedAt: '2026-08-15T00:00:01.000Z',
      },
    }));

    // The whole-home layout rewrote EVERY thread's records on every write —
    // the O(global population) cost the fix exists to remove. t-1's file is
    // byte-identical after t-2's write.
    expect(readFileSync(fileA, 'utf-8')).toBe(bytesA);
    expect(store.listThread('t-1')).toHaveLength(1);
    expect(store.listThread('t-2')).toHaveLength(1);
  });

  it('a torn single-thread file resets only that thread, not the home (fix round H2/M6)', () => {
    const { store, dir } = newStore();
    for (const thread of ['t-1', 't-2']) {
      store.recordTurnPhase(thread, 'turn-1', () => ({
        baseline: {
          status: 'failed',
          error: 'x',
          recordedAt: '2026-08-15T00:00:00.000Z',
        },
      }));
    }
    // Torn write on t-1's file only.
    writeFileSync(
      join(dir, 'turn-checkpoints', 't-1.json'),
      '{"version":1,"turns":{"turn-1":{"bas',
    );

    expect(store.listThread('t-1')).toEqual([]);
    // t-2's records survive the sibling's corruption; the store keeps
    // writing t-1 as a fresh namespace.
    expect(store.listThread('t-2')).toHaveLength(1);
    store.recordTurnPhase('t-1', 'turn-2', () => ({
      baseline: {
        status: 'failed',
        error: 'x',
        recordedAt: '2026-08-15T00:00:02.000Z',
      },
    }));
    expect(store.listThread('t-1')).toHaveLength(1);
  });

  it('refuses thread ids that cannot be file names (route-supplied ids)', () => {
    const { store, dir } = newStore();
    store.recordTurnPhase('../escape', 'turn-1', () => ({
      baseline: {
        status: 'failed',
        error: 'x',
        recordedAt: '2026-08-15T00:00:00.000Z',
      },
    }));
    expect(store.listThread('../escape')).toEqual([]);
    expect(store.readTurn('../escape', 'turn-1')).toBeUndefined();
    expect(existsSync(join(dir, 'turn-checkpoints', 'escape.json'))).toBe(
      false,
    );
  });

  it('trims to the documented per-thread and thread-count bounds', () => {
    const { store, dir } = newStore({ maxTurnsPerThread: 2, maxThreads: 2 });
    for (const turn of ['turn-1', 'turn-2', 'turn-3']) {
      store.recordTurnPhase('t-1', turn, () => ({
        baseline: {
          status: 'failed',
          error: 'x',
          recordedAt: '2026-08-15T00:00:00.000Z',
        },
      }));
    }
    // turn-1 (oldest) was dropped; newest two stand.
    expect(store.listThread('t-1').map((record) => record.turnId)).toEqual([
      'turn-2',
      'turn-3',
    ]);

    store.recordTurnPhase('t-2', 'turn-x', () => ({
      baseline: {
        status: 'failed',
        error: 'x',
        recordedAt: '2026-08-15T01:00:00.000Z',
      },
    }));
    store.recordTurnPhase('t-3', 'turn-y', () => ({
      baseline: {
        status: 'failed',
        error: 'x',
        recordedAt: '2026-08-15T02:00:00.000Z',
      },
    }));
    // t-1 (stalest) was dropped when t-3 arrived; t-2 and t-3 stand.
    expect(store.listThread('t-1')).toEqual([]);
    expect(store.listThread('t-2')).toHaveLength(1);
    expect(store.listThread('t-3')).toHaveLength(1);
    expect(
      readdirSync(join(dir, 'turn-checkpoints-evicted')).some((entry) =>
        entry.startsWith('t-1.'),
      ),
    ).toBe(true);
  });

  it('fails closed when eviction cannot archive the discovery record', () => {
    const { store, dir } = newStore({
      maxThreads: 1,
      archiveEvictedThread: () => {
        throw new Error('injected archive failure');
      },
    });
    for (const thread of ['t-1', 't-2']) {
      store.recordTurnPhase(thread, 'turn-1', () => ({
        settle: {
          status: 'captured',
          checkpointId: `cp-${thread}`,
          commitSha: 'sha',
          treeSha: 'tree',
          repoRoot: '/repo',
          capturedAt: '2026-08-15T00:00:00.000Z',
        },
      }));
    }
    // The soft bound loses to discoverability: both active files remain.
    expect(existsSync(join(dir, 'turn-checkpoints', 't-1.json'))).toBe(true);
    expect(existsSync(join(dir, 'turn-checkpoints', 't-2.json'))).toBe(true);
  });

  it('keeps every thread discoverable across interleaved store instances', () => {
    const { store: first, dir } = newStore({ maxThreads: 1 });
    const second = new CheckpointIndexStore(dir, { maxThreads: 1 });
    const write = (store: CheckpointIndexStore, threadId: string) =>
      store.recordTurnPhase(threadId, 'turn-1', () => ({
        settle: {
          status: 'captured',
          checkpointId: `cp-${threadId}`,
          commitSha: 'sha',
          treeSha: 'tree',
          repoRoot: `/repo/${threadId}`,
          capturedAt: '2026-08-15T00:00:00.000Z',
        },
      }));
    write(first, 't-1');
    write(second, 't-2');
    write(first, 't-3');
    const discoverable = [
      ...readdirSync(join(dir, 'turn-checkpoints')),
      ...readdirSync(join(dir, 'turn-checkpoints-evicted')),
    ];
    for (const threadId of ['t-1', 't-2', 't-3']) {
      expect(
        discoverable.some((entry) => entry.startsWith(`${threadId}.`)),
      ).toBe(true);
    }
  });

  it('keeps every archived generation when a thread is reactivated and evicted again', () => {
    const { store, dir } = newStore({ maxThreads: 1 });
    const write = (threadId: string, repoRoot: string) =>
      store.recordTurnPhase(threadId, `turn-${repoRoot.at(-1)}`, () => ({
        settle: {
          status: 'captured',
          checkpointId: `cp-${repoRoot.at(-1)}`,
          commitSha: 'sha',
          treeSha: 'tree',
          repoRoot,
          capturedAt: '2026-08-15T00:00:00.000Z',
        },
      }));
    write('t-1', '/repo/a');
    write('t-2', '/repo/x');
    write('t-1', '/repo/b');
    write('t-3', '/repo/y');

    const generations = readdirSync(
      join(dir, 'turn-checkpoints-evicted'),
    ).filter((entry) => entry.startsWith('t-1.'));
    expect(generations).toHaveLength(2);
    const archived = generations.map((entry) =>
      readFileSync(join(dir, 'turn-checkpoints-evicted', entry), 'utf-8'),
    );
    expect(archived.some((contents) => contents.includes('/repo/a'))).toBe(
      true,
    );
    expect(archived.some((contents) => contents.includes('/repo/b'))).toBe(
      true,
    );

    const discovery = store.listThreadDiscovery('t-1');
    expect(discovery.status).toBe('ok');
    if (discovery.status === 'ok') {
      expect(
        discovery.records
          .flatMap((record) => [record.baseline, record.settle])
          .filter((phase) => phase?.status === 'captured')
          .map((phase) => phase?.status === 'captured' && phase.repoRoot),
      ).toEqual(['/repo/a', '/repo/b']);
    }
  });

  it('fails retention discovery closed when any matching generation is corrupt', () => {
    const { store, dir } = newStore({ maxThreads: 1 });
    store.recordTurnPhase('t-1', 'turn-1', () => ({
      baseline: {
        status: 'captured',
        checkpointId: 'cp-1',
        commitSha: 'sha',
        treeSha: 'tree',
        repoRoot: '/repo',
        capturedAt: '2026-08-15T00:00:00.000Z',
      },
    }));
    store.recordTurnPhase('t-2', 'turn-1', () => ({
      baseline: {
        status: 'failed',
        error: 'x',
        recordedAt: '2026-08-15T00:00:01.000Z',
      },
    }));
    writeFileSync(
      join(dir, 'turn-checkpoints-evicted', 't-1.corrupt.json'),
      '{corrupt',
    );
    expect(store.listThreadDiscovery('t-1')).toEqual({
      status: 'failed',
      reason: 'corrupt_discovery',
    });
  });

  it('writes a versioned, parseable JSON document per thread', () => {
    const { store, dir } = newStore();
    store.recordTurnPhase('t-1', 'turn-1', () => ({
      baseline: {
        status: 'captured',
        checkpointId: 'cp-1',
        commitSha: 'sha',
        treeSha: 'tree',
        repoRoot: '/repo',
        capturedAt: '2026-08-15T00:00:00.000Z',
      },
    }));
    const raw = JSON.parse(
      readFileSync(join(dir, 'turn-checkpoints', 't-1.json'), 'utf-8'),
    );
    expect(raw.version).toBe(1);
    expect(raw.turns['turn-1'].baseline.status).toBe('captured');
  });
});

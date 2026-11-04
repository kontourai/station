import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { TASK_WRITE_BACK_LIMITS } from '@kontourai/station-contracts/task-write-back';
import { afterEach, describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { EventStore } from '../event-store.js';
import { performTaskWriteBack } from '../task-write-back-store.js';

const makeTempDir = trackTempDirs();
const closers: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
});
const scope = {
  projectId: 'project-a',
  taskId: 'task-a',
  taskCreatedAt: '2026-10-24T00:00:00.000Z',
};
const admission = {
  ...scope,
  initiatedBy: { kind: 'person', id: 'owner' } as const,
  beforeCommit: () => true,
};
const target = {
  kind: 'pull-request',
  system: 'github',
  destination: 'github.com/acme/repo/pull/7',
  action: 'comment',
} as const;
function setup() {
  const path = join(makeTempDir('station-write-back-'), 'orchestration.sqlite');
  const events = new EventStore(path);
  closers.push(async () => {
    await events.close();
  });
  return { path, events, store: events.taskWriteBackStore() };
}
function value<T>(
  result: { ok: true; value: T } | { ok: false; code: string },
): T {
  if (!result.ok) throw new Error(result.code);
  return result.value;
}

describe('Task write-back over real orchestration SQLite', () => {
  test('pending attempts settle, and a retry preserves the original failure history', async () => {
    const { store } = setup();
    const pending = value(store.start({ ...admission, target }));
    expect(store.list(scope)).toMatchObject([
      {
        id: pending.id,
        state: 'pending',
        failureReason: null,
        settledAt: null,
      },
    ]);
    const failed = value(
      store.settle(scope, pending.id, {
        state: 'failed',
        reason: 'Provider refused the comment.',
      }),
    );
    expect(failed).toMatchObject({
      id: pending.id,
      state: 'failed',
      failureReason: 'Provider refused the comment.',
    });
    const retry = value(
      store.retry({
        ...admission,
        initiatedBy: { kind: 'session', id: 'session-1' },
        originalId: pending.id,
      }),
    );
    expect(retry.id).not.toBe(pending.id);
    expect(retry).toMatchObject({
      retryOf: pending.id,
      state: 'pending',
      target,
      initiatedBy: { kind: 'session', id: 'session-1' },
    });
    expect(store.retry({ ...admission, originalId: pending.id })).toEqual({
      ok: false,
      code: 'retry-not-failed',
    });
    const retryFailed = value(
      store.settle(scope, retry.id, {
        state: 'failed',
        reason: 'Still unavailable.',
      }),
    );
    const secondRetry = value(
      store.retry({ ...admission, originalId: pending.id }),
    );
    value(store.settle(scope, secondRetry.id, { state: 'succeeded' }));
    expect(store.list(scope)).toEqual([
      failed,
      retryFailed,
      expect.objectContaining({
        id: secondRetry.id,
        retryOf: pending.id,
        state: 'succeeded',
        failureReason: null,
        settledAt: expect.any(String),
      }),
    ]);
    expect(store.retry({ ...admission, originalId: pending.id })).toEqual({
      ok: false,
      code: 'retry-not-failed',
    });
    expect(store.settle(scope, pending.id, { state: 'succeeded' })).toEqual({
      ok: false,
      code: 'not-pending',
    });
  });

  test('attempts and outcomes survive restart and both tables refuse updates and deletes', async () => {
    const { path, events, store } = setup();
    const pending = value(store.start({ ...admission, target }));
    value(store.settle(scope, pending.id, { state: 'succeeded' }));
    const before = store.list(scope);
    const db = new DatabaseSync(path);
    try {
      for (const table of [
        'task_write_back_attempts',
        'task_write_back_outcomes',
      ]) {
        expect(() => db.exec(`UPDATE ${table} SET rowid = rowid`)).toThrow(
          'append-only',
        );
        expect(() => db.exec(`DELETE FROM ${table}`)).toThrow('append-only');
      }
    } finally {
      db.close();
    }
    await events.close();
    closers.pop();
    const reopened = new EventStore(path);
    closers.push(async () => {
      await reopened.close();
    });
    expect(reopened.taskWriteBackStore().list(scope)).toEqual(before);
  });

  test('Task and incarnation boundaries prevent reads, settlement, and cross-Task retry', () => {
    const { store } = setup();
    const first = value(store.start({ ...admission, target }));
    value(
      store.settle(scope, first.id, {
        state: 'failed',
        reason: 'Permission denied.',
      }),
    );
    const other = { ...scope, taskId: 'task-b' };
    const replacement = { ...scope, taskCreatedAt: '2026-10-25T00:00:00.000Z' };
    const otherProject = { ...scope, projectId: 'project-b' };
    for (const boundary of [other, replacement, otherProject]) {
      expect(store.list(boundary)).toEqual([]);
      expect(store.settle(boundary, first.id, { state: 'succeeded' })).toEqual({
        ok: false,
        code: 'not-pending',
      });
      expect(
        store.retry({ ...admission, ...boundary, originalId: first.id }),
      ).toEqual({ ok: false, code: 'retry-not-failed' });
    }
    expect(store.list(scope)).toHaveLength(1);
  });

  test('the bound and revoked authority refuse before invoking an outbound write', async () => {
    const { store } = setup();
    for (let i = 0; i < TASK_WRITE_BACK_LIMITS.attemptsPerTask; i++)
      value(store.start({ ...admission, target }));
    let calls = 0;
    const write = async () => {
      calls++;
      return { ok: true as const, value: 'sent' };
    };
    expect(
      await performTaskWriteBack(store, { ...admission, target }, write),
    ).toEqual({ ok: false, code: 'limit' });
    const other = { ...admission, taskId: 'task-b', beforeCommit: () => false };
    expect(
      await performTaskWriteBack(store, { ...other, target }, write),
    ).toEqual({ ok: false, code: 'stale' });
    expect(calls).toBe(0);
    expect(store.list(scope)).toHaveLength(
      TASK_WRITE_BACK_LIMITS.attemptsPerTask,
    );
    expect(store.list(other)).toEqual([]);
  });

  test('the outbound seam records pending before the effect and records success, refusal and thrown uncertainty', async () => {
    const { store } = setup();
    const success = value(
      await performTaskWriteBack(store, { ...admission, target }, async () => {
        expect(store.list(scope).at(-1)?.state).toBe('pending');
        return { ok: true as const, value: 'remote-id' };
      }),
    );
    expect(success).toMatchObject({
      entry: { state: 'succeeded' },
      value: 'remote-id',
    });
    const failure = value(
      await performTaskWriteBack(store, { ...admission, target }, async () => ({
        ok: false as const,
        reason: 'Provider refused.',
      })),
    );
    expect(failure.entry).toMatchObject({
      state: 'failed',
      failureReason: 'Provider refused.',
    });
    const uncertain = value(
      await performTaskWriteBack(store, { ...admission, target }, async () => {
        throw new Error('private transport detail');
      }),
    );
    expect(uncertain.entry).toMatchObject({
      state: 'failed',
      failureReason: 'The write failed or could not be confirmed.',
    });
  });
});

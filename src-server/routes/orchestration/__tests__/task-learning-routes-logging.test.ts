/**
 * #4003 review round 6: a Learning request the person sees only as 503 is
 * logged with its error's name, code and message, never a record's text, so
 * a Task-memory table missing a column (an earlier build's migration 022)
 * is diagnosable.
 */
import type { KnowledgeStoreProvider } from '@kontourai/station-contracts/knowledge-store';
import type { TaskRecord } from '@kontourai/station-contracts/task-graph';
import { expect, test, vi } from 'vitest';
import type { TaskMemoryStore } from '../../../services/orchestration/task-memory-store.js';
import { createTaskLearningRoutes } from '../task-learning.js';

test('a failed read answers 503 and logs the underlying error, without record text', async () => {
  const broken = Object.assign(new Error('no such column: adapter_id'), {
    code: 'ERR_SQLITE_ERROR',
  });
  const memory = {
    listStandingRecords: () => ({
      decisions: [
        {
          taskId: 'task-1',
          kind: 'decision',
          key: 'secret-key',
          version: 1,
          action: 'set',
          state: 'active',
          importance: 'standing',
          text: 'Record text that must not be logged.',
          author: { kind: 'person', principalId: 'p' },
          createdAt: '2026-10-21T00:00:00.000Z',
        },
      ],
      deadEnds: [],
    }),
    listLearningDismissals: () => [],
    listLearningPromotions: () => {
      throw broken;
    },
  } as unknown as TaskMemoryStore;
  const warn = vi.fn();
  const app = createTaskLearningRoutes({
    store: { listRoots: async () => [] } as unknown as KnowledgeStoreProvider,
    logger: { warn },
    access: async () => ({
      kind: 'granted',
      memory,
      task: { id: 'task-1', status: 'done', createdAt: 'x' } as TaskRecord,
      projectId: 'project-1',
      projectSlug: 'project',
      principalId: 'p',
      isCurrent: () => true,
    }),
  });
  const response = await app.request('/task-1/room/memory/learning');
  expect(response.status).toBe(503);
  expect(warn).toHaveBeenCalledWith('task learning request failed', {
    operation: 'read',
    taskId: 'task-1',
    errorName: 'Error',
    code: 'ERR_SQLITE_ERROR',
    message: 'no such column: adapter_id',
  });
  expect(JSON.stringify(warn.mock.calls)).not.toContain('must not be logged');
});

test('a failed knowledge write answers 502 saying the record was not written and how to finish, and logs it (review round 6)', async () => {
  const records = new Map<string, unknown>();
  const root = {
    id: 'root:project-project',
    scope: { kind: 'project', projectSlug: 'project' },
    adapterId: 'kit-default-store',
    storeRoot: '/stores/project',
    displayName: 'Project store',
    createdAt: '2026-10-01T00:00:00.000Z',
  };
  const store = {
    listRoots: async () => [root],
    adapterFor: async () => ({
      get: async (id: string) => records.get(id) ?? null,
      create: async () => {
        throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
      },
    }),
  } as unknown as KnowledgeStoreProvider;
  const record = {
    taskId: 'task-1',
    kind: 'decision',
    key: 'storage',
    version: 1,
    action: 'set',
    state: 'active',
    importance: 'standing',
    text: 'Use SQLite.',
    author: { kind: 'person', principalId: 'p' },
    createdAt: '2026-10-21T00:00:00.000Z',
  };
  const memory = {
    listStandingRecords: () => ({ decisions: [record], deadEnds: [] }),
    listLearningDismissals: () => [],
    claimLearningPromotion: (input: Record<string, unknown>) => ({
      kind: 'claimed',
      promotion: { ...input, promotedAt: 'x' },
    }),
  } as unknown as TaskMemoryStore;
  const warn = vi.fn();
  const app = createTaskLearningRoutes({
    store,
    logger: { warn },
    access: async () => ({
      kind: 'granted',
      memory,
      task: { id: 'task-1', status: 'done', createdAt: 'x' } as TaskRecord,
      projectId: 'project-1',
      projectSlug: 'project',
      principalId: 'p',
      isCurrent: () => true,
    }),
  });
  const response = await app.request('/task-1/room/memory/learning/promote', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      kind: 'decision',
      key: 'storage',
      version: 1,
      rootId: root.id,
      title: 'Storage',
      text: 'Use SQLite.',
    }),
  });
  expect(response.status).toBe(502);
  expect(await response.json()).toMatchObject({
    code: 'task_learning_store_failed',
    error:
      'The knowledge store did not accept the record, so it was not written. Finish the promotion to try again.',
  });
  expect(warn).toHaveBeenCalledWith(
    'task learning request failed',
    expect.objectContaining({ operation: 'promote', code: 'ENOSPC' }),
  );
});

/**
 * #4003 review F9: a done Task's record version is promoted once across the
 * Project's knowledge stores, not once per store.
 *
 * Real: the orchestration database's Task memory store (migrations 020-022)
 * and `promoteTaskLearning`. Fake: the knowledge store provider, two
 * Project stores whose adapters keep records in memory and refuse an id they
 * already hold, as the Kit's stores do. Each create waits on a gate, so two
 * promotions are both past their read-back before either writes.
 */
import { join } from 'node:path';
import type {
  KitRecord,
  KnowledgeStoreProvider,
  KnowledgeStoreRoot,
} from '@kontourai/station-contracts/knowledge-store';
import type { TaskRecord } from '@kontourai/station-contracts/task-graph';
import { afterEach, expect, test } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { EventStore } from '../../orchestration/event-store.js';
import {
  promoteTaskLearning,
  type TaskLearningAccess,
} from '../task-learning.js';

const temp = trackTempDirs();
const closers: Array<() => void> = [];
afterEach(() => {
  for (const close of closers.splice(0)) close();
});

const TASK = {
  id: 'task-1',
  projectId: 'project-1',
  title: 'Queue',
  description: '',
  priority: 'normal',
  status: 'done',
  createdBy: 'user',
  createdAt: '2026-10-20T00:00:00.000Z',
  updatedAt: '2026-10-21T00:00:00.000Z',
} as TaskRecord;

function root(name: string): KnowledgeStoreRoot {
  return {
    id: `root:project-alpha:${name}`,
    scope: { kind: 'project', projectSlug: 'alpha' },
    adapterId: 'kit-default-store',
    storeRoot: `/stores/${name}`,
    displayName: name,
    createdAt: '2026-10-01T00:00:00.000Z',
  };
}

function knowledge(roots: KnowledgeStoreRoot[]) {
  const records = new Map<string, Map<string, KitRecord>>(
    roots.map((r) => [r.id, new Map()]),
  );
  let open: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  const provider = {
    listRoots: async () => roots,
    adapterFor: async (rootId: string) => ({
      get: async (id: string) => records.get(rootId)?.get(id) ?? null,
      create: async (record: KitRecord) => {
        await gate;
        const held = records.get(rootId)!;
        if (held.has(record.id))
          throw new Error(`record ${record.id} already exists`);
        held.set(record.id, record);
      },
    }),
  } as unknown as KnowledgeStoreProvider;
  return { provider, records, open };
}

function memoryWithDecision() {
  const events = new EventStore(
    join(temp('station-task-learning-'), 'orchestration.sqlite'),
  );
  closers.push(() => events.close());
  const memory = events.taskMemoryStore();
  expect(
    memory.writeRecord({
      taskId: TASK.id,
      taskCreatedAt: TASK.createdAt,
      projectId: TASK.projectId,
      author: { kind: 'session', sessionId: 'session-1' },
      write: { kind: 'decision', key: 'storage', text: 'Use SQLite.' },
    }),
  ).toMatchObject({ kind: 'recorded' });
  return memory;
}

test('two people promoting one version into two stores at once write one record, in one store', async () => {
  const stores = [root('a'), root('b')];
  const { provider, records, open } = knowledge(stores);
  const memory = memoryWithDecision();
  const access = (principalId: string): TaskLearningAccess => ({
    memory,
    task: TASK,
    projectId: TASK.projectId,
    projectSlug: 'alpha',
    principalId,
    isCurrent: () => true,
  });
  const promote = (rootId: string, principalId: string) =>
    promoteTaskLearning(provider, access(principalId), {
      kind: 'decision',
      key: 'storage',
      version: 1,
      rootId,
      title: 'Storage',
      text: `Use SQLite (${principalId}).`,
    });
  const both = Promise.all([
    promote(stores[0]!.id, 'person-a'),
    promote(stores[1]!.id, 'person-b'),
  ]);
  // Both are past their read-back and waiting to write.
  await new Promise((resolve) => setTimeout(resolve, 50));
  open();
  const results = await both;
  const written = [...records.entries()].flatMap(([rootId, held]) =>
    [...held.values()].map((record) => [rootId, record.body]),
  );
  expect(written).toEqual([[stores[0]!.id, 'Use SQLite (person-a).']]);
  expect(results.map((result) => result.kind).sort()).toEqual([
    'already-promoted',
    'promoted',
  ]);
  for (const result of results)
    expect('rootId' in result && result.rootId).toBe(stores[0]!.id);
});

test('a promotion whose write failed is finished in its recorded store, never another', async () => {
  const stores = [root('a'), root('b')];
  const { provider, records, open } = knowledge(stores);
  open();
  const memory = memoryWithDecision();
  const access: TaskLearningAccess = {
    memory,
    task: TASK,
    projectId: TASK.projectId,
    projectSlug: 'alpha',
    principalId: 'person-a',
    isCurrent: () => true,
  };
  // The first promotion recorded store a, then its write failed.
  const failing = {
    ...provider,
    listRoots: provider.listRoots,
    adapterFor: async (rootId: string) => ({
      ...(await provider.adapterFor(rootId)),
      create: async () => {
        throw new Error('disk full');
      },
    }),
  } as unknown as KnowledgeStoreProvider;
  const request = {
    kind: 'decision' as const,
    key: 'storage',
    version: 1,
    title: 'Storage',
    text: 'Use SQLite.',
  };
  expect(
    (
      await promoteTaskLearning(failing, access, {
        ...request,
        rootId: stores[0]!.id,
      })
    ).kind,
  ).toBe('store-failed');
  // A later promotion that asks for store b writes into store a.
  const retried = await promoteTaskLearning(provider, access, {
    ...request,
    rootId: stores[1]!.id,
  });
  expect(retried).toMatchObject({ kind: 'promoted', rootId: stores[0]!.id });
  expect(records.get(stores[0]!.id)!.size).toBe(1);
  expect(records.get(stores[1]!.id)!.size).toBe(0);
});

test('a dismissal that lands after the pre-check still stops the promotion, inside its transaction (review round 2, P3-6)', async () => {
  const stores = [root('a')];
  const { provider, records, open } = knowledge(stores);
  open();
  const memory = memoryWithDecision();
  expect(
    memory.dismissLearningCandidate({
      taskId: TASK.id,
      taskCreatedAt: TASK.createdAt,
      projectId: TASK.projectId,
      kind: 'decision',
      key: 'storage',
      version: 1,
      principalId: 'person-b',
    }).kind,
  ).toBe('dismissed');
  // The promotion's own read ran before the dismissal committed.
  const raced = new Proxy(memory, {
    get: (target, property, receiver) =>
      property === 'listLearningDismissals'
        ? () => []
        : Reflect.get(target, property, receiver),
  });
  const result = await promoteTaskLearning(
    provider,
    {
      memory: raced,
      task: TASK,
      projectId: TASK.projectId,
      projectSlug: 'alpha',
      principalId: 'person-a',
      isCurrent: () => true,
    },
    {
      kind: 'decision',
      key: 'storage',
      version: 1,
      rootId: stores[0]!.id,
      title: 'Storage',
      text: 'Use SQLite.',
    },
  );
  expect(result).toEqual({ kind: 'was-dismissed' });
  expect(records.get(stores[0]!.id)!.size).toBe(0);
});

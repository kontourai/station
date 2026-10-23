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
import { mkdirSync, realpathSync, symlinkSync } from 'node:fs';
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
  dismissTaskLearning,
  promoteTaskLearning,
  readTaskLearning,
  storeIdentity,
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

function knowledge(initialRoots: KnowledgeStoreRoot[]) {
  let roots = initialRoots;
  // Records live in a store's directory, as the Kit's stores keep them, so
  // a root id names them only while it names that directory.
  const records = new Map<string, Map<string, KitRecord>>();
  const held = (rootId: string) => {
    const dir = roots.find((r) => r.id === rootId)?.storeRoot ?? `?${rootId}`;
    const map = records.get(dir) ?? new Map<string, KitRecord>();
    records.set(dir, map);
    return map;
  };
  let open: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  const provider = {
    listRoots: async () => roots,
    adapterFor: async (rootId: string) => ({
      get: async (id: string) => held(rootId).get(id) ?? null,
      create: async (record: KitRecord) => {
        await gate;
        const into = held(rootId);
        if (into.has(record.id))
          throw new Error(`record ${record.id} already exists`);
        into.set(record.id, record);
      },
    }),
  } as unknown as KnowledgeStoreProvider;
  /** The Project's stores from now on (one removed, say). */
  const setRoots = (next: KnowledgeStoreRoot[]) => {
    roots = next;
  };
  /** The records in a store's directory. */
  const recordsIn = (root: KnowledgeStoreRoot) =>
    records.get(root.storeRoot) ?? new Map<string, KitRecord>();
  return { provider, records, recordsIn, open, setRoots };
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
  const written = [...records.entries()].flatMap(([dir, held]) =>
    [...held.values()].map((record) => [dir, record.body]),
  );
  expect(written).toEqual([[stores[0]!.storeRoot, 'Use SQLite (person-a).']]);
  expect(results.map((result) => result.kind).sort()).toEqual([
    'already-promoted',
    'promoted',
  ]);
  for (const result of results)
    expect('rootId' in result && result.rootId).toBe(stores[0]!.id);
});

test('a promotion whose write failed is finished in its recorded store, never another', async () => {
  const stores = [root('a'), root('b')];
  const { provider, recordsIn, open } = knowledge(stores);
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
  expect(recordsIn(stores[0]!).size).toBe(1);
  expect(recordsIn(stores[1]!).size).toBe(0);
});

test('a dismissal that lands after the pre-check still stops the promotion, inside its transaction (review round 2, P3-6)', async () => {
  const stores = [root('a')];
  const { provider, recordsIn, open } = knowledge(stores);
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
  expect(recordsIn(stores[0]!).size).toBe(0);
});

test('once a promotion claims a version it cannot be dismissed, and a failed write still finishes (review round 3, F1)', async () => {
  const stores = [root('a')];
  const { provider, recordsIn, open } = knowledge(stores);
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
  const request = {
    kind: 'decision' as const,
    key: 'storage',
    version: 1,
    rootId: stores[0]!.id,
    title: 'Storage',
    text: 'Use SQLite.',
  };
  // The claim lands, then the knowledge write fails.
  const failing = {
    listRoots: provider.listRoots,
    adapterFor: async (rootId: string) => ({
      ...(await provider.adapterFor(rootId)),
      create: async () => {
        throw new Error('disk full');
      },
    }),
  } as unknown as KnowledgeStoreProvider;
  expect((await promoteTaskLearning(failing, access, request)).kind).toBe(
    'store-failed',
  );
  // A dismissal now is refused, not recorded.
  expect(
    dismissTaskLearning(access, {
      kind: 'decision',
      key: 'storage',
      version: 1,
    }),
  ).toEqual({ kind: 'was-promoted' });
  expect(
    memory.listLearningDismissals({
      taskId: TASK.id,
      taskCreatedAt: TASK.createdAt,
    }),
  ).toEqual([]);
  // The retried promotion completes.
  expect(await promoteTaskLearning(provider, access, request)).toMatchObject({
    kind: 'promoted',
    rootId: stores[0]!.id,
  });
  expect(recordsIn(stores[0]!).size).toBe(1);
});

const accessFor = (
  memory: ReturnType<typeof memoryWithDecision>,
): TaskLearningAccess => ({
  memory,
  task: TASK,
  projectId: TASK.projectId,
  projectSlug: 'alpha',
  principalId: 'person-a',
  isCurrent: () => true,
});
const IDENTITY = { kind: 'decision' as const, key: 'storage', version: 1 };
const promotionInto = (rootId: string) => ({
  ...IDENTITY,
  rootId,
  title: 'Storage',
  text: 'Use SQLite.',
});
/** A provider over the same stores whose every knowledge write fails. */
const failingWrites = (provider: KnowledgeStoreProvider) =>
  ({
    listRoots: provider.listRoots,
    adapterFor: async (rootId: string) => ({
      ...(await provider.adapterFor(rootId)),
      create: async () => {
        throw new Error('disk full');
      },
    }),
  }) as unknown as KnowledgeStoreProvider;

test('a finished promotion whose store is then removed is a closed review, and dismissing it is refused (review round 5)', async () => {
  const stores = [root('a')];
  const { provider, open, setRoots } = knowledge(stores);
  open();
  const access = accessFor(memoryWithDecision());
  expect(
    (await promoteTaskLearning(provider, access, promotionInto(stores[0]!.id)))
      .kind,
  ).toBe('promoted');
  setRoots([]);
  expect((await readTaskLearning(provider, access)).candidates).toMatchObject([
    { review: { state: 'promotion-store-gone', rootId: stores[0]!.id } },
  ]);
  expect(dismissTaskLearning(access, IDENTITY)).toEqual({
    kind: 'was-promoted',
  });
});

test("a removed store's root id reused by an unrelated store reads as closed, not pending (review round 5)", async () => {
  const original = root('a');
  const { provider, open, setRoots } = knowledge([original]);
  open();
  const access = accessFor(memoryWithDecision());
  await promoteTaskLearning(provider, access, promotionInto(original.id));
  // The store is removed and a new one, in another directory, takes the id.
  const replacement = { ...root('other'), id: original.id };
  setRoots([replacement]);
  expect((await readTaskLearning(provider, access)).candidates).toMatchObject([
    { review: { state: 'promotion-store-gone', rootId: original.id } },
  ]);
  expect(
    await promoteTaskLearning(provider, access, promotionInto(original.id)),
  ).toEqual({ kind: 'promotion-store-gone' });
});

test('the same directory registered again is the same store: its record reads as promoted (review round 5)', async () => {
  const original = root('a');
  const { provider, open, setRoots } = knowledge([original]);
  open();
  const access = accessFor(memoryWithDecision());
  await promoteTaskLearning(provider, access, promotionInto(original.id));
  setRoots([{ ...original, id: 'root:project-alpha:a-again' }]);
  expect((await readTaskLearning(provider, access)).candidates).toMatchObject([
    { review: { state: 'promoted', rootId: 'root:project-alpha:a-again' } },
  ]);
});

test('a pending promotion with its store present reads as pending and can be finished there (review round 5)', async () => {
  const stores = [root('a'), root('b')];
  const { provider, recordsIn, open } = knowledge(stores);
  open();
  const access = accessFor(memoryWithDecision());
  expect(
    (
      await promoteTaskLearning(
        failingWrites(provider),
        access,
        promotionInto(stores[0]!.id),
      )
    ).kind,
  ).toBe('store-failed');
  expect((await readTaskLearning(provider, access)).candidates).toMatchObject([
    { review: { state: 'pending', rootId: stores[0]!.id } },
  ]);
  // Finishing it, even naming the other store, writes only into its own.
  expect(
    await promoteTaskLearning(provider, access, promotionInto(stores[1]!.id)),
  ).toMatchObject({ kind: 'promoted', rootId: stores[0]!.id });
  expect(recordsIn(stores[0]!).size).toBe(1);
  expect(recordsIn(stores[1]!).size).toBe(0);
  expect((await readTaskLearning(provider, access)).candidates).toMatchObject([
    { review: { state: 'promoted', rootId: stores[0]!.id } },
  ]);
});

test('one store directory is one identity however it is spelled, through a symlink too (review round 6)', () => {
  const directory = join(temp('station-store-identity-'), 'store');
  mkdirSync(directory);
  const link = join(temp('station-store-link-'), 'link');
  // A junction on Windows (no admin right needed); a symlink elsewhere.
  symlinkSync(directory, link, 'junction');
  const identity = storeIdentity(directory);
  // The native form: on Windows the JS form keeps 8.3 short names.
  expect(identity).toBe(realpathSync.native(directory));
  for (const spelling of [
    `${directory}/`,
    join(directory, '.'),
    `${directory}/./`,
    link,
    `${link}/`,
    realpathSync.native(directory),
  ])
    expect(storeIdentity(spelling)).toBe(identity);
  // A directory that does not exist keeps its resolved path.
  const gone = join(directory, 'missing');
  expect(storeIdentity(`${gone}/`)).toBe(gone);
});

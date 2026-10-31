import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import * as contracts from '@kontourai/station-contracts/task-review';
import { afterEach, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import legacy from '../../../domain/__fixtures__/shared-working-state-v1.json';
import { EventStore } from '../../orchestration/event-store.js';
import type { TaskReviewAccess } from '../../orchestration/project-task-room-runtime.js';
import { TaskReviewError, TaskReviewModule } from '../task-review-module.js';

const makeTempDir = trackTempDirs();
const stores: EventStore[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) await store.close();
});
const access: TaskReviewAccess = {
  kind: 'granted',
  staleOutcome: { kind: 'not-found' },
  write: {
    projectId: 'project',
    taskId: 'task',
    taskCreatedAt: '2026-10-25T00:00:00.000Z',
    author: { kind: 'person', principalId: 'owner' },
    beforeCommit: () => true,
  },
};
const request = new Request('http://station.test/api/tasks/task/review');
function setup({
  readPlan,
  readPlanOrdinals,
}: {
  readPlan?: ConstructorParameters<typeof TaskReviewModule>[0]['readPlan'];
  readPlanOrdinals?: ConstructorParameters<
    typeof TaskReviewModule
  >[0]['readPlanOrdinals'];
} = {}) {
  const databasePath = join(
    makeTempDir('station-review-module-'),
    'events.sqlite',
  );
  const events = new EventStore(databasePath);
  stores.push(events);
  const store = events.taskReviewStore();
  let plan = {
    kind: 'available' as const,
    documentId: 'plan',
    revision: 'v0',
    text: 'Plan',
  };
  let status: 'confirmed' | 'unconfirmed' = 'unconfirmed';
  const deliveryStatusFor = vi.fn(
    (_threadId: string, _deliveryKey: string) => status,
  );
  const logger = { warn: vi.fn() };
  const module = new TaskReviewModule({
    store,
    logger,
    memory: { readSummary: () => undefined },
    outputs: {
      list: async () => [],
      read: async () => {
        throw new Error('Unexpected output read');
      },
      readContent: async () => {
        throw new Error('Unexpected content read');
      },
    },

    freezePlan: async () => true,
    readPlan: readPlan ?? (async () => plan),
    readPlanOrdinals,
    readAnswers: async () => [],
    deliveryStatusFor,
  });
  return {
    events,
    databasePath,
    logger,
    store,
    module,
    deliveryStatusFor,
    setPlan: (revision: string, text = 'Plan') => {
      plan = { ...plan, revision, text };
    },
    setDelivery: (value: typeof status) => {
      status = value;
    },
    read: () => module.read(access, request),
  };
}

test('relocates a v1-era plan thread after the actual SQLite document is saved as v2', async () => {
  const scope = legacy.snapshot.scope;
  const e = setup({
    readPlan: async () => {
      const document = await working.read({ scope });
      if (document.kind === 'unavailable')
        return { kind: 'unavailable' as const };
      if (
        typeof document.revision !== 'string' ||
        typeof document.text !== 'string'
      )
        throw new Error('expected complete document projection');
      return {
        kind: 'available' as const,
        documentId: scope.documentId,
        revision: document.revision,
        text: document.text,
      };
    },
  });
  const working = e.events.createProjectTaskRoomWorkingState();
  const owner: TaskReviewAccess = {
    ...access,
    write: {
      ...access.write,
      projectId: scope.projectId,
      taskId: scope.taskId,
    },
  };
  try {
    await working.read({ scope });
    const database = new DatabaseSync(e.databasePath);
    try {
      database
        .prepare(
          'INSERT INTO project_task_room_working_states(project_id,task_id,document_id,snapshot_json,revision,compaction_floor,updated_at) VALUES(?,?,?,?,?,?,?)',
        )
        .run(
          scope.projectId,
          scope.taskId,
          scope.documentId,
          JSON.stringify(legacy.snapshot),
          legacy.snapshot.revision,
          legacy.snapshot.revision,
          '2026-10-26T00:00:00Z',
        );
    } finally {
      database.close();
    }
    const before = await e.module.read(owner, request);
    const item = before.items.find((item) => item.kind === 'plan');
    if (item?.status !== 'available')
      throw new Error('expected available v1 plan');
    expect(item.artifact.revision).toMatch(/^swsr-v1:/);
    const start = legacy.receipt.text.indexOf('brief');
    expect(start).toBeGreaterThanOrEqual(0);
    const thread = await e.module.create(owner, request, {
      artifact: item.artifact,
      anchor: {
        kind: 'text-quote',
        start,
        end: start + 5,
        exact: 'brief',
        prefix: '',
        suffix: '',
      },
      body: 'Keep this plan detail',
      operationId: 'v1-thread',
    });
    expect(
      await working.settle({
        scope,
        intentId: 'upgrade',
        intentDigest: 'upgrade',
        actorId: 'legacy-person',
        epoch: 0,
        operations: [
          {
            schemaVersion: 1,
            documentId: legacy.snapshot.scope.documentId,
            replicaId: 'room:legacy-device',
            actor: { actorId: 'legacy-person', kind: 'human' },
            parents: [],
            authorizationEpoch: 0,
            kind: 'insert',
            operationId: '!prefix',
            after: null,
            text: 'New ',
          },
        ],
        suppressRevisionPublicationForDiagnostic: true,
      }),
    ).toMatchObject({ kind: 'committed', text: `New ${legacy.receipt.text}` });
    expect(await working.privateSnapshot({ scope })).toMatchObject({
      schemaVersion: 2,
    });
    const current = await e.module.read(owner, request);
    const detail = await e.module.readThread(owner, request, thread.threadId);
    expect(current.threads[0]).toMatchObject({
      artifact: { revision: legacy.snapshot.revision },
      currentRevision: expect.stringMatching(/^swsr-v2:/),
      state: 'open',
      outdated: false,
    });
    expect(detail).toMatchObject({
      quote: 'brief',
      artifact: { revision: legacy.snapshot.revision },
      currentRevision: expect.stringMatching(/^swsr-v2:/),
      state: 'open',
      outdated: false,
    });
    if (thread.anchor.kind !== 'text-quote')
      throw new Error('expected quote anchor');
    expect(
      contracts.relocateTextQuote(`New ${legacy.receipt.text}`, thread.anchor),
    ).toMatchObject({ status: 'moved', start: start + 4, end: start + 9 });
    expect(
      e.store.readThread({ ...owner.write, threadId: thread.threadId }),
    ).toMatchObject({ artifact: item.artifact, anchor: thread.anchor });
  } finally {
    await working.close();
  }
});

function open(e: ReturnType<typeof setup>, body = 'Please clarify') {
  const result = e.store.createThread({
    ...access.write,
    artifact: {
      kind: 'plan',
      id: 'plan',
      revision: 'v0',
      digest: `sha256:${'a'.repeat(64)}`,
    },
    anchor: { kind: 'whole' },
    body,
    operationId: 'opening',
  });
  if (!result.success) throw new Error(result.error);
  return result.data;
}

test('delivery standing changes on cached list and detail views without a new event', async () => {
  const e = setup();
  const thread = open(e);
  expect(
    e.store.recordSend({
      ...access.write,
      threadIds: [thread.threadId],
      deliveryKey: 'delivery',
      operationId: 'send',
    }).success,
  ).toBe(true);
  const derive = vi.spyOn(contracts, 'deriveThreadView');
  const first = (await e.read()).threads[0]!;
  expect(first).toMatchObject({ eventCount: 2, deliveryStatus: 'unconfirmed' });
  e.setDelivery('confirmed');
  expect((await e.read()).threads[0]).toMatchObject({
    eventCount: 2,
    deliveryStatus: 'confirmed',
  });
  expect(
    await e.module.readThread(access, request, thread.threadId),
  ).toMatchObject({ deliveryStatus: 'confirmed' });
  e.setDelivery('unconfirmed');
  expect(
    await e.module.readThread(access, request, thread.threadId),
  ).toMatchObject({ deliveryStatus: 'unconfirmed' });
  expect(e.deliveryStatusFor.mock.calls).toEqual(
    Array(4).fill([thread.threadId, 'delivery']),
  );
  expect(derive).toHaveBeenCalledTimes(1);
});

test('a delivery port outage keeps list and detail available and recovers without another event', async () => {
  const e = setup();
  const thread = open(e);
  expect(
    e.store.recordSend({
      ...access.write,
      threadIds: [thread.threadId],
      deliveryKey: 'delivery',
      operationId: 'send',
    }).success,
  ).toBe(true);
  e.setDelivery('confirmed');
  expect((await e.read()).threads[0]).toMatchObject({
    status: 'available',
    deliveryStatus: 'confirmed',
  });
  e.deliveryStatusFor.mockImplementation(() => {
    throw new Error('Inbox offline');
  });
  expect((await e.read()).threads[0]).toMatchObject({
    status: 'available',
    eventCount: 2,
    deliveryStatus: 'unconfirmed',
  });
  expect(
    await e.module.readThread(access, request, thread.threadId),
  ).toMatchObject({ deliveryStatus: 'unconfirmed' });
  expect(e.logger.warn.mock.calls.map(([message]) => message)).toEqual([
    'task review delivery status unavailable',
    'task review delivery status unavailable',
  ]);
  e.deliveryStatusFor.mockImplementation(() => 'confirmed');
  expect((await e.read()).threads[0]).toMatchObject({
    status: 'available',
    eventCount: 2,
    deliveryStatus: 'confirmed',
  });
});

test('detail returns the typed unavailable error when its diagnostic listing also fails', async () => {
  const e = setup();
  const thread = open(e);
  await e.events.close();
  stores.splice(stores.indexOf(e.events), 1);
  const detail = e.module.readThread(access, request, thread.threadId);
  await expect(detail).rejects.toBeInstanceOf(TaskReviewError);
  await expect(detail).rejects.toMatchObject({
    code: 'unavailable',
    message: 'Review thread is unavailable.',
  });
  expect(e.logger.warn).toHaveBeenCalledWith(
    'task review thread lookup failed',
    expect.objectContaining({ threadId: thread.threadId }),
  );
});

test('summary retains a bounded opening preview and last delivery after another event; detail retains full body', async () => {
  const e = setup();
  const body = `${'x'.repeat(499)}😀${'z'.repeat(2000)}`;
  const thread = open(e, body);
  expect((await e.read()).threads[0]).toMatchObject({
    openingEvent: { body: 'x'.repeat(499) },
    lastEvent: { body: 'x'.repeat(499) },
  });
  expect(
    e.store.recordSend({
      ...access.write,
      threadIds: [thread.threadId],
      deliveryKey: 'delivery',
      operationId: 'send',
    }).success,
  ).toBe(true);
  expect(
    e.store.appendReviewEvent({
      ...access.write,
      threadId: thread.threadId,
      event: { kind: 'resolved', reason: 'Done', operationId: 'resolve' },
    }).success,
  ).toBe(true);
  const summary = (await e.read()).threads[0]!;
  expect(summary).toMatchObject({
    status: 'available',
    eventCount: 3,
    openingEvent: {
      kind: 'comment',
      body: 'x'.repeat(499),
      author: access.write.author,
      createdAt: thread.events[0]!.createdAt,
    },
    lastDeliveryEvent: { kind: 'sent', deliveryKey: 'delivery', ordinal: 2 },
    lastEvent: { kind: 'resolved', ordinal: 3 },
  });
  expect(summary).not.toHaveProperty('events');
  expect(
    (await e.module.readThread(access, request, thread.threadId)).events[0],
  ).toMatchObject({ body });
});

test('document revision cache evicts the least recently read entry at its 16-entry limit', async () => {
  const e = setup();
  const prepare = vi.spyOn(contracts, 'prepareTaskReviewDocument');
  for (let n = 0; n < 16; n++) {
    e.setPlan(`v${n}`);
    await e.read();
  }
  expect(prepare).toHaveBeenCalledTimes(16);
  e.setPlan('v0');
  await e.read();
  e.setPlan('v16');
  await e.read();
  e.setPlan('v0');
  await e.read();
  expect(prepare).toHaveBeenCalledTimes(17);
  e.setPlan('v1');
  await e.read();
  expect(prepare).toHaveBeenCalledTimes(18);
});

test('document cache budgets text and line offsets within 8 MiB and never retains failed preparations', async () => {
  const e = setup();
  const prepare = vi.spyOn(contracts, 'prepareTaskReviewDocument');
  const text = '\n'.repeat(600_000); // About 6 MB of UTF-16 text plus numeric line offsets per revision.
  e.setPlan('large-a', text);
  await e.read();
  await e.read();
  expect(prepare).toHaveBeenCalledTimes(1);
  e.setPlan('large-b', text);
  await e.read();
  e.setPlan('large-a', text);
  await e.read();
  expect(prepare).toHaveBeenCalledTimes(3);
  for (const [revision, raw] of [
    ['oversize', 'x'.repeat(1_048_577)],
    ['malformed', '\uD800'],
  ]) {
    e.setPlan(revision!, raw!);
    await e.read();
    await e.read();
  }
  expect(prepare).toHaveBeenCalledTimes(7);
});

test('ordinal cache budgets anchored revision payloads and retries failed lookups without poisoning the cache', async () => {
  const readOrdinals = vi.fn(
    async (
      _taskId: string,
      _request: Request,
      _latest: string,
      revisions: readonly string[],
    ) => Object.fromEntries(revisions.map((revision, i) => [revision, i + 1])),
  );
  const e = setup({ readPlanOrdinals: readOrdinals });
  // 500 distinct bounded revision identities consume over 400 KiB including
  // both requested identities and the values map, before keys/entry allowance.
  for (let n = 0; n < 500; n++) {
    const revision = `saved-${String(n).padStart(3, '0')}-${'x'.repeat(230)}`;
    const created = e.store.createThread({
      ...access.write,
      artifact: {
        kind: 'plan',
        id: 'plan',
        revision,
        digest: `sha256:${'a'.repeat(64)}`,
      },
      anchor: { kind: 'whole' },
      body: 'Review saved revision',
      operationId: `cache-${n}`,
    });
    expect(created.success).toBe(true);
  }
  e.setPlan('current-a');
  await e.read();
  await e.read();
  expect(readOrdinals).toHaveBeenCalledTimes(1);
  e.setPlan('current-b');
  await e.read();
  e.setPlan('current-c');
  await e.read();
  e.setPlan('current-a');
  await e.read();
  expect(readOrdinals).toHaveBeenCalledTimes(4); // Byte budget evicts before the 16-entry cap.
  e.setPlan('lookup-outage');
  readOrdinals.mockRejectedValueOnce(new Error('worker unavailable'));
  const outage = (await e.read()).items.find((item) => item.kind === 'plan');
  expect(
    outage?.status === 'available' ? outage.revisionOrdinals : undefined,
  ).toBeUndefined();
  await e.read();
  expect(readOrdinals).toHaveBeenCalledTimes(6);
});

import { join } from 'node:path';
import * as contracts from '@kontourai/station-contracts/task-review';
import { afterEach, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
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
function setup() {
  const events = new EventStore(
    join(makeTempDir('station-review-module-'), 'events.sqlite'),
  );
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
    readPlan: async () => plan,
    readAnswers: async () => [],
    deliveryStatusFor,
  });
  return {
    events,
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
    e.store.appendEvent({
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

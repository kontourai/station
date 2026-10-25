import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { TASK_REVIEW_LIMITS as LIMITS } from '@kontourai/station-contracts/task-review';
import { afterEach, describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { EventStore } from '../event-store.js';

const makeTempDir = trackTempDirs();
const closers: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
});
const TASK = {
  projectId: 'project',
  taskId: 'task',
  taskCreatedAt: '2026-10-24T00:00:00.000Z',
};
const WRITE = {
  ...TASK,
  author: { kind: 'person', principalId: 'owner' } as const,
  beforeCommit: () => true,
};
const artifact = {
  kind: 'plan',
  id: 'document',
  revision: 'v1',
  digest: `sha256:${'a'.repeat(64)}`,
} as const;
const opening = {
  artifact,
  anchor: {
    kind: 'text-quote',
    start: 0,
    end: 4,
    exact: 'Plan',
    prefix: '',
    suffix: '',
  } as const,
  body: 'Please clarify.',
  operationId: 'create',
};
const capture = {
  sourceKind: 'browser' as const,
  sourceSessionId: 'browser',
  commit: 'a'.repeat(40),
  mediaType: 'image/png' as const,
  byteLength: 10,
  digest: `sha256:${'b'.repeat(64)}` as const,
  operationId: 'capture',
};
function setup() {
  const path = join(
    makeTempDir('station-task-review-'),
    'orchestration.sqlite',
  );
  const events = new EventStore(path);
  closers.push(() => {
    events.close();
  });
  return { path, events, store: events.taskReviewStore() };
}
function create(s: ReturnType<typeof setup>, operationId = 'create') {
  const result = s.store.createThread({ ...WRITE, ...opening, operationId });
  if (!result.success) throw new Error(result.error);
  return result.data;
}

describe('Task review over real orchestration SQLite', () => {
  test('threads, events and capture metadata survive closing and reopening the same file; all three tables refuse updates and deletes', async () => {
    const s = setup();
    const thread = create(s);
    expect(
      s.store.recordSend({
        ...WRITE,
        threadIds: [thread.threadId],
        deliveryKey: 'tr-delivery',
        operationId: 'send',
      }).success,
    ).toBe(true);
    const captured = s.store.createCapture({ ...WRITE, ...capture });
    expect(captured.success).toBe(true);
    const before = s.store.readThread({ ...TASK, threadId: thread.threadId });
    const metadata = s.store.listCaptures(TASK);
    const db = new DatabaseSync(s.path);
    try {
      for (const [table, field] of [
        ['task_review_threads', 'quote'],
        ['task_review_events', 'body'],
        ['task_review_captures', 'label'],
      ]) {
        expect(() =>
          db.exec(`UPDATE ${table} SET ${field} = 'changed'`),
        ).toThrow('append-only');
        expect(() => db.exec(`DELETE FROM ${table}`)).toThrow('append-only');
      }
    } finally {
      db.close();
    }
    await s.events.close();
    closers.pop();
    const reopened = new EventStore(s.path);
    closers.push(() => {
      reopened.close();
    });
    expect(
      reopened
        .taskReviewStore()
        .readThread({ ...TASK, threadId: thread.threadId }),
    ).toEqual(before);
    expect(reopened.taskReviewStore().listCaptures(TASK)).toEqual(metadata);
    expect(before?.events.map((e) => e.kind)).toEqual(['comment', 'sent']);
  });

  test('operation ids replay identical writes, refuse changed payloads, and never duplicate events or captures', () => {
    const s = setup();
    const thread = create(s);
    expect(create(s)).toEqual(thread);
    expect(
      s.store.createThread({ ...WRITE, ...opening, body: 'Different' }),
    ).toMatchObject({ success: false, code: 'operation-conflict' });
    const input = {
      ...WRITE,
      threadId: thread.threadId,
      event: { kind: 'reply' as const, body: 'Yes', operationId: 'reply' },
    };
    expect(s.store.appendEvent(input).success).toBe(true);
    expect(s.store.appendEvent(input).success).toBe(true);
    expect(
      s.store.appendEvent({ ...input, event: { ...input.event, body: 'No' } }),
    ).toMatchObject({ success: false, code: 'operation-conflict' });
    expect(s.store.createCapture({ ...WRITE, ...capture }).success).toBe(true);
    expect(s.store.createCapture({ ...WRITE, ...capture }).success).toBe(true);
    expect(
      s.store.createCapture({ ...WRITE, ...capture, label: 'different' }),
    ).toMatchObject({ success: false, code: 'operation-conflict' });
    expect(
      s.store.readThread({ ...TASK, threadId: thread.threadId })?.events,
    ).toHaveLength(2);
    expect(s.store.listThreads(TASK)).toHaveLength(1);
    expect(s.store.listCaptures(TASK)).toHaveLength(1);
  });

  test('a re-created Task lists and reads no threads or captures from its old incarnation', () => {
    const s = setup();
    const thread = create(s);
    expect(s.store.createCapture({ ...WRITE, ...capture }).success).toBe(true);
    const recreated = { ...TASK, taskCreatedAt: '2026-10-25T00:00:00.000Z' };
    expect(s.store.listThreads(recreated)).toEqual([]);
    expect(
      s.store.readThread({ ...recreated, threadId: thread.threadId }),
    ).toBeUndefined();
    expect(s.store.listCaptures(recreated)).toEqual([]);
    expect(
      s.store.readThread({
        ...TASK,
        taskId: 'other',
        threadId: thread.threadId,
      }),
    ).toBeUndefined();
    const fresh = s.store.createThread({ ...WRITE, ...recreated, ...opening });
    expect(fresh).toMatchObject({
      success: true,
      data: { ordinal: 1, taskCreatedAt: recreated.taskCreatedAt },
    });
  });

  test('beforeCommit refusal rolls back every write, including a revocation after insertion', () => {
    const s = setup();
    expect(
      s.store.createThread({ ...WRITE, ...opening, beforeCommit: () => false })
        .success,
    ).toBe(false);
    expect(s.store.listThreads(TASK)).toEqual([]);
    const thread = create(s);
    const refused = { ...WRITE, beforeCommit: () => false };
    expect(
      s.store.appendEvent({
        ...refused,
        threadId: thread.threadId,
        event: { kind: 'reply', body: 'Hi', operationId: 'reply' },
      }).success,
    ).toBe(false);
    expect(
      s.store.recordSend({
        ...refused,
        threadIds: [thread.threadId],
        deliveryKey: 'key',
        operationId: 'send',
      }).success,
    ).toBe(false);
    expect(
      s.store.recordSendFailed({
        ...refused,
        threadIds: [thread.threadId],
        reason: 'capacity',
        operationId: 'failed',
      }).success,
    ).toBe(false);
    expect(s.store.createCapture({ ...refused, ...capture }).success).toBe(
      false,
    );
    let checks = 0;
    expect(
      s.store.createThread({
        ...WRITE,
        ...opening,
        operationId: 'revoked',
        beforeCommit: () => ++checks === 1,
      }).success,
    ).toBe(false);
    expect(s.store.listThreads(TASK)).toHaveLength(1);
    expect(
      s.store.readThread({ ...TASK, threadId: thread.threadId })?.events,
    ).toHaveLength(1);
    expect(s.store.listCaptures(TASK)).toEqual([]);
  });

  test('all event and thread slots are retained; full stores refuse new writes but permit identical retries; batch send is atomic', () => {
    const s = setup();
    const first = create(s);
    const second = create(s, 'second');
    for (let ordinal = 2; ordinal <= LIMITS.eventsPerThread; ordinal++) {
      expect(
        s.store.appendEvent({
          ...WRITE,
          threadId: second.threadId,
          event: {
            kind: 'reply',
            body: 'reply',
            operationId: `reply-${ordinal}`,
          },
        }).success,
      ).toBe(true);
    }
    expect(
      s.store.appendEvent({
        ...WRITE,
        threadId: second.threadId,
        event: { kind: 'reply', body: 'reply', operationId: 'reply-2' },
      }).success,
    ).toBe(true);
    expect(
      s.store.recordSend({
        ...WRITE,
        threadIds: [first.threadId, second.threadId],
        deliveryKey: 'key',
        operationId: 'send',
      }),
    ).toMatchObject({ success: false, code: 'event-limit' });
    expect(
      s.store.readThread({ ...TASK, threadId: first.threadId })?.events,
    ).toHaveLength(1);
    expect(
      s.store.readThread({ ...TASK, threadId: second.threadId })?.events,
    ).toHaveLength(LIMITS.eventsPerThread);
    for (let n = 2; n < LIMITS.threadsPerTask; n++) create(s, `thread-${n}`);
    expect(
      s.store.createThread({ ...WRITE, ...opening, operationId: 'over' }),
    ).toMatchObject({ success: false, code: 'thread-limit' });
    expect(create(s).threadId).toBe(first.threadId);
    expect(s.store.listThreads(TASK)).toHaveLength(LIMITS.threadsPerTask);
  });

  test('capture count and home byte caps refuse without evicting metadata or truncating bytes', () => {
    const s = setup();
    for (let n = 0; n < LIMITS.capturesPerTask; n++)
      expect(
        s.store.createCapture({
          ...WRITE,
          ...capture,
          operationId: `capture-${n}`,
        }).success,
      ).toBe(true);
    expect(s.store.createCapture({ ...WRITE, ...capture })).toMatchObject({
      success: false,
      code: 'capture-limit',
    });
    expect(s.store.listCaptures(TASK)).toHaveLength(LIMITS.capturesPerTask);
    const other = { ...WRITE, taskId: 'large-captures' };
    // One existing ten-byte digest means only 31 distinct 16 MiB captures fit.
    for (let n = 0; n < 31; n++)
      expect(
        s.store.createCapture({
          ...other,
          ...capture,
          byteLength: LIMITS.captureBytes,
          digest: `sha256:${n.toString(16).padStart(64, '0')}`,
          operationId: `large-${n}`,
        }).success,
      ).toBe(true);
    expect(
      s.store.createCapture({
        ...other,
        ...capture,
        byteLength: LIMITS.captureBytes,
        digest: `sha256:${'c'.repeat(64)}`,
      }),
    ).toMatchObject({ success: false, code: 'capture-home-limit' });
    expect(s.store.listCaptures(other)).toHaveLength(31);
    expect(
      s.store.createCapture({
        ...other,
        ...capture,
        byteLength: LIMITS.captureBytes + 1,
      }),
    ).toMatchObject({ success: false, code: 'invalid-request' });
  });

  test('max-length comments are stored intact; oversize bodies and wrong author event kinds write nothing', () => {
    const s = setup();
    const atBound = s.store.createThread({
      ...WRITE,
      ...opening,
      body: 'x'.repeat(LIMITS.bodyChars),
    });
    expect(atBound).toMatchObject({
      success: true,
      data: { events: [{ body: 'x'.repeat(LIMITS.bodyChars) }] },
    });
    expect(
      s.store.createThread({
        ...WRITE,
        ...opening,
        operationId: 'too-long',
        body: 'x'.repeat(LIMITS.bodyChars + 1),
      }),
    ).toMatchObject({ success: false, code: 'invalid-request' });
    const thread = s.store.listThreads(TASK)[0]!;
    expect(
      s.store.appendEvent({
        ...WRITE,
        threadId: thread.threadId,
        event: { kind: 'agent-reply', body: 'No', operationId: 'agent' },
      }),
    ).toMatchObject({ success: false, code: 'invalid-request' });
    expect(
      s.store.readThread({ ...TASK, threadId: thread.threadId })?.events,
    ).toHaveLength(1);
  });
});

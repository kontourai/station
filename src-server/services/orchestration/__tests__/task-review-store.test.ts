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

  test('agent evidence is persisted canonically and case-equivalent retries consume no event', () => {
    const s = setup();
    const thread = create(s);
    expect(
      s.store.recordSend({
        ...WRITE,
        threadIds: [thread.threadId],
        deliveryKey: 'evidence-key',
        operationId: 'send-evidence',
      }).success,
    ).toBe(true);
    const input = {
      ...WRITE,
      author: { kind: 'session' as const, sessionId: 'lead' },
      threadId: thread.threadId,
      event: {
        kind: 'agent-reply' as const,
        deliveryKey: 'evidence-key',
        body: 'Claim',
        operationId: 'canonical-evidence',
        evidence: {
          commit: 'A'.repeat(40),
          commitVerified: false,
          gateVerified: false,
        },
      },
    };
    expect(s.store.appendEvent(input).success).toBe(true);
    expect(s.store.appendEvent(input).success).toBe(true);
    expect(
      s.store.appendEvent({
        ...input,
        event: {
          ...input.event,
          evidence: { ...input.event.evidence, commit: 'a'.repeat(40) },
        },
      }).success,
    ).toBe(true);
    expect(
      s.store.appendEvent({
        ...input,
        event: {
          ...input.event,
          operationId: 'zero-evidence',
          evidence: { ...input.event.evidence, commit: '0'.repeat(40) },
        },
      }),
    ).toMatchObject({ success: false, code: 'invalid-request' });
    const db = new DatabaseSync(s.path);
    try {
      const row = db
        .prepare(
          'SELECT evidence_json FROM task_review_events WHERE thread_id=? AND ordinal=3',
        )
        .get(thread.threadId);
      expect(JSON.parse(String(row?.evidence_json))).toMatchObject({
        commit: 'a'.repeat(40),
        commitVerified: false,
        gateVerified: false,
      });
    } finally {
      db.close();
    }
    expect(
      s.store.readThread({ ...TASK, threadId: thread.threadId })?.events,
    ).toHaveLength(3);
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
        deliveryKey: 'key',
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
        event: {
          kind: 'agent-reply',
          deliveryKey: 'key',
          body: 'No',
          operationId: 'agent',
        },
      }),
    ).toMatchObject({ success: false, code: 'invalid-request' });
    expect(
      s.store.readThread({ ...TASK, threadId: thread.threadId })?.events,
    ).toHaveLength(1);
  });
  test('person-only opening/replies and structured artifact revisions survive the store boundary', () => {
    const s = setup();
    const session = { kind: 'session', sessionId: 'agent' } as const;
    expect(
      s.store.createThread({ ...WRITE, ...opening, author: session }),
    ).toMatchObject({ success: false, code: 'invalid-request' });
    const thread = create(s);
    expect(
      s.store.appendEvent({
        ...WRITE,
        author: session,
        threadId: thread.threadId,
        event: { kind: 'reply', body: 'No', operationId: 'session-reply' },
      }),
    ).toMatchObject({ success: false, code: 'invalid-request' });
    for (const ref of [
      { kind: 'summary', id: 'summary', revision: 7, digest: artifact.digest },
      {
        kind: 'answer',
        sessionId: 'session/with/slashes',
        turnId: 'turn/one',
        revision: 'turn/one',
        digest: artifact.digest,
      },
    ] as const) {
      const result = s.store.createThread({
        ...WRITE,
        ...opening,
        artifact: ref,
        anchor: { kind: 'whole' },
        operationId: ref.kind,
      });
      expect(result).toMatchObject({ success: true, data: { artifact: ref } });
    }
    expect(
      s.store.readThread({ ...TASK, threadId: thread.threadId })?.events,
    ).toHaveLength(1);
  });

  test('SQLite constraints independently refuse invalid row shapes and overlong identities', () => {
    const s = setup();
    create(s);
    expect(s.store.createCapture({ ...WRITE, ...capture }).success).toBe(true);
    const db = new DatabaseSync(s.path);
    try {
      const clone = (
        table: string,
        changes: Record<string, string | number | null>,
      ) => {
        const row = db.prepare(`SELECT * FROM ${table} LIMIT 1`).get()!;
        const changed = { ...row, ...changes };
        db.prepare(
          `INSERT INTO ${table} (${Object.keys(changed).join(',')}) VALUES (${Object.keys(
            changed,
          )
            .map(() => '?')
            .join(',')})`,
        ).run(...Object.values(changed));
      };
      for (const [table, changes] of [
        [
          'task_review_threads',
          {
            thread_id: 'bad-thread',
            ordinal: 2,
            operation_id: 'new',
            author_kind: 'session',
          },
        ],
        [
          'task_review_events',
          {
            ordinal: 2,
            kind: 'reply',
            operation_id: 'new',
            author_kind: 'session',
          },
        ],
        [
          'task_review_events',
          {
            ordinal: 2,
            kind: 'reply',
            operation_id: 'new',
            author_id: 'x'.repeat(257),
          },
        ],
        [
          'task_review_threads',
          { thread_id: 'bad-op', ordinal: 2, operation_id: 'x'.repeat(513) },
        ],
        [
          'task_review_captures',
          {
            capture_id: 'bad-capture',
            operation_id: 'new',
            author_kind: 'invented',
          },
        ],
        [
          'task_review_captures',
          {
            capture_id: 'bad-source',
            operation_id: 'new',
            source_session_id: 'x'.repeat(513),
          },
        ],
        [
          'task_review_events',
          {
            ordinal: 2,
            kind: 'reply',
            operation_id: 'reply-evidence',
            evidence_json: '{}',
          },
        ],
        [
          'task_review_events',
          { ordinal: 4, kind: 'reply', operation_id: 'gap' },
        ],
        [
          'task_review_events',
          {
            ordinal: 2,
            kind: 'resolved',
            reason: 'Done',
            operation_id: 'resolved-body',
          },
        ],
        [
          'task_review_events',
          {
            ordinal: 2,
            kind: 'send-failed',
            body: null,
            reason: 'Failure',
            delivery_key: 'key',
            author_kind: 'session',
            operation_id: 'session-failure',
          },
        ],
        [
          'task_review_threads',
          {
            thread_id: 'whole-quote',
            ordinal: 2,
            operation_id: 'whole-quote',
            anchor_kind: 'whole',
            anchor_json: '{"kind":"whole"}',
          },
        ],
        [
          'task_review_threads',
          {
            thread_id: 'block-no-quote',
            ordinal: 2,
            operation_id: 'block-no-quote',
            anchor_kind: 'block',
            anchor_json: '{"kind":"block","startLine":1,"endLine":1}',
            quote: null,
          },
        ],
        [
          'task_review_threads',
          {
            thread_id: 'bad-summary',
            ordinal: 2,
            operation_id: 'bad-summary',
            artifact_kind: 'summary',
            artifact_id: 'summary',
            artifact_revision: 'not-numeric',
          },
        ],
        [
          'task_review_threads',
          {
            thread_id: 'kind-mismatch',
            ordinal: 2,
            operation_id: 'kind-mismatch',
            anchor_kind: 'whole',
            quote: null,
          },
        ],
        [
          'task_review_captures',
          {
            capture_id: 'bad-sha256',
            operation_id: 'new',
            commit_sha: 'a'.repeat(64),
          },
        ],
      ] as const)
        expect(() => clone(table, changes)).toThrow(
          /CHECK constraint|ordinal must be max\+1/,
        );
    } finally {
      db.close();
    }
  });
  test('delivery failure is person-authored, keys are lifetime unique, and both reopen paths retire active correlation', () => {
    const s = setup();
    const thread = create(s);
    const send = (key: string, operationId: string) =>
      s.store.recordSend({
        ...WRITE,
        threadIds: [thread.threadId],
        deliveryKey: key,
        operationId,
      });
    expect(send('key-one', 'send-one').success).toBe(true);
    expect(
      s.store.recordSendFailed({
        ...WRITE,
        author: { kind: 'session', sessionId: 'lead' },
        threadIds: [thread.threadId],
        deliveryKey: 'key-one',
        reason: 'Failed',
        operationId: 'session-failed',
      }),
    ).toMatchObject({ success: false, code: 'invalid-request' });
    expect(
      s.store.recordSendFailed({
        ...WRITE,
        threadIds: [thread.threadId],
        deliveryKey: 'key-one',
        reason: 'Failed',
        operationId: 'person-failed',
      }).success,
    ).toBe(true);
    expect(send('key-one', 'reuse')).toMatchObject({
      success: false,
      code: 'invalid-transition',
    });
    const db = new DatabaseSync(s.path);
    try {
      expect(() =>
        db
          .prepare(`INSERT INTO task_review_events(thread_id, ordinal, kind, author_kind, author_id, delivery_key, operation_id, created_at)
        VALUES (?, 4, 'sent', 'person', 'owner', 'key-one', 'direct-reuse', ?)`)
          .run(thread.threadId, TASK.taskCreatedAt),
      ).toThrow(/UNIQUE constraint/);
    } finally {
      db.close();
    }
    for (const [n, reopen] of ['reopened', 'reply'].entries()) {
      const deliveryKey = `fresh-${n}`;
      expect(send(deliveryKey, `send-${n}`).success).toBe(true);
      expect(
        s.store.appendEvent({
          ...WRITE,
          threadId: thread.threadId,
          event: {
            kind: 'resolved',
            reason: 'Done',
            operationId: `resolve-${n}`,
          },
        }).success,
      ).toBe(true);
      const event =
        reopen === 'reply'
          ? {
              kind: 'reply' as const,
              body: 'More work',
              operationId: `reopen-${n}`,
            }
          : { kind: 'reopened' as const, operationId: `reopen-${n}` };
      expect(
        s.store.appendEvent({ ...WRITE, threadId: thread.threadId, event })
          .success,
      ).toBe(true);
      expect(
        s.store.appendEvent({
          ...WRITE,
          author: { kind: 'session', sessionId: 'lead' },
          threadId: thread.threadId,
          event: {
            kind: 'agent-reply',
            deliveryKey,
            body: 'Late',
            operationId: `late-${n}`,
          },
        }),
      ).toMatchObject({ success: false, code: 'invalid-transition' });
    }
  });
});

import { createHash } from 'node:crypto';
import { rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { PROJECT_TASK_ROOM_REVISION_PUBLICATION_MIGRATION } from '../../../domain/migrations/008-project-task-room-revision-publication.js';
import { ensureProjectTaskRoomRevisionAttributionColumn } from '../../../domain/migrations/009-project-task-room-revision-attribution.js';
import type { Logger } from '../../../utils/logger.js';
import { createProjectTaskRoomWorkingState } from '../project-task-room-working-state.js';

const { warnings } = vi.hoisted(() => ({ warnings: vi.fn<Logger['warn']>() }));
vi.mock('../../../utils/logger.js', () => ({
  createLogger: (): Pick<Logger, 'warn'> => ({ warn: warnings }),
}));

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as {
  DatabaseSync: new (
    path: string,
  ) => {
    prepare(sql: string): {
      run(...values: unknown[]): unknown;
      get(...values: unknown[]): unknown;
      all(...values: unknown[]): unknown[];
    };
    exec(sql: string): void;
    close(): void;
  };
};

const scope = { projectId: 'project', taskId: 'task', documentId: 'document' };
const makeTempDir = trackTempDirs();
let directory = '';
afterEach(() => {
  if (directory) rmSync(directory, { recursive: true, force: true });
  directory = '';
  warnings.mockReset();
});
const operation = (id: string, text: string) => ({
  schemaVersion: 1 as const,
  operationId: id,
  documentId: scope.documentId,
  replicaId: 'replica',
  actor: { actorId: 'operator', kind: 'human' as const },
  parents: [],
  authorizationEpoch: 1,
  kind: 'insert' as const,
  after: null,
  text,
});
async function finishPublication(
  working: ReturnType<typeof createProjectTaskRoomWorkingState>,
) {
  const read = await working.readRevisionPublication({ scope });
  if (read.kind !== 'available') throw new Error('expected publication');
  const evidenceRevision = `revision-evidence-v1:${createHash('sha256')
    .update(read.publication.intentId)
    .digest('hex')}`;
  expect(
    await working.markRevisionPublication({
      scope,
      intentId: read.publication.intentId,
      evidenceRevision,
    }),
  ).toBe('marked');
  expect(
    await working.removeRevisionPublication({
      scope,
      intentId: read.publication.intentId,
      evidenceRevision,
    }),
  ).toBe('removed');
  return { ...read.publication, evidenceRevision };
}

describe('project task room working state', () => {
  test('acknowledges only the exact persisted lifecycle intent and preserves it across restart', async () => {
    directory = makeTempDir('station-agent-outbox-');
    const path = join(directory, 'orchestration.sqlite');
    const first = createProjectTaskRoomWorkingState(path);
    const input = {
      scope,
      intentId: 'agent:started:session',
      value: {
        taskId: scope.taskId,
        sessionId: 'session',
        provider: 'codex',
        outcome: 'started',
        dispatchId: 'dispatch',
        occurredAt: '2026-09-05T00:00:00.000Z',
        authorizationReceiptId: 'authority',
      },
    };
    try {
      expect(await first.agentLifecycle(input)).toBe('stored');
      expect(await first.agentLifecycle(input)).toBe('stored');
      expect(warnings).not.toHaveBeenCalled();
      expect(
        await first.agentLifecycle({
          ...input,
          value: { ...input.value, sessionId: 'wrong-session' },
        }),
      ).toBe('unavailable');
      expect(warnings).toHaveBeenCalledWith(
        'Task room working state unavailable',
        {
          event: 'project-task-room-working-state-unavailable',
          operation: 'agent-lifecycle',
          reason: 'worker-unavailable-reply',
        },
      );
      expect(await first.readAgentLifecycles({ scope })).toEqual([
        { intentId: input.intentId, value: input.value },
      ]);
    } finally {
      await first.close();
    }
    const restarted = createProjectTaskRoomWorkingState(path);
    try {
      expect(await restarted.agentLifecycle(input)).toBe('stored');
      expect(await restarted.readAgentLifecycles({ scope })).toEqual([
        { intentId: input.intentId, value: input.value },
      ]);
    } finally {
      await restarted.close();
    }
  });

  test('migrates existing human publication rows explicitly and idempotently', () => {
    directory = makeTempDir('station-room-working-migrate-');
    const database = new DatabaseSync(join(directory, 'orchestration.sqlite'));
    database.exec(PROJECT_TASK_ROOM_REVISION_PUBLICATION_MIGRATION);
    database
      .prepare(
        `INSERT INTO project_task_room_revision_publication_outbox(
          project_id,task_id,document_id,intent_id,base_working_revision,
          working_revision,snapshot_json,snapshot_bytes,actor_id,actor_label,
          operator_id,device_id,policy_revision,correlation_json,
          parent_evidence_revision,evidence_revision,created_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        'project',
        'task',
        'document',
        'intent',
        'base',
        'working',
        '{}',
        2,
        'operator',
        null,
        'operator',
        'device',
        'policy',
        '{}',
        null,
        null,
        '2026-08-21T00:00:00.000Z',
      );
    ensureProjectTaskRoomRevisionAttributionColumn(database);
    ensureProjectTaskRoomRevisionAttributionColumn(database);
    expect(
      database
        .prepare(
          'SELECT actor_kind FROM project_task_room_revision_publication_outbox',
        )
        .get(),
    ).toEqual({ actor_kind: 'human' });
    database.close();
  });

  test('settles an owned nonresponsive worker and makes future requests fail closed', async () => {
    directory = makeTempDir('station-room-working-');
    const path = join(directory, 'orchestration.sqlite');
    const workerSourceUrl = new URL(
      'data:text/javascript,import { parentPort } from "node:worker_threads"; parentPort.on("message", () => {});',
    );
    const working = createProjectTaskRoomWorkingState(path, {
      workerSourceUrl,
      responseTimeoutMs: 50,
    });
    const pending = working.read({ scope });
    await expect(pending).resolves.toEqual({ kind: 'unavailable' });
    expect(warnings).toHaveBeenCalledWith(
      'Task room working state unavailable',
      {
        event: 'project-task-room-working-state-unavailable',
        operation: 'read',
        reason: 'response-deadline',
      },
    );
    await expect(working.read({ scope })).resolves.toEqual({
      kind: 'unavailable',
    });
    await expect(working.close()).resolves.toBeUndefined();
    await expect(working.close()).resolves.toBeUndefined();
  });

  test.each([
    [
      'worker-error',
      'throw new Error("worker failure with private database data");',
    ],
    ['worker-exit', 'process.exit(7);'],
    [
      'malformed-response',
      'import { parentPort } from "node:worker_threads"; parentPort.on("message", () => parentPort.postMessage({ malformed: true }));',
    ],
  ] as const)(
    'reports %s without exposing worker payload or changing refusal',
    async (reason, source) => {
      directory = makeTempDir('station-room-working-reason-');
      const working = createProjectTaskRoomWorkingState(
        join(directory, 'orchestration.sqlite'),
        {
          workerSourceUrl: new URL(
            `data:text/javascript,${encodeURIComponent(source)}`,
          ),
        },
      );
      try {
        await expect(working.read({ scope })).resolves.toEqual({
          kind: 'unavailable',
        });
        expect(warnings).toHaveBeenCalledWith(
          'Task room working state unavailable',
          {
            event: 'project-task-room-working-state-unavailable',
            operation: 'read',
            reason,
          },
        );
        expect(JSON.stringify(warnings.mock.calls)).not.toContain(
          'private database data',
        );
        await expect(working.read({ scope })).resolves.toEqual({
          kind: 'unavailable',
        });
      } finally {
        await working.close();
      }
    },
  );

  test('reports a real postMessage clone failure without serializing the request payload', async () => {
    directory = makeTempDir('station-room-working-clone-');
    const working = createProjectTaskRoomWorkingState(
      join(directory, 'orchestration.sqlite'),
    );
    try {
      await expect(
        working.agentLifecycle({
          scope,
          intentId: 'private-intent',
          value: () => 'private-payload',
        }),
      ).resolves.toBe('unavailable');
      expect(warnings).toHaveBeenCalledWith(
        'Task room working state unavailable',
        {
          event: 'project-task-room-working-state-unavailable',
          operation: 'agent-lifecycle',
          reason: 'post-message-failed',
        },
      );
      expect(JSON.stringify(warnings.mock.calls)).not.toContain('private-');
    } finally {
      await working.close();
    }
  });

  test('keeps the unavailable result and owned shutdown when the diagnostic sink fails', async () => {
    directory = makeTempDir('station-room-working-log-failure-');
    warnings.mockImplementation(() => {
      throw new Error('diagnostic sink failed');
    });
    const working = createProjectTaskRoomWorkingState(
      join(directory, 'orchestration.sqlite'),
      { workerSourceUrl: new URL('data:text/javascript,process.exit(7);') },
    );
    await expect(working.read({ scope })).resolves.toEqual({
      kind: 'unavailable',
    });
    await expect(working.close()).resolves.toBeUndefined();
  });

  test('persists an atomically settled batch, returns text-only projections, and detects duplicate/equivocation', async () => {
    directory = makeTempDir('station-room-working-');
    const path = join(directory, 'orchestration.sqlite');
    const first = createProjectTaskRoomWorkingState(path);
    expect(
      await first.settle({
        scope,
        intentId: 'intent',
        intentDigest: 'digest-a',
        actorId: 'operator',
        epoch: 1,
        operations: [operation('op', 'hello')],
      }),
    ).toMatchObject({ kind: 'committed', text: 'hello' });
    const publication = await first.readRevisionPublication({ scope });
    expect(publication).toMatchObject({
      kind: 'available',
      publication: {
        baseWorkingRevision: expect.any(String),
        workingRevision: expect.any(String),
        actorId: 'operator',
        correlation: { projectId: 'project', taskId: 'task' },
      },
    });
    expect(
      await first.settle({
        scope,
        intentId: 'intent',
        intentDigest: 'digest-a',
        actorId: 'operator',
        epoch: 1,
        operations: [operation('op', 'hello')],
      }),
    ).toMatchObject({ kind: 'duplicate', text: 'hello' });
    expect(
      await first.settle({
        scope,
        intentId: 'intent',
        intentDigest: 'digest-b',
        actorId: 'operator',
        epoch: 1,
        operations: [],
      }),
    ).toEqual({ kind: 'conflict' });
    expect(
      await first.receipt({
        scope,
        intentId: 'intent',
        intentDigest: 'digest-a',
      }),
    ).toMatchObject({ kind: 'duplicate', text: 'hello' });
    const read = await first.read({ scope });
    expect(read).toMatchObject({ kind: 'snapshot', text: 'hello' });
    expect(JSON.stringify(read)).not.toContain('atoms');
    await first.close();
    const reopened = createProjectTaskRoomWorkingState(path);
    expect(await reopened.read({ scope })).toMatchObject({
      kind: 'snapshot',
      text: 'hello',
    });
    await reopened.close();
  });

  test('serializes ordinary requests across the asynchronous pre-commit fence', async () => {
    directory = makeTempDir('station-room-working-');
    const path = join(directory, 'orchestration.sqlite');
    const working = createProjectTaskRoomWorkingState(path);
    let releaseCommit: ((allowed: boolean) => void) | undefined;
    const first = working.settle({
      scope,
      intentId: 'paused',
      intentDigest: 'paused-digest',
      actorId: 'operator',
      epoch: 1,
      operations: [operation('paused-operation', 'secret')],
      beforeCommit: () =>
        new Promise<boolean>((resolve) => {
          releaseCommit = resolve;
        }),
    });
    await expect
      .poll(() => Boolean(releaseCommit), { timeout: 1_000 })
      .toBe(true);

    let readSettled = false;
    const read = working.read({ scope }).then((value) => {
      readSettled = true;
      return value;
    });
    const concurrent = working.settle({
      scope,
      intentId: 'after-paused',
      intentDigest: 'after-paused-digest',
      actorId: 'operator',
      epoch: 1,
      operations: [operation('after-paused-operation', '!')],
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(readSettled).toBe(false);

    releaseCommit?.(true);
    await expect(first).resolves.toMatchObject({
      kind: 'committed',
      text: 'secret',
    });
    await expect(read).resolves.toMatchObject({
      kind: 'snapshot',
      text: 'secret',
    });
    await expect(concurrent).resolves.toMatchObject({
      kind: 'rejected',
      reason: 'revision-publication-pending',
    });
    await finishPublication(working);
    await expect(
      working.settle({
        scope,
        intentId: 'after-published',
        intentDigest: 'after-published-digest',
        actorId: 'operator',
        epoch: 1,
        operations: [operation('after-published-operation', '!')],
      }),
    ).resolves.toMatchObject({ kind: 'committed', text: '!secret' });
    await working.close();
  });

  test('rolls back a denied pre-commit batch without exposing its text', async () => {
    directory = makeTempDir('station-room-working-');
    const path = join(directory, 'orchestration.sqlite');
    const working = createProjectTaskRoomWorkingState(path);
    await expect(
      working.settle({
        scope,
        intentId: 'denied',
        intentDigest: 'denied-digest',
        actorId: 'operator',
        epoch: 1,
        operations: [operation('denied-operation', 'SECRET')],
        beforeCommit: async () => false,
      }),
    ).resolves.toEqual({ kind: 'rejected' });
    await expect(working.read({ scope })).resolves.toMatchObject({
      kind: 'snapshot',
      text: '',
    });
    await expect(working.readRevisionPublication({ scope })).resolves.toEqual({
      kind: 'missing',
    });
    await working.close();
  });

  test('retains the configured recent revision window across settlements and reports a gap beyond its floor', async () => {
    directory = makeTempDir('station-room-working-');
    const path = join(directory, 'orchestration.sqlite');
    const working = createProjectTaskRoomWorkingState(path, {
      maxRetainedOperations: 1,
    });
    const initial = await working.read({ scope });
    if (!initial.revision) throw new Error('expected initial revision');
    await working.settle({
      scope,
      intentId: 'first',
      intentDigest: 'first-digest',
      actorId: 'operator',
      epoch: 1,
      operations: [operation('first-operation', 'one')],
    });
    await finishPublication(working);
    const first = await working.read({ scope });
    if (!first.revision) throw new Error('expected first revision');
    await working.settle({
      scope,
      intentId: 'second',
      intentDigest: 'second-digest',
      actorId: 'operator',
      epoch: 1,
      operations: [operation('second-operation', 'two')],
    });
    await finishPublication(working);

    const second = await working.read({ scope });
    if (!second.revision) throw new Error('expected second revision');
    await working.settle({
      scope,
      intentId: 'third',
      intentDigest: 'third-digest',
      actorId: 'operator',
      epoch: 1,
      operations: [operation('third-operation', 'three')],
    });

    await expect(
      working.read({ scope, after: second.revision }),
    ).resolves.toMatchObject({
      kind: 'delta',
      text: 'onetwothree',
    });
    await expect(
      working.read({ scope, after: first.revision }),
    ).resolves.toMatchObject({
      kind: 'gap',
      text: 'onetwothree',
    });
    await expect(
      working.read({ scope, after: 'not-a-retained-revision' }),
    ).resolves.toMatchObject({
      kind: 'gap',
      text: 'onetwothree',
    });
    const retained = await working.read({ scope });
    const requested = [first.revision, second.revision, retained.revision!];
    const ordinals = await working.readRevisionOrdinals({
      scope,
      revision: retained.revision!,
      revisions: requested,
    });
    expect(ordinals).toEqual({
      kind: 'available',
      revisionOrdinals: {
        [first.revision]: 1,
        [second.revision]: 2,
        [retained.revision!]: 3,
      },
    });
    await working.close();
    const restarted = createProjectTaskRoomWorkingState(path, {
      maxRetainedOperations: 1,
    });
    try {
      expect(
        await restarted.readRevisionOrdinals({
          scope,
          revision: retained.revision!,
          revisions: requested,
        }),
      ).toEqual(ordinals);
    } finally {
      await restarted.close();
    }
  });

  test('numbers three saves once per committed batch, including multi-op saves and retries', async () => {
    directory = makeTempDir('station-room-saves-');
    const path = join(directory, 'orchestration.sqlite');
    const working = createProjectTaskRoomWorkingState(path, {
      maxRetainedOperations: 1,
    });
    const revisions: string[] = [];
    try {
      const denied = await working.settle({
        scope,
        intentId: 'denied-save',
        intentDigest: 'denied-digest',
        actorId: 'operator',
        epoch: 1,
        operations: [operation('denied-op', 'no')],
        beforeCommit: async () => false,
      });
      expect(denied.kind).toBe('rejected');
      for (let n = 1; n <= 3; n++) {
        const input = {
          scope,
          intentId: `save-${n}`,
          intentDigest: `digest-${n}`,
          actorId: 'operator',
          epoch: 1,
          operations: [
            operation(`save-${n}-a`, 'a'),
            operation(`save-${n}-b`, 'b'),
          ],
        };
        const saved = await working.settle(input);
        expect(saved.kind).toBe('committed');
        if (!saved.revision) throw new Error('expected save revision');
        revisions.push(saved.revision);
        expect(await working.settle(input)).toMatchObject({
          kind: 'duplicate',
          revision: saved.revision,
        });
        expect(
          await working.readRevisionOrdinals({
            scope,
            revision: saved.revision,
            revisions,
          }),
        ).toEqual({
          kind: 'available',
          revisionOrdinals: Object.fromEntries(
            revisions.map((revision, i) => [revision, i + 1]),
          ),
        });
        await finishPublication(working);
      }
    } finally {
      await working.close();
    }
    const restarted = createProjectTaskRoomWorkingState(path, {
      maxRetainedOperations: 1,
    });
    try {
      expect(
        await restarted.readRevisionOrdinals({
          scope,
          revision: revisions[2]!,
          revisions,
        }),
      ).toEqual({
        kind: 'available',
        revisionOrdinals: {
          [revisions[0]!]: 1,
          [revisions[1]!]: 2,
          [revisions[2]!]: 3,
        },
      });
      const db = new DatabaseSync(path);
      try {
        expect(
          db
            .prepare(
              'SELECT COUNT(*) AS count FROM project_task_room_save_revisions WHERE ordinal > 0',
            )
            .get(),
        ).toEqual({ count: 3 });
        expect(
          db
            .prepare(
              'SELECT COUNT(*) AS count FROM project_task_room_working_revisions',
            )
            .get(),
        ).toEqual({ count: 1 });
      } finally {
        db.close();
      }
    } finally {
      await restarted.close();
    }
  });

  test('isolates malformed legacy receipts and retries without inventing ordinals', async () => {
    directory = makeTempDir('station-room-bad-receipt-');
    const path = join(directory, 'orchestration.sqlite');
    const healthy = { ...scope, taskId: 'healthy' };
    const legacy = createProjectTaskRoomWorkingState(path);
    let healthyRevision = '';
    let healthyInitial = '';
    let badRevision = '';
    let badReceipt = '';
    try {
      for (const target of [scope, healthy]) {
        const before = await legacy.read({ scope: target });
        if (target === healthy && before.kind === 'snapshot') {
          if (!before.revision) throw new Error('missing initial revision');
          healthyInitial = before.revision;
        }
        const saved = await legacy.settle({
          scope: target,
          intentId: target.taskId,
          intentDigest: target.taskId,
          actorId: 'operator',
          epoch: 1,
          operations: [operation(target.taskId, 'a')],
          suppressRevisionPublicationForDiagnostic: true,
        });
        expect(saved.kind).toBe('committed');
        if (!saved.revision) throw new Error('missing revision');
        if (target === healthy) healthyRevision = saved.revision;
        else badRevision = saved.revision;
      }
    } finally {
      await legacy.close();
    }
    const db = new DatabaseSync(path);
    badReceipt = (
      db
        .prepare(
          'SELECT receipt_json FROM project_task_room_working_batches WHERE task_id=?',
        )
        .get(scope.taskId) as { receipt_json: string }
    ).receipt_json;
    db.exec('DROP TABLE project_task_room_save_revisions');
    db.prepare(
      'UPDATE project_task_room_working_batches SET receipt_json=? WHERE task_id=?',
    ).run('{}', scope.taskId);
    db.close();
    for (let restart = 0; restart < 2; restart++) {
      const upgraded = createProjectTaskRoomWorkingState(path);
      try {
        expect((await upgraded.read({ scope: healthy })).kind).toBe('snapshot');
        expect(
          await upgraded.readRevisionOrdinals({
            scope: healthy,
            revision: healthyRevision,
            revisions: [healthyInitial, healthyRevision],
          }),
        ).toEqual({
          kind: 'available',
          revisionOrdinals: { [healthyInitial]: 0, [healthyRevision]: 1 },
        });
        expect(
          await upgraded.readRevisionOrdinals({
            scope,
            revision: badRevision,
            revisions: [badRevision],
          }),
        ).toEqual({ kind: 'unavailable' });
      } finally {
        await upgraded.close();
      }
    }
    const pending = createProjectTaskRoomWorkingState(path);
    let nextRevision = '';
    try {
      const next = await pending.settle({
        scope,
        intentId: 'later',
        intentDigest: 'later',
        actorId: 'operator',
        epoch: 1,
        operations: [operation('later', 'b')],
        suppressRevisionPublicationForDiagnostic: true,
      });
      expect(next.kind).toBe('committed');
      if (!next.revision) throw new Error('missing later revision');
      nextRevision = next.revision;
      expect(
        await pending.readRevisionOrdinals({
          scope,
          revision: nextRevision,
          revisions: [badRevision, nextRevision],
        }),
      ).toEqual({ kind: 'unavailable' });
    } finally {
      await pending.close();
    }
    const repaired = new DatabaseSync(path);
    repaired
      .prepare(
        'UPDATE project_task_room_working_batches SET receipt_json=? WHERE task_id=? AND intent_id=?',
      )
      .run(badReceipt, scope.taskId, scope.taskId);
    repaired.close();
    const retried = createProjectTaskRoomWorkingState(path);
    try {
      expect(
        await retried.readRevisionOrdinals({
          scope,
          revision: nextRevision,
          revisions: [badRevision, nextRevision],
        }),
      ).toEqual({
        kind: 'available',
        revisionOrdinals: { [badRevision]: 1, [nextRevision]: 2 },
      });
    } finally {
      await retried.close();
    }
  });

  test('backfills v1 initial no-op and save identities independently of the current default', async () => {
    directory = makeTempDir('station-room-v1-upgrade-');
    const path = join(directory, 'orchestration.sqlite');
    const bootstrap = createProjectTaskRoomWorkingState(path);
    await bootstrap.read({ scope });
    await bootstrap.close();
    // Captured from the v1 writer before the v2 snapshot format was introduced.
    const initial =
      'swsr-v1:3937eaa33e2bf85608ae0fa9dc4198a899092007cd53cbf249be44f092365e76';
    const saved = {
      schemaVersion: 1,
      scope: { projectId: 'project', taskId: 'task', documentId: 'document' },
      checkpointRevision:
        'swsr-v1:c075998f086e3861c4063956f2899e76e94d4d7acf013b7f3402828b8759af69',
      revision:
        'swsr-v1:c075998f086e3861c4063956f2899e76e94d4d7acf013b7f3402828b8759af69',
      atoms: [
        { id: 'legacy-fixture:0', after: null, value: 'a', deleted: false },
      ],
      knownOperations: [
        {
          operationId: 'legacy-fixture',
          digest:
            '12f58990b50d505ed7cd619238fdd45a8ebde9e0816ad918fb987bcfad109def',
        },
      ],
      deferred: [],
    };
    const db = new DatabaseSync(path);
    try {
      db.exec('DROP TABLE project_task_room_save_revisions');
      db.prepare(
        'INSERT INTO project_task_room_working_states VALUES(?,?,?,?,?,?,?)',
      ).run(
        scope.projectId,
        scope.taskId,
        scope.documentId,
        JSON.stringify(saved),
        saved.revision,
        initial,
        '2026-01-01',
      );
      const insert = db.prepare(
        'INSERT INTO project_task_room_working_batches VALUES(?,?,?,?,?,?,?)',
      );
      insert.run(
        scope.projectId,
        scope.taskId,
        scope.documentId,
        'noop',
        'noop',
        JSON.stringify({ revision: initial, text: '' }),
        '2026-01-01',
      );
      insert.run(
        scope.projectId,
        scope.taskId,
        scope.documentId,
        'save',
        'save',
        JSON.stringify({ revision: saved.revision, text: 'a' }),
        '2026-01-01',
      );
    } finally {
      db.close();
    }
    for (let restart = 0; restart < 2; restart++) {
      const upgraded = createProjectTaskRoomWorkingState(path);
      try {
        expect(
          await upgraded.readRevisionOrdinals({
            scope,
            revision: saved.revision,
            revisions: [initial, saved.revision],
          }),
        ).toEqual({
          kind: 'available',
          revisionOrdinals: { [initial]: 0, [saved.revision]: 1 },
        });
      } finally {
        await upgraded.close();
      }
    }
  });

  test('backfills legacy save ordinals from final batch receipts after operation pruning', async () => {
    directory = makeTempDir('station-room-save-upgrade-');
    const path = join(directory, 'orchestration.sqlite');
    const legacy = createProjectTaskRoomWorkingState(path, {
      maxRetainedOperations: 1,
    });
    const revisions: string[] = [];
    try {
      for (let n = 1; n <= 3; n++) {
        const saved = await legacy.settle({
          scope,
          intentId: `legacy-${n}`,
          intentDigest: `legacy-digest-${n}`,
          actorId: 'operator',
          epoch: 1,
          operations: [
            operation(`legacy-${n}-a`, 'a'),
            operation(`legacy-${n}-b`, 'b'),
          ],
        });
        expect(saved.kind).toBe('committed');
        if (!saved.revision) throw new Error('expected save revision');
        revisions.push(saved.revision);
        await finishPublication(legacy);
      }
    } finally {
      await legacy.close();
    }
    // Model the pre-upgrade schema, retaining the real worker's batch receipts.
    const db = new DatabaseSync(path);
    try {
      db.exec('DROP TABLE project_task_room_save_revisions');
    } finally {
      db.close();
    }
    const upgraded = createProjectTaskRoomWorkingState(path, {
      maxRetainedOperations: 1,
    });
    try {
      expect(
        await upgraded.readRevisionOrdinals({
          scope,
          revision: revisions[2]!,
          revisions,
        }),
      ).toEqual({
        kind: 'available',
        revisionOrdinals: {
          [revisions[0]!]: 1,
          [revisions[1]!]: 2,
          [revisions[2]!]: 3,
        },
      });
      const fourth = await upgraded.settle({
        scope,
        intentId: 'upgraded-fourth',
        intentDigest: 'upgraded-fourth',
        actorId: 'operator',
        epoch: 1,
        operations: [
          operation('upgraded-fourth-a', 'a'),
          operation('upgraded-fourth-b', 'b'),
        ],
      });
      expect(fourth.kind).toBe('committed');
      if (!fourth.revision) throw new Error('expected save revision');
      expect(
        await upgraded.readRevisionOrdinals({
          scope,
          revision: fourth.revision,
          revisions: [fourth.revision],
        }),
      ).toEqual({
        kind: 'available',
        revisionOrdinals: { [fourth.revision]: 4 },
      });
    } finally {
      await upgraded.close();
    }
  });

  test('observes a committed change from a second worker only while watched', async () => {
    directory = makeTempDir('station-room-working-');
    const path = join(directory, 'orchestration.sqlite');
    const first = createProjectTaskRoomWorkingState(path);
    const second = createProjectTaskRoomWorkingState(path);
    let resolveChanged: (() => void) | undefined;
    const changed = new Promise<void>((resolve) => {
      resolveChanged = resolve;
    });
    const unwatch = first.watch(() => resolveChanged?.());
    await second.settle({
      scope,
      intentId: 'second-worker',
      intentDigest: 'second-digest',
      actorId: 'operator',
      epoch: 1,
      operations: [operation('second-op', 'from second process')],
    });
    await expect(
      Promise.race([
        changed,
        new Promise<void>((_, reject) =>
          setTimeout(
            () => reject(new Error('data_version did not wake')),
            2_000,
          ),
        ),
      ]),
    ).resolves.toBeUndefined();
    unwatch();
    await first.close();
    await second.close();
  });

  test('persists a bounded publication outbox and advances the exact evidence parent across restart', async () => {
    directory = makeTempDir('station-room-working-');
    const path = join(directory, 'orchestration.sqlite');
    const first = createProjectTaskRoomWorkingState(path);
    await first.settle({
      scope,
      intentId: 'parent-one',
      intentDigest: 'parent-one-digest',
      actorId: 'operator',
      actorLabel: 'Original operator',
      epoch: 1,
      operations: [operation('parent-one-operation', 'one')],
    });
    const firstPublication = await finishPublication(first);
    await first.settle({
      scope,
      intentId: 'parent-two',
      intentDigest: 'parent-two-digest',
      actorId: 'operator',
      actorLabel: 'Second operator',
      epoch: 1,
      operations: [operation('parent-two-operation', 'two')],
    });
    await expect(
      first.readRevisionPublication({ scope }),
    ).resolves.toMatchObject({
      kind: 'available',
      publication: {
        parentEvidenceRevision: firstPublication.evidenceRevision,
        actorId: 'operator',
        actorLabel: 'Second operator',
      },
    });
    await first.close();

    const reopened = createProjectTaskRoomWorkingState(path);
    await expect(
      reopened.readRevisionPublication({ scope }),
    ).resolves.toMatchObject({
      kind: 'available',
      publication: {
        parentEvidenceRevision: firstPublication.evidenceRevision,
        actorId: 'operator',
      },
    });
    await reopened.close();
  });

  test('fails a tampered oversized publication closed before JSON materialization', async () => {
    directory = makeTempDir('station-room-working-');
    const path = join(directory, 'orchestration.sqlite');
    const working = createProjectTaskRoomWorkingState(path);
    await working.settle({
      scope,
      intentId: 'bounded',
      intentDigest: 'bounded-digest',
      actorId: 'operator',
      epoch: 1,
      operations: [operation('bounded-operation', 'safe')],
    });
    await working.close();
    const database = new DatabaseSync(path);
    database
      .prepare(
        'UPDATE project_task_room_revision_publication_outbox SET snapshot_json=?, snapshot_bytes=?',
      )
      .run('x'.repeat(512 * 1024 + 1), 512 * 1024);
    database.close();
    const reopened = createProjectTaskRoomWorkingState(path);
    await expect(reopened.readRevisionPublication({ scope })).resolves.toEqual({
      kind: 'unavailable',
    });
    await reopened.close();
  });
});

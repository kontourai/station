import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { PROJECT_TASK_ROOM_REVISION_PUBLICATION_MIGRATION } from '../../../domain/migrations/008-project-task-room-revision-publication.js';
import { ensureProjectTaskRoomRevisionAttributionColumn } from '../../../domain/migrations/009-project-task-room-revision-attribution.js';
import { createProjectTaskRoomWorkingState } from '../project-task-room-working-state.js';

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
let directory = '';
afterEach(() => {
  if (directory) rmSync(directory, { recursive: true, force: true });
  directory = '';
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
  test('migrates existing human publication rows explicitly and idempotently', () => {
    directory = mkdtempSync(join(tmpdir(), 'station-room-working-migrate-'));
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
    directory = mkdtempSync(join(tmpdir(), 'station-room-working-'));
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
    await expect(working.read({ scope })).resolves.toEqual({
      kind: 'unavailable',
    });
    await expect(working.close()).resolves.toBeUndefined();
    await expect(working.close()).resolves.toBeUndefined();
  });

  test('persists an atomically settled batch, returns text-only projections, and detects duplicate/equivocation', async () => {
    directory = mkdtempSync(join(tmpdir(), 'station-room-working-'));
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
    directory = mkdtempSync(join(tmpdir(), 'station-room-working-'));
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
    directory = mkdtempSync(join(tmpdir(), 'station-room-working-'));
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
    directory = mkdtempSync(join(tmpdir(), 'station-room-working-'));
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
    await working.close();
  });

  test('observes a committed change from a second worker only while watched', async () => {
    directory = mkdtempSync(join(tmpdir(), 'station-room-working-'));
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
    directory = mkdtempSync(join(tmpdir(), 'station-room-working-'));
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
    directory = mkdtempSync(join(tmpdir(), 'station-room-working-'));
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

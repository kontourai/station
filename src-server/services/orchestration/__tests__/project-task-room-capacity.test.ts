/**
 * #4007 / #4008 at the room seam: the real `ProjectTaskRoomRuntime`, the real
 * SQLite working-state worker and the production revision-evidence bridge.
 * Every person edit goes through the browser's path (edit-plan, then batch),
 * and every document read goes back through `runtime.document`.
 */
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { TaskRecord } from '@kontourai/station-contracts/task-graph';
import { afterEach, describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import {
  SHARED_WORKING_STATE_SCHEMA_VERSION,
  type TextDocumentOperation,
} from '../../../domain/shared-working-state.js';
import { sharedWorkingStateEditBatchDigest } from '../../../domain/shared-working-state-editing.js';
import { EnvironmentSecurityService } from '../../ssh/environment-security-service.js';
import { EventStore } from '../event-store.js';
import { projectTaskRoomDocumentId } from '../project-task-room-document-id.js';
import {
  ProjectTaskRoomRevisionEvidenceBridge,
  type ProjectTaskRoomRevisionEvidencePort,
} from '../project-task-room-revision-evidence-bridge.js';
import { ProjectTaskRoomRuntime } from '../project-task-room-runtime.js';

const makeTempDir = trackTempDirs();

const closers: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
});

async function setup() {
  const directory = makeTempDir('station-room-capacity-');
  const store = new EventStore(join(directory, 'orchestration.sqlite'));
  const security = new EnvironmentSecurityService({ homeDir: directory });
  await security.initialize();
  const revisionEvidence = new ProjectTaskRoomRevisionEvidenceBridge({
    eventStore: store,
    security,
  });
  const task = {
    id: 'task-1',
    projectId: 'project-1',
    title: 'Room task',
    description: '',
    priority: 'normal',
    status: 'in_progress',
    createdBy: 'owner-1',
    createdAt: '2026-08-20T00:00:00.000Z',
    updatedAt: '2026-08-20T00:00:00.000Z',
  } as TaskRecord;
  const backing = store.createProjectTaskRoomWorkingState();
  const settled: TextDocumentOperation[][] = [];
  const runtime = new ProjectTaskRoomRuntime({
    taskGraph: { readTaskView: (id) => (id === task.id ? task : null) },
    projectForId: (id) =>
      id === task.projectId ? { id, slug: 'project' } : undefined,
    history: (authority) =>
      store.createProjectTaskRoomHistory({
        capabilities: authority.capabilities,
        agents: authority.agents,
        ...(authority.links ? { links: authority.links } : {}),
      }),
    revisionEvidence,
    working: {
      ...backing,
      settle: async (input) => {
        settled.push([...input.operations]);
        return backing.settle(input);
      },
    },
    requestAuthority: {
      resolve: async () => ({
        kind: 'granted' as const,
        operatorId: 'owner-1',
        deviceId: 'device-1',
        policyRevision: 'pairing-v1',
      }),
    },
  });
  closers.push(() => {
    store.close();
  });
  closers.push(async () => {
    await runtime.close();
  });
  const request = new Request('http://station');
  await runtime.discover({ taskId: task.id, request });
  const scope = {
    projectId: task.projectId,
    taskId: task.id,
    documentId: projectTaskRoomDocumentId({
      projectId: task.projectId,
      taskId: task.id,
    }),
  };
  const text = async () => {
    const document = await runtime.document({ taskId: task.id, request });
    if (document.kind !== 'snapshot')
      throw new Error(`document was ${document.kind}`);
    return document.text as string;
  };
  /** Plans against the current document; the returned call submits it. */
  const plan = async (desiredText: string) => {
    const planned = await runtime.editPlan({
      taskId: task.id,
      request,
      intentId: randomUUID(),
      desiredText,
      selection: { anchor: 0, focus: 0 },
    });
    if (planned.kind !== 'planned') throw new Error(`plan was ${planned.kind}`);
    return () =>
      runtime.submitBatch({
        taskId: task.id,
        request,
        intentId: planned.intentId,
        intentDigest: planned.digest,
      });
  };
  const edit = async (desiredText: string) => (await plan(desiredText))();
  /** Deleted atoms across every batch settled from index `from` on. */
  const deletedSince = (from: number) =>
    settled
      .slice(from)
      .flat()
      .reduce(
        (total, operation) =>
          total + (operation.kind === 'delete' ? operation.target.length : 0),
        0,
      );
  /**
   * A room as the planner wrote it before #4008: one insert whose identity is
   * a random UUID, so it sorts above every id the fixed runtime mints.
   */
  const seedLegacy = async (legacyText: string) => {
    const intentId = randomUUID();
    const operations: TextDocumentOperation[] = [
      {
        schemaVersion: SHARED_WORKING_STATE_SCHEMA_VERSION,
        operationId: `${intentId}:insert`,
        documentId: scope.documentId,
        replicaId: 'room:device-1',
        actor: { actorId: 'legacy-person', kind: 'human' },
        parents: [],
        authorizationEpoch: 0,
        kind: 'insert',
        after: null,
        text: legacyText,
      },
    ];
    expect(
      await backing.settle({
        scope,
        intentId,
        intentDigest: sharedWorkingStateEditBatchDigest({
          intentId,
          scope,
          operations,
        }),
        actorId: 'legacy-person',
        epoch: 0,
        operations,
        suppressRevisionPublicationForDiagnostic: true,
      }),
    ).toMatchObject({ kind: 'committed' });
  };
  return {
    runtime,
    text,
    plan,
    edit,
    settled,
    deletedSince,
    seedLegacy,
    backing,
    scope,
  };
}

type Room = Awaited<ReturnType<typeof setup>>;

/** Upper-cases one character at `offset`: a one-atom delete plus insert. */
const upperAt = (value: string, offset: number) =>
  value.slice(0, offset) +
  value.charAt(offset).toUpperCase() +
  value.slice(offset + 1);

async function eightMidDocumentEdits(room: Room) {
  let expected = await room.text();
  const from = room.settled.length;
  for (let index = 0; index < 8; index += 1) {
    expected = upperAt(expected, 10 + index * 7);
    expect(await room.edit(expected)).toMatchObject({ kind: 'committed' });
  }
  expect(await room.text()).toBe(expected);
  return room.deletedSince(from);
}

const BRIEF =
  'the quick brown fox jumps over the lazy dog and keeps running far away. ';

describe('#4008 a mid-document edit never rewrites the rest of the document', () => {
  test('eight mid-document person edits delete exactly 8 atoms in a room this runtime wrote', async () => {
    const room = await setup();
    expect(await room.edit(BRIEF.repeat(3))).toMatchObject({
      kind: 'committed',
    });
    expect(await eightMidDocumentEdits(room)).toBe(8);
  });

  test('eight mid-document person edits delete exactly 8 atoms in a room written with UUID edit ids', async () => {
    const room = await setup();
    await room.seedLegacy(BRIEF.repeat(3));
    expect(await eightMidDocumentEdits(room)).toBe(8);
  });

  test('two writers planning against the same text both land mid-document without rewriting it', async () => {
    const room = await setup();
    const base = BRIEF.repeat(2);
    expect(await room.edit(base)).toMatchObject({ kind: 'committed' });
    const from = room.settled.length;
    const first = await room.plan(`${base.slice(0, 20)}[A]${base.slice(20)}`);
    const second = await room.plan(`${base.slice(0, 40)}[B]${base.slice(40)}`);
    expect(await first()).toMatchObject({ kind: 'committed' });
    expect(await second()).toMatchObject({ kind: 'committed' });
    expect(await room.text()).toBe(
      `${base.slice(0, 20)}[A]${base.slice(20, 40)}[B]${base.slice(40)}`,
    );
    expect(room.deletedSince(from)).toBe(0);
  });
});

describe('#4007 a Task document refuses what it cannot hold, explicitly and up front', () => {
  test('seeds a 12,000-character brief with linked evidence (#4007 run capacity)', async () => {
    const room = await setup();
    const brief = 'a'.repeat(12_000);
    expect(await room.edit(brief)).toMatchObject({
      kind: 'committed',
      revisionEvidence: { kind: 'linked' },
    });
    expect(await room.text()).toBe(brief);
  });

  test('refuses an over-bound write at the worker and the following writes still link evidence', async () => {
    const room = await setup();
    // Fill document metadata through the real worker without charging #4055's
    // unchanged global ledger for these diagnostic workload saves.
    for (let batch = 0; batch < 110; batch += 1) {
      const operations: TextDocumentOperation[] = [];
      for (let index = 0; index < 10; index += 1) {
        const id = randomUUID();
        const common = {
          schemaVersion: 1,
          documentId: room.scope.documentId,
          replicaId: 'replica',
          actor: { actorId: 'owner-1', kind: 'human' as const },
          parents: [],
          authorizationEpoch: 0,
        };
        operations.push({
          ...common,
          kind: 'insert',
          operationId: id,
          after: null,
          text: 'deleted',
        });
        operations.push({
          ...common,
          kind: 'delete',
          operationId: randomUUID(),
          target: Array.from({ length: 7 }, (_, i) => `${id}:${i}`),
        });
      }
      expect(
        await room.backing.settle({
          scope: room.scope,
          intentId: `fill-${batch}`,
          intentDigest: `fill-${batch}`,
          actorId: 'owner-1',
          epoch: 0,
          operations,
          suppressRevisionPublicationForDiagnostic: true,
        }),
      ).toMatchObject({ kind: 'committed' });
    }
    expect(await room.edit('x'.repeat(120_000))).toEqual({
      kind: 'rejected',
      reason: 'document-full',
    });
    expect(await room.text()).toBe('');
    expect(
      await room.backing.readRevisionPublication({ scope: room.scope }),
    ).toEqual({ kind: 'missing' });
    for (const text of ['xy', 'x']) {
      expect(await room.edit(text)).toMatchObject({
        kind: 'committed',
        revisionEvidence: { kind: 'linked' },
      });
      expect(await room.text()).toBe(text);
      expect(
        await room.backing.readRevisionPublication({ scope: room.scope }),
      ).toEqual({ kind: 'missing' });
    }
  }, 300_000);

  test('when the Station-wide evidence ledger is full every write is refused as evidence-ledger-full, never left pending', async () => {
    const room = await setup();
    // Full snapshots still charge the unchanged 4 MiB ledger on every save.
    let current = 'd'.repeat(120_000);
    let refused: unknown;
    let committed = 0;
    for (let index = 0; index < 20; index += 1) {
      const result = await room.edit(current);
      if (result.kind !== 'committed') {
        refused = result;
        break;
      }
      committed += 1;
      expect(result).toMatchObject({ revisionEvidence: { kind: 'linked' } });
      current = `${current}e`;
    }
    expect(committed).toBeGreaterThan(1);
    expect(refused).toEqual({
      kind: 'rejected',
      reason: 'evidence-ledger-full',
    });
    const stored = await room.text();
    expect(current).toBe(`${stored}e`);
    // Still explicit on the next writes, a deletion included: nothing pends.
    expect(await room.edit(current)).toEqual({
      kind: 'rejected',
      reason: 'evidence-ledger-full',
    });
    expect(await room.edit(stored.slice(1))).toEqual({
      kind: 'rejected',
      reason: 'evidence-ledger-full',
    });
    expect(await room.text()).toBe(stored);
  }, 300_000);
});

/**
 * Several Tasks' rooms over one store, with revision evidence that can be
 * switched off, so a publication stays admitted but not yet frozen.
 */
async function setupRooms(taskIds: readonly string[]) {
  const directory = makeTempDir('station-room-reservation-');
  const databasePath = join(directory, 'orchestration.sqlite');
  const store = new EventStore(databasePath);
  const security = new EnvironmentSecurityService({ homeDir: directory });
  await security.initialize();
  const bridge = new ProjectTaskRoomRevisionEvidenceBridge({
    eventStore: store,
    security,
  });
  let evidenceDown = false;
  const revisionEvidence: ProjectTaskRoomRevisionEvidencePort = {
    available: () => !evidenceDown && bridge.available(),
    recordPublication: (publication) =>
      evidenceDown
        ? { kind: 'unavailable' }
        : bridge.recordPublication(publication),
    links: bridge.links,
    close: () => bridge.close(),
    matchesCommittedRevision: (input) => bridge.matchesCommittedRevision(input),
  };
  const tasks = new Map(
    taskIds.map((id) => [
      id,
      {
        id,
        projectId: 'project-1',
        title: id,
        description: '',
        priority: 'normal',
        status: 'in_progress',
        createdBy: 'owner-1',
        createdAt: '2026-08-20T00:00:00.000Z',
        updatedAt: '2026-08-20T00:00:00.000Z',
      } as TaskRecord,
    ]),
  );
  const runtime = new ProjectTaskRoomRuntime({
    taskGraph: { readTaskView: (id) => tasks.get(id) ?? null },
    projectForId: (id) =>
      id === 'project-1' ? { id, slug: 'project' } : undefined,
    history: (authority) =>
      store.createProjectTaskRoomHistory({
        capabilities: authority.capabilities,
        agents: authority.agents,
        ...(authority.links ? { links: authority.links } : {}),
      }),
    revisionEvidence,
    working: store.createProjectTaskRoomWorkingState(),
    requestAuthority: {
      resolve: async () => ({
        kind: 'granted' as const,
        operatorId: 'owner-1',
        deviceId: 'device-1',
        policyRevision: 'pairing-v1',
      }),
    },
  });
  closers.push(() => {
    store.close();
  });
  closers.push(async () => {
    await runtime.close();
  });
  const request = new Request('http://station');
  for (const taskId of taskIds) await runtime.discover({ taskId, request });
  const edit = async (taskId: string, desiredText: string) => {
    const planned = await runtime.editPlan({
      taskId,
      request,
      intentId: randomUUID(),
      desiredText,
      selection: { anchor: 0, focus: 0 },
    });
    if (planned.kind !== 'planned') throw new Error(`plan was ${planned.kind}`);
    return runtime.submitBatch({
      taskId,
      request,
      intentId: planned.intentId,
      intentDigest: planned.digest,
    });
  };
  /** Bytes the 4 MiB portable ledger still has room for. */
  const ledgerRemaining = () => {
    const db = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const row = db
        .prepare(
          'SELECT COUNT(*) AS c, COALESCE(SUM(record_bytes), 0) AS b FROM revision_evidence_receipts',
        )
        .get() as { c: number; b: number };
      return 4 * 1024 * 1024 - (32 + row.b + row.c + 2);
    } finally {
      db.close();
    }
  };
  return {
    runtime,
    request,
    edit,
    ledgerRemaining,
    setEvidenceDown: (down: boolean) => {
      evidenceDown = down;
    },
  };
}

describe('#4007 the ledger reserves room for revisions admitted but not yet recorded', () => {
  test('while evidence recording is down, a second room is refused instead of being admitted into a wedge', async () => {
    const rooms = await setupRooms(['filler', 'room-b', 'room-c']);
    // Fill the shared ledger until between 300 KB and 800 KB remain.
    let filler = 'f'.repeat(120_000);
    while (rooms.ledgerRemaining() > 800_000) {
      expect(await rooms.edit('filler', filler)).toMatchObject({
        kind: 'committed',
        revisionEvidence: { kind: 'linked' },
      });
      filler += 'g';
    }
    const remaining = rooms.ledgerRemaining();
    expect(remaining).toBeGreaterThan(300_000);
    // Each of B and C alone fits; both together do not (about 0.6 each).
    const size = Math.floor((0.6 * remaining - 28_000) / 2);
    rooms.setEvidenceDown(true);
    expect(await rooms.edit('room-b', 'b'.repeat(size))).toMatchObject({
      kind: 'committed',
      revisionEvidence: { kind: 'unavailable' },
    });
    // B's revision is admitted but not recorded; its reservation counts.
    expect(await rooms.edit('room-c', 'c'.repeat(size))).toEqual({
      kind: 'rejected',
      reason: 'evidence-ledger-full',
    });
    rooms.setEvidenceDown(false);
    // B's publication drains into the ledger it was reserved in.
    await rooms.runtime.discover({ taskId: 'room-b', request: rooms.request });
    expect(rooms.ledgerRemaining()).toBeLessThan(remaining);
    // C is still refused explicitly, never left pending.
    expect(await rooms.edit('room-c', 'c'.repeat(size))).toEqual({
      kind: 'rejected',
      reason: 'evidence-ledger-full',
    });
  }, 300_000);
});

/**
 * #4007 / #4008 at the room seam: the real `ProjectTaskRoomRuntime`, the real
 * SQLite working-state worker and the production revision-evidence bridge.
 * Every person edit goes through the browser's path (edit-plan, then batch),
 * and every document read goes back through `runtime.document`.
 */
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
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
import { ProjectTaskRoomRevisionEvidenceBridge } from '../project-task-room-revision-evidence-bridge.js';
import { ProjectTaskRoomRuntime } from '../project-task-room-runtime.js';

const makeTempDir = trackTempDirs();

/**
 * Measured (#4007): the longest plain-ASCII text one person edit can seed in
 * an empty room of this test's Project/Task, which is the room's capacity in
 * characters ever typed. Before #4007 it was 3,627 (UUID edit ids, about 140 bytes per character).
 */
const SEED_CAPACITY = 5_479;

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
  return { runtime, text, plan, edit, settled, deletedSince, seedLegacy };
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
  test(`an empty room seeds ${SEED_CAPACITY} characters with linked evidence and refuses one more`, async () => {
    const over = await setup();
    expect(await over.edit('a'.repeat(SEED_CAPACITY + 1))).toEqual({
      kind: 'rejected',
      reason: 'document-full',
    });
    expect(await over.text()).toBe('');
    const room = await setup();
    expect(await room.edit('a'.repeat(SEED_CAPACITY))).toMatchObject({
      kind: 'committed',
      revisionEvidence: { kind: 'linked' },
    });
  }, 120_000);

  test("a full room refuses more text, still accepts a person's deletion, and never waits on a pending publication", async () => {
    const room = await setup();
    const full = 'b'.repeat(SEED_CAPACITY);
    expect(await room.edit(full)).toMatchObject({
      kind: 'committed',
      revisionEvidence: { kind: 'linked' },
    });
    // Fill whatever insert headroom remains with halving chunks, until one
    // character is refused. Refusals are deterministic and write nothing.
    let filled = full;
    for (let chunk = 256; chunk >= 1; chunk = Math.floor(chunk / 2)) {
      const result = await room.edit(filled + 'c'.repeat(chunk));
      if (result.kind === 'committed') filled += 'c'.repeat(chunk);
      else
        expect(result).toEqual({ kind: 'rejected', reason: 'document-full' });
    }
    expect(await room.edit(`${filled}c`)).toEqual({
      kind: 'rejected',
      reason: 'document-full',
    });
    expect(await room.text()).toBe(filled);
    // Pure deletions add no atoms; each costs one known-operation entry. Two
    // of them exceed any slack the fill left, so only the reserve admits them.
    let trimmed = filled;
    for (const at of [100, 200]) {
      trimmed = trimmed.slice(0, at) + trimmed.slice(at + 10);
      expect(await room.edit(trimmed)).toMatchObject({
        kind: 'committed',
        revisionEvidence: { kind: 'linked' },
      });
    }
    expect(await room.text()).toBe(trimmed);
    expect(await room.edit(`${trimmed}c`)).toEqual({
      kind: 'rejected',
      reason: 'document-full',
    });
  }, 120_000);

  test('when the Station-wide evidence ledger is full every write is refused as evidence-ledger-full, never left pending', async () => {
    const room = await setup();
    // About 370 KB per revision record: the 4 MiB ledger holds about eleven.
    let current = 'd'.repeat(4_000);
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

import { createHash } from 'node:crypto';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
  ProjectTaskRoomGrant,
  ProjectTaskRoomGrantKind,
} from '@kontourai/station-contracts/project-task-room';
import { afterEach, expect, test } from 'vitest';
import { EventStore } from '../event-store.js';
import {
  createLocalProjectTaskRoomTransferOwners,
  createPlannedHomeTransferCoordinator,
} from '../planned-home-transfer-coordinator.js';
import {
  createSqlitePlannedHomeTransferStore,
  type PlannedHomeTransferStore,
} from '../planned-home-transfer-store.js';
import type { ProjectTaskRoomCapabilityAuthority } from '../project-task-room-history.js';

const roots: string[] = [];
const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) {
    try {
      database.close();
    } catch {}
  }
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

const scope = {
  projectId: 'transfer-project',
  projectSlug: 'transfer-project',
  taskId: 'transfer-task',
};
const channelId = `project-task:${createHash('sha256')
  .update(`${scope.projectId}\u0000${scope.taskId}`)
  .digest('hex')}`;
const tenantId = 'controller:transfer-test';
const sourceHomeRef = 'paired:source';
const targetHomeRef = 'paired:target';
const operationId = 'transfer-operation';
const owner = {
  tenantId,
  channelId,
  homeRef: sourceHomeRef,
  policyRevision: 'policy-1',
  revision: 0,
};
const intent = {
  tenantId,
  channelId,
  operationId,
  sourceHomeRef,
  targetHomeRef,
  policyRevision: owner.policyRevision,
  expectedRevision: 0,
};

function grant<K extends ProjectTaskRoomGrantKind>(
  capability: K,
  opaqueToken = 'valid',
): ProjectTaskRoomGrant<K> {
  return Object.freeze({
    schemaVersion: 'station.project-task-room-grant/v1',
    capability,
    opaqueToken,
  }) as ProjectTaskRoomGrant<K>;
}

function authority(revoked = () => false): ProjectTaskRoomCapabilityAuthority {
  return {
    async resolve({ grant: presented, required }) {
      if (
        revoked() ||
        presented.opaqueToken !== 'valid' ||
        presented.capability !== required
      )
        return { kind: 'denied' };
      return {
        kind: 'granted',
        receipt: {
          receiptId: `receipt-${required}`,
          capability: required,
          scope,
          principal: {
            kind: 'operator',
            operatorId: 'transfer-operator',
            deviceId: 'transfer-device',
          },
          policyRevision: owner.policyRevision,
        },
      };
    },
  };
}

function rootPath(): string {
  const root = mkdtempSync(join(tmpdir(), 'station-transfer-coordinator-'));
  roots.push(root);
  return root;
}

function decisionStore(root: string): PlannedHomeTransferStore {
  const database = new DatabaseSync(join(root, 'controller.sqlite'));
  databases.push(database);
  database.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL');
  const store = createSqlitePlannedHomeTransferStore(database);
  expect(store.initialize(owner)).toMatchObject({ kind: 'stored' });
  expect(store.prepare(intent)).toMatchObject({
    kind: 'stored',
    value: { phase: 'prepared' },
  });
  return store;
}

function room(path: string, capabilities = authority()) {
  const events = new EventStore(path);
  const history = events.createProjectTaskRoomHistory({ capabilities });
  return { events, history };
}

function coordinator(
  store: PlannedHomeTransferStore,
  source: ReturnType<typeof room>['history'],
  target: ReturnType<typeof room>['history'],
) {
  return createPlannedHomeTransferCoordinator({
    store,
    tenantId,
    ...createLocalProjectTaskRoomTransferOwners({
      source: { history: source, grant: grant('home-transfer') },
      target: { history: target, grant: grant('history-read') },
    }),
  });
}

const message = (proposalId: string) => ({
  grant: grant('message-write'),
  intent: {
    proposalId,
    occurredAt: '2026-09-05T00:00:00.000Z',
    body: { kind: 'human-message' as const, text: proposalId },
  },
});

test('seals the real source, waits for a real restored target, then commits without granting execution', async () => {
  const root = rootPath();
  const sourcePath = join(root, 'source.sqlite');
  const targetPath = join(root, 'target.sqlite');
  const store = decisionStore(root);
  const source = room(sourcePath);
  const unavailableTarget = room(targetPath);
  await source.history.open({ grant: grant('discover') });
  await unavailableTarget.history.open({ grant: grant('discover') });
  expect(await source.history.append(message('before-transfer'))).toMatchObject(
    {
      kind: 'committed',
    },
  );

  const first = await coordinator(
    store,
    source.history,
    unavailableTarget.history,
  ).advance(operationId);
  expect(first).toMatchObject({
    kind: 'pending',
    reason: 'target-unavailable',
    decision: { phase: 'source-closed' },
    executionAuthorityTransferred: false,
    executionResumeAvailable: false,
  });
  expect(await source.history.append(message('source-remains-frozen'))).toEqual(
    {
      kind: 'denied',
    },
  );

  await source.history.close();
  await unavailableTarget.history.close();
  expect(source.events.close()).toEqual({ kind: 'closed' });
  expect(unavailableTarget.events.close()).toEqual({ kind: 'closed' });
  copyFileSync(sourcePath, targetPath);

  const restoredSource = room(sourcePath);
  const restoredTarget = room(targetPath);
  const committed = await coordinator(
    store,
    restoredSource.history,
    restoredTarget.history,
  ).advance(operationId);
  expect(committed).toMatchObject({
    kind: 'decision-committed',
    decision: { phase: 'committed', committedRevision: 1 },
    executionAuthorityTransferred: false,
    executionResumeAvailable: false,
  });
  expect(
    await restoredSource.history.append(message('source-after-decision')),
  ).toEqual({ kind: 'denied' });
  expect(
    await restoredTarget.history.append(message('target-after-decision')),
  ).toEqual({ kind: 'denied' });
  await restoredSource.history.close();
  await restoredTarget.history.close();
  expect(restoredSource.events.close()).toEqual({ kind: 'closed' });
  expect(restoredTarget.events.close()).toEqual({ kind: 'closed' });
});

test('recovers a lost commit response by resolving the committed decision', async () => {
  const root = rootPath();
  const sourcePath = join(root, 'source.sqlite');
  const targetPath = join(root, 'target.sqlite');
  const durable = decisionStore(root);
  const source = room(sourcePath);
  await source.history.open({ grant: grant('discover') });
  await source.history.append(message('response-loss'));
  const sealed = await source.history.sealSource({
    grant: grant('home-transfer'),
    operationId,
    sourceHomeRef,
    targetHomeRef,
  });
  expect(sealed.kind).toBe('sealed');
  await source.history.close();
  expect(source.events.close()).toEqual({ kind: 'closed' });
  copyFileSync(sourcePath, targetPath);
  const sourceAgain = room(sourcePath);
  const target = room(targetPath);
  let loseReply = true;
  const store: PlannedHomeTransferStore = {
    ...durable,
    async commit(tenant, operation) {
      const result = await durable.commit(tenant, operation);
      if (loseReply) {
        loseReply = false;
        return { kind: 'unavailable' };
      }
      return result;
    },
  };
  expect(
    await coordinator(store, sourceAgain.history, target.history).advance(
      operationId,
    ),
  ).toMatchObject({
    kind: 'unavailable',
    executionAuthorityTransferred: false,
    executionResumeAvailable: false,
  });
  expect(
    await coordinator(store, sourceAgain.history, target.history).advance(
      operationId,
    ),
  ).toMatchObject({
    kind: 'decision-committed',
    decision: { phase: 'committed' },
    executionAuthorityTransferred: false,
    executionResumeAvailable: false,
  });
  await sourceAgain.history.close();
  await target.history.close();
  expect(sourceAgain.events.close()).toEqual({ kind: 'closed' });
  expect(target.events.close()).toEqual({ kind: 'closed' });
});

test.each([
  [
    'corrupt history',
    "UPDATE project_task_room_records SET record_json='{}'",
    'pending',
  ],
  [
    'wrong target seal',
    "UPDATE project_task_room_source_seals SET target_home_ref='paired:wrong'",
    'conflict',
  ],
] as const)(
  'refuses a restored target with %s',
  async (_label, mutation, expected) => {
    const root = rootPath();
    const sourcePath = join(root, 'source.sqlite');
    const targetPath = join(root, 'target.sqlite');
    const store = decisionStore(root);
    const source = room(sourcePath);
    const emptyTarget = room(targetPath);
    await source.history.open({ grant: grant('discover') });
    await emptyTarget.history.open({ grant: grant('discover') });
    await source.history.append(message('integrity'));
    expect(
      await coordinator(store, source.history, emptyTarget.history).advance(
        operationId,
      ),
    ).toMatchObject({
      kind: 'pending',
    });
    await source.history.close();
    await emptyTarget.history.close();
    expect(source.events.close()).toEqual({ kind: 'closed' });
    expect(emptyTarget.events.close()).toEqual({ kind: 'closed' });
    copyFileSync(sourcePath, targetPath);
    const tampered = new DatabaseSync(targetPath);
    tampered.exec(mutation);
    tampered.close();
    const sourceAgain = room(sourcePath);
    const target = room(targetPath);
    expect(
      await coordinator(store, sourceAgain.history, target.history).advance(
        operationId,
      ),
    ).toMatchObject({
      kind: expected,
      ...(expected === 'pending' ? { reason: 'target-unavailable' } : {}),
      executionAuthorityTransferred: false,
      executionResumeAvailable: false,
    });
    expect(await store.resolve(tenantId, operationId)).toMatchObject({
      kind: 'stored',
      value: { phase: 'source-closed' },
    });
    await sourceAgain.history.close();
    await target.history.close();
    expect(sourceAgain.events.close()).toEqual({ kind: 'closed' });
    expect(target.events.close()).toEqual({ kind: 'closed' });
  },
);

test.each(['publication-pending', 'execution-pending'] as const)(
  'keeps a prepared decision frozen when source reports %s',
  async (reason) => {
    const root = rootPath();
    const store = decisionStore(root);
    const result = await createPlannedHomeTransferCoordinator({
      store,
      tenantId,
      source: {
        ownerIdentity: {},
        ensureClosed: async () => ({ kind: reason }),
      },
      target: {
        ownerIdentity: {},
        readSeal: async () => ({ kind: 'unsealed' }),
      },
    }).advance(operationId);
    expect(result).toMatchObject({
      kind: 'pending',
      reason,
      decision: { phase: 'prepared' },
      executionAuthorityTransferred: false,
      executionResumeAvailable: false,
    });
    expect(await store.resolve(tenantId, operationId)).toMatchObject({
      kind: 'stored',
      value: { phase: 'prepared' },
    });
  },
);

test('keeps a read-only unsealed source prepared without recording closure', async () => {
  const root = rootPath();
  const durable = decisionStore(root);
  let closureWrites = 0;
  let observedIntent: unknown;
  const store: PlannedHomeTransferStore = {
    ...durable,
    async recordClosure(...args) {
      closureWrites += 1;
      return durable.recordClosure(...args);
    },
  };
  const result = await createPlannedHomeTransferCoordinator({
    store,
    tenantId,
    source: {
      ownerIdentity: {},
      ensureClosed: async (persistedIntent) => {
        observedIntent = persistedIntent;
        return { kind: 'unsealed' };
      },
    },
    target: {
      ownerIdentity: {},
      readSeal: async () => ({ kind: 'unavailable' }),
    },
  }).advance(operationId);
  expect(observedIntent).toEqual(intent);
  expect(Object.isFrozen(observedIntent)).toBe(true);
  expect(closureWrites).toBe(0);
  expect(result).toMatchObject({
    kind: 'pending',
    reason: 'source-not-closed',
    decision: { phase: 'prepared' },
    executionAuthorityTransferred: false,
    executionResumeAvailable: false,
  });
  expect(await durable.resolve(tenantId, operationId)).toMatchObject({
    kind: 'stored',
    value: { phase: 'prepared' },
  });
});

test('returns denied when captured source authority is revoked', async () => {
  const root = rootPath();
  const store = decisionStore(root);
  let revoked = false;
  const source = room(
    join(root, 'source.sqlite'),
    authority(() => revoked),
  );
  await source.history.open({ grant: grant('discover') });
  revoked = true;
  expect(
    await createPlannedHomeTransferCoordinator({
      store,
      tenantId,
      ...createLocalProjectTaskRoomTransferOwners({
        source: { history: source.history, grant: grant('home-transfer') },
        target: {
          history: { readSourceSeal: async () => ({ kind: 'unsealed' }) },
          grant: grant('history-read'),
        },
      }),
    }).advance(operationId),
  ).toMatchObject({
    kind: 'denied',
    executionAuthorityTransferred: false,
    executionResumeAvailable: false,
  });
  await source.history.close();
  expect(source.events.close()).toEqual({ kind: 'closed' });
});

test('refuses the source history wired as the target before sealing', async () => {
  const root = rootPath();
  const store = decisionStore(root);
  const source = room(join(root, 'source.sqlite'));
  try {
    await source.history.open({ grant: grant('discover') });
    expect(
      await coordinator(store, source.history, source.history).advance(
        operationId,
      ),
    ).toMatchObject({ kind: 'conflict', executionAuthorityTransferred: false });
    expect(
      await source.history.readSourceSeal({ grant: grant('history-read') }),
    ).toEqual({ kind: 'unsealed' });
  } finally {
    await source.history.close();
    source.events.close();
  }
});

test('returns the committed decision when another driver finishes during readiness acknowledgement', async () => {
  const root = rootPath();
  const store = decisionStore(root);
  const sourcePath = join(root, 'source.sqlite');
  const targetPath = join(root, 'target.sqlite');
  const source = room(sourcePath);
  let target: ReturnType<typeof room> | undefined;
  try {
    await source.history.open({ grant: grant('discover') });
    const sealed = await source.history.sealSource({
      grant: grant('home-transfer'),
      operationId,
      sourceHomeRef,
      targetHomeRef,
    });
    if (sealed.kind !== 'sealed')
      throw new Error('Expected actual source seal');
    expect(
      (await store.recordClosure(tenantId, operationId, sealed.seal)).kind,
    ).toBe('stored');
    await source.history.close();
    expect(source.events.close()).toEqual({ kind: 'closed' });
    copyFileSync(sourcePath, targetPath);
    target = room(targetPath);
    const interleaved: PlannedHomeTransferStore = {
      ...store,
      async recordReady(...args) {
        const ready = await store.recordReady(...args);
        if (ready.kind !== 'stored') return ready;
        // A second authorized driver commits before this driver observes the
        // idempotent readiness result. Both operations use real SQLite.
        const committed = await store.commit(tenantId, operationId);
        expect(committed.kind).toBe('stored');
        return store.recordReady(...args);
      },
    };
    const result = await coordinator(
      interleaved,
      source.history,
      target.history,
    ).advance(operationId);
    expect(result).toMatchObject({
      kind: 'decision-committed',
      executionAuthorityTransferred: false,
      executionResumeAvailable: false,
    });
    expect(await store.inspect(tenantId, channelId)).toMatchObject({
      kind: 'stored',
      value: { revision: 1, homeRef: targetHomeRef },
    });
  } finally {
    await source.history.close();
    source.events.close();
    await target?.history.close();
    target?.events.close();
  }
});

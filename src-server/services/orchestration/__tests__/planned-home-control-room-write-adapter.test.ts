import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  PAIRING_SCOPE_HOME_CONTROL,
  PAIRING_SCOPE_HOME_TRANSFER,
} from '@kontourai/station-contracts/environment-security';
import type {
  ProjectTaskRoomGrant,
  ProjectTaskRoomGrantKind,
  ProjectTaskRoomScope,
} from '@kontourai/station-contracts/project-task-room';
import { afterEach, expect, test } from 'vitest';
import { EnvironmentSecurityService } from '../../ssh/environment-security-service.js';
import { EventStore } from '../event-store.js';
import {
  pairedHomeRef,
  personalControllerTenantId,
} from '../personal-home-authority-identity.js';
import { readPlannedHomeAdmissionJournal } from '../planned-home-admission-schema.js';
import { createPlannedHomeControlRoomWriteAdmissionAdapter } from '../planned-home-control-room-write-adapter.js';
import {
  createPlannedHomeControlSessionAuthority,
  type PlannedHomeControlAdmissionPort,
} from '../planned-home-control-session-authority.js';
import { createSqlitePlannedHomeTransferStore } from '../planned-home-transfer-store.js';
import { projectTaskRoomChannelId } from '../project-task-room-history.js';

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

function grant<K extends ProjectTaskRoomGrantKind>(
  capability: K,
): ProjectTaskRoomGrant<K> {
  return Object.freeze({
    schemaVersion: 'station.project-task-room-grant/v1',
    capability,
    opaqueToken: 'room-adapter-test',
  }) as ProjectTaskRoomGrant<K>;
}

function stored<T>(result: { kind: 'stored'; value: T } | { kind: string }): T {
  if (result.kind !== 'stored' || !('value' in result))
    throw new Error('Expected stored fixture result');
  return result.value;
}

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'station-home-room-adapter-'));
  const security = new EnvironmentSecurityService({
    homeDir: join(root, 'controller-home'),
  });
  const controller = await security.initialize();
  const database = new DatabaseSync(join(root, 'authority.sqlite'));
  database.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL');
  cleanup.push(() => {
    database.close();
    rmSync(root, { recursive: true, force: true });
  });
  const offer = security.devicePairing.createOffer({
    endpoint: 'https://controller.example.test',
    scope: PAIRING_SCOPE_HOME_TRANSFER,
  });
  const request = security.devicePairing.requestPairing({
    requesterPosition: 'off-box',
    offerId: offer.offerId,
    proof: offer.challenge,
    deviceName: 'Room owner',
  });
  security.devicePairing.confirmRequest(request.requestId, {
    kind: 'presented-credential',
  });
  const paired = security.devicePairing.exchange({
    offerId: offer.offerId,
    proof: offer.challenge,
    requestId: request.requestId,
  });
  security.devicePairing.setDeviceScope(
    paired.device.id,
    [PAIRING_SCOPE_HOME_TRANSFER, PAIRING_SCOPE_HOME_CONTROL],
    { kind: 'presented-credential' },
  );
  const participant = {
    authority: 'device-credential' as const,
    deviceId: paired.device.id,
    credential: paired.credential,
  };
  const control = createPlannedHomeControlSessionAuthority({
    database,
    security,
    controllerEnvironmentId: controller.environmentId,
  });
  const capability = stored(
    control.open(participant, {
      openId: 'room-runtime',
      replaySecret: randomBytes(32).toString('hex'),
    }),
  ).capability;
  const transfers = createSqlitePlannedHomeTransferStore(database);
  const owner = (scope: ProjectTaskRoomScope) =>
    transfers.initialize({
      tenantId: personalControllerTenantId(controller.environmentId),
      channelId: projectTaskRoomChannelId(scope),
      homeRef: pairedHomeRef(paired.device.id),
      policyRevision: 'policy-1',
      revision: 0,
    });
  const capabilities = (scope: ProjectTaskRoomScope) => ({
    async resolve({
      grant: presented,
      required,
    }: {
      grant: ProjectTaskRoomGrant<ProjectTaskRoomGrantKind>;
      required: ProjectTaskRoomGrantKind;
    }) {
      if (
        presented.opaqueToken !== 'room-adapter-test' ||
        presented.capability !== required
      )
        return { kind: 'denied' as const };
      return {
        kind: 'granted' as const,
        receipt: {
          receiptId: `receipt-${required}`,
          capability: required,
          scope,
          principal: {
            kind: 'operator' as const,
            operatorId: 'room-owner',
            deviceId: 'room-device',
          },
          policyRevision: 'policy-1',
        },
      };
    },
  });
  const openRoom = async (
    scope: ProjectTaskRoomScope,
    roomWriteAdmissions: ReturnType<
      typeof createPlannedHomeControlRoomWriteAdmissionAdapter
    >,
    name: string,
  ) => {
    const events = new EventStore(join(root, `${name}.sqlite`));
    const room = events.createProjectTaskRoomHistory({
      capabilities: capabilities(scope),
      roomWriteAdmissions,
    });
    cleanup.push(async () => {
      await room.close();
      events.close();
    });
    await room.open({ grant: grant('discover') });
    return room;
  };
  const adapter = (
    scope: ProjectTaskRoomScope,
    localAuthority = () => true,
    nextControl: Pick<typeof control, 'bind'> = control,
    nextCapability = capability,
  ) =>
    createPlannedHomeControlRoomWriteAdmissionAdapter({
      control: nextControl,
      capability: nextCapability,
      channelId: projectTaskRoomChannelId(scope),
      ownerRevision: 0,
      requireSynchronousLocalAuthority: localAuthority,
    });
  return {
    root,
    database,
    security,
    controller,
    paired,
    participant,
    control,
    capability,
    transfers,
    owner,
    adapter,
    openRoom,
  };
}

const scope = (taskId: string): ProjectTaskRoomScope => ({
  projectId: 'room-adapter-project',
  projectSlug: 'room-adapter-project',
  taskId,
});

const message = (proposalId: string, text = proposalId) => ({
  grant: grant('message-write'),
  intent: {
    proposalId,
    occurredAt: '2026-09-06T00:00:00.000Z',
    body: { kind: 'human-message' as const, text },
  },
});

test('actual room write settles the fixed controller admission', async () => {
  const f = await fixture();
  const roomScope = scope('task-a');
  expect(f.owner(roomScope).kind).toBe('stored');
  const roomPort = f.adapter(roomScope);
  const room = await f.openRoom(roomScope, roomPort, 'settled');
  const committed = await room.append(message('proposal-a'));
  expect(committed).toMatchObject({ kind: 'committed' });
  const journal = readPlannedHomeAdmissionJournal(f.database);
  expect(journal).toHaveLength(1);
  expect(journal[0]).toMatchObject({
    channelId: projectTaskRoomChannelId(roomScope),
    homeRef: pairedHomeRef(f.paired.device.id),
    ownerRevision: 0,
    kind: 'room-write',
    state: 'finished',
    intentDigest:
      committed.kind === 'committed'
        ? committed.receipt.proposalDigest
        : undefined,
  });
  expect(journal[0]?.admissionId).not.toBe('proposal-a');
  expect(journal[0]?.admissionId).toMatch(/^[a-f0-9]{64}$/);
  expect(journal[0]?.receiptDigest).toMatch(/^[a-f0-9]{64}$/);
  expect(
    await roomPort.begin({
      scope: scope('foreign-task'),
      channelId: projectTaskRoomChannelId(roomScope),
      proposalId: 'foreign-scope',
      intentDigest: 'a'.repeat(64),
    }),
  ).toEqual({ kind: 'conflict' });
  const freshLocal = await f.openRoom(roomScope, f.adapter(roomScope), 'fresh');
  expect((await freshLocal.append(message('proposal-a'))).kind).toBe('denied');
  expect(readPlannedHomeAdmissionJournal(f.database)).toHaveLength(1);
});

test('same proposal id in two room channels derives distinct central identities', async () => {
  const f = await fixture();
  const firstScope = scope('task-a');
  const secondScope = scope('task-b');
  expect(f.owner(firstScope).kind).toBe('stored');
  expect(f.owner(secondScope).kind).toBe('stored');
  const first = await f.openRoom(firstScope, f.adapter(firstScope), 'first');
  const second = await f.openRoom(
    secondScope,
    f.adapter(secondScope),
    'second',
  );
  expect((await first.append(message('shared-proposal'))).kind).toBe(
    'committed',
  );
  expect((await second.append(message('shared-proposal'))).kind).toBe(
    'committed',
  );
  const journal = readPlannedHomeAdmissionJournal(f.database);
  expect(journal).toHaveLength(2);
  expect(new Set(journal.map((record) => record.admissionId)).size).toBe(2);
  expect(new Set(journal.map((record) => record.channelId))).toEqual(
    new Set([
      projectTaskRoomChannelId(firstScope),
      projectTaskRoomChannelId(secondScope),
    ]),
  );
});

test('configured missing, revoked, and locally denied authority never becomes unmanaged', async () => {
  const f = await fixture();
  const localScope = scope('local-denied');
  expect(f.owner(localScope).kind).toBe('stored');
  const localDenied = await f.openRoom(
    localScope,
    f.adapter(localScope, () => false),
    'local-denied',
  );
  expect((await localDenied.append(message('local-denied'))).kind).toBe(
    'denied',
  );

  const missingScope = scope('missing-session');
  expect(f.owner(missingScope).kind).toBe('stored');
  const missing = await f.openRoom(
    missingScope,
    f.adapter(missingScope, () => true, f.control, {
      ...f.capability,
      token: 'f'.repeat(64),
    }),
    'missing-session',
  );
  expect((await missing.append(message('missing-session'))).kind).toBe(
    'denied',
  );

  const revokedScope = scope('revoked-session');
  expect(f.owner(revokedScope).kind).toBe('stored');
  const revoked = await f.openRoom(
    revokedScope,
    f.adapter(revokedScope),
    'revoked-session',
  );
  f.security.devicePairing.setDeviceScope(
    f.paired.device.id,
    [PAIRING_SCOPE_HOME_TRANSFER],
    { kind: 'presented-credential' },
  );
  expect((await revoked.append(message('revoked-session'))).kind).toBe(
    'denied',
  );
  expect(readPlannedHomeAdmissionJournal(f.database)).toEqual([]);
});

test('malformed, null, and rejected bind results become concrete unavailable ports', async () => {
  const f = await fixture();
  const roomScope = scope('malformed-bind');
  const identity = {
    scope: roomScope,
    channelId: projectTaskRoomChannelId(roomScope),
    proposalId: 'proposal',
    intentDigest: 'a'.repeat(64),
  };
  for (const result of [null, undefined, {}, { kind: 'unknown' }]) {
    const port = f.adapter(roomScope, () => true, {
      bind: (() => result) as unknown as typeof f.control.bind,
    });
    expect(await port.begin(identity)).toEqual({ kind: 'unavailable' });
  }
  const rejected = f.adapter(roomScope, () => true, {
    bind: (() =>
      Promise.reject(
        new Error('late transport rejection'),
      )) as unknown as typeof f.control.bind,
  });
  expect(await rejected.begin(identity)).toEqual({ kind: 'unavailable' });
  await new Promise<void>((resolve) => setImmediate(resolve));
});

test('malformed control-port admission records never authorize or settle', async () => {
  const f = await fixture();
  const roomScope = scope('malformed-admission');
  const malformed: PlannedHomeControlAdmissionPort = {
    begin: () => ({ kind: 'begun', value: {} as never }),
    finish: () => ({ kind: 'stored', value: {} as never }),
  };
  const port = f.adapter(roomScope, () => true, {
    bind: (() => ({
      kind: 'stored',
      value: malformed,
    })) as typeof f.control.bind,
  });
  const identity = {
    scope: roomScope,
    channelId: projectTaskRoomChannelId(roomScope),
    proposalId: 'proposal',
    intentDigest: 'a'.repeat(64),
  };
  expect(await port.begin(identity)).toEqual({ kind: 'unavailable' });
  expect(
    await port.finish({ ...identity, receiptDigest: 'b'.repeat(64) }),
  ).toEqual({ kind: 'unavailable' });
});

test('lost finish response recovers from the local durable duplicate after reopen', async () => {
  const f = await fixture();
  const roomScope = scope('finish-replay');
  expect(f.owner(roomScope).kind).toBe('stored');
  let loseFinish = true;
  const wrappedControl: Pick<typeof f.control, 'bind'> = {
    bind(...args) {
      const result = f.control.bind(...args);
      if (result.kind !== 'stored') return result;
      const durable = result.value;
      const wrapped: PlannedHomeControlAdmissionPort = {
        begin: durable.begin.bind(durable),
        finish(input) {
          const finished = durable.finish(input);
          if (loseFinish && finished.kind === 'stored') {
            loseFinish = false;
            return { kind: 'unavailable' };
          }
          return finished;
        },
      };
      return { kind: 'stored', value: wrapped };
    },
  };
  const sourcePath = join(f.root, 'finish-replay.sqlite');
  const firstEvents = new EventStore(sourcePath);
  const first = firstEvents.createProjectTaskRoomHistory({
    capabilities: {
      async resolve({ grant: presented, required }) {
        return {
          kind:
            presented.opaqueToken === 'room-adapter-test' &&
            presented.capability === required
              ? ('granted' as const)
              : ('denied' as const),
          receipt: {
            receiptId: `receipt-${required}`,
            capability: required,
            scope: roomScope,
            principal: {
              kind: 'operator' as const,
              operatorId: 'room-owner',
              deviceId: 'room-device',
            },
            policyRevision: 'policy-1',
          },
        } as const;
      },
    },
    roomWriteAdmissions: f.adapter(roomScope, () => true, wrappedControl),
  });
  let firstClosed = false;
  cleanup.push(async () => {
    if (firstClosed) return;
    await first.close();
    firstEvents.close();
  });
  await first.open({ grant: grant('discover') });
  expect((await first.append(message('finish-replay'))).kind).toBe(
    'unavailable',
  );
  await first.close();
  firstEvents.close();
  firstClosed = true;

  const reopenedEvents = new EventStore(sourcePath);
  const reopened = reopenedEvents.createProjectTaskRoomHistory({
    capabilities: {
      async resolve({ grant: presented, required }) {
        if (
          presented.opaqueToken !== 'room-adapter-test' ||
          presented.capability !== required
        )
          return { kind: 'denied' as const };
        return {
          kind: 'granted' as const,
          receipt: {
            receiptId: `receipt-${required}`,
            capability: required,
            scope: roomScope,
            principal: {
              kind: 'operator' as const,
              operatorId: 'room-owner',
              deviceId: 'room-device',
            },
            policyRevision: 'policy-1',
          },
        };
      },
    },
    roomWriteAdmissions: f.adapter(roomScope),
  });
  cleanup.push(async () => {
    await reopened.close();
    reopenedEvents.close();
  });
  expect((await reopened.append(message('finish-replay'))).kind).toBe(
    'duplicate',
  );
  expect(readPlannedHomeAdmissionJournal(f.database)[0]).toMatchObject({
    state: 'finished',
  });
});

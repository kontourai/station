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
  ProjectTaskRoomAppendReceipt,
  ProjectTaskRoomGrant,
  ProjectTaskRoomGrantKind,
  ProjectTaskRoomScope,
} from '@kontourai/station-contracts/project-task-room';
import { afterEach, expect, test, vi } from 'vitest';
import { EnvironmentSecurityService } from '../../ssh/environment-security-service.js';
import { EventStore } from '../event-store.js';
import {
  pairedHomeRef,
  personalControllerTenantId,
} from '../personal-home-authority-identity.js';
import { createPlannedHomeAdmissionReconciliation } from '../planned-home-admission-reconciliation.js';
import { readPlannedHomeAdmissionJournal } from '../planned-home-admission-schema.js';
import { createPlannedHomeControlRoomWriteAdmissionAdapter } from '../planned-home-control-room-write-adapter.js';
import { plannedHomeControlRoomWriteAdmissionId } from '../planned-home-control-room-write-identity.js';
import { createPlannedHomeControlRoomWriteReceiptVerifier } from '../planned-home-control-room-write-receipt-verifier.js';
import { createPlannedHomeControlSessionAuthority } from '../planned-home-control-session-authority.js';
import { createSqlitePlannedHomeTransferStore } from '../planned-home-transfer-store.js';
import type { ProjectTaskRoomWriteAdmissionPort } from '../project-task-room-history.js';
import { projectTaskRoomChannelId } from '../project-task-room-history.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

const scope: ProjectTaskRoomScope = {
  projectId: 'receipt-project',
  projectSlug: 'receipt-project',
  taskId: 'receipt-task',
};
const proposalId = 'durable-write';

function grant<K extends ProjectTaskRoomGrantKind>(
  capability: K,
): ProjectTaskRoomGrant<K> {
  return Object.freeze({
    schemaVersion: 'station.project-task-room-grant/v1',
    capability,
    opaqueToken: 'receipt-verifier-grant',
  }) as ProjectTaskRoomGrant<K>;
}

test('revoked control reconciles a lost finish from the reopened EventStore receipt before retirement', async () => {
  const root = mkdtempSync(join(tmpdir(), 'station-room-receipt-verifier-'));
  roots.push(root);
  const security = new EnvironmentSecurityService({
    homeDir: join(root, 'controller-home'),
  });
  const controller = await security.initialize();
  const database = new DatabaseSync(join(root, 'authority.sqlite'));
  database.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL');
  const offer = security.devicePairing.createOffer({
    endpoint: 'https://controller.example.test',
    scope: PAIRING_SCOPE_HOME_TRANSFER,
  });
  const request = security.devicePairing.requestPairing({
    requesterPosition: 'off-box',
    offerId: offer.offerId,
    proof: offer.challenge,
    deviceName: 'Source',
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
  const operator = {
    authority: 'operator-credential' as const,
    credential: controller.credential,
  };
  const control = createPlannedHomeControlSessionAuthority({
    database,
    security,
    controllerEnvironmentId: controller.environmentId,
  });
  const opened = control.open(participant, {
    openId: 'receipt-runtime',
    replaySecret: randomBytes(32).toString('hex'),
  });
  if (opened.kind !== 'stored') throw new Error('Expected control session');
  const channelId = projectTaskRoomChannelId(scope);
  const owner = createSqlitePlannedHomeTransferStore(database).initialize({
    tenantId: personalControllerTenantId(controller.environmentId),
    channelId,
    homeRef: pairedHomeRef(paired.device.id),
    policyRevision: 'policy-1',
    revision: 0,
  });
  expect(owner.kind).toBe('stored');
  const admitted = createPlannedHomeControlRoomWriteAdmissionAdapter({
    control,
    capability: opened.value.capability,
    channelId,
    ownerRevision: 0,
    requireSynchronousLocalAuthority: () => true,
  });
  const roomPath = join(root, 'room.sqlite');
  const source = new EventStore(roomPath);
  const loseFinish: ProjectTaskRoomWriteAdmissionPort = {
    async begin(identity) {
      const begun = await admitted.begin(identity);
      expect(
        source.readProjectTaskRoomAppendReceipt({
          channelId: identity.channelId,
          proposalId: identity.proposalId,
        }),
      ).toEqual({ kind: 'not-found' });
      return begun;
    },
    async finish() {
      return { kind: 'unavailable' };
    },
  };
  const room = source.createProjectTaskRoomHistory({
    capabilities: {
      async resolve({ grant: presented, required }) {
        if (
          presented.opaqueToken !== 'receipt-verifier-grant' ||
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
              operatorId: 'room-operator',
              deviceId: 'room-device',
            },
            policyRevision: 'policy-1',
          },
        };
      },
    },
    roomWriteAdmissions: loseFinish,
  });
  let sourceClosed = false;
  let reopened: EventStore | undefined;
  try {
    expect(await room.open({ grant: grant('discover') })).toMatchObject({
      kind: 'opened',
    });
    expect(
      await room.append({
        grant: grant('message-write'),
        intent: {
          proposalId,
          occurredAt: '2026-09-06T00:00:00.000Z',
          body: { kind: 'human-message', text: 'Durable effect' },
        },
      }),
    ).toEqual({ kind: 'unavailable' });
    const admissionId = plannedHomeControlRoomWriteAdmissionId(
      channelId,
      proposalId,
    );
    expect(readPlannedHomeAdmissionJournal(database)).toMatchObject([
      { admissionId, state: 'unresolved', kind: 'room-write' },
    ]);
    await room.close();
    source.close();
    sourceClosed = true;

    security.devicePairing.setDeviceScope(
      paired.device.id,
      [PAIRING_SCOPE_HOME_TRANSFER],
      { kind: 'presented-credential' },
    );
    expect(
      control.retire(operator, {
        deviceId: paired.device.id,
        expectedGeneration: opened.value.capability.generation,
      }).kind,
    ).toBe('admission-pending');

    reopened = new EventStore(roomPath);
    const durable = reopened.readProjectTaskRoomAppendReceipt({
      channelId,
      proposalId,
    });
    expect(durable).toMatchObject({
      kind: 'found',
      receipt: { proposalId, coordinate: { channelId } },
      receiptDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(Object.isFrozen(durable)).toBe(true);
    expect(
      reopened.readProjectTaskRoomAppendReceipt({
        channelId,
        proposalId: 'missing-proposal',
      }),
    ).toEqual({ kind: 'not-found' });
    if (durable.kind !== 'found') throw new Error('Expected durable receipt');
    const tamper = new DatabaseSync(roomPath);
    try {
      tamper
        .prepare(
          'UPDATE project_task_room_identities SET receipt_digest=? WHERE channel_id=? AND proposal_id=?',
        )
        .run('f'.repeat(64), channelId, proposalId);
      expect(
        reopened.readProjectTaskRoomAppendReceipt({ channelId, proposalId }),
      ).toEqual({ kind: 'unavailable' });
      tamper
        .prepare(
          'UPDATE project_task_room_identities SET receipt_digest=? WHERE channel_id=? AND proposal_id=?',
        )
        .run(durable.receiptDigest, channelId, proposalId);
      expect(
        reopened.readProjectTaskRoomAppendReceipt({ channelId, proposalId }),
      ).toMatchObject({ kind: 'found', receiptDigest: durable.receiptDigest });
    } finally {
      tamper.close();
    }
    const unresolved = readPlannedHomeAdmissionJournal(database)[0];
    if (!unresolved) throw new Error('Expected unresolved admission');
    const verifier = createPlannedHomeControlRoomWriteReceiptVerifier({
      receipts: reopened,
      proposalId,
      expectedOwner: {
        tenantId: personalControllerTenantId(controller.environmentId),
        homeRef: pairedHomeRef(paired.device.id),
        channelId,
        ownerRevision: 0,
      },
    });
    expect(
      await verifier.verify(
        { ...unresolved, intentDigest: 'f'.repeat(64) },
        new AbortController().signal,
      ),
    ).toEqual({ kind: 'unavailable' });
    const reconciliation = createPlannedHomeAdmissionReconciliation({
      database,
      security,
      controllerEnvironmentId: controller.environmentId,
      receipts: verifier,
    });
    const settled = await reconciliation.reconcile(operator, {
      deviceId: paired.device.id,
      admissionId,
    });
    expect(settled).toMatchObject({
      kind: 'settled',
      admission: {
        admissionId,
        state: 'finished',
        receiptDigest:
          durable.kind === 'found' ? durable.receiptDigest : undefined,
      },
    });
    expect(
      control.retire(operator, {
        deviceId: paired.device.id,
        expectedGeneration: opened.value.capability.generation,
      }),
    ).toMatchObject({ kind: 'stored', value: { state: 'retired' } });
    expect(
      control.bind(opened.value.capability, {
        channelId,
        ownerRevision: 0,
        kind: 'room-write',
        requireSynchronousLocalAuthority: () => true,
      }).kind,
    ).toBe('denied');
  } finally {
    if (!sourceClosed) {
      await room.close();
      source.close();
    }
    reopened?.close();
    database.close();
  }
});

test('wrong lookup identity, effect kind, and aborted work never read or verify a receipt', async () => {
  const channelId = projectTaskRoomChannelId(scope);
  const read = vi.fn(() => ({ kind: 'not-found' as const }));
  const admission = {
    tenantId: 'personal-controller:controller',
    channelId,
    admissionId: plannedHomeControlRoomWriteAdmissionId(channelId, proposalId),
    ownerRevision: 0,
    homeRef: 'paired:device',
    kind: 'room-write' as const,
    intentDigest: 'a'.repeat(64),
    state: 'unresolved' as const,
  };
  const verifier = createPlannedHomeControlRoomWriteReceiptVerifier({
    receipts: { readProjectTaskRoomAppendReceipt: read },
    proposalId,
    expectedOwner: {
      tenantId: admission.tenantId,
      homeRef: admission.homeRef,
      channelId,
      ownerRevision: 0,
    },
  });
  expect(
    await createPlannedHomeControlRoomWriteReceiptVerifier({
      receipts: { readProjectTaskRoomAppendReceipt: read },
      proposalId: 'wrong-proposal',
      expectedOwner: {
        tenantId: admission.tenantId,
        homeRef: admission.homeRef,
        channelId,
        ownerRevision: 0,
      },
    }).verify(admission, new AbortController().signal),
  ).toEqual({ kind: 'unavailable' });
  expect(
    await verifier.verify(
      { ...admission, kind: 'execution' },
      new AbortController().signal,
    ),
  ).toEqual({ kind: 'unavailable' });
  const aborted = new AbortController();
  aborted.abort();
  expect(await verifier.verify(admission, aborted.signal)).toEqual({
    kind: 'unavailable',
  });
  expect(read).not.toHaveBeenCalled();
});

test('wrong trusted home, tenant, channel, or owner revision never reads a receipt', async () => {
  const channelId = projectTaskRoomChannelId(scope);
  const admission = {
    tenantId: 'personal-controller:controller',
    channelId,
    admissionId: plannedHomeControlRoomWriteAdmissionId(channelId, proposalId),
    ownerRevision: 3,
    homeRef: 'paired:device',
    kind: 'room-write' as const,
    intentDigest: 'a'.repeat(64),
    state: 'unresolved' as const,
  };
  for (const expectedOwner of [
    { ...admission, tenantId: 'personal-controller:other' },
    { ...admission, homeRef: 'paired:other' },
    { ...admission, channelId: 'other-channel' },
    { ...admission, ownerRevision: 4 },
  ]) {
    const read = vi.fn(() => ({ kind: 'not-found' as const }));
    const verifier = createPlannedHomeControlRoomWriteReceiptVerifier({
      receipts: { readProjectTaskRoomAppendReceipt: read },
      proposalId,
      expectedOwner,
    });
    expect(
      await verifier.verify(admission, new AbortController().signal),
    ).toEqual({ kind: 'unavailable' });
    expect(read).not.toHaveBeenCalled();
  }
});

test('trusted owner binding is captured before caller mutation', async () => {
  const channelId = projectTaskRoomChannelId(scope);
  const admission = {
    tenantId: 'personal-controller:controller',
    channelId,
    admissionId: plannedHomeControlRoomWriteAdmissionId(channelId, proposalId),
    ownerRevision: 3,
    homeRef: 'paired:device',
    kind: 'room-write' as const,
    intentDigest: 'a'.repeat(64),
    state: 'unresolved' as const,
  };
  const expectedOwner = {
    tenantId: admission.tenantId,
    homeRef: admission.homeRef,
    channelId,
    ownerRevision: admission.ownerRevision,
  };
  const read = vi.fn(() => ({ kind: 'not-found' as const }));
  const verifier = createPlannedHomeControlRoomWriteReceiptVerifier({
    receipts: { readProjectTaskRoomAppendReceipt: read },
    proposalId,
    expectedOwner,
  });
  expectedOwner.tenantId = 'personal-controller:replacement';
  expectedOwner.homeRef = 'paired:replacement';
  expectedOwner.channelId = 'replacement-channel';
  expectedOwner.ownerRevision = 4;
  expect(
    await verifier.verify(admission, new AbortController().signal),
  ).toEqual({ kind: 'unavailable' });
  expect(read).toHaveBeenCalledWith({ channelId, proposalId });
});

test('room receipt epoch is independent from the trusted owner revision', async () => {
  const channelId = projectTaskRoomChannelId(scope);
  const admission = {
    tenantId: 'personal-controller:controller',
    channelId,
    admissionId: plannedHomeControlRoomWriteAdmissionId(channelId, proposalId),
    ownerRevision: 3,
    homeRef: 'paired:device',
    kind: 'room-write' as const,
    intentDigest: 'a'.repeat(64),
    state: 'unresolved' as const,
  };
  const receipt: ProjectTaskRoomAppendReceipt = {
    schemaVersion: 'station.project-task-room-append-receipt/v1',
    proposalId,
    proposalDigest: admission.intentDigest,
    envelopeDigest: 'b'.repeat(64),
    coordinate: { channelId, epoch: 11, seq: 1 },
    checkpoint: {
      channelId,
      epoch: 11,
      throughSeq: 1,
      checkpointDigest: 'c'.repeat(64),
      retainedAnchorSeq: 0,
      retainedAnchorDigest: 'd'.repeat(64),
    },
    committedAt: '2026-09-06T00:00:00.000Z',
    assurance: 'L0',
  };
  const verifier = createPlannedHomeControlRoomWriteReceiptVerifier({
    receipts: {
      readProjectTaskRoomAppendReceipt: () => ({
        kind: 'found',
        receipt,
        receiptDigest: 'e'.repeat(64),
      }),
    },
    proposalId,
    expectedOwner: {
      tenantId: admission.tenantId,
      homeRef: admission.homeRef,
      channelId,
      ownerRevision: admission.ownerRevision,
    },
  });
  expect(
    await verifier.verify(admission, new AbortController().signal),
  ).toMatchObject({
    kind: 'verified',
    admission: { ownerRevision: 3, receiptDigest: 'e'.repeat(64) },
  });
});

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
} from '@kontourai/station-contracts/project-task-room';
import { afterEach, expect, test } from 'vitest';
import { EnvironmentSecurityService } from '../../ssh/environment-security-service.js';
import { EventStore } from '../event-store.js';
import {
  pairedHomeRef,
  personalControllerTenantId,
} from '../personal-home-authority-identity.js';
import {
  createPlannedHomeAdmissionReconciliation,
  type PlannedHomeAdmissionReceiptVerifier,
} from '../planned-home-admission-reconciliation.js';
import { readPlannedHomeAdmissionJournal } from '../planned-home-admission-schema.js';
import { plannedHomeControlRoomWriteAdmissionId } from '../planned-home-control-room-write-identity.js';
import { createPlannedHomeControlRoomWriteReceiptVerifier } from '../planned-home-control-room-write-receipt-verifier.js';
import {
  createPlannedHomeControlSessionAuthority,
  type PlannedHomeControlResult,
} from '../planned-home-control-session-authority.js';
import { createSqlitePlannedHomeTransferStore } from '../planned-home-transfer-store.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const scope = {
  projectId: 'recovery-project',
  projectSlug: 'recovery-project',
  taskId: 'recovery-task',
};
function grant<K extends ProjectTaskRoomGrantKind>(
  capability: K,
): ProjectTaskRoomGrant<K> {
  return Object.freeze({
    schemaVersion: 'station.project-task-room-grant/v1',
    capability,
    opaqueToken: 'fixture-operator',
  }) as ProjectTaskRoomGrant<K>;
}
function stored<T>(result: PlannedHomeControlResult<T>): T {
  if (result.kind !== 'stored')
    throw new Error('Expected stored fixture result');
  return result.value;
}

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'station-admission-reconcile-'));
  const security = new EnvironmentSecurityService({
    homeDir: join(root, 'controller-home'),
  });
  const controller = await security.initialize();
  const database = new DatabaseSync(join(root, 'authority.sqlite'));
  database.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL');
  const transfers = createSqlitePlannedHomeTransferStore(database);
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
  const operator = {
    authority: 'operator-credential' as const,
    credential: controller.credential,
  };
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
      openId: 'source-runtime',
      replaySecret: randomBytes(32).toString('hex'),
    }),
  ).capability;
  const sourcePath = join(root, 'source.sqlite');
  const source = new EventStore(sourcePath);
  const room = source.createProjectTaskRoomHistory({
    capabilities: {
      async resolve({ grant: presented, required }) {
        if (
          presented.opaqueToken !== 'fixture-operator' ||
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
              operatorId: 'source-operator',
              deviceId: 'source-device',
            },
            policyRevision: 'policy-1',
          },
        };
      },
    },
  });
  cleanup.push(async () => {
    await room.close();
    source.close();
    database.close();
    rmSync(root, { recursive: true, force: true });
  });
  expect(await room.open({ grant: grant('discover') })).toMatchObject({
    kind: 'opened',
  });
  const committed = await room.append({
    grant: grant('message-write'),
    intent: {
      proposalId: 'write-1',
      occurredAt: '2026-09-06T00:00:00.000Z',
      body: { kind: 'human-message', text: 'Durable effect' },
    },
  });
  if (committed.kind !== 'committed')
    throw new Error('Fixture room did not commit');
  const receipt = committed.receipt;
  const admissionId = plannedHomeControlRoomWriteAdmissionId(
    receipt.coordinate.channelId,
    receipt.proposalId,
  );
  stored(
    transfers.initialize({
      tenantId: personalControllerTenantId(controller.environmentId),
      channelId: receipt.coordinate.channelId,
      homeRef: pairedHomeRef(paired.device.id),
      policyRevision: 'policy-1',
      revision: 0,
    }),
  );
  const port = stored(
    control.bind(capability, {
      channelId: receipt.coordinate.channelId,
      ownerRevision: 0,
      kind: 'room-write',
      requireSynchronousLocalAuthority: () => true,
    }),
  );
  // Persisted crash snapshot. Admission-before-effect ordering is exercised by
  // the room-write integration suite; this fixture owns receipt reconciliation.
  expect(
    port.begin({
      admissionId,
      intentDigest: receipt.proposalDigest,
    }).kind,
  ).toBe('begun');
  let reads = 0;
  const durable = createPlannedHomeControlRoomWriteReceiptVerifier({
    receipts: {
      readProjectTaskRoomAppendReceipt(input) {
        reads += 1;
        return source.readProjectTaskRoomAppendReceipt(input);
      },
    },
    proposalId: receipt.proposalId,
    expectedOwner: {
      tenantId: personalControllerTenantId(controller.environmentId),
      homeRef: pairedHomeRef(paired.device.id),
      channelId: receipt.coordinate.channelId,
      ownerRevision: 0,
    },
  });
  const receipts: PlannedHomeAdmissionReceiptVerifier = {
    verify(admission, signal) {
      expect(Object.isFrozen(admission)).toBe(true);
      return durable.verify(admission, signal);
    },
  };
  const reconcile = (verifier = receipts, receiptTimeoutMs?: number) =>
    createPlannedHomeAdmissionReconciliation({
      database,
      security,
      controllerEnvironmentId: controller.environmentId,
      receipts: verifier,
      receiptTimeoutMs,
    });
  return {
    database,
    security,
    control,
    capability,
    operator,
    participant,
    paired,
    port,
    receipts,
    reconcile,
    receipt,
    input: { deviceId: paired.device.id, admissionId },
    reads: () => reads,
  };
}

test('operator reconciles a revoked session from the actual durable room receipt without reviving its capability', async () => {
  const f = await fixture();
  f.security.devicePairing.setDeviceScope(
    f.paired.device.id,
    [PAIRING_SCOPE_HOME_TRANSFER],
    { kind: 'presented-credential' },
  );
  expect(
    f.port.finish({
      admissionId: f.receipt.proposalId,
      intentDigest: f.receipt.proposalDigest,
      receiptDigest: 'a'.repeat(64),
    }).kind,
  ).toBe('denied');
  expect(
    f.control.retire(f.operator, {
      deviceId: f.paired.device.id,
      expectedGeneration: f.capability.generation,
    }).kind,
  ).toBe('admission-pending');
  const recovery = f.reconcile();
  expect(await recovery.reconcile(f.participant, f.input)).toEqual({
    kind: 'denied',
  });
  expect(f.reads()).toBe(0);
  const settled = await recovery.reconcile(f.operator, f.input);
  expect(settled).toMatchObject({
    kind: 'settled',
    admission: { state: 'finished' },
  });
  expect(f.reads()).toBe(1);
  expect(await recovery.reconcile(f.operator, f.input)).toMatchObject({
    kind: 'settled',
  });
  expect(f.reads()).toBe(1);
  expect(
    f.port.begin({
      admissionId: 'new-write',
      intentDigest: 'b'.repeat(64),
    }).kind,
  ).toBe('denied');
  expect(
    f.control.retire(f.operator, {
      deviceId: f.paired.device.id,
      expectedGeneration: f.capability.generation,
    }).kind,
  ).toBe('stored');
});

test('wrong proof identity cannot settle the requested admission', async () => {
  const f = await fixture();
  const recovery = f.reconcile({
    async verify(admission) {
      return {
        kind: 'verified',
        admission: {
          ...admission,
          admissionId: 'another-write',
          state: 'finished',
          receiptDigest: 'a'.repeat(64),
        },
      };
    },
  });
  expect(await recovery.reconcile(f.operator, f.input)).toEqual({
    kind: 'conflict',
  });
  expect(readPlannedHomeAdmissionJournal(f.database)[0]?.state).toBe(
    'unresolved',
  );
});

test('operator revocation during proof lookup prevents settlement', async () => {
  const f = await fixture();
  const recovery = f.reconcile({
    async verify(admission, signal) {
      const proof = await f.receipts.verify(admission, signal);
      await f.security.rotateCredential();
      return proof;
    },
  });
  expect(await recovery.reconcile(f.operator, f.input)).toEqual({
    kind: 'denied',
  });
  expect(readPlannedHomeAdmissionJournal(f.database)[0]?.state).toBe(
    'unresolved',
  );
});

test('timeout aborts receipt lookup and a late result never finishes the admission', async () => {
  const f = await fixture();
  let complete!: (value: unknown) => void;
  let signal: AbortSignal | undefined;
  const recovery = f.reconcile(
    {
      verify(_admission, observedSignal) {
        signal = observedSignal;
        return new Promise((resolve) => {
          complete = resolve;
        });
      },
    },
    10,
  );
  expect(await recovery.reconcile(f.operator, f.input)).toEqual({
    kind: 'unavailable',
  });
  expect(signal?.aborted).toBe(true);
  complete({
    kind: 'verified',
    admission: {
      ...readPlannedHomeAdmissionJournal(f.database)[0],
      state: 'finished',
      receiptDigest: 'a'.repeat(64),
    },
  });
  await Promise.resolve();
  expect(readPlannedHomeAdmissionJournal(f.database)[0]?.state).toBe(
    'unresolved',
  );
});

test('corrupt routing and a mismatched home fail before receipt lookup', async () => {
  const f = await fixture();
  const recovery = f.reconcile();
  expect(
    await recovery.reconcile(f.operator, {
      ...f.input,
      deviceId: 'another-device',
    }),
  ).toEqual({ kind: 'conflict' });
  f.database.exec("UPDATE planned_home_admissions SET channel_id='corrupt'");
  expect(await recovery.reconcile(f.operator, f.input)).toEqual({
    kind: 'unavailable',
  });
  expect(f.reads()).toBe(0);
});

test('a conflicting concurrent settlement cannot be overwritten by recovery', async () => {
  const f = await fixture();
  const recovery = f.reconcile({
    async verify(admission, signal) {
      const proof = await f.receipts.verify(admission, signal);
      expect(
        f.port.finish({
          admissionId: admission.admissionId,
          intentDigest: admission.intentDigest,
          receiptDigest: 'f'.repeat(64),
        }).kind,
      ).toBe('stored');
      return proof;
    },
  });
  expect(await recovery.reconcile(f.operator, f.input)).toEqual({
    kind: 'conflict',
  });
  expect(readPlannedHomeAdmissionJournal(f.database)[0]?.receiptDigest).toBe(
    'f'.repeat(64),
  );
});
test('receipt verifier is captured at construction', async () => {
  const f = await fixture();
  const recovery = f.reconcile();
  f.receipts.verify = async () => {
    throw new Error('Replaced verifier must not run');
  };
  expect(await recovery.reconcile(f.operator, f.input)).toMatchObject({
    kind: 'settled',
  });
});

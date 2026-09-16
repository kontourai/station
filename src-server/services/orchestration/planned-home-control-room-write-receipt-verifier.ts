import type { EventStore } from './event-store.js';
import type { PlannedHomeAdmissionReceiptVerifier } from './planned-home-admission-reconciliation.js';
import {
  type PlannedHomeAdmissionRecord,
  plannedHomeAdmissionIdentifier,
  plannedHomeAdmissionRecordValid,
} from './planned-home-admission-schema.js';
import { plannedHomeControlRoomWriteAdmissionId } from './planned-home-control-room-write-identity.js';

type RoomReceiptReader = Pick<EventStore, 'readProjectTaskRoomAppendReceipt'>;

/** Bind one operator-supplied lookup hint to durable EventStore receipt truth. */
export function createPlannedHomeControlRoomWriteReceiptVerifier(options: {
  receipts: RoomReceiptReader;
  proposalId: string;
  expectedOwner: {
    tenantId: string;
    homeRef: string;
    channelId: string;
    ownerRevision: number;
  };
}): PlannedHomeAdmissionReceiptVerifier {
  const read = options.receipts?.readProjectTaskRoomAppendReceipt;
  const proposalId = options.proposalId;
  const rawExpectedOwner = options.expectedOwner;
  if (
    typeof read !== 'function' ||
    !plannedHomeAdmissionIdentifier(proposalId) ||
    !plannedHomeAdmissionIdentifier(rawExpectedOwner?.tenantId) ||
    !plannedHomeAdmissionIdentifier(rawExpectedOwner?.homeRef) ||
    !plannedHomeAdmissionIdentifier(rawExpectedOwner?.channelId) ||
    !Number.isSafeInteger(rawExpectedOwner?.ownerRevision) ||
    rawExpectedOwner.ownerRevision < 0
  )
    return Object.freeze({
      async verify() {
        return { kind: 'unavailable' };
      },
    });
  const expectedOwner = Object.freeze({
    tenantId: rawExpectedOwner.tenantId,
    homeRef: rawExpectedOwner.homeRef,
    channelId: rawExpectedOwner.channelId,
    ownerRevision: rawExpectedOwner.ownerRevision,
  });
  const readReceipt = read.bind(options.receipts);
  return Object.freeze({
    async verify(
      admission: Readonly<PlannedHomeAdmissionRecord>,
      signal: AbortSignal,
    ) {
      try {
        if (
          signal.aborted ||
          !plannedHomeAdmissionRecordValid(admission) ||
          admission.kind !== 'room-write' ||
          admission.state !== 'unresolved' ||
          admission.tenantId !== expectedOwner.tenantId ||
          admission.homeRef !== expectedOwner.homeRef ||
          admission.channelId !== expectedOwner.channelId ||
          admission.ownerRevision !== expectedOwner.ownerRevision ||
          plannedHomeControlRoomWriteAdmissionId(
            admission.channelId,
            proposalId,
          ) !== admission.admissionId
        )
          return { kind: 'unavailable' };
        const found = readReceipt({
          channelId: admission.channelId,
          proposalId,
        });
        if (signal.aborted || found.kind !== 'found')
          return { kind: 'unavailable' };
        if (
          found.receipt.proposalId !== proposalId ||
          found.receipt.proposalDigest !== admission.intentDigest ||
          found.receipt.coordinate.channelId !== admission.channelId ||
          found.receipt.checkpoint.channelId !== admission.channelId
        )
          return { kind: 'unavailable' };
        return {
          kind: 'verified',
          admission: {
            ...admission,
            state: 'finished',
            receiptDigest: found.receiptDigest,
          },
        };
      } catch {
        return { kind: 'unavailable' };
      }
    },
  });
}

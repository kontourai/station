import { createHash } from 'node:crypto';
import type { ProjectTaskRoomAppendReceipt } from '@kontourai/station-contracts/project-task-room';
import { expect, test } from 'vitest';
import {
  type ProjectTaskRoomAppendReceiptRow,
  parseDurableProjectTaskRoomAppendReceipt,
  projectTaskRoomReceiptLookupIdentifier,
} from '../project-task-room-append-receipt.js';

const receipt: ProjectTaskRoomAppendReceipt = {
  schemaVersion: 'station.project-task-room-append-receipt/v1',
  proposalId: 'proposal-1',
  proposalDigest: 'a'.repeat(64),
  envelopeDigest: 'b'.repeat(64),
  coordinate: { channelId: 'channel-1', epoch: 0, seq: 1 },
  checkpoint: {
    channelId: 'channel-1',
    epoch: 0,
    throughSeq: 1,
    checkpointDigest: 'c'.repeat(64),
    retainedAnchorSeq: 0,
    retainedAnchorDigest: 'd'.repeat(64),
  },
  committedAt: '2026-09-06T00:00:00.000Z',
  assurance: 'L0',
};

function row(
  nextReceipt: ProjectTaskRoomAppendReceipt = receipt,
): ProjectTaskRoomAppendReceiptRow {
  const receiptJson = JSON.stringify(nextReceipt);
  return {
    proposal_id: receipt.proposalId,
    proposal_digest: receipt.proposalDigest,
    epoch: receipt.coordinate.epoch,
    seq: receipt.coordinate.seq,
    envelope_digest: receipt.envelopeDigest,
    checkpoint_digest: receipt.checkpoint.checkpointDigest,
    committed_at: receipt.committedAt,
    receipt_json: receiptJson,
    receipt_bytes: Buffer.byteLength(receiptJson),
    receipt_digest: createHash('sha256').update(receiptJson).digest('hex'),
  };
}

test('validates and freezes the original stored receipt with every row identity', () => {
  const parsed = parseDurableProjectTaskRoomAppendReceipt(row(), 'channel-1');
  expect(parsed).toMatchObject({
    receipt,
    receiptDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
  });
  expect(Object.isFrozen(parsed)).toBe(true);
  expect(Object.isFrozen(parsed?.receipt)).toBe(true);
  expect(Object.isFrozen(parsed?.receipt.checkpoint)).toBe(true);
});

test.each([
  ['proposal_id', 'other-proposal'],
  ['proposal_digest', 'e'.repeat(64)],
  ['epoch', 1],
  ['seq', 2],
  ['envelope_digest', 'e'.repeat(64)],
  ['checkpoint_digest', 'e'.repeat(64)],
  ['committed_at', '2026-09-06T00:00:01.000Z'],
  ['receipt_bytes', 1],
  ['receipt_digest', 'e'.repeat(64)],
] as const)('rejects a receipt whose %s column disagrees', (key, value) => {
  expect(
    parseDurableProjectTaskRoomAppendReceipt(
      { ...row(), [key]: value },
      'channel-1',
    ),
  ).toBeUndefined();
});

test('rejects altered, oversized, and cross-channel receipt JSON', () => {
  const altered = row({ ...receipt, proposalId: 'other-proposal' });
  expect(
    parseDurableProjectTaskRoomAppendReceipt(altered, 'channel-1'),
  ).toBeUndefined();
  expect(
    parseDurableProjectTaskRoomAppendReceipt(
      { ...row(), receipt_json: null },
      'channel-1',
    ),
  ).toBeUndefined();
  expect(
    parseDurableProjectTaskRoomAppendReceipt(row(), 'another-channel'),
  ).toBeUndefined();
});

test('lookup identifiers reject control characters and oversized UTF-8', () => {
  expect(projectTaskRoomReceiptLookupIdentifier('channel-1')).toBe(true);
  expect(projectTaskRoomReceiptLookupIdentifier('bad\nchannel')).toBe(false);
  expect(
    projectTaskRoomReceiptLookupIdentifier(`bad${String.fromCharCode(127)}`),
  ).toBe(false);
  expect(projectTaskRoomReceiptLookupIdentifier('é'.repeat(129))).toBe(false);
});

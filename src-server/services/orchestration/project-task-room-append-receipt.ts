import { createHash } from 'node:crypto';
import {
  isProjectTaskRoomAppendReceipt,
  type ProjectTaskRoomAppendReceipt,
} from '@kontourai/station-contracts/project-task-room';

const DIGEST = /^[a-f0-9]{64}$/;

export const PROJECT_TASK_ROOM_APPEND_RECEIPT_LIMITS = Object.freeze({
  maxBytes: 4_096,
  maxDepth: 8,
  maxItems: 80,
  maxStringCodeUnits: 1_024,
  maxKeyCodeUnits: 128,
});

export const PROJECT_TASK_ROOM_APPEND_RECEIPT_COLUMNS =
  `proposal_id,proposal_digest,epoch,seq,envelope_digest,checkpoint_digest,committed_at,` +
  `CASE WHEN length(CAST(receipt_json AS BLOB))<=${PROJECT_TASK_ROOM_APPEND_RECEIPT_LIMITS.maxBytes} THEN receipt_json END AS receipt_json,` +
  'receipt_bytes,receipt_digest';

export interface ProjectTaskRoomAppendReceiptRow {
  proposal_id: string;
  proposal_digest: string;
  epoch: number;
  seq: number;
  envelope_digest: string;
  checkpoint_digest: string;
  committed_at: string;
  receipt_json: string | null;
  receipt_bytes: number;
  receipt_digest: string;
}

export interface DurableProjectTaskRoomAppendReceipt {
  readonly receipt: ProjectTaskRoomAppendReceipt;
  readonly receiptDigest: string;
}

export type ProjectTaskRoomAppendReceiptReadResult =
  | ({ readonly kind: 'found' } & DurableProjectTaskRoomAppendReceipt)
  | { readonly kind: 'not-found' | 'unavailable' };

export function projectTaskRoomReceiptLookupIdentifier(
  value: unknown,
): value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 256 ||
    Buffer.byteLength(value) > 256
  )
    return false;
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit < 32 || unit === 127) return false;
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const low = value.charCodeAt(index + 1);
      if (!(low >= 0xdc00 && low <= 0xdfff)) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
  }
  return true;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

function sqliteDataRow(value: unknown): value is Record<string, unknown> {
  try {
    if (value === null || typeof value !== 'object') return false;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    return (
      Reflect.ownKeys(value).every((key) => typeof key === 'string') &&
      Object.values(Object.getOwnPropertyDescriptors(value)).every(
        (descriptor) => 'value' in descriptor && descriptor.enumerable,
      )
    );
  } catch {
    return false;
  }
}

export function parseDurableProjectTaskRoomAppendReceipt(
  row: unknown,
  channelId: string,
): DurableProjectTaskRoomAppendReceipt | undefined {
  try {
    if (
      !projectTaskRoomReceiptLookupIdentifier(channelId) ||
      !sqliteDataRow(row) ||
      Object.keys(row).length !== 10 ||
      ![
        'proposal_id',
        'proposal_digest',
        'epoch',
        'seq',
        'envelope_digest',
        'checkpoint_digest',
        'committed_at',
        'receipt_json',
        'receipt_bytes',
        'receipt_digest',
      ].every((key) => Object.hasOwn(row, key))
    )
      return undefined;
    const stored = row as unknown as ProjectTaskRoomAppendReceiptRow;
    if (
      typeof stored.receipt_json !== 'string' ||
      typeof stored.receipt_bytes !== 'number' ||
      !Number.isSafeInteger(stored.receipt_bytes) ||
      stored.receipt_bytes < 1 ||
      stored.receipt_bytes > PROJECT_TASK_ROOM_APPEND_RECEIPT_LIMITS.maxBytes ||
      Buffer.byteLength(stored.receipt_json) !== stored.receipt_bytes ||
      typeof stored.receipt_digest !== 'string' ||
      !DIGEST.test(stored.receipt_digest) ||
      createHash('sha256').update(stored.receipt_json).digest('hex') !==
        stored.receipt_digest
    )
      return undefined;
    const receipt = JSON.parse(stored.receipt_json) as unknown;
    if (
      !isProjectTaskRoomAppendReceipt(receipt) ||
      receipt.proposalId !== stored.proposal_id ||
      receipt.proposalDigest !== stored.proposal_digest ||
      receipt.coordinate.channelId !== channelId ||
      receipt.coordinate.epoch !== stored.epoch ||
      receipt.coordinate.seq !== stored.seq ||
      receipt.checkpoint.channelId !== channelId ||
      receipt.checkpoint.epoch !== stored.epoch ||
      receipt.checkpoint.throughSeq !== stored.seq ||
      receipt.envelopeDigest !== stored.envelope_digest ||
      receipt.checkpoint.checkpointDigest !== stored.checkpoint_digest ||
      receipt.committedAt !== stored.committed_at
    )
      return undefined;
    return Object.freeze({
      receipt: deepFreeze(receipt),
      receiptDigest: stored.receipt_digest,
    });
  } catch {
    return undefined;
  }
}

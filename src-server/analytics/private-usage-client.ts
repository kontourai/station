import type {
  PrivateUsageCheckpoint,
  PrivateUsageCommit,
  PrivateUsageCommitReceipt,
} from '@kontourai/station-contracts/usage-export';
import { canonicalUsageExportJson } from '@kontourai/station-contracts/usage-export';
import { z } from 'zod/v3';

const integer = z.number().int().nonnegative().refine(Number.isSafeInteger);
const epoch = z.string().uuid();
export const privateCheckpointSchema = z
  .object({
    receiverEpoch: epoch,
    revision: integer,
    streamEpoch: z.string().min(1).max(200),
    highWater: integer,
    afterGlobalSequence: integer,
    nextCursor: z.string().min(1).max(2048).optional(),
    sourceRevision: integer,
    completeThroughHighWater: z.boolean(),
  })
  .strict();
export const privateReceiptSchema = z
  .object({
    protocol: z.literal('station-private-usage-commit-receipt/v1'),
    operationId: z.string().uuid(),
    checkpoint: privateCheckpointSchema,
    inserted: integer,
    alreadyPresent: integer,
    storedAt: z.string().datetime(),
  })
  .strict();
export class PrivateUsageClientRejected extends Error {
  constructor(
    readonly status: 400 | 403 | 409 | 503,
    readonly code:
      | 'private_usage_unavailable'
      | 'private_usage_conflict'
      | 'private_usage_provision_required',
  ) {
    super(code);
  }
}
/** Bound service transport. It exposes no operator key, arbitrary URL or Docker command. */
export interface PrivateUsageTarget {
  installationId: string;
  custody: string;
  assertCurrent(): Promise<void>;
  provision(credentialHash: string): Promise<{ receiverEpoch: string }>;
  checkpoint(
    key: string,
    window: { from: string; to: string },
  ): Promise<{
    receiverEpoch: string;
    checkpoint: PrivateUsageCheckpoint | null;
  } | null>;
  receipt(
    key: string,
    operationId: string,
  ): Promise<PrivateUsageCommitReceipt | null>;
  commit(
    key: string,
    body: PrivateUsageCommit,
    assertSource: () => Promise<void>,
  ): Promise<PrivateUsageCommitReceipt>;
}
export const privateReceiptIntentSchema = z
  .object({
    checkpoint: privateCheckpointSchema,
    observationCount: integer,
    sourceApprovalId: z.string().uuid(),
    expiresAt: z.string().datetime(),
  })
  .strict();
export function privateReceiptIntent(
  body: PrivateUsageCommit,
  expiresAt: string,
) {
  return privateReceiptIntentSchema.parse({
    checkpoint: {
      receiverEpoch: body.expectedReceiverEpoch,
      revision: body.expectedCheckpoint + 1,
      streamEpoch: body.page.streamEpoch,
      highWater: body.page.highWater,
      afterGlobalSequence: body.page.nextCursor
        ? body.page.observations.at(-1)?.globalSequence
        : body.page.highWater,
      ...(body.page.nextCursor ? { nextCursor: body.page.nextCursor } : {}),
      sourceRevision: body.sourceRevision,
      completeThroughHighWater: body.page.nextCursor === undefined,
    },
    observationCount: body.page.observations.length,
    sourceApprovalId: body.binding.sourceApprovalId,
    expiresAt,
  });
}
export function validatePrivateReceiptIntent(
  receipt: PrivateUsageCommitReceipt,
  operationId: string,
  intent: z.infer<typeof privateReceiptIntentSchema>,
) {
  if (
    receipt.operationId !== operationId ||
    canonicalUsageExportJson(receipt.checkpoint) !==
      canonicalUsageExportJson(intent.checkpoint) ||
    receipt.inserted + receipt.alreadyPresent !== intent.observationCount
  )
    throw new PrivateUsageClientRejected(503, 'private_usage_unavailable');
}

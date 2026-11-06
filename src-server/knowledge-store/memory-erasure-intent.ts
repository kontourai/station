import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { InboxEntryRecord, OwnerLiveness } from '@kontourai/monument';
import { openSqliteKernelStorage } from '@kontourai/monument/sqlite';
import { z } from 'zod/v3';
import { assertExistingPathInside } from '../utils/path-containment.js';
import { openPrivateSqlite } from '../utils/private-sqlite.js';

const id = z.string().min(1).max(200);
const recordImpact = z.object({
  purged: z.array(id),
  cascaded: z.array(id),
  survivors: z.array(id),
  referrers: z.array(id),
  alreadyPurged: z.array(id),
  proposalsRejected: z.array(id),
  proposalsScrubbed: z.array(id),
  proposalsBlocked: z.array(id),
});
const receiptSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('record'), result: recordImpact }).strict(),
  z
    .object({
      kind: z.literal('proposal'),
      result: z
        .object({
          proposalId: id,
          alreadyErased: z.boolean(),
          record: recordImpact.optional(),
        })
        .strict(),
    })
    .strict(),
]);
export type MemoryErasureReceipt = z.infer<typeof receiptSchema>;

/** Only content-free identifiers and the confirmed Corpus plan enter the journal. */
const memoryErasureIntentSchema = z
  .object({
    version: z.literal(1),
    operation: z.enum(['purge', 'cleanup']),
    purgeId: id,
    parentPurgeId: id.optional(),
    rootId: id,
    ownerId: z.string().min(1).max(4096),
    registrationId: id,
    binding: z.string().min(1).max(4096),
    targetKind: z.enum(['record', 'proposal']),
    targetId: id,
    revision: z.string().min(1).max(512),
    impact: recordImpact.optional(),
    reviewItems: z.array(z.string().min(1).max(512)).optional(),
  })
  .strict();
export type MemoryErasureIntent = z.infer<typeof memoryErasureIntentSchema>;

const noLiveness: OwnerLiveness = () => 'unknown';
const context = { liveness: noLiveness };
const MAX_INTENT_BYTES = 1024 * 1024;
const inboxId = (
  rootId: string,
  operation: 'purge' | 'cleanup',
  key: string,
  targetId?: string,
) => {
  if (operation === 'cleanup' && !targetId)
    throw new Error('Memory cleanup target is required.');
  const identity = createHash('sha256')
    .update(
      JSON.stringify([
        rootId,
        operation,
        key,
        operation === 'cleanup' ? targetId : null,
      ]),
    )
    .digest('hex');
  return `memory:${operation}:${identity}`;
};

/** The caller must serialize work for a root before claiming or replaying an effect. */
export class MemoryErasureIntentStore {
  private readonly db;
  private readonly kernel;

  constructor(home: string) {
    const path = join(home, 'data', 'memory-erasure', 'intents.sqlite');
    assertExistingPathInside(home, path, 'Private memory erasure journal');
    this.db = openPrivateSqlite(path, 'Private memory erasure journal');
    try {
      this.kernel = openSqliteKernelStorage({
        database: this.db,
        tables: {
          turnDedup: 'unused',
          requestKeys: 'unused',
          turnBoundary: 'unused',
          steerReceipts: 'unused',
        },
      });
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  submit(value: MemoryErasureIntent) {
    const intent = memoryErasureIntentSchema.parse(value);
    const payload = JSON.stringify(intent);
    if (Buffer.byteLength(payload, 'utf8') > MAX_INTENT_BYTES)
      throw new Error('Memory erasure plan is too large.');
    return this.kernel.executeSync(
      {
        type: 'inbox.submit',
        inboxId: inboxId(
          intent.rootId,
          intent.operation,
          intent.purgeId,
          intent.targetId,
        ),
        key: intent.purgeId,
        kind: 'follow-up',
        digest: createHash('sha256').update(payload).digest('hex'),
        payload,
        now: Date.now(),
      },
      context,
    );
  }

  claimNext(
    rootId: string,
    placement: string,
    operation: 'purge' | 'cleanup' = 'purge',
    targetId?: string,
  ) {
    return this.kernel.executeSync(
      {
        type: 'inbox.claimNext',
        inboxId: inboxId(rootId, operation, placement, targetId),
        placement,
        now: Date.now(),
      },
      context,
    );
  }

  open() {
    return this.kernel.executeSync({ type: 'inbox.listOpen' }, context);
  }

  read(
    rootId: string,
    purgeId: string,
    operation: 'purge' | 'cleanup' = 'purge',
    targetId?: string,
  ) {
    return this.kernel.executeSync(
      {
        type: 'inbox.read',
        inboxId: inboxId(rootId, operation, purgeId, targetId),
        key: purgeId,
      },
      context,
    );
  }

  settle(
    rootId: string,
    purgeId: string,
    to: 'placed' | 'refused' | 'unconfirmed',
    outcome: MemoryErasureReceipt | null,
    operation: 'purge' | 'cleanup' = 'purge',
    targetId?: string,
  ) {
    const serialized =
      outcome === null ? null : JSON.stringify(receiptSchema.parse(outcome));
    if (
      serialized !== null &&
      Buffer.byteLength(serialized, 'utf8') > MAX_INTENT_BYTES
    )
      throw new Error('Memory erasure receipt is too large.');
    return this.kernel.executeSync(
      {
        type: 'inbox.settle',
        inboxId: inboxId(rootId, operation, purgeId, targetId),
        key: purgeId,
        to,
        outcome: serialized,
        now: Date.now(),
      },
      context,
    );
  }

  decode(entry: InboxEntryRecord): MemoryErasureIntent {
    if (
      createHash('sha256').update(entry.payload).digest('hex') !== entry.digest
    )
      throw new Error('Memory erasure intent is corrupt.');
    const parsed = memoryErasureIntentSchema.parse(JSON.parse(entry.payload));
    if (
      inboxId(
        parsed.rootId,
        parsed.operation,
        parsed.purgeId,
        parsed.targetId,
      ) !== entry.inboxId ||
      parsed.purgeId !== entry.key
    )
      throw new Error('Memory erasure intent identity is invalid.');
    return parsed;
  }

  decodeReceipt(entry: InboxEntryRecord): MemoryErasureReceipt | null {
    if (entry.state !== 'placed' || entry.outcome === null) return null;
    return receiptSchema.parse(JSON.parse(entry.outcome));
  }

  async close() {
    await this.kernel.close();
    this.db.close();
  }
}

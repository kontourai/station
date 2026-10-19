import { z } from 'zod';
import {
  attemptSchema,
  bodyRef,
  digest,
  fence,
  pinSchema,
  projectionSchema,
  specSchema,
  text,
} from './encoding.js';
import type { RetiredRecord } from './retention.js';

const attemptRecordSchema = z
  .object({
    attempt: attemptSchema,
    state: z.enum(['running', 'completed', 'aborted']),
    partials: z.array(bodyRef),
    tape: bodyRef.nullable(),
  })
  .strict();
export const runRecordSchema = z
  .object({
    spec: specSchema,
    fence,
    state: z.enum(['open', 'running', 'completed', 'cancelled', 'blocked']),
    pins: z.array(
      z
        .object({ pin: pinSchema, attempts: z.array(attemptRecordSchema) })
        .strict(),
    ),
    writerGeneration: text,
    createdAt: z.number().int(),
    settledAt: z.number().int().nullable(),
  })
  .strict();
export type RunRecord = z.infer<typeof runRecordSchema>;
export type AttemptRecord = z.infer<typeof attemptRecordSchema>;
export const outboxRecordSchema = z
  .object({
    projection: projectionSchema,
    position: z.number().int().nonnegative(),
    acknowledged: z.boolean(),
  })
  .strict();
export type OutboxRecord = z.infer<typeof outboxRecordSchema>;
const refused = z
  .object({
    kind: z.literal('refused'),
    reason: z.enum([
      'stale',
      'busy',
      'unknown-owner',
      'conflict',
      'unavailable',
      'unsupported',
      'capacity',
      'expired',
      'cancelled',
    ]),
  })
  .strict();
const snapshot = z
  .object({
    spec: specSchema,
    fence,
    state: runRecordSchema.shape.state,
    nextOrdinal: z.number().int().nonnegative(),
  })
  .strict();
export const resultSchema = z.union([
  refused,
  z
    .object({
      kind: z.enum(['applied', 'already-applied']),
      fence: fence.optional(),
    })
    .strict(),
  z.object({ kind: z.enum(['opened', 'existing']), snapshot }).strict(),
  z
    .object({ kind: z.literal('execute'), fence, attempt: attemptSchema })
    .strict(),
  z
    .object({ kind: z.literal('acknowledged'), fence, originalGrantId: text })
    .strict(),
  z.object({ kind: z.literal('already-begun'), fence }).strict(),
  z
    .object({
      kind: z.literal('replay'),
      fence,
      tape: bodyRef,
      attempt: attemptSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('restored'),
      snapshot,
      entry: specSchema.shape.entry,
      pendingRequest: pinSchema.nullable(),
    })
    .strict(),
  z
    .object({ kind: z.literal('found'), snapshot, pins: z.array(pinSchema) })
    .strict(),
  z.object({ kind: z.literal('absent') }).strict(),
  z
    .object({
      kind: z.literal('listed'),
      entries: z.array(projectionSchema),
      throughPosition: z.number().int().safe().min(-1),
    })
    .strict(),
]);
export const receiptSchema = z
  .object({
    operationId: text,
    digest,
    commandType: text,
    answer: resultSchema,
  })
  .strict();
export type Receipt = z.infer<typeof receiptSchema>;
export interface ModelState {
  runs: Map<string, RunRecord>;
  retired: Map<string, RetiredRecord>;
  receipts: Map<string, Receipt>;
  outbox: Map<string, OutboxRecord>;
}
export const emptyState = (): ModelState => ({
  runs: new Map(),
  retired: new Map(),
  receipts: new Map(),
  outbox: new Map(),
});

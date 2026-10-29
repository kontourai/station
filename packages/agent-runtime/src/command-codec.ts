import { z } from 'zod';
import type { ModelCommand } from './decisions.js';
import {
  attemptSchema,
  bodyRef,
  canonical,
  digest,
  fence,
  owner,
  pinSchema,
  runKey,
  specSchema,
  text,
} from './encoding.js';

const operation = { operationId: text, digest };
const owned = { ...operation, key: runKey, expected: fence };
const commandSchema = z.discriminatedUnion('type', [
  z
    .object({ type: z.literal('open'), ...operation, spec: specSchema, owner })
    .strict(),
  z.object({ type: z.literal('pin'), ...owned, pin: pinSchema }).strict(),
  z.object({ type: z.literal('begin'), ...owned, requestId: text }).strict(),
  z
    .object({
      type: z.literal('partial'),
      ...owned,
      attempt: attemptSchema,
      sequence: z.number().int().nonnegative(),
      body: bodyRef,
    })
    .strict(),
  z
    .object({
      type: z.literal('complete'),
      ...owned,
      attempt: attemptSchema,
      tape: bodyRef,
      lastPartialSequence: z.number().int().min(-1),
    })
    .strict(),
  z
    .object({
      type: z.literal('abandon'),
      ...owned,
      attempt: attemptSchema,
      reason: z.enum(['consumer-cancel', 'provider-error', 'durability-error']),
    })
    .strict(),
  z.object({ type: z.literal('takeOver'), ...owned, owner }).strict(),
  z
    .object({
      type: z.literal('finish'),
      ...owned,
      status: z.enum(['completed', 'blocked']),
    })
    .strict(),
  z.object({ type: z.literal('cancel'), ...owned }).strict(),
  z.object({ type: z.literal('read'), key: runKey }).strict(),
  z
    .object({
      type: z.literal('listOutbox'),
      key: runKey,
      limit: z.number().int().positive().max(1024),
      throughPosition: z.number().int().safe().min(-1).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('acknowledge'),
      ...operation,
      key: runKey,
      projectionId: text.max(65536),
      projectionDigest: digest,
    })
    .strict(),
]);
export function validateCommand(command: ModelCommand): void {
  canonical(command);
  commandSchema.parse(command);
}
export function commandBodies(command: ModelCommand) {
  switch (command.type) {
    case 'open':
      return [command.spec.entry.body];
    case 'pin':
      return [command.pin.request];
    case 'partial':
      return [command.body];
    case 'complete':
      return [command.tape];
    default:
      return [];
  }
}
export function operationFor(command: ModelCommand) {
  switch (command.type) {
    case 'read':
      return 'read';
    case 'listOutbox':
    case 'acknowledge':
      return 'project';
    case 'takeOver':
      return 'recover';
    case 'cancel':
      return 'cancel';
    default:
      return 'execute';
  }
}

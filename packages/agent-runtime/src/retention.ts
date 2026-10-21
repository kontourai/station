import { z } from 'zod';
import {
  commandDigest,
  keyOf,
  type ModelCommand,
  projectionId,
  same,
} from './decisions.js';
import {
  bindingSchema,
  digest,
  fence,
  hash,
  runKey,
  text,
} from './encoding.js';
import type { ModelPolicy } from './policy.js';
import type { ModelState } from './records.js';
import type { CurrentAdmission, Projection } from './types.js';

const identity = {
  key: runKey,
  specDigest: digest,
  binding: bindingSchema,
  writerGeneration: text,
};
export const retiredSchema = z.discriminatedUnion('kind', [
  z
    .object({
      ...identity,
      kind: z.literal('tombstone'),
      fence,
      settledAt: z.number().int(),
      protectedUntil: z.number().int(),
      finalState: z.enum(['completed', 'cancelled', 'blocked']),
    })
    .strict(),
  z
    .object({
      ...identity,
      kind: z.literal('expired'),
      expiredAt: z.number().int(),
    })
    .strict(),
]);
export type RetiredRecord = z.infer<typeof retiredSchema>;
export function maintainGeneration(
  command: ModelCommand,
  state: ModelState,
  policy: ModelPolicy,
  admission: CurrentAdmission,
  now: number,
  applied: (entry: Projection) => boolean,
): boolean {
  if (command.type === 'read' || command.type === 'listOutbox') return false;
  if (!same(command.digest, commandDigest(command))) return false;
  const key = command.type === 'open' ? command.spec.key : command.key;
  const id = keyOf(key);
  const previousReceipt = state.receipts.get(
    JSON.stringify([id, command.operationId]),
  );
  if (
    previousReceipt &&
    (previousReceipt.digest !== command.digest ||
      previousReceipt.commandType !== command.type)
  )
    return false;
  const run = state.runs.get(id);
  const retired = state.retired.get(id);
  const binding = run?.spec.binding ?? retired?.binding;
  const writer = run?.writerGeneration ?? retired?.writerGeneration;
  if (
    !binding ||
    !same(admission.binding, binding) ||
    admission.writerGeneration !== writer
  )
    return false;
  if (
    command.type === 'open' &&
    ((run && !same(command.spec, run.spec)) ||
      (retired && hash(command.spec) !== retired.specDigest))
  )
    return false;
  if (
    'expected' in command &&
    !same(
      command.expected,
      run?.fence ?? (retired?.kind === 'tombstone' ? retired.fence : null),
    )
  )
    return false;
  if (command.type === 'acknowledge') {
    const row = state.outbox.get(command.projectionId);
    if (
      !row ||
      !same(row.projection.key, key) ||
      hash(row.projection) !== command.projectionDigest
    )
      return false;
  }
  if (retired?.kind === 'tombstone' && now >= retired.protectedUntil) {
    state.retired.set(id, {
      kind: 'expired',
      key: retired.key,
      specDigest: retired.specDigest,
      binding: retired.binding,
      writerGeneration: retired.writerGeneration,
      expiredAt: retired.protectedUntil,
    });
    return true;
  }
  if (
    !run ||
    run.settledAt === null ||
    run.state === 'open' ||
    run.state === 'running' ||
    now < run.settledAt + policy.settledRetentionMs
  )
    return false;
  const rows = [...state.outbox.values()].filter((row) =>
    same(row.projection.key, key),
  );
  if (rows.some((row) => !row.acknowledged || !applied(row.projection)))
    return false;
  for (const pin of run.pins)
    for (const attempt of pin.attempts) {
      if (attempt.state === 'running') return false;
      for (const [sequence, body] of attempt.partials.entries()) {
        const partial = state.outbox.get(
          projectionId({
            key,
            requestId: attempt.attempt.requestId,
            attempt: attempt.attempt.number,
            sequence,
            kind: 'partial',
          }),
        );
        if (!partial || !same(partial.projection.body, body)) return false;
      }
      const projection = projectionId({
        key,
        requestId: attempt.attempt.requestId,
        attempt: attempt.attempt.number,
        sequence: 0,
        kind: attempt.state === 'completed' ? 'completed' : 'aborted',
      });
      const terminal = state.outbox.get(projection);
      if (
        !terminal ||
        !same(
          terminal.projection.body,
          attempt.state === 'completed' ? attempt.tape : null,
        )
      )
        return false;
    }
  const protectedUntil = run.settledAt + policy.tombstoneRetentionMs;
  const common = {
    key: run.spec.key,
    specDigest: hash(run.spec),
    binding: run.spec.binding,
    writerGeneration: run.writerGeneration,
  };
  state.retired.set(
    id,
    now >= protectedUntil
      ? { ...common, kind: 'expired', expiredAt: protectedUntil }
      : {
          ...common,
          kind: 'tombstone',
          fence: run.fence,
          settledAt: run.settledAt,
          protectedUntil,
          finalState: run.state,
        },
  );
  state.runs.delete(id);
  for (const [receiptId, receipt] of state.receipts) {
    const tuple = z
      .tuple([z.string(), z.string()])
      .parse(JSON.parse(receiptId));
    if (tuple[0] === id)
      state.receipts.set(receiptId, {
        ...receipt,
        answer: { kind: 'refused', reason: 'expired' },
      });
  }
  return true;
}

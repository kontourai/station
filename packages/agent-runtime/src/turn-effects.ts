import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { canonical, fence, hash, runKey, text } from './encoding.js';
import { agentWire, readAgentWire } from './turn-wire.js';
import type { Fence, RunKey } from './types.js';

const payload = z.string().max(32 * 1024 * 1024);
export const effectIntentSchema = z
  .object({
    id: text,
    kind: z.enum(['model', 'provider', 'tool', 'entry']),
    input: payload,
    replay: z.enum(['safe', 'unsafe']),
    codec: z.literal('strands-native/1').optional(),
  })
  .strict();
export type EffectIntent = z.infer<typeof effectIntentSchema>;
export const effectSchema = z
  .object({
    version: z.literal(1),
    intent: effectIntentSchema,
    inputDigest: text,
    state: z.enum(['planned', 'running', 'completed', 'indeterminate']),
    attempts: z
      .array(
        z
          .object({
            ownerId: text,
            state: z.enum(['running', 'aborted', 'completed']),
            partials: z.array(payload),
            output: payload.nullable(),
          })
          .strict(),
      )
      .max(1024),
  })
  .strict();
export type EffectRecord = z.infer<typeof effectSchema>;
export type EffectResult = {
  readonly kind: 'effect';
  readonly effect: EffectRecord;
  readonly execute: boolean;
};
type OwnedEffect = { readonly key: RunKey; readonly expected: Fence };
export type EffectCommand =
  | (OwnedEffect & { readonly type: 'effectRead'; readonly id: string })
  | (OwnedEffect & {
      readonly type: 'effectPlan';
      readonly intent: EffectIntent;
    })
  | (OwnedEffect & { readonly type: 'effectBegin'; readonly id: string })
  | (OwnedEffect & {
      readonly type: 'effectPartial';
      readonly id: string;
      readonly part: string;
    })
  | (OwnedEffect & {
      readonly type: 'effectComplete';
      readonly id: string;
      readonly output: string;
    });
const owned = { key: runKey, expected: fence };
export const effectCommands = [
  z.object({ type: z.literal('effectRead'), ...owned, id: text }).strict(),
  z
    .object({
      type: z.literal('effectPlan'),
      ...owned,
      intent: effectIntentSchema,
    })
    .strict(),
  z.object({ type: z.literal('effectBegin'), ...owned, id: text }).strict(),
  z
    .object({
      type: z.literal('effectPartial'),
      ...owned,
      id: text,
      part: payload,
    })
    .strict(),
  z
    .object({
      type: z.literal('effectComplete'),
      ...owned,
      id: text,
      output: payload,
    })
    .strict(),
] as const;
export const effectsDefinition =
  'CREATE TABLE agent_steps_effects(turn_id TEXT NOT NULL REFERENCES agent_steps_turns(id), id TEXT NOT NULL, record TEXT NOT NULL, PRIMARY KEY(turn_id,id)) STRICT';
function validate(record: EffectRecord) {
  const effect = effectSchema.parse(record);
  const last = effect.attempts.at(-1);
  readAgentWire(effect.intent.input);
  for (const attempt of effect.attempts) {
    for (const part of attempt.partials) readAgentWire(part);
    if (attempt.output !== null) {
      const decoded = readAgentWire(attempt.output);
      const output =
        effect.intent.codec === 'strands-native/1' &&
        decoded &&
        typeof decoded === 'object' &&
        'events' in decoded
          ? decoded.events
          : decoded;
      if (
        (effect.intent.kind === 'model' || effect.intent.kind === 'provider') &&
        (!Array.isArray(output) ||
          !output.some((part) =>
            effect.intent.codec === 'strands-native/1'
              ? part?.type === 'modelMessageStopEvent' &&
                typeof part.stopReason === 'string' &&
                part.stopReason.length > 0
              : part?.type === 'finish',
          ) ||
          output.some((part) => part?.type === 'error') ||
          attempt.partials.some(
            (part, index) => part !== agentWire(output[index]),
          ))
      )
        throw new Error('DURABLE_AGENT_MODEL_TAPE_DAMAGED');
    }
  }
  if (
    effect.inputDigest !== hash(effect.intent.input) ||
    ((effect.intent.kind === 'model' || effect.intent.kind === 'provider') &&
      effect.intent.replay !== 'unsafe') ||
    (effect.state === 'running' && last?.state !== 'running') ||
    (effect.state === 'completed' &&
      (last?.state !== 'completed' || last.output === null)) ||
    effect.attempts.some(
      (attempt, index) =>
        (index < effect.attempts.length - 1 && attempt.state !== 'aborted') ||
        (attempt.state === 'completed') !== (attempt.output !== null),
    )
  )
    throw new Error('DURABLE_AGENT_EFFECT_DAMAGED');
  return effect;
}
export function readAgentEffect(
  database: DatabaseSync,
  turnId: string,
  id: string,
) {
  const row = database
    .prepare('SELECT * FROM agent_steps_effects WHERE turn_id=? AND id=?')
    .get(turnId, id);
  if (!row) return undefined;
  const effect = validate(JSON.parse(String(row.record)));
  if (effect.intent.id !== id)
    throw new Error('DURABLE_AGENT_EFFECT_ID_DAMAGED');
  return effect;
}
function write(database: DatabaseSync, turnId: string, effect: EffectRecord) {
  validate(effect);
  database
    .prepare(
      'INSERT INTO agent_steps_effects VALUES(?,?,?) ON CONFLICT(turn_id,id) DO UPDATE SET record=excluded.record',
    )
    .run(turnId, effect.intent.id, canonical(effect));
}
export function validateAgentEffects(database: DatabaseSync, turnId: string) {
  const rows = database
    .prepare('SELECT id FROM agent_steps_effects WHERE turn_id=? ORDER BY id')
    .all(turnId);
  if (rows.length > 1024) throw new Error('DURABLE_AGENT_EFFECT_CAPACITY');
  return rows.map((row) => readAgentEffect(database, turnId, String(row.id))!);
}
export function takeOverAgentEffects(database: DatabaseSync, turnId: string) {
  for (const effect of validateAgentEffects(database, turnId)) {
    if (effect.state !== 'running') continue;
    effect.attempts.at(-1)!.state = 'aborted';
    effect.state =
      effect.intent.kind === 'tool' && effect.intent.replay === 'safe'
        ? 'planned'
        : 'indeterminate';
    write(database, turnId, effect);
  }
}
export function decideAgentEffect(
  database: DatabaseSync,
  turnId: string,
  command: EffectCommand,
  now: number,
):
  | EffectResult
  | { readonly kind: 'absent' }
  | { readonly kind: 'refused'; readonly reason: 'conflict' | 'busy' } {
  const id = command.type === 'effectPlan' ? command.intent.id : command.id;
  let effect = readAgentEffect(database, turnId, id);
  if (command.type === 'effectRead')
    return effect
      ? { kind: 'effect', effect, execute: false }
      : { kind: 'absent' };
  if (command.type === 'effectPlan') {
    if (effect)
      return canonical(effect.intent) === canonical(command.intent)
        ? { kind: 'effect', effect, execute: false }
        : { kind: 'refused', reason: 'conflict' };
    if (
      (command.intent.kind === 'model' || command.intent.kind === 'provider') &&
      validateAgentEffects(database, turnId).some(
        (previous) =>
          (previous.intent.kind === command.intent.kind ||
            previous.intent.kind === 'provider') &&
          previous.state !== 'completed',
      )
    )
      return { kind: 'refused', reason: 'busy' };
    if (
      Number(
        database
          .prepare(
            'SELECT count(*) AS n FROM agent_steps_effects WHERE turn_id=?',
          )
          .get(turnId)?.n,
      ) >= 1024
    )
      return { kind: 'refused', reason: 'busy' };
    effect = {
      version: 1,
      intent: command.intent,
      inputDigest: hash(command.intent.input),
      state: 'planned',
      attempts: [],
    };
    write(database, turnId, effect);
    return { kind: 'effect', effect, execute: false };
  }
  if (!effect) return { kind: 'refused', reason: 'conflict' };
  if (command.type === 'effectBegin') {
    if (effect.intent.kind === 'entry')
      return { kind: 'refused', reason: 'conflict' };
    const approval = database
      .prepare(
        'SELECT record FROM agent_steps_approvals WHERE turn_id=? AND tool_id=?',
      )
      .get(turnId, id);
    const decision = approval && JSON.parse(String(approval.record));
    if (decision && (decision.state !== 'approved' || now >= decision.deadline))
      return { kind: 'refused', reason: 'busy' };
    if (effect.state !== 'planned')
      return { kind: 'effect', effect, execute: false };
    effect.state = 'running';
    effect.attempts.push({
      ownerId: command.expected.owner.id,
      state: 'running',
      partials: [],
      output: null,
    });
    write(database, turnId, effect);
    return { kind: 'effect', effect, execute: true };
  }
  const attempt = effect.attempts.at(-1);
  if (
    effect.state !== 'running' ||
    attempt?.state !== 'running' ||
    attempt.ownerId !== command.expected.owner.id
  )
    return { kind: 'refused', reason: 'conflict' };
  if (command.type === 'effectPartial') {
    if (
      (effect.intent.kind !== 'model' && effect.intent.kind !== 'provider') ||
      attempt.partials.reduce(
        (n, part) => n + Buffer.byteLength(part),
        Buffer.byteLength(command.part),
      ) >
        16 * 1024 * 1024
    )
      return { kind: 'refused', reason: 'conflict' };
    attempt.partials.push(command.part);
  } else {
    attempt.output = command.output;
    attempt.state = 'completed';
    effect.state = 'completed';
  }
  write(database, turnId, effect);
  return { kind: 'effect', effect, execute: false };
}

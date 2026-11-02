import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { canonical, fence, hash, runKey, text } from './encoding.js';
import {
  agentBodyReference,
  putAgentBody,
  readAgentBody,
} from './turn-bodies.js';
import { agentWire, readAgentWire } from './turn-wire.js';
import type { Fence, RunKey } from './types.js';

const payload = z.string().max(32 * 1024 * 1024);
const effectIntentSchema = z
  .object({
    id: text,
    kind: z.enum(['model', 'provider', 'tool', 'entry']),
    input: payload,
    replay: z.enum(['safe', 'unsafe']),
    codec: z.literal('strands-native/1').optional(),
  })
  .strict();
export type EffectIntent = z.infer<typeof effectIntentSchema>;
const effectSchema = z
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
export function copyAgentEffect(effect: EffectRecord): EffectRecord {
  return {
    ...effect,
    intent: { ...effect.intent },
    attempts: effect.attempts.map((attempt) => ({
      ...attempt,
      partials: [...attempt.partials],
    })),
  };
}
export function agentEffectHeader(
  database: DatabaseSync,
  effect: EffectRecord,
): string {
  return canonical({
    ...effect,
    intent: { ...effect.intent, input: effect.inputDigest },
    attempts: effect.attempts.map((attempt) => ({
      ...attempt,
      partials: attempt.partials.map((wire) =>
        agentBodyReference(database, wire),
      ),
      output:
        attempt.output === null
          ? null
          : agentBodyReference(database, attempt.output),
    })),
  });
}

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
      readonly type: 'effectPartialBatch';
      readonly id: string;
      readonly parts: readonly string[];
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
      type: z.literal('effectPartialBatch'),
      ...owned,
      id: text,
      parts: z.array(payload).min(1).max(256),
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
export const effectIndexDefinition =
  "CREATE INDEX agent_steps_effect_states ON agent_steps_effects(turn_id,json_extract(record,'$.intent.kind')) WHERE json_extract(record,'$.state') <> 'completed'";
type CachedEffect = { wire: string; value: EffectRecord; size: number };
const records = new WeakMap<
  DatabaseSync,
  { values: Map<string, CachedEffect>; size: number }
>();
export function clearAgentEffects(database: DatabaseSync) {
  records.delete(database);
}
function recordCache(database: DatabaseSync) {
  let state = records.get(database);
  if (!state) {
    state = { values: new Map(), size: 0 };
    records.set(database, state);
  }
  return state;
}
function rememberEffect(
  database: DatabaseSync,
  key: string,
  wire: string,
  value: EffectRecord,
) {
  const state = recordCache(database);
  const prior = state.values.get(key);
  if (prior) {
    state.size -= prior.size;
    state.values.delete(key);
  }
  const size =
    512 +
    2 *
      (wire.length +
        value.intent.input.length +
        value.attempts.reduce(
          (n, attempt) =>
            n +
            (attempt.output?.length ?? 0) +
            attempt.partials.reduce(
              (total, part) => total + part.length + 8,
              0,
            ),
          0,
        ));
  const limit = 16 * 1024 * 1024;
  if (size > limit) return;
  while (
    state.values.size &&
    (state.size + size > limit || state.values.size >= 256)
  ) {
    const oldest = state.values.keys().next().value!;
    state.size -= state.values.get(oldest)!.size;
    state.values.delete(oldest);
  }
  state.values.set(key, { wire, value: copyAgentEffect(value), size });
  state.size += size;
}
export function unfinishedAgentEffects(
  database: DatabaseSync,
  turnId: string,
  kind?: 'model' | 'provider',
) {
  return (
    database
      .prepare(
        "SELECT 1 FROM agent_steps_effects WHERE turn_id=? AND json_extract(record,'$.state') <> 'completed' AND (json_extract(record,'$.intent.kind') IN ('model','provider') OR (? IS NULL AND json_extract(record,'$.state')='running')) AND (? IS NULL OR json_extract(record,'$.intent.kind') IN (?, 'provider')) LIMIT 1",
      )
      .get(turnId, kind ?? null, kind ?? null, kind ?? null) !== undefined
  );
}
function validate(
  record: EffectRecord,
  bodiesValidated = false,
  inputReference?: string,
) {
  const effect = effectSchema.parse(record);
  const last = effect.attempts.at(-1);
  if (!bodiesValidated) readAgentWire(effect.intent.input);
  for (const attempt of effect.attempts) {
    if (!bodiesValidated)
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
    effect.inputDigest !== (inputReference ?? hash(effect.intent.input)) ||
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
  const wire = String(row.record);
  const cache = recordCache(database).values;
  const key = JSON.stringify([turnId, id]);
  const prior = cache.get(key);
  if (prior?.wire === wire) {
    cache.delete(key);
    cache.set(key, prior);
    return copyAgentEffect(prior.value);
  }
  const header = effectSchema.parse(JSON.parse(wire));
  if (!header.intent.input.startsWith('sha256:')) {
    if (
      ['agent-steps/7', 'agent-steps/8'].includes(
        String(
          database
            .prepare('SELECT writer_format FROM agent_steps_meta WHERE id=1')
            .get()?.writer_format,
        ),
      )
    )
      throw new Error('DURABLE_AGENT_EFFECT_DAMAGED');
    return validate(header);
  }
  const effect = validate(
    {
      ...header,
      intent: {
        ...header.intent,
        input: readAgentBody(database, header.intent.input),
      },
      attempts: header.attempts.map((attempt) => ({
        ...attempt,
        partials: attempt.partials.map((ref) => readAgentBody(database, ref)),
        output:
          attempt.output === null
            ? null
            : readAgentBody(database, attempt.output),
      })),
    },
    true,
    header.intent.input,
  );
  rememberEffect(database, key, wire, effect);
  if (effect.intent.id !== id)
    throw new Error('DURABLE_AGENT_EFFECT_ID_DAMAGED');
  return effect;
}
function write(database: DatabaseSync, turnId: string, effect: EffectRecord) {
  const input = putAgentBody(database, effect.intent.input);
  validate(effect, true, input);
  for (const attempt of effect.attempts) {
    for (const part of attempt.partials) putAgentBody(database, part);
    if (attempt.output !== null) putAgentBody(database, attempt.output);
  }
  const wire = agentEffectHeader(database, effect);
  rememberEffect(
    database,
    JSON.stringify([turnId, effect.intent.id]),
    wire,
    effect,
  );
  database
    .prepare(
      'INSERT INTO agent_steps_effects VALUES(?,?,?) ON CONFLICT(turn_id,id) DO UPDATE SET record=excluded.record',
    )
    .run(turnId, effect.intent.id, wire);
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
      unfinishedAgentEffects(database, turnId, command.intent.kind)
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
      inputDigest: putAgentBody(database, command.intent.input),
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
  if (
    command.type === 'effectPartial' ||
    command.type === 'effectPartialBatch'
  ) {
    const parts =
      command.type === 'effectPartial' ? [command.part] : command.parts;
    if (
      (effect.intent.kind !== 'model' && effect.intent.kind !== 'provider') ||
      attempt.partials.reduce(
        (n, part) => n + Buffer.byteLength(part),
        parts.reduce((n, part) => n + Buffer.byteLength(part), 0),
      ) >
        16 * 1024 * 1024
    )
      return { kind: 'refused', reason: 'conflict' };
    attempt.partials.push(...parts);
  } else {
    attempt.output = command.output;
    attempt.state = 'completed';
    effect.state = 'completed';
  }
  write(database, turnId, effect);
  return { kind: 'effect', effect, execute: false };
}

export function migrateAgentEffects(database: DatabaseSync) {
  for (const row of database
    .prepare('SELECT turn_id,id FROM agent_steps_effects')
    .all()) {
    const turnId = String(row.turn_id);
    const effect = readAgentEffect(database, turnId, String(row.id))!;
    write(database, turnId, effect);
  }
}

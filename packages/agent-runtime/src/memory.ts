import type { AtomicParticipant } from '@kontourai/monument/testing';
import { validateBody } from './codecs.js';
import {
  commandBodies,
  operationFor,
  validateCommand,
} from './command-codec.js';
import {
  decideModel,
  isRead,
  keyOf,
  type ModelCommand,
  type ModelResult,
} from './decisions.js';
import {
  bindingSchema,
  canonical,
  digestBytes,
  RuntimeError,
} from './encoding.js';
import { fixedPolicy, type ModelPolicy } from './policy.js';
import { emptyState, type ModelState } from './records.js';
import type {
  Bodies,
  BodyRef,
  CurrentAdmission,
  ModelContext,
  ModelProtocol,
  ModelStorage,
  Refused,
  RunKey,
} from './types.js';

const volumes = new WeakMap<ModelMemoryVolume, ModelState>();
export class ModelMemoryVolume {
  constructor() {
    volumes.set(this, emptyState());
  }
}
export interface ModelMemoryTransaction {
  readonly adapter: 'staged-memory';
}
export function openMemoryModelStorage(options: {
  volume: ModelMemoryVolume;
  bodies: Bodies;
  policy: ModelPolicy;
  host: (
    key: RunKey,
    operation: 'execute' | 'recover' | 'read' | 'cancel' | 'project',
  ) => CurrentAdmission;
  participants?: readonly AtomicParticipant<
    ModelProtocol,
    ModelMemoryTransaction,
    Refused
  >[];
}): ModelStorage {
  const policy = fixedPolicy(options.policy);
  let closed = false;
  let executing = false;
  const participants = [...(options.participants ?? [])];
  return {
    async execute<C extends ModelCommand>(
      command: C,
      context: ModelContext,
    ): Promise<ModelResult<C>> {
      if (closed || executing)
        throw new RuntimeError(
          closed ? 'DURABLE_STORAGE_CLOSED' : 'DURABLE_NESTED_TRANSACTION',
        );
      executing = true;
      try {
        validateCommand(command);
        const key = command.type === 'open' ? command.spec.key : command.key;
        let admission: CurrentAdmission;
        try {
          admission = options.host(key, operationFor(command));
          canonical(admission);
          bindingSchema.parse(admission.binding);
          if (!admission.writerGeneration)
            throw new Error('writer unavailable');
        } catch {
          return { kind: 'refused', reason: 'unavailable' };
        }
        let current = volumes.get(options.volume);
        if (!current) throw new RuntimeError('DURABLE_UNAVAILABLE');
        const bytes = new Map<string, Uint8Array>();
        for (;;) {
          const refs = [
            ...commandBodies(command),
            ...[...current.runs.values()]
              .filter((r) => keyOf(r.spec.key) === keyOf(key))
              .flatMap((r) => [
                r.spec.entry.body,
                ...r.pins.flatMap((p) => [
                  p.pin.request,
                  ...p.attempts.flatMap((a) => [
                    ...a.partials,
                    ...(a.tape ? [a.tape] : []),
                  ]),
                ]),
              ]),
          ];
          for (const ref of refs) {
            const body = await options.bodies.read(ref);
            if (
              body.length !== ref.byteLength ||
              digestBytes(body) !== ref.digest
            )
              throw new RuntimeError('DURABLE_BODY_DAMAGED');
            validateBody(ref.codec, body);
            bytes.set(canonical(ref), body);
          }
          const latest = volumes.get(options.volume);
          if (!latest) throw new RuntimeError('DURABLE_UNAVAILABLE');
          if (latest === current) break;
          current = latest;
        }
        if (closed) throw new RuntimeError('DURABLE_STORAGE_CLOSED');
        const staged = structuredClone(current);
        const host: ModelMemoryTransaction = { adapter: 'staged-memory' };
        const active = participants.filter(
          (p) => !isRead(command) || p.observeReads,
        );
        for (const p of active)
          if (p.admit?.(command, host))
            return { kind: 'refused', reason: 'unavailable' };
        const result = decideModel(command, {
          state: staged,
          context,
          policy,
          admission,
          now: Date.now(),
          readBody(ref: BodyRef) {
            const value = bytes.get(canonical(ref));
            if (!value) throw new RuntimeError('DURABLE_BODY_MISSING');
            return value;
          },
        });
        if (result.kind === 'refused') return result;
        for (const p of active) {
          const returned: unknown = p.commit?.({ command, result }, host);
          if (returned !== undefined)
            throw new RuntimeError('DURABLE_ASYNC_PARTICIPANT');
        }
        volumes.set(options.volume, staged);
        return result;
      } finally {
        executing = false;
      }
    },
    async close() {
      closed = true;
    },
  };
}

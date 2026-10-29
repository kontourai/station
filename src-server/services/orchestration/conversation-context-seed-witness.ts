import { createHash } from 'node:crypto';
import type { ConversationHandoffEffectStatus } from '@kontourai/station-contracts/orchestration';
import { z } from 'zod';
import type { EventStore } from './event-store.js';
import type { TurnDeduplicator } from './turn-deduplicator.js';

const witnessSchema = z
  .object({
    protocolVersion: z.literal(1),
    kind: z.enum(['handoff', 'fork', 'boundary']),
    contextId: z.string().min(1),
    contextDigest: z.string().regex(/^[a-f0-9]{64}$/),
    threadId: z.string().min(1),
    clientTurnId: z.string().min(1),
    seedDigest: z.string().regex(/^[a-f0-9]{64}$/),
    invocationId: z.uuid(),
    providerTurnId: z.string().min(1),
    terminalEventId: z.string().min(1),
    nativeIdentityKey: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type ConversationSeedWitness = z.infer<typeof witnessSchema>;

function witnessDigest(input: Omit<ConversationSeedWitness, 'digest'>): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        'station-context-seed-witness/v1',
        input.kind,
        input.contextId,
        input.contextDigest,
        input.threadId,
        input.clientTurnId,
        input.seedDigest,
        input.invocationId,
        input.providerTurnId,
        input.terminalEventId,
        input.nativeIdentityKey ?? null,
      ]),
    )
    .digest('hex');
}

/** Recorded only alongside the canonical completion; supplies no execution authority. */
export function createConversationSeedWitness(
  input: Omit<ConversationSeedWitness, 'digest' | 'protocolVersion'>,
): ConversationSeedWitness {
  const body = { ...input, protocolVersion: 1 as const };
  return { ...body, digest: witnessDigest(body) };
}

export function readConversationSeedWitness(
  json: string,
): ConversationSeedWitness {
  try {
    const witness = witnessSchema.parse(JSON.parse(json));
    if (witnessDigest(witness) !== witness.digest) throw new Error('digest');
    return witness;
  } catch {
    throw new Error('Context delivery evidence is unavailable.');
  }
}

/** Read-only observation; the caller must authorize the owning context first. */
export async function observeConversationSeedTurn(input: {
  store: EventStore;
  deduplicator?: TurnDeduplicator;
  threadId: string;
  clientTurnId: string;
  expected?: {
    kind: ConversationSeedWitness['kind'];
    contextId: string;
    contextDigest: string;
    seedDigest: string;
  };
  requiresNativeIdentity?: boolean;
}): Promise<{
  status: ConversationHandoffEffectStatus;
  contextStatus: ConversationHandoffEffectStatus;
  providerTurnId?: string;
  nativeBinding?: 'matched' | 'changed' | 'unavailable';
  literalSeedCompleted: boolean;
}> {
  const { store, threadId, clientTurnId, expected } = input;
  const providerTurnId = await input.deduplicator?.awaitResolution({
    threadId,
    clientTurnId,
    timeoutMs: 1,
    intervalMs: 1,
  });
  const invocationId = providerTurnId
    ? store.preparedInvocationForClientTurn(threadId, clientTurnId)
    : undefined;
  const disposition = invocationId
    ? store.readInvocationTerminal(threadId, invocationId, providerTurnId)
    : undefined;
  const events = providerTurnId
    ? store
        .listEvents(threadId)
        .filter(
          (event) =>
            event.turnId === providerTurnId &&
            (invocationId === undefined ||
              event.payload.invocationId === invocationId),
        )
    : [];
  const terminal =
    disposition && disposition.kind !== 'found'
      ? undefined
      : disposition?.kind === 'found'
        ? events.find((event) => event.id === disposition.fact.terminalEventId)
            ?.method
        : events
            .filter((event) =>
              ['turn.completed', 'turn.aborted', 'runtime.error'].includes(
                event.method,
              ),
            )
            .at(-1)?.method;
  const status: ConversationHandoffEffectStatus =
    terminal === 'turn.completed'
      ? 'completed'
      : terminal === 'turn.aborted' || terminal === 'runtime.error'
        ? 'failed'
        : providerTurnId
          ? 'accepted'
          : store.readSessionByThread(threadId)
            ? 'indeterminate'
            : 'reserved';
  const witness = store.conversationSeedWitness(threadId, clientTurnId);
  const nativeBinding = witness?.nativeIdentityKey
    ? store.contextSeedWitnessHasCurrentNativeBinding(witness)
      ? ('matched' as const)
      : ('changed' as const)
    : input.requiresNativeIdentity
      ? ('unavailable' as const)
      : undefined;
  const literalSeedCompleted =
    expected !== undefined &&
    witness !== undefined &&
    witness.kind === expected.kind &&
    witness.contextId === expected.contextId &&
    witness.contextDigest === expected.contextDigest &&
    witness.seedDigest === expected.seedDigest &&
    witness.invocationId === invocationId &&
    witness.providerTurnId === providerTurnId &&
    disposition?.kind === 'found' &&
    disposition.fact.terminalEventId === witness.terminalEventId;
  const contextStatus =
    (providerTurnId && invocationId === undefined) ||
    (status === 'completed' &&
      (!literalSeedCompleted ||
        nativeBinding === 'changed' ||
        (input.requiresNativeIdentity && nativeBinding !== 'matched')))
      ? 'indeterminate'
      : status;
  return {
    status,
    contextStatus,
    literalSeedCompleted,
    ...(providerTurnId ? { providerTurnId } : {}),
    ...(nativeBinding ? { nativeBinding } : {}),
  };
}

/** Synchronous provider-effect fence; it never waits between authority checks and invocation. */
export function hasCompletedConversationSeedTurn(
  input: Pick<
    Parameters<typeof observeConversationSeedTurn>[0],
    | 'store'
    | 'threadId'
    | 'clientTurnId'
    | 'expected'
    | 'requiresNativeIdentity'
  >,
): boolean {
  const { store, threadId, clientTurnId, expected } = input;
  const witness = store.conversationSeedWitness(threadId, clientTurnId);
  if (
    !witness ||
    !expected ||
    witness.kind !== expected.kind ||
    witness.contextId !== expected.contextId ||
    witness.contextDigest !== expected.contextDigest ||
    witness.seedDigest !== expected.seedDigest ||
    store.preparedInvocationForClientTurn(threadId, clientTurnId) !==
      witness.invocationId
  )
    return false;
  const terminal = store.readInvocationTerminal(
    threadId,
    witness.invocationId,
    witness.providerTurnId,
  );
  if (
    terminal.kind !== 'found' ||
    terminal.fact.terminalEventId !== witness.terminalEventId
  )
    return false;
  const event = store.eventById(threadId, witness.terminalEventId);
  if (
    event?.payload.method !== 'turn.completed' ||
    event.turnId !== witness.providerTurnId ||
    event.payload.invocationId !== witness.invocationId
  )
    return false;
  return witness.nativeIdentityKey !== undefined
    ? store.contextSeedWitnessHasCurrentNativeBinding(witness)
    : input.requiresNativeIdentity !== true;
}

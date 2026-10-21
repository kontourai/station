import { CONVERSATION_CONTEXT_UNAVAILABLE_CODE } from '@kontourai/station-contracts/orchestration';
import type {
  ProviderSendTurnInput,
  ProviderSessionStartInput,
} from '@kontourai/station-contracts/provider';
import { z } from 'zod';
import { hasCompletedConversationSeedTurn } from './conversation-context-seed-witness.js';
import type { ConversationContextSeedPin } from './conversation-handoff-module.js';
import type { EventStore } from './event-store.js';

export class ConversationStartContextError extends Error {
  readonly code = CONVERSATION_CONTEXT_UNAVAILABLE_CODE;
}

const carrierSchema = z
  .object({
    pinDigest: z.string().regex(/^[a-f0-9]{64}$/),
    seedDigest: z.string().regex(/^[a-f0-9]{64}$/),
    clientTurnId: z.string().min(1),
  })
  .strict();

export function readConversationStartSeedCarrier(
  metadata: Record<string, unknown> | undefined,
  pin: ConversationContextSeedPin,
) {
  const carrier = carrierSchema.safeParse(
    metadata?.conversationStartSeedCarrier,
  );
  return carrier.success &&
    carrier.data.pinDigest === pin.pinDigest &&
    carrier.data.seedDigest === pin.seedDigest
    ? carrier.data
    : undefined;
}

export function assertConversationStartSeedStart(
  store: EventStore | undefined,
  input: ProviderSessionStartInput,
): void {
  const pin = store?.conversationStartContext(input.threadId);
  if (pin && !readConversationStartSeedCarrier(input.metadata, pin))
    throw new ConversationStartContextError(
      'The saved continuation context does not match this start.',
    );
}

/** Called inside the authorized provider-turn boundary, after materialization. */
export function assertConversationStartSeedTurn(
  store: EventStore | undefined,
  input: ProviderSendTurnInput,
  metadata: Record<string, unknown> | undefined,
  requiresNativeIdentity: boolean,
): void {
  const pin = store?.conversationStartContext(input.threadId);
  if (!pin || !store) return;
  const carrier = readConversationStartSeedCarrier(metadata, pin);
  if (!carrier)
    throw new ConversationStartContextError(
      'The saved continuation context carrier is unavailable.',
    );
  if (
    input.clientTurnId === carrier.clientTurnId &&
    input.ambientContext?.includes(pin.text)
  )
    return;
  const completed = hasCompletedConversationSeedTurn({
    store,
    threadId: input.threadId,
    clientTurnId: carrier.clientTurnId,
    expected: {
      kind: 'boundary',
      contextId: input.threadId,
      contextDigest: pin.pinDigest,
      seedDigest: pin.seedDigest,
    },
    requiresNativeIdentity,
  });
  if (!completed)
    throw new ConversationStartContextError(
      'Continuation context delivery has not completed. Reconcile the context before continuing.',
    );
}

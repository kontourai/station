import { createHash } from 'node:crypto';
import {
  CONVERSATION_HANDOFF_CARRIED_FIELDS,
  CONVERSATION_HANDOFF_RESET_FIELDS,
  type ConversationContextSeedReceipt,
  type ConversationHandoffCarriedField,
  type ConversationHandoffResetField,
} from '@kontourai/station-contracts/orchestration';
import { z } from 'zod';

export interface ConversationContextSeedPin
  extends ConversationContextSeedReceipt {
  text: string;
  pinDigest: string;
}

export function conversationHandoffClientTurnId(
  conversationId: string,
  idempotencyKey: string,
): string {
  return `handoff:${createHash('sha256').update(`${conversationId}\0${idempotencyKey}`).digest('hex')}`;
}

function contextSeedPinDigest(
  seed: Omit<ConversationContextSeedPin, 'pinDigest'>,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        text: seed.text,
        seedDigest: seed.seedDigest,
        sourceCutoffs: seed.sourceCutoffs.map((cutoff) => ({
          sessionId: cutoff.sessionId,
          afterSequence: cutoff.afterSequence,
          throughSequence: cutoff.throughSequence,
        })),
        omission: {
          totalMessages: seed.omission.totalMessages,
          includedMessages: seed.omission.includedMessages,
          omittedMessages: seed.omission.omittedMessages,
          newestShortened: seed.omission.newestShortened,
          nonTextMessages: seed.omission.nonTextMessages,
        },
      }),
    )
    .digest('hex');
}

/** Seals source/omission facts together with the text; it grants no authority. */
export function createConversationContextSeedPin(
  input: Omit<ConversationContextSeedPin, 'seedDigest' | 'pinDigest'>,
): ConversationContextSeedPin {
  const seed = {
    ...input,
    seedDigest: createHash('sha256').update(input.text).digest('hex'),
  };
  return { ...seed, pinDigest: contextSeedPinDigest(seed) };
}

const contextSeedSchema = z
  .object({
    text: z.string(),
    seedDigest: z.string().regex(/^[a-f0-9]{64}$/),
    pinDigest: z.string().regex(/^[a-f0-9]{64}$/),
    sourceCutoffs: z.array(
      z
        .object({
          sessionId: z.string().min(1),
          afterSequence: z.number().int().nonnegative(),
          throughSequence: z.number().int().nonnegative(),
        })
        .strict(),
    ),
    omission: z
      .object({
        totalMessages: z.number().int().nonnegative(),
        includedMessages: z.number().int().nonnegative(),
        omittedMessages: z.number().int().nonnegative(),
        newestShortened: z.boolean(),
        nonTextMessages: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();

/** Corrupt persisted context must refuse rather than reconstruct different text. */
export function readConversationContextSeedPin(
  json: string,
): ConversationContextSeedPin {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    // JSON diagnostics may contain private transcript bytes, before read authorization.
    throw new Error('The pinned conversation context is invalid.');
  }
  const result = contextSeedSchema.safeParse(parsed);
  if (!result.success)
    throw new Error('The pinned conversation context is invalid.');
  const seed = result.data;
  if (
    createHash('sha256').update(seed.text).digest('hex') !== seed.seedDigest ||
    contextSeedPinDigest(seed) !== seed.pinDigest ||
    seed.omission.includedMessages + seed.omission.omittedMessages !==
      seed.omission.totalMessages ||
    new Set(seed.sourceCutoffs.map((cutoff) => cutoff.sessionId)).size !==
      seed.sourceCutoffs.length ||
    seed.sourceCutoffs.some(
      (cutoff) => cutoff.throughSequence < cutoff.afterSequence,
    )
  ) {
    throw new Error('The pinned conversation context is invalid.');
  }
  return seed;
}

/**
 * Deep authority for an explicit Agent/engine handoff.  A caller gets one
 * result or a typed refusal; it never gets storage access or permission to
 * mutate an ordinary continuation's target.
 */
export interface ConversationHandoffMarker {
  conversationId: string;
  predecessorSessionId: string;
  sessionId: string;
  idempotencyKey: string;
  targetAgentId: string;
  targetEnvironmentId: string;
  targetConnectionId?: string;
  targetExecutionAgentId?: string;
  targetModelId?: string;
  messageDigest: string;
  nativeReturnSourceSessionId?: string;
  nativeReturnSourceEventId?: string;
  contextSeed?: ConversationContextSeedPin;
  createdAt: string;
}

export class ConversationHandoffConflictError extends Error {
  readonly name = 'ConversationHandoffConflictError';
  constructor(
    readonly code: 'idempotency_target_mismatch' | 'successor_exists',
  ) {
    super(
      code === 'idempotency_target_mismatch'
        ? 'The handoff idempotency key already names a different target.'
        : 'This conversation already has a successor session.',
    );
  }
}

interface ConversationHandoffPersistence {
  reserve(input: ConversationHandoffMarker): {
    marker: ConversationHandoffMarker;
    outcome: 'created' | 'existing';
  };
  findBySession(sessionId: string): ConversationHandoffMarker | undefined;
  findByPredecessor(sessionId: string): ConversationHandoffMarker | undefined;
  findByKey(
    conversationId: string,
    idempotencyKey: string,
  ): ConversationHandoffMarker | undefined;
  listByConversation(conversationId: string): ConversationHandoffMarker[];
}

export interface ConversationHandoffModule {
  describe(
    marker: ConversationHandoffMarker,
    outcome: 'created' | 'existing',
  ): ReturnType<ConversationHandoffModule['reserve']>;
  reserve(input: ConversationHandoffMarker): {
    marker: Readonly<ConversationHandoffMarker>;
    outcome: 'created' | 'existing';
    carried: readonly ConversationHandoffCarriedField[];
    reset: readonly ConversationHandoffResetField[];
  };
  markerForSession(
    sessionId: string,
  ): Readonly<ConversationHandoffMarker> | undefined;
  markerForPredecessor(
    sessionId: string,
  ): Readonly<ConversationHandoffMarker> | undefined;
  markerForKey(
    conversationId: string,
    idempotencyKey: string,
  ): Readonly<ConversationHandoffMarker> | undefined;
  markersForConversation(
    conversationId: string,
  ): readonly Readonly<ConversationHandoffMarker>[];
}

function snapshot(
  marker: ConversationHandoffMarker,
): Readonly<ConversationHandoffMarker> {
  return Object.freeze({
    ...marker,
    ...(marker.contextSeed
      ? {
          contextSeed: Object.freeze({
            ...marker.contextSeed,
            sourceCutoffs: Object.freeze(
              marker.contextSeed.sourceCutoffs.map((cutoff) =>
                Object.freeze({ ...cutoff }),
              ),
            ),
            omission: Object.freeze({ ...marker.contextSeed.omission }),
          }),
        }
      : {}),
  });
}

/** The module's disclosure is structural, stable, and never provider-derived. */
export function createConversationHandoffModule(input: {
  persistence: ConversationHandoffPersistence;
  observe?: (outcome: 'created' | 'existing' | 'conflict') => void;
}): ConversationHandoffModule {
  const describe = (
    marker: ConversationHandoffMarker,
    outcome: 'created' | 'existing',
  ) => ({
    marker: snapshot(marker),
    outcome,
    carried: marker.nativeReturnSourceSessionId
      ? Object.freeze([
          ...CONVERSATION_HANDOFF_CARRIED_FIELDS,
          'nativeSession' as const,
        ])
      : CONVERSATION_HANDOFF_CARRIED_FIELDS,
    reset: marker.nativeReturnSourceSessionId
      ? Object.freeze(
          CONVERSATION_HANDOFF_RESET_FIELDS.filter(
            (field) => field !== 'providerNativeCursor',
          ),
        )
      : CONVERSATION_HANDOFF_RESET_FIELDS,
  });
  return {
    describe,
    markerForSession(sessionId) {
      const marker = input.persistence.findBySession(sessionId);
      return marker ? snapshot(marker) : undefined;
    },
    markerForPredecessor(sessionId) {
      const marker = input.persistence.findByPredecessor(sessionId);
      return marker ? snapshot(marker) : undefined;
    },
    markerForKey(conversationId, idempotencyKey) {
      const marker = input.persistence.findByKey(
        conversationId,
        idempotencyKey,
      );
      return marker ? snapshot(marker) : undefined;
    },
    markersForConversation(conversationId) {
      return Object.freeze(
        input.persistence
          .listByConversation(conversationId)
          .map((marker) => snapshot(marker)),
      );
    },
    reserve(marker) {
      try {
        const result = input.persistence.reserve(marker);
        try {
          input.observe?.(result.outcome);
        } catch {
          // OTel observation must never change the durable handoff outcome.
        }
        return describe(result.marker, result.outcome);
      } catch (error) {
        try {
          input.observe?.('conflict');
        } catch {
          // Same fail-open observation boundary for rejections.
        }
        throw error;
      }
    },
  };
}

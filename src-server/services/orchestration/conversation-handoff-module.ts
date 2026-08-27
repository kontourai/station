import {
  CONVERSATION_HANDOFF_CARRIED_FIELDS,
  CONVERSATION_HANDOFF_RESET_FIELDS,
  type ConversationHandoffResetField,
} from '@kontourai/station-contracts/orchestration';

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
  targetModelId?: string;
  messageDigest: string;
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

export interface ConversationHandoffPersistence {
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
    carried: typeof CONVERSATION_HANDOFF_CARRIED_FIELDS;
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
  return Object.freeze({ ...marker });
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
    carried: CONVERSATION_HANDOFF_CARRIED_FIELDS,
    reset: CONVERSATION_HANDOFF_RESET_FIELDS,
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

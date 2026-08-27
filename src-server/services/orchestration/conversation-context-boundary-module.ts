import type {
  ConversationContextBoundaryPolicy,
  ConversationContextBoundaryProjection,
  ConversationContextBoundaryStatus,
} from '@kontourai/station-contracts/conversation-context-boundary';
import {
  CONTEXT_BOUNDARY_OMITTED,
  CONTEXT_BOUNDARY_PRESERVED,
} from '@kontourai/station-contracts/conversation-context-boundary';

export interface ConversationContextBoundaryMarker {
  boundaryId: string;
  conversationId: string;
  predecessorSessionId: string;
  successorSessionId: string;
  idempotencyKey: string;
  policy: ConversationContextBoundaryPolicy;
  status: ConversationContextBoundaryStatus;
  actorId: string;
  clientOrigin?: string;
  createdAt: string;
  /** Exact internal start command that owns a claimed cold-start attempt. */
  startCommandId?: string;
  claimedAt?: string;
  consumedAt?: string;
}

export class ConversationContextBoundaryConflictError extends Error {
  readonly name = 'ConversationContextBoundaryConflictError';
  constructor(
    readonly code:
      | 'idempotency_mismatch'
      | 'successor_exists'
      | 'not_claimable',
  ) {
    super(`Conversation context boundary conflict: ${code}`);
  }
}

export interface ConversationContextBoundaryPersistence {
  reserve(input: ConversationContextBoundaryMarker): {
    marker: ConversationContextBoundaryMarker;
    outcome: 'created' | 'existing';
  };
  bySuccessor(sessionId: string): ConversationContextBoundaryMarker | undefined;
  byKey(
    conversationId: string,
    idempotencyKey: string,
  ): ConversationContextBoundaryMarker | undefined;
  listForConversation(
    conversationId: string,
  ): readonly ConversationContextBoundaryMarker[];
  update(
    boundaryId: string,
    from: readonly ConversationContextBoundaryStatus[],
    status: ConversationContextBoundaryStatus,
    at: string,
    startCommandId?: string,
  ): ConversationContextBoundaryMarker | undefined;
  /**
   * Cancel only an unclaimed reservation, atomically retiring its unstarted
   * successor lineage edge while retaining the marker as the audit record.
   */
  cancelReserved(
    boundaryId: string,
    at: string,
  ): ConversationContextBoundaryMarker | undefined;
  reconcile(): void;
}

const snapshot = (marker: ConversationContextBoundaryMarker) =>
  Object.freeze({ ...marker });
export function projectConversationContextBoundary(
  marker: ConversationContextBoundaryMarker,
): ConversationContextBoundaryProjection {
  const priorTranscriptInjected = marker.policy === 'continue-from-history';
  return Object.freeze({
    boundaryId: marker.boundaryId,
    conversationId: marker.conversationId,
    predecessorSessionId: marker.predecessorSessionId,
    successorSessionId: marker.successorSessionId,
    policy: marker.policy,
    status: marker.status,
    actorId: marker.actorId,
    ...(marker.clientOrigin ? { clientOrigin: 'request' as const } : {}),
    createdAt: marker.createdAt,
    ...(marker.claimedAt ? { claimedAt: marker.claimedAt } : {}),
    ...(marker.consumedAt ? { consumedAt: marker.consumedAt } : {}),
    priorTranscriptInjected,
    omitted:
      marker.policy === 'empty-next-cold-start' ? CONTEXT_BOUNDARY_OMITTED : [],
    preserved: CONTEXT_BOUNDARY_PRESERVED,
    retryable: marker.status === 'reserved' || marker.status === 'failed',
  });
}

export interface ConversationContextBoundaryModule {
  reserve(input: ConversationContextBoundaryMarker): {
    marker: Readonly<ConversationContextBoundaryMarker>;
    outcome: 'created' | 'existing';
  };
  forSuccessor(
    sessionId: string,
  ): Readonly<ConversationContextBoundaryMarker> | undefined;
  byKey(
    conversationId: string,
    idempotencyKey: string,
  ): Readonly<ConversationContextBoundaryMarker> | undefined;
  listForConversation(
    conversationId: string,
  ): readonly Readonly<ConversationContextBoundaryMarker>[];
  claimColdStart(
    boundaryId: string,
    startCommandId: string,
    at: string,
  ): Readonly<ConversationContextBoundaryMarker>;
  consumeAcceptedStart(
    boundaryId: string,
    startCommandId: string,
    at: string,
  ): Readonly<ConversationContextBoundaryMarker>;
  releaseProvablyFailedClaim(
    boundaryId: string,
    at: string,
  ): Readonly<ConversationContextBoundaryMarker>;
  markIndeterminate(
    boundaryId: string,
    at: string,
  ): Readonly<ConversationContextBoundaryMarker>;
  cancelReserved(
    boundaryId: string,
    at: string,
  ): Readonly<ConversationContextBoundaryMarker>;
  reconcileAtBoot(): void;
}

export function createConversationContextBoundaryModule(input: {
  persistence: ConversationContextBoundaryPersistence;
}): ConversationContextBoundaryModule {
  const transition = (
    id: string,
    from: readonly ConversationContextBoundaryStatus[],
    status: ConversationContextBoundaryStatus,
    at: string,
    startCommandId?: string,
  ) => {
    const marker = input.persistence.update(
      id,
      from,
      status,
      at,
      startCommandId,
    );
    if (!marker)
      throw new ConversationContextBoundaryConflictError('not_claimable');
    return snapshot(marker);
  };
  return {
    reserve(marker) {
      const result = input.persistence.reserve(marker);
      return { marker: snapshot(result.marker), outcome: result.outcome };
    },
    forSuccessor: (id) => {
      const marker = input.persistence.bySuccessor(id);
      return marker ? snapshot(marker) : undefined;
    },
    byKey: (conversationId, key) => {
      const marker = input.persistence.byKey(conversationId, key);
      return marker ? snapshot(marker) : undefined;
    },
    listForConversation: (conversationId) =>
      input.persistence
        .listForConversation(conversationId)
        .map((marker) => snapshot(marker)),
    claimColdStart: (id, startCommandId, at) =>
      transition(id, ['reserved', 'failed'], 'claimed', at, startCommandId),
    consumeAcceptedStart: (id, startCommandId, at) =>
      transition(id, ['claimed'], 'consumed', at, startCommandId),
    releaseProvablyFailedClaim: (id, at) =>
      transition(id, ['claimed'], 'failed', at),
    markIndeterminate: (id, at) =>
      transition(id, ['claimed'], 'indeterminate', at),
    cancelReserved: (id, at) => {
      const marker = input.persistence.cancelReserved(id, at);
      if (!marker)
        throw new ConversationContextBoundaryConflictError('not_claimable');
      return snapshot(marker);
    },
    reconcileAtBoot: () => input.persistence.reconcile(),
  };
}

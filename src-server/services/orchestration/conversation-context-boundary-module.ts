import type {
  ConversationContextBoundaryPolicy,
  ConversationContextBoundaryProjection,
  ConversationContextBoundarySeed,
  ConversationContextBoundaryStatus,
} from '@kontourai/station-contracts/conversation-context-boundary';
import type { EventStore } from './event-store.js';

/** A ready Task may repair its first context only while durable placement is definitely inactive. */
export function isReadyUnstartedTaskStateSession(
  store: EventStore,
  sessionId: string,
): boolean {
  if (
    !store.readProjectTaskRoomExecutionBinding(sessionId) ||
    store.readSessionByThread(sessionId)?.status !== 'ready' ||
    store.latestEventByMethod(sessionId, 'turn.started')
  )
    return false;
  const effect = store
    .sessionTurnBoundaryAuthority()
    .hasPossibleEffect(sessionId);
  return effect.kind === 'available' && !effect.active;
}

import {
  CONTEXT_BOUNDARY_OMITTED,
  CONTEXT_BOUNDARY_PRESERVED,
  isSummaryContextBoundary,
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
  seed?: ConversationContextBoundarySeed;
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

interface ConversationContextBoundaryPersistence {
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

export function assertConversationContextBoundarySeed(
  marker: Pick<
    ConversationContextBoundaryMarker,
    'policy' | 'seed' | 'predecessorSessionId'
  >,
): void {
  const seed = marker.seed;
  if (!isSummaryContextBoundary(marker.policy)) {
    if (seed)
      throw new Error('Legacy context boundary cannot carry a summary seed');
    return;
  }
  if (
    !seed ||
    typeof seed.text !== 'string' ||
    !seed.text.trim() ||
    seed.text.length > 16000 ||
    createHash('sha256').update(seed.text).digest('hex') !== seed.digest ||
    seed.sourceSessionId !== marker.predecessorSessionId ||
    !seed.sourceEventId ||
    !seed.sourceRevision ||
    (seed.sourceCutoffs !== undefined &&
      (!Array.isArray(seed.sourceCutoffs) ||
        seed.sourceCutoffs.length > 128 ||
        seed.sourceCutoffs.some(
          (cutoff) =>
            !cutoff ||
            typeof cutoff.sessionId !== 'string' ||
            !cutoff.sessionId ||
            !Number.isSafeInteger(cutoff.throughSequence) ||
            cutoff.throughSequence < 0,
        ) ||
        new Set(seed.sourceCutoffs.map((cutoff) => cutoff.sessionId)).size !==
          seed.sourceCutoffs.length)) ||
    (marker.policy === 'task-state-next-cold-start'
      ? seed.kind !== 'task-state' ||
        !seed.task?.taskId ||
        !seed.task.taskCreatedAt
      : seed.kind !== 'semantic-summary') ||
    (seed.kind === 'semantic-summary' && !seed.model) ||
    !['unknown', 'observed'].includes(seed.generationUsage?.state) ||
    (seed.generationUsage.state === 'observed' &&
      (!Number.isSafeInteger(seed.generationUsage.inputTokens) ||
        seed.generationUsage.inputTokens < 0 ||
        !Number.isSafeInteger(seed.generationUsage.outputTokens) ||
        seed.generationUsage.outputTokens < 0))
  )
    throw new Error('Context summary seed is missing, changed or unbound');
}
const snapshot = (marker: ConversationContextBoundaryMarker) => {
  assertConversationContextBoundarySeed(marker);
  return Object.freeze({
    ...marker,
    ...(marker.seed
      ? {
          seed: Object.freeze({
            ...marker.seed,
            generationUsage: Object.freeze({ ...marker.seed.generationUsage }),
            ...(marker.seed.task
              ? { task: Object.freeze({ ...marker.seed.task }) }
              : {}),
          }),
        }
      : {}),
  });
};
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
      marker.policy !== 'continue-from-history' ? CONTEXT_BOUNDARY_OMITTED : [],
    preserved: CONTEXT_BOUNDARY_PRESERVED,
    retryable: marker.status === 'reserved' || marker.status === 'failed',
    ...(marker.seed
      ? { seed: (({ text: _text, ...metadata }) => metadata)(marker.seed) }
      : {}),
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
      const result = input.persistence.reserve(snapshot(marker));
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

import { createHash } from 'node:crypto';

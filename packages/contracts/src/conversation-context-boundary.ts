/** Durable, Station-owned intent to replace a Conversation's next engine context. */
export type ConversationContextBoundaryPolicy =
  | 'continue-from-history'
  | 'empty-next-cold-start';

export type ConversationContextBoundaryStatus =
  | 'reserved'
  | 'claimed'
  | 'consumed'
  | 'cancelled'
  | 'failed'
  | 'indeterminate';

export interface ConversationContextBoundaryRequest {
  policy: ConversationContextBoundaryPolicy;
  idempotencyKey: string;
  /** Prevent a stale tab from resetting a newer execution Session. */
  expectedCurrentSessionId: string;
}

/** Browser-safe durable provenance; no provider cursor or transcript is exposed. */
export interface ConversationContextBoundaryProjection {
  boundaryId: string;
  conversationId: string;
  predecessorSessionId: string;
  successorSessionId: string;
  policy: ConversationContextBoundaryPolicy;
  status: ConversationContextBoundaryStatus;
  actorId: string;
  /** Bounded server observation; never reflects device, build, or headers. */
  clientOrigin?: 'request';
  createdAt: string;
  claimedAt?: string;
  consumedAt?: string;
  /** Explicit disclosure for Answer Basis and transcript renderers. */
  priorTranscriptInjected: boolean;
  omitted: readonly string[];
  preserved: readonly string[];
  retryable: boolean;
}

export interface ConversationContextBoundaryProvenance {
  boundaryId: string;
  policy: ConversationContextBoundaryPolicy;
  priorTranscriptInjected: boolean;
}

/**
 * A transcript-only projection of an effect that actually happened.  This is
 * deliberately smaller than the reservation/status response: a pending,
 * cancelled, failed, or indeterminate intent is not a transcript fact.
 */
export interface ConversationContextBoundaryTranscriptMarker
  extends ConversationContextBoundaryProvenance {
  successorSessionId: string;
  consumedAt: string;
}

export const CONTEXT_BOUNDARY_OMITTED = Object.freeze([
  'provider-native history',
  'tool state',
  'session approvals',
] as const);
export const CONTEXT_BOUNDARY_PRESERVED = Object.freeze([
  'canonical transcript',
  'Task links and evidence',
  'Agent, system, project, safety policy, tools, and skills',
  'current user turn',
] as const);

/** Durable, Station-owned intent to replace a Conversation's next engine context. */
export type ConversationContextBoundaryPolicy =
  | 'continue-from-history'
  | 'empty-next-cold-start'
  | 'summary-next-cold-start'
  | 'task-state-next-cold-start';

export interface ConversationContextBoundarySeed {
  kind: 'semantic-summary' | 'task-state';
  text: string;
  digest: string;
  sourceSessionId: string;
  sourceEventId: string;
  sourceRevision: string;
  task?: { taskId: string; taskCreatedAt: string };
  model?: string;
  generationUsage:
    | { state: 'unknown' }
    | { state: 'observed'; inputTokens: number; outputTokens: number };
  contextTokensBefore?: number;
  contextWindowTokens?: number;
}
export function isSummaryContextBoundary(
  policy: ConversationContextBoundaryPolicy,
): boolean {
  return (
    policy === 'summary-next-cold-start' ||
    policy === 'task-state-next-cold-start'
  );
}
export interface ConversationCompactionView {
  currentSessionId: string;
  state: 'ready' | 'busy' | 'engine-owned' | 'unsupported' | 'unknown';
  threshold: number;
  policyRevision: number;
  autoEnabled: boolean;
  reason?: string;
  operation?: {
    operationId: string;
    state: string;
    reason?: string;
    nextEligibleAt: number;
  };
}

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
  /** Server-produced only; route callers must never supply a generated summary. */
  seed?: ConversationContextBoundarySeed;
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
  seed?: Omit<ConversationContextBoundarySeed, 'text'>;
}

export interface ConversationContextBoundaryProvenance {
  boundaryId: string;
  policy: ConversationContextBoundaryPolicy;
  priorTranscriptInjected: boolean;
  seed?: Omit<ConversationContextBoundarySeed, 'text'>;
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
  'attachments and raw tool results from earlier context',
] as const);
export const CONTEXT_BOUNDARY_PRESERVED = Object.freeze([
  'canonical transcript',
  'Task links and evidence',
  'Agent, system, project, safety policy, tools, and skills',
  'current user turn',
] as const);

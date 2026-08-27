/**
 * A user-requested, discardable re-entry aid.  It is deliberately not a
 * transcript, Answer Basis, Task receipt, or verification authority.
 */
export const CONVERSATION_INTENT_SUMMARY_VERSION = 2 as const;
/** Shared structural collection ceiling for every producer and consumer. */
export const CONVERSATION_INTENT_SUMMARY_MAX_ITEMS = 32;

export interface ConversationIntentSummaryRange {
  fromMessageId: string;
  throughMessageId: string;
  messageCount: number;
}

export type ConversationIntentSummaryUsageReceipt =
  | { state: 'observed'; inputTokens: number; outputTokens: number }
  | { state: 'unknown' };

export type ConversationIntentSummaryVerificationRef =
  | {
      kind: 'task-turn';
      taskId: string;
      turnId: string;
      /** Only this state is an independently server-observed fact. */
      state: 'observed';
      /** A server-observed event pointer, never model supplied content. */
      eventId: string;
    }
  | {
      kind: 'task-turn';
      state: 'unavailable';
      unavailableReason:
        | 'not-captured-by-station'
        | 'not-authorized'
        | 'revoked';
    };

/**
 * A bounded, server-authorized pointer that may help a reader investigate
 * related work. It is deliberately not an independent verification claim.
 */
export interface ConversationIntentSummaryRelatedEvidenceRef {
  kind: 'task-turn';
  taskId: string;
  turnId: string;
  eventId: string;
}

/** Exact consumed-context disclosure supplied by the runtime event window. */
export interface ConversationIntentSummaryContextBoundary {
  boundaryId: string;
  policy: 'continue-from-history' | 'empty-next-cold-start';
  priorTranscriptInjected: boolean;
}

export interface ConversationIntentSummaryV1 {
  version: 1;
  text: string;
  model: string;
  generatedAt: string;
  summarizedFromMessageId: string;
  summarizedThroughMessageId: string;
  summarizedMessageCount: number;
  sourceMessageCount: number;
  partialMessageIncluded: boolean;
  stale: boolean;
}

export interface ConversationIntentSummaryV2 {
  version: typeof CONVERSATION_INTENT_SUMMARY_VERSION;
  /** Compatibility projection for v1 readers; derived from `overview`. */
  text: string;
  overview: string;
  goals: string[];
  constraints: string[];
  progress: string[];
  nextSteps: string[];
  /** What the model reports, explicitly not an independently verified fact. */
  reportedCompletion: string[];
  /** Related Task/turn pointers; these never prove reported completion. */
  relatedEvidenceRefs: ConversationIntentSummaryRelatedEvidenceRef[];
  verificationRefs: ConversationIntentSummaryVerificationRef[];
  model: string;
  generatedAt: string;
  sourceRange: ConversationIntentSummaryRange;
  /** Digest of authorized message ids/content and consumed boundary markers. */
  sourceRevision: string;
  /** Non-contiguous bounded transcript selections are disclosed explicitly. */
  sourceRanges: ConversationIntentSummaryRange[];
  sourceMessageCount: number;
  partialMessageIncluded: boolean;
  contextBoundaryCount: number;
  /** Consumed #4148 context-boundary facts, copied from the authorized source. */
  contextBoundaries: readonly ConversationIntentSummaryContextBoundary[];
  /** Model usage is a receipt only when the server observed both counters. */
  generationUsage: ConversationIntentSummaryUsageReceipt;
  /** Server-derived currentness; never persisted as a claim. */
  stale: boolean;
}

/** Public reads are always a real versioned union; do not pretend v1 is v2. */
export type ConversationIntentSummary =
  | ConversationIntentSummaryV1
  | ConversationIntentSummaryV2;

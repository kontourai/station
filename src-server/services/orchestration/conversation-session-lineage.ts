/**
 * Durable boundary between a human-visible conversation and replaceable
 * execution sessions. This slice records only today's legacy one-to-one shape
 * and deliberately does not alter continuation or lifecycle behavior.
 */
export interface ConversationSessionLineage {
  conversationId: string;
  sessionId: string;
  ordinal: number;
  predecessorSessionId?: string;
  createdAt: string;
}

export type ConversationSessionLineageConflictReason =
  | 'session-already-linked'
  | 'ordinal-already-linked'
  | 'immutable-facts-mismatch';

/**
 * A requested lineage fact conflicts with an immutable durable mapping.
 * Callers may report the bounded reason; they must never retry with a changed
 * identity and call the conflicting row an idempotent replay.
 */
export class ConversationSessionLineageConflictError extends Error {
  readonly name = 'ConversationSessionLineageConflictError';

  constructor(
    readonly reason: ConversationSessionLineageConflictReason,
    readonly requested: Readonly<ConversationSessionLineage>,
    readonly existing: Readonly<ConversationSessionLineage>,
  ) {
    super(
      reason === 'session-already-linked'
        ? `Execution session "${requested.sessionId}" is already linked to conversation "${existing.conversationId}".`
        : reason === 'ordinal-already-linked'
          ? `Conversation "${requested.conversationId}" ordinal ${requested.ordinal} is already linked to execution session "${existing.sessionId}".`
          : `Execution session "${requested.sessionId}" has conflicting immutable lineage facts.`,
    );
  }
}

export type ConversationSessionLineageStructureReason =
  | 'invalid-root'
  | 'missing-predecessor'
  | 'conversation-mismatch'
  | 'ordinal-mismatch'
  | 'cycle'
  | 'branch'
  | 'provider-session-unmapped';

/** A persisted lineage graph is structurally impossible or ambiguous. */
export class ConversationSessionLineageStructureError extends Error {
  readonly name = 'ConversationSessionLineageStructureError';

  constructor(
    readonly reason: ConversationSessionLineageStructureReason,
    readonly lineage: Readonly<ConversationSessionLineage>,
    readonly related?: Readonly<ConversationSessionLineage>,
  ) {
    super(
      `Conversation Session lineage is invalid (${reason}) at execution session "${lineage.sessionId}".`,
    );
  }
}

export function isSameConversationSessionLineage(
  left: Readonly<ConversationSessionLineage>,
  right: Readonly<ConversationSessionLineage>,
): boolean {
  return (
    left.conversationId === right.conversationId &&
    left.sessionId === right.sessionId &&
    left.ordinal === right.ordinal &&
    left.predecessorSessionId === right.predecessorSessionId &&
    left.createdAt === right.createdAt
  );
}

export interface ConversationSessionLineagePersistence {
  recordInitial(lineage: ConversationSessionLineage): {
    lineage: ConversationSessionLineage;
    outcome: 'created' | 'existing';
  };
  backfillLegacy(): { backfilled: number; reconciled: number };
  list(conversationId: string): readonly ConversationSessionLineage[];
  findBySession(sessionId: string): ConversationSessionLineage | undefined;
  /**
   * Atomically reserve exactly one next child for an observed predecessor.
   * A concurrent caller observing the same predecessor receives that same
   * child instead of allocating a competing execution session.
   */
  reserveNext(input: {
    conversationId: string;
    predecessorSessionId: string;
    proposedSessionId: string;
    createdAt: string;
  }): { lineage: ConversationSessionLineage; outcome: 'created' | 'existing' };
}

/** Intent-shaped interface; callers cannot perform arbitrary table mutations. */
export interface ConversationSessionLineageModule {
  establishInitialSession(input: {
    conversationId: string;
    sessionId: string;
    createdAt: string;
  }): Readonly<ConversationSessionLineage>;
  backfillLegacySessions(): number;
  sessionsForConversation(
    conversationId: string,
  ): readonly Readonly<ConversationSessionLineage>[];
  sessionForExecution(
    sessionId: string,
  ): Readonly<ConversationSessionLineage> | undefined;
  reserveNextSession(input: {
    conversationId: string;
    predecessorSessionId: string;
    proposedSessionId: string;
    createdAt: string;
  }): {
    lineage: Readonly<ConversationSessionLineage>;
    outcome: 'created' | 'existing';
  };
}

function snapshot(
  value: ConversationSessionLineage,
): Readonly<ConversationSessionLineage> {
  return Object.freeze({ ...value });
}

export function createConversationSessionLineageModule(options: {
  persistence: ConversationSessionLineagePersistence;
  observeMutation?: (
    outcome: 'created' | 'existing' | 'backfilled' | 'reconciled',
  ) => void;
}): ConversationSessionLineageModule {
  return {
    establishInitialSession(input) {
      const result = options.persistence.recordInitial({
        ...input,
        ordinal: 0,
      });
      options.observeMutation?.(result.outcome);
      return snapshot(result.lineage);
    },
    backfillLegacySessions() {
      const { backfilled, reconciled } = options.persistence.backfillLegacy();
      if (backfilled > 0) options.observeMutation?.('backfilled');
      if (reconciled > 0) options.observeMutation?.('reconciled');
      return backfilled + reconciled;
    },
    sessionsForConversation(conversationId) {
      return options.persistence.list(conversationId).map(snapshot);
    },
    sessionForExecution(sessionId) {
      const lineage = options.persistence.findBySession(sessionId);
      return lineage ? snapshot(lineage) : undefined;
    },
    reserveNextSession(input) {
      const result = options.persistence.reserveNext(input);
      options.observeMutation?.(result.outcome);
      return { lineage: snapshot(result.lineage), outcome: result.outcome };
    },
  };
}

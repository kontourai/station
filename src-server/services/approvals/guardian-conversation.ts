import type { TurnDispatchOrigin } from '@kontourai/station-contracts/runtime-events';

/**
 * #4827: what the approval guardian is told about the conversation a tool
 * call belongs to, and how often it has refused calls there.
 */

/** Prompts read per conversation; one more marks earlier ones as omitted. */
export const GUARDIAN_PERSON_TURN_LIMIT = 20;
/** Characters kept from one prompt. */
export const GUARDIAN_PERSON_TURN_CHARS = 1_500;
/** Characters kept across every prompt shown. */
export const GUARDIAN_PERSON_TOTAL_CHARS = 8_000;
/** Sessions of one conversation read, newest first. */
const GUARDIAN_SESSION_LIMIT = 16;

export interface GuardianConversationIntent {
  /** What the person typed, oldest first, each bounded. Never tool output. */
  personTurns: string[];
  /** The bounds left out earlier person prompts (how many is not read). */
  earlierPersonTurnsOmitted: boolean;
  /**
   * The thread's newest turn was sent by a person, so a request for this
   * call reaches someone who sent the turn. Anything else (an Automation, a
   * Task, a delegated agent, an unknown sender) is no person path.
   */
  currentTurnInteractive: boolean;
}

export const NO_PERSON_INTENT: GuardianConversationIntent = Object.freeze({
  personTurns: [],
  earlierPersonTurnsOmitted: false,
  currentTurnInteractive: false,
}) as GuardianConversationIntent;

/** The orchestration event store reads the reader is built from. */
export interface GuardianPersonTurnStore {
  interactiveTurnPrompts(
    threadIds: readonly string[],
    limit: number,
  ): Array<{ prompt: string; globalSequence: number }>;
  latestTurnDispatchOrigin(threadId: string): TurnDispatchOrigin | undefined;
  conversationLineageForThreads(
    threadIds: readonly string[],
  ): Map<string, { conversationId: string; sessionIds: string[] }>;
}

export type GuardianConversationReader = (
  conversationId: string,
) => GuardianConversationIntent;

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * Reads the person's own turns from Station's event store, never from an
 * engine's transcript or Station's chat memory, which also hold tool results
 * and replies. `conversationId` is the orchestration thread every engine
 * adapter passes as `InvocationContext.conversationId`; its whole
 * conversation (earlier Sessions included) is read.
 *
 * Bounds: the newest {@link GUARDIAN_PERSON_TURN_LIMIT} prompts, each cut to
 * {@link GUARDIAN_PERSON_TURN_CHARS}, and older prompts dropped once
 * {@link GUARDIAN_PERSON_TOTAL_CHARS} is spent. The newest are kept because
 * the latest request is what most often authorizes the call at hand.
 */
export function createGuardianConversationReader(
  store: GuardianPersonTurnStore,
): GuardianConversationReader {
  return (conversationId) => {
    const lineage = store
      .conversationLineageForThreads([conversationId])
      .get(conversationId);
    const sessions = lineage?.sessionIds.length
      ? lineage.sessionIds.slice(-GUARDIAN_SESSION_LIMIT)
      : [conversationId];
    if (!sessions.includes(conversationId)) sessions.push(conversationId);
    const newestFirst = store.interactiveTurnPrompts(
      sessions,
      GUARDIAN_PERSON_TURN_LIMIT + 1,
    );
    let omitted = newestFirst.length > GUARDIAN_PERSON_TURN_LIMIT;
    const kept: string[] = [];
    let budget = GUARDIAN_PERSON_TOTAL_CHARS;
    for (const entry of newestFirst.slice(0, GUARDIAN_PERSON_TURN_LIMIT)) {
      const text = truncate(entry.prompt.trim(), GUARDIAN_PERSON_TURN_CHARS);
      if (!text) continue;
      if (text.length > budget) {
        omitted = true;
        break;
      }
      budget -= text.length;
      kept.push(text);
    }
    return {
      personTurns: kept.reverse(),
      earlierPersonTurnsOmitted: omitted,
      currentTurnInteractive:
        store.latestTurnDispatchOrigin(conversationId) === 'interactive',
    };
  };
}

/** Consecutive guardian denials after which the next one asks the person. */
export const GUARDIAN_ESCALATE_AFTER_CONSECUTIVE = 3;
/** Guardian denials in one conversation after which every further one asks. */
export const GUARDIAN_ESCALATE_AFTER_TOTAL = 20;
const GUARDIAN_LEDGER_CONVERSATIONS = 1_024;

/**
 * #4827: per-conversation guardian denial counts. A guardian that keeps
 * refusing is no reason to stop the work unseen: once it has refused
 * {@link GUARDIAN_ESCALATE_AFTER_CONSECUTIVE} calls in a row, or
 * {@link GUARDIAN_ESCALATE_AFTER_TOTAL} in the conversation, its next refusal
 * goes to the person instead. An allow resets the run; so does an
 * escalation, because the person has then been brought in.
 *
 * Process memory, bounded to the most recently used conversations. Losing an
 * entry (restart, eviction) only delays the next escalation: the guardian's
 * refusals keep refusing, which is the behaviour before this existed.
 */
export class GuardianDenialLedger {
  private readonly entries = new Map<string, { row: number; total: number }>();

  private touch(conversationId: string) {
    const entry = this.entries.get(conversationId) ?? { row: 0, total: 0 };
    this.entries.delete(conversationId);
    this.entries.set(conversationId, entry);
    if (this.entries.size > GUARDIAN_LEDGER_CONVERSATIONS) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    return entry;
  }

  recordAllow(conversationId: string): void {
    this.touch(conversationId).row = 0;
  }

  /**
   * Counts one guardian denial and says whether it should go to the person:
   * true when the denials BEFORE this one already reached a threshold.
   */
  recordDenial(conversationId: string): { escalate: boolean } {
    const entry = this.touch(conversationId);
    const escalate =
      entry.row >= GUARDIAN_ESCALATE_AFTER_CONSECUTIVE ||
      entry.total >= GUARDIAN_ESCALATE_AFTER_TOTAL;
    entry.row += 1;
    entry.total += 1;
    return { escalate };
  }

  /** The person was asked about a refused call: start a new run. */
  recordEscalation(conversationId: string): void {
    this.touch(conversationId).row = 0;
  }
}

/** One ledger for every Agent's evaluator, as conversations span engines. */
export const sharedGuardianDenialLedger = new GuardianDenialLedger();

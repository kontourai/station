import type { OrchestrationSessionSummary } from '@kontourai/station-contracts/orchestration';
import type { ActivitySessionPresentation } from './run-groups';

export interface ConversationTurnFold {
  /** Input order preserved; folded-away sibling turn-sessions removed. */
  presentations: ActivitySessionPresentation[];
  /**
   * Representative threadId → number of member turn-sessions folded behind
   * that row (always ≥ 2; a conversation with one session records nothing).
   */
  turnCounts: ReadonlyMap<string, number>;
}

/**
 * Durable conversation identity, the SAME rule Home's work-item merge uses
 * (`localConversationIdentity` in `home-view-model.ts`): the server-stamped
 * `conversationId` when present, else the session's own thread id. The
 * lineage service mints continuation children with the root's conversation
 * id, so the root (whose own id IS the conversation id) and its children
 * share one key. Two sessions with NO conversation identity can never fold —
 * absence is not corroboration, matching `run-groups.ts`' doctrine.
 */
function conversationIdentity(session: OrchestrationSessionSummary): string {
  return session.conversationId ?? session.threadId;
}

/**
 * Presentation-only conversation folding for the Activity list (#765
 * residue, A2-adjacent).
 *
 * The orchestration runtime opens a NEW engine session per continuation turn
 * (`conversation-lineage.ts`), so a three-turn chat lists as three sibling
 * rows — "Recently finished" reads as fragmentation even when continuity
 * worked. Home already folds these into one conversation row
 * (`mergeHomeWorkItems`); this brings the Activity list into the same
 * per-conversation population without touching the session model or the lane
 * classifier: lanes still classify every session, and this fold only decides
 * which member REPRESENTS the conversation on screen.
 *
 * Rules:
 * - Operates AFTER delegated-run grouping: run groups pass through verbatim,
 *   and their members (already presentation units of a run) never fold here.
 * - Flat delegated sessions are exempt too — delegation is run-groups.ts'
 *   population, and folding a stray worker under a chat row would misfile it.
 * - The representative is the FIRST member in input order. The caller feeds
 *   lane-partitioned rows (Needs you → Active now → Recently finished →
 *   Earlier, newest-first within a lane), so the representative is the
 *   highest-priority, newest member — newest state wins, and a conversation
 *   with an active turn renders in Active now, not once per finished turn.
 * - `pinnedThreadId` (the selected session) exempts its whole conversation:
 *   a deep link or explicit selection of an older turn keeps every turn
 *   visible while the reader is inspecting it, so the selected row cannot
 *   vanish under its own fold.
 */
export function foldConversationTurns(
  presentations: readonly ActivitySessionPresentation[],
  { pinnedThreadId }: { pinnedThreadId?: string | null } = {},
): ConversationTurnFold {
  const membersByConversation = new Map<
    string,
    OrchestrationSessionSummary[]
  >();
  for (const presentation of presentations) {
    if (presentation.kind !== 'session') continue;
    if (presentation.session.delegation) continue;
    const key = conversationIdentity(presentation.session);
    const members = membersByConversation.get(key) ?? [];
    members.push(presentation.session);
    membersByConversation.set(key, members);
  }

  const foldedAway = new Set<string>();
  const turnCounts = new Map<string, number>();
  for (const members of membersByConversation.values()) {
    if (members.length < 2) continue;
    if (
      pinnedThreadId &&
      members.some((member) => member.threadId === pinnedThreadId)
    ) {
      continue;
    }
    const [representative, ...rest] = members;
    turnCounts.set(representative.threadId, members.length);
    for (const member of rest) {
      foldedAway.add(member.threadId);
    }
  }

  return {
    presentations: presentations.filter(
      (presentation) =>
        presentation.kind !== 'session' ||
        !foldedAway.has(presentation.session.threadId),
    ),
    turnCounts,
  };
}

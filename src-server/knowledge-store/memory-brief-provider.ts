import type { KnowledgeStoreRoot } from '@kontourai/station-contracts/knowledge-store';
import type { SessionReadAuthority } from '@kontourai/station-contracts/tenancy';
import type { MemoryReviewService } from './memory-review.js';
import type { MemoryRootManager } from './memory-root.js';

export interface MemoryBriefProviderDeps {
  manager: Pick<MemoryRootManager, 'findRoot'>;
  review: Pick<MemoryReviewService, 'brief'>;
  enabled: () => boolean;
  /** The person asking, derived from the request, or none. */
  authority: (request: Request) => SessionReadAuthority | undefined;
  isRequestCurrent: (request: Request) => boolean;
  mayReadRoot: (request: Request, root: KnowledgeStoreRoot) => Promise<boolean>;
  guardReadResponse: (
    request: Request,
    roots: readonly KnowledgeStoreRoot[],
    response: Response,
  ) => Promise<Response>;
}

/**
 * The brief for a new session's first turn. It takes the same steps as the
 * brief route: derive the person from the request, find only their root,
 * check they may read it, and let the delivery guard have the last word.
 * Anything short of all of that is no brief, never someone else's memory.
 */
export function createMemoryBriefProvider(deps: MemoryBriefProviderDeps) {
  // A conversation is briefed once. Station's relay sends every turn as plain
  // text, so "first turn" cannot be read from the message; it is the first time
  // this person's conversation asks. A restart forgets, and briefs a long-running
  // conversation once more, still as labelled background.
  const briefed = new Set<string>();
  return async (
    request: Request,
    session: {
      relayOwner?: string | null;
      conversationId?: string;
    } = {},
  ): Promise<{ text: string | null; entries: number } | null> => {
    if (!deps.enabled()) return null;
    const scope = deps.authority(request);
    if (!scope || scope.mode !== 'personal' || !deps.isRequestCurrent(request))
      return null;
    // Station's relay carries its own internal identity, which is the local
    // operator whoever the session belongs to. The brief follows the session's
    // owner: with no recorded owner, or another person, there is no brief.
    if (session.relayOwner === null) return null;
    if (session.relayOwner !== undefined && session.relayOwner !== scope.userId)
      return null;
    if (session.conversationId) {
      const key = `${scope.userId}\u0000${session.conversationId}`;
      if (briefed.has(key)) return null;
      briefed.add(key);
      if (briefed.size > 5000) {
        const oldest = briefed.values().next().value;
        if (oldest !== undefined) briefed.delete(oldest);
      }
    }
    const assertCurrent = () => {
      if (!deps.enabled() || request.signal.aborted)
        throw new Error('Private memory authority ended.');
    };
    const root = await deps.manager.findRoot(scope, assertCurrent);
    if (!root || !(await deps.mayReadRoot(request, root))) return null;
    const brief = await deps.review.brief(scope, root, assertCurrent);
    const guarded = await deps.guardReadResponse(
      request,
      [root],
      new Response(null, { status: 200 }),
    );
    return guarded.ok
      ? { text: brief.text, entries: brief.entries.length }
      : null;
  };
}

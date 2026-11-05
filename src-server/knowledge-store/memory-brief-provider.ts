import { createHash } from 'node:crypto';
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
  // this person's conversation gets a brief. A restart forgets, and briefs a
  // long-running conversation once more, still as labelled background.
  //
  // `done` holds conversations whose brief was built and delivered (including an
  // empty one); `working` holds those being built right now, so two turns cannot
  // both brief. A refused or failed attempt is in neither, so a later turn retries.
  // Keys are hashes, so a long caller-chosen id costs a fixed 32 bytes.
  const done = new Set<string>();
  const working = new Set<string>();
  const MAX_REMEMBERED = 5000;
  const keyOf = (userId: string, conversationId: string) =>
    createHash('sha256')
      .update(`${userId}\u0000${conversationId}`)
      .digest('hex');
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
    const key = session.conversationId
      ? keyOf(scope.userId, session.conversationId)
      : undefined;
    if (key && (done.has(key) || working.has(key))) return null;
    if (key) working.add(key);
    try {
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
      if (!guarded.ok) return null;
      if (key) {
        done.add(key);
        if (done.size > MAX_REMEMBERED) {
          const oldest = done.values().next().value;
          if (oldest !== undefined) done.delete(oldest);
        }
      }
      return { text: brief.text, entries: brief.entries.length };
    } finally {
      if (key) working.delete(key);
    }
  };
}

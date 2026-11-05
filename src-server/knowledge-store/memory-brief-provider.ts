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
/**
 * How a brief's turn ended. The caller reports exactly one of these:
 * `delivered` when the agent is actually invoked with the brief in its input,
 * `abandoned` when the turn ends first for any other reason (a refusal, a
 * replayed turn, an error). Until then the conversation is only reserved.
 */
export interface MemoryBriefDelivery {
  delivered(): void;
  abandoned(): void;
}

export interface MemoryBrief extends MemoryBriefDelivery {
  text: string | null;
  entries: number;
}

export function createMemoryBriefProvider(
  deps: MemoryBriefProviderDeps & { now?: () => number },
) {
  // A conversation is briefed once. Station's relay sends every turn as plain
  // text, so "first turn" cannot be read from the message; it is the first time
  // this person's conversation gets a brief to the model. A restart forgets, and
  // briefs a long-running conversation once more, still as labelled background.
  //
  // `done`: briefed (or nothing to brief). `reserved`: a brief is being built or is
  // on its way, until `commit` or the reservation lapses. A refused or failed
  // attempt leaves neither, so a later turn retries. Keys are hashes, so a long
  // caller-chosen id costs a fixed 64 characters.
  const now = deps.now ?? Date.now;
  const done = new Set<string>();
  const reserved = new Map<string, number>();
  const MAX_REMEMBERED = 5000;
  // Only a backstop for a turn that never reports (a crash mid-request): every
  // normal ending reports `delivered` or `abandoned`, which settles it at once.
  const RESERVATION_MS = 10 * 60_000;
  const keyOf = (userId: string, conversationId: string) =>
    createHash('sha256')
      .update(`${userId}\u0000${conversationId}`)
      .digest('hex');
  const finish = (key: string) => {
    reserved.delete(key);
    done.add(key);
    if (done.size > MAX_REMEMBERED) {
      const oldest = done.values().next().value;
      if (oldest !== undefined) done.delete(oldest);
    }
  };
  return async (
    request: Request,
    session: {
      relayOwner?: string | null;
      conversationId?: string;
    } = {},
  ): Promise<MemoryBrief | null> => {
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
    if (key) {
      const until = reserved.get(key);
      if (done.has(key) || (until !== undefined && until > now())) return null;
      if (reserved.size > 1000)
        for (const [held, expiry] of reserved)
          if (expiry <= now()) reserved.delete(held);
      reserved.set(key, now() + RESERVATION_MS);
    }
    let handedOff = false;
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
      if (!brief.text) {
        if (key) finish(key);
        return {
          text: null,
          entries: 0,
          delivered: () => {},
          abandoned: () => {},
        };
      }
      handedOff = true;
      return {
        text: brief.text,
        entries: brief.entries.length,
        delivered: () => {
          if (key) finish(key);
        },
        // After delivery this is a no-op: the conversation stays briefed.
        abandoned: () => {
          if (key && !done.has(key)) reserved.delete(key);
        },
      };
    } finally {
      if (key && !handedOff) reserved.delete(key);
    }
  };
}

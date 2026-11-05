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
  return async (
    request: Request,
  ): Promise<{ text: string | null; entries: number } | null> => {
    if (!deps.enabled()) return null;
    const scope = deps.authority(request);
    if (!scope || scope.mode !== 'personal' || !deps.isRequestCurrent(request))
      return null;
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

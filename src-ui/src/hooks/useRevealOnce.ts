import { useRef } from 'react';

/**
 * Identity-keyed reveal-once entrances (archive#2651).
 *
 * A transcript block gets its entrance animation the FIRST time its stable
 * identity (tool call id, message id) is ever rendered — and never again.
 * Keying to identity instead of component mount is the whole point: the
 * virtualizer recycles row components as you scroll, stream→history promotion
 * re-renders the same tool call under a different parent, and expand/collapse
 * remounts work rows. None of those may replay the entrance, because nothing
 * new happened to the underlying block.
 *
 * Scoping choice (documented per the issue): the seen-id registry is
 * module-scope — deliberately outside React — precisely so remounts cannot
 * reset it. Ids are already globally unique (tool call ids / message ids are
 * conversation-scoped upstream), so rather than partitioning per conversation
 * we bound total memory with a FIFO cap: once REVEALED_IDS_CAP identities have
 * been seen, the oldest entries are evicted (Set preserves insertion order).
 * Worst case on eviction is one cosmetic re-reveal of a block last seen
 * thousands of blocks ago — an unbounded session can never grow the registry
 * past the cap.
 *
 * Standing assumption (review note): the per-instance latch below relies on
 * consumer lists being keyed by stable anchor/row ids (ChatMessageList /
 * TranscriptVirtualizer today). Re-keying those lists to positional keys
 * would recycle instances across DIFFERENT ids and reintroduce replay — if
 * you change list keying, re-run this hook's remount/recycle tests.
 */
const REVEALED_IDS_CAP = 4000;

const revealedIds = new Set<string>();

function claimFirstSight(id: string): boolean {
  if (revealedIds.has(id)) return false;
  revealedIds.add(id);
  if (revealedIds.size > REVEALED_IDS_CAP) {
// FIFO eviction: drop the oldest-seen identity.
    const oldest = revealedIds.values().next().value;
    if (oldest !== undefined) revealedIds.delete(oldest);
  }
  return true;
}

/** Test-only: reset the module-scope registry between test cases. */
export function resetRevealedIdsForTest(): void {
  revealedIds.clear();
}

/**
 * Returns `'reveal-once'` on the render pass that first sees `id` (and on
 * every re-render of that same component instance for that id, so the CSS
 * animation is never cancelled mid-flight), `''` for every later sighting of
 * the id — including a fresh mount after unmount.
 *
 * An `undefined`/empty id never reveals: without a stable identity there is
 * no way to promise "once", so we honestly skip the entrance instead of
 * replaying it on every mount.
 *
 * The claim happens during render (module-scope registry mutation). That is
 * intentional and idempotent per id; the one caveat is a render React
 * discards (concurrent mode) claims the id without painting, so that block's
 * entrance is skipped rather than replayed — the safe failure direction.
 */
export function useRevealOnce(id: string | undefined): string {
// Latched per id so a recycled component instance re-used for a DIFFERENT
// row (virtualizer) re-evaluates, while re-renders for the same id stay
// stable.
  const claimedByIdRef = useRef<Map<string, boolean>>(new Map());
  if (!id) return '';
  let claimed = claimedByIdRef.current.get(id);
  if (claimed === undefined) {
    claimed = claimFirstSight(id);
    claimedByIdRef.current.set(id, claimed);
  }
  return claimed ? 'reveal-once' : '';
}

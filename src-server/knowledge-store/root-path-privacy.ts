import type { KnowledgeStoreRoot } from '@kontourai/station-contracts/knowledge-store';
import {
  canonicalPathThroughExistingAncestor,
  isCanonicalPathWithin,
} from '../utils/path-containment.js';

/** A shared registration cannot alias a private store, including through a parent or symlink. */
export function assertNoPrivateRootOverlap(
  root: KnowledgeStoreRoot,
  roots: readonly KnowledgeStoreRoot[],
): void {
  const others = roots.filter((candidate) => candidate.id !== root.id);
  if (!root.readPolicy && !others.some((candidate) => candidate.readPolicy))
    return;
  const path = canonicalPathThroughExistingAncestor(root.storeRoot);
  for (const candidate of others) {
    if (!root.readPolicy && !candidate.readPolicy) continue;
    const other = canonicalPathThroughExistingAncestor(candidate.storeRoot);
    if (
      isCanonicalPathWithin(path, other) ||
      isCanonicalPathWithin(other, path)
    )
      throw new Error(
        'Private knowledge source overlaps another registration.',
      );
  }
}

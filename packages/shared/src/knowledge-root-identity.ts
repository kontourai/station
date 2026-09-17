import type { KnowledgeStoreRoot } from '@kontourai/station-contracts/knowledge-store';

/** Registration metadata precondition only: not authorization, an immutable incarnation, or an owner revision. Identically restored metadata can share a key. */
export const KNOWLEDGE_ROOT_IDENTITY_HEADER =
  'x-station-knowledge-root-identity';
export const KNOWLEDGE_ROOT_IDENTITY_MAX_CHARS = 8_192;

export function knowledgeRootIncarnationKey(root: KnowledgeStoreRoot): string {
  return JSON.stringify([
    root.id,
    root.scope.kind,
    root.scope.kind === 'project' ? root.scope.projectSlug : null,
    root.adapterId,
    root.storeRoot,
    root.displayName,
    root.createdAt,
  ]);
}

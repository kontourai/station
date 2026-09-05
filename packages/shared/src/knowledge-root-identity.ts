import type { KnowledgeStoreRoot } from '@kontourai/station-contracts/knowledge-store';

/** Registration identity precondition only: not authorization or an owner revision. */
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

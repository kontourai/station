import type { KnowledgeStoreRoot } from '@kontourai/station-contracts/knowledge-store';

/** Registration metadata precondition, including the issued registration ID when present. Not authorization, a record version, or an owner revision; restored metadata can retain a key. */
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
    ...(root.projectId || root.registrationId ? [root.projectId ?? null] : []),
    ...(root.registrationId ? [root.registrationId] : []),
  ]);
}

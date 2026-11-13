import type { GlobalKnowledgeStatus } from '@kontourai/station-sdk';
import { connectionVerdictTone } from '../../components/kontour/station-tones';
import type { ResourceStatus } from '../../components/resource-hub/resource-status';

/** Where the one fix for semantic search goes. */
export type KnowledgeFix =
  | { kind: 'add-store' }
  | { kind: 'add-embedding' }
  | { kind: 'open-model'; connectionId: string };

export interface KnowledgeReadiness extends ResourceStatus {
  on: boolean;
  fix?: KnowledgeFix & { label: string };
}

/**
 * Whether semantic search is on, and why not, from the knowledge status
 * route: it needs a vector store and an embedding model, both turned on.
 * Off for want of an embedding model is a resting state, not an attention
 * mark; a missing or turned-off vector store is marked on the Overview
 * (`connection-section-signals`).
 */
export function knowledgeReadiness(
  status: Pick<GlobalKnowledgeStatus, 'vectorDb' | 'embedding'>,
): KnowledgeReadiness {
  const off = (
    reason: string,
    fix?: KnowledgeReadiness['fix'],
  ): KnowledgeReadiness => ({
    on: false,
    label: 'Semantic search off',
    tone: connectionVerdictTone('setup'),
    reason,
    ...(fix ? { fix } : {}),
  });
  if (!status.vectorDb)
    return off('No vector store.', {
      kind: 'add-store',
      label: 'Add a knowledge source',
    });
  if (!status.vectorDb.enabled) return off('The vector store is turned off.');
  if (!status.embedding)
    return off('No embedding model.', {
      kind: 'add-embedding',
      label: 'Add an embedding model',
    });
  if (!status.embedding.enabled)
    return off('The embedding model is turned off.', {
      kind: 'open-model',
      connectionId: status.embedding.id,
      label: 'Open it',
    });
  return {
    on: true,
    label: 'Semantic search on',
    tone: connectionVerdictTone('ready'),
  };
}

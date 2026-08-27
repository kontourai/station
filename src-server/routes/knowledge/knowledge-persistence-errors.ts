import {
  KnowledgeStoreConflictError,
  KnowledgeStoreCorruptionError,
  KnowledgeStoreUnavailableError,
} from '../../knowledge-store/errors.js';

export type KnowledgePersistenceErrorProjection = {
  status: 409 | 503;
  error: string;
};

/** Stable public projection for the shared file-authority failure contract. */
export function projectKnowledgePersistenceError(
  error: unknown,
): KnowledgePersistenceErrorProjection | null {
  if (error instanceof KnowledgeStoreConflictError) {
    return {
      status: 409,
      error: 'Knowledge store changed; retry the operation.',
    };
  }
  if (
    error instanceof KnowledgeStoreCorruptionError ||
    error instanceof KnowledgeStoreUnavailableError
  ) {
    return {
      status: 503,
      error:
        'Knowledge store is unavailable until its persisted state is repaired.',
    };
  }
  return null;
}

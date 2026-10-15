/**
 * The embedding generation a Knowledge index vector belongs to (#2727).
 * Vectors are comparable only when the same provider kind, model and output
 * width produced them; equal width alone proves nothing. Credentials and
 * endpoints are deliberately excluded: the same model name served from a
 * different endpoint is assumed to embed identically.
 */
import type { IEmbeddingProvider } from '@kontourai/station-contracts/knowledge-index';

/**
 * An embedder that does not declare `embeddingIdentity()` falls back to its
 * provider `id`. That fallback cannot detect a model change within one
 * provider; every built-in Station embedder declares its model.
 */
export function knowledgeEmbeddingIdentity(
  embedder: IEmbeddingProvider,
): string {
  const declared = embedder.embeddingIdentity?.();
  const base =
    typeof declared === 'string' && declared.length > 0
      ? declared
      : `provider=${embedder.id}`;
  return `${base}|dimensions=${embedder.dimensions()}`;
}

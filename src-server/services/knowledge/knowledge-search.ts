import { mapWithConcurrency } from '../../utils/bounded-async.js';
import { knowledgeVectorNamespace } from './knowledge-storage.js';

export async function searchKnowledgeDocuments({
  projectSlug,
  query,
  topK,
  namespace,
  vectorDb,
  embeddingProvider,
  listNamespaces,
  listAuthoritativeDocuments,
}: {
  projectSlug: string;
  query: string;
  topK: number;
  namespace?: string;
  vectorDb: {
    namespaceExists: (namespace: string) => Promise<boolean>;
    search: (
      namespace: string,
      queryVector: number[],
      topK: number,
    ) => Promise<any[]>;
  } | null;
  embeddingProvider: {
    embed: (texts: string[]) => Promise<number[][]>;
  } | null;
  listNamespaces: (
    projectSlug: string,
  ) => Array<{ id: string; behavior?: string }>;
  listAuthoritativeDocuments: (
    projectSlug: string,
    namespace: string,
  ) => Promise<Map<string, string | null>>;
}): Promise<any[]> {
  if (!vectorDb || !embeddingProvider) {
    return [];
  }

  const candidates = namespace
    ? [namespace]
    : listNamespaces(projectSlug)
        .filter((candidate) => candidate.behavior === 'rag')
        .map((candidate) => candidate.id);
  const present = await mapWithConcurrency(candidates, 4, async (id) =>
    vectorDb.namespaceExists(knowledgeVectorNamespace(projectSlug, id)),
  );
  const namespaces = candidates.filter((_, index) => present[index]);
  if (namespaces.length === 0) return [];

  const [queryVector] = await embeddingProvider.embed([query]);
  const pages = await mapWithConcurrency(namespaces, 4, async (id) => {
    const [results, authoritative] = await Promise.all([
      vectorDb.search(
        knowledgeVectorNamespace(projectSlug, id),
        queryVector,
        topK,
      ),
      listAuthoritativeDocuments(projectSlug, id),
    ]);
    return results.filter((result) => {
      const hash = authoritative.get(String(result.metadata?.docId ?? ''));
      return typeof hash === 'string' && result.metadata?.contentHash === hash;
    });
  });

  // Preserve explicit-namespace provider order and stable cross-namespace ties.
  if (namespace) return pages[0];
  return pages
    .flat()
    .sort((left, right) => right.score - left.score)
    .slice(0, topK);
}

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

  const [queryVector] = await embeddingProvider.embed([query]);

  if (namespace) {
    const vectorNamespace = knowledgeVectorNamespace(projectSlug, namespace);
    if (!(await vectorDb.namespaceExists(vectorNamespace))) {
      return [];
    }
    const [results, authoritative] = await Promise.all([
      vectorDb.search(vectorNamespace, queryVector, topK),
      listAuthoritativeDocuments(projectSlug, namespace),
    ]);
    return results.filter((result) => {
      const hash = authoritative.get(String(result.metadata?.docId ?? ''));
      return typeof hash === 'string' && result.metadata?.contentHash === hash;
    });
  }

  const namespaces = listNamespaces(projectSlug).filter(
    (candidate) => candidate.behavior === 'rag',
  );
  const allResults: any[] = [];
  for (const namespaceConfig of namespaces) {
    const vectorNamespace = knowledgeVectorNamespace(
      projectSlug,
      namespaceConfig.id,
    );
    if (!(await vectorDb.namespaceExists(vectorNamespace))) {
      continue;
    }
    const [results, authoritative] = await Promise.all([
      vectorDb.search(vectorNamespace, queryVector, topK),
      listAuthoritativeDocuments(projectSlug, namespaceConfig.id),
    ]);
    allResults.push(
      ...results.filter((result) => {
        const hash = authoritative.get(String(result.metadata?.docId ?? ''));
        return (
          typeof hash === 'string' && result.metadata?.contentHash === hash
        );
      }),
    );
  }

  allResults.sort((left, right) => right.score - left.score);
  return allResults.slice(0, topK);
}

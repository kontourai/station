import {
  useKnowledgeDocsQuery,
  useKnowledgeNamespacesQuery,
  useKnowledgeSearchQuery,
} from '../queries';

export function useKnowledgeNamespaces(projectSlug: string) {
  return useKnowledgeNamespacesQuery(projectSlug);
}

export function useKnowledgeDocs(projectSlug: string, namespace?: string) {
  return useKnowledgeDocsQuery(projectSlug, namespace);
}

export function useKnowledgeSearch(
  projectSlug: string,
  query: string,
  namespace?: string,
) {
  return useKnowledgeSearchQuery(projectSlug, query, namespace);
}

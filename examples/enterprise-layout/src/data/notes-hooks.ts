/**
 * Notes domain hooks — compose SDK knowledge hooks for the enterprise layout.
 */

import {
  useKnowledgeDeleteMutation,
  useKnowledgeDocumentQuery,
  useKnowledgeSaveMutation,
  useKnowledgeSearchQuery,
  useKnowledgeTreeQuery,
} from '@kontourai/station-sdk';
import { useProjectSlug } from '../hooks/useProjectSlug';

const NAMESPACE = 'enterprise-notes';

export interface NoteFrontmatter {
  title?: string;
  tags?: string[];
  territory?: string;
  accountId?: string;
  type?: string;
  status?: string;
}

export function useNoteTree() {
  const projectSlug = useProjectSlug();
  return useKnowledgeTreeQuery(projectSlug ?? '', NAMESPACE, {
    enabled: !!projectSlug,
  });
}

export function useFilteredNotes(filter: {
  query?: string;
  territory?: string;
  type?: string;
  status?: string;
}) {
  const projectSlug = useProjectSlug();
  return useKnowledgeSearchQuery(projectSlug ?? '', NAMESPACE, filter, {
    enabled: !!projectSlug,
  });
}

export function useNoteContent(path: string | null) {
  const projectSlug = useProjectSlug();
  return useKnowledgeDocumentQuery(projectSlug ?? '', NAMESPACE, path ?? '', {
    enabled: !!projectSlug && !!path,
  });
}

export function useSaveNote() {
  const projectSlug = useProjectSlug();
  return useKnowledgeSaveMutation(projectSlug ?? '', NAMESPACE);
}

export function useUpdateNote() {
  const projectSlug = useProjectSlug();
  return useKnowledgeSaveMutation(projectSlug ?? '', NAMESPACE);
}

export function useDeleteNote() {
  const projectSlug = useProjectSlug();
  return useKnowledgeDeleteMutation(projectSlug ?? '', NAMESPACE);
}

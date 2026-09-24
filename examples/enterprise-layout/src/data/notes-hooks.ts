/**
 * Notes domain hooks — compose SDK knowledge hooks for the enterprise layout.
 *
 * The knowledge API addresses a document by its id, keeps a note's
 * frontmatter in the document's `metadata`, and returns the namespace tree
 * as one root directory node. These hooks translate that into the note
 * shape the Notes pane works with.
 */

import {
  useKnowledgeDeleteMutation,
  useKnowledgeDocContentQuery,
  useKnowledgeFilteredQuery,
  useKnowledgeSaveMutation,
  useKnowledgeTreeQuery,
  useKnowledgeUpdateMutation,
} from '@kontourai/station-sdk';
import { useProjectSlug } from '../hooks/useProjectSlug';
import type {
  KnowledgeDocumentMeta,
  KnowledgeTreeNode,
  NoteFrontmatter,
} from '../types/knowledge';

export type { NoteFrontmatter } from '../types/knowledge';

const NAMESPACE = 'enterprise-notes';

/** A note as the Notes pane lists and selects it. */
export interface NoteSummary {
  docId: string;
  path: string;
  title: string;
  frontmatter: NoteFrontmatter;
}

export function toNoteSummary(doc: KnowledgeDocumentMeta): NoteSummary {
  const frontmatter = (doc.metadata ?? {}) as NoteFrontmatter;
  return {
    docId: doc.id,
    path: doc.path,
    title: frontmatter.title ?? doc.filename,
    frontmatter,
  };
}

export function useNoteTree(): {
  data: KnowledgeTreeNode[];
  isLoading: boolean;
} {
  const projectSlug = useProjectSlug();
  const query = useKnowledgeTreeQuery(projectSlug ?? '', NAMESPACE, {
    enabled: !!projectSlug,
  });
  const root = query.data as KnowledgeTreeNode | undefined;
  return { data: root?.children ?? [], isLoading: query.isLoading };
}

export function useFilteredNotes(filter: {
  query?: string;
  territory?: string;
  type?: string;
  status?: string;
}): { data: NoteSummary[]; isLoading: boolean } {
  const projectSlug = useProjectSlug();
  // Frontmatter is stored as metadata, so its fields filter server-side as
  // metadata.<key>. The API has no free-text filter; that one runs here.
  const metadata: Record<string, string> = {};
  if (filter.territory) metadata.territory = filter.territory;
  if (filter.type) metadata.type = filter.type;
  if (filter.status) metadata.status = filter.status;
  const query = useKnowledgeFilteredQuery(
    projectSlug ?? '',
    NAMESPACE,
    { metadata },
    { enabled: !!projectSlug },
  );
  const needle = filter.query?.trim().toLowerCase();
  const notes = ((query.data ?? []) as KnowledgeDocumentMeta[])
    .map(toNoteSummary)
    .filter(
      (note) =>
        !needle ||
        note.title.toLowerCase().includes(needle) ||
        note.path.toLowerCase().includes(needle),
    );
  return { data: notes, isLoading: query.isLoading };
}

export function useNoteContent(docId: string | null) {
  const projectSlug = useProjectSlug();
  return useKnowledgeDocContentQuery(projectSlug ?? '', docId, NAMESPACE);
}

/** Creates a note: `{ filename, content, metadata }`. */
export function useSaveNote() {
  const projectSlug = useProjectSlug();
  return useKnowledgeSaveMutation(projectSlug ?? '', NAMESPACE);
}

/** Updates a note in place: `{ docId, content, metadata }`. */
export function useUpdateNote() {
  const projectSlug = useProjectSlug();
  return useKnowledgeUpdateMutation(projectSlug ?? '', NAMESPACE);
}

/** Deletes a note by document id. */
export function useDeleteNote() {
  const projectSlug = useProjectSlug();
  return useKnowledgeDeleteMutation(projectSlug ?? '', NAMESPACE);
}

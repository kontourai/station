/**
 * Local shim for @kontourai/station-shared knowledge types.
 * Import from here rather than directly from the shared package to keep
 * the plugin boundary clean.
 */

export type {
  KnowledgeDocumentMeta,
  KnowledgeSearchFilter,
  KnowledgeTreeNode,
} from '@kontourai/station-shared';

export interface NoteFrontmatter {
  title?: string;
  tags?: string[];
  territory?: string;
  accountId?: string;
  type?: string;
  status?: string;
}

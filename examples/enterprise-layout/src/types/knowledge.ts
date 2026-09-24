/**
 * Knowledge types this example uses. The document and tree shapes are the
 * SDK's own exports, so the example stays on the plugin boundary.
 */

export type {
  KnowledgeDocumentMeta,
  KnowledgeSearchFilter,
  KnowledgeTreeNode,
} from '@kontourai/station-sdk';

export interface NoteFrontmatter {
  title?: string;
  tags?: string[];
  territory?: string;
  accountId?: string;
  type?: string;
  status?: string;
}

import type { KnowledgeDocumentMeta } from '@kontourai/station-contracts/knowledge';

export interface DocMeta {
  id: string;
  filename: string;
  namespace?: string;
  /** Every origin the knowledge contract names, `sync` included. */
  source?: KnowledgeDocumentMeta['source'];
  chunkCount: number;
  createdAt: string;
}

export interface KnowledgeNamespace {
  id: string;
  label: string;
  behavior: 'rag' | 'inject';
  builtIn?: boolean;
}

export interface ConversationRecord {
  id: string;
  projectId: string;
  title: string;
  agentSlug: string;
  layoutId?: string;
  createdAt: string;
  updatedAt: string;
}

export type { LayoutCatalogItem as AvailableLayout } from '@kontourai/station-contracts/distribution';

export interface KnowledgeStatusSummary {
  documentCount: number;
  totalChunks: number;
  lastIndexed?: string;
}

export interface KnowledgeSearchResult {
  text: string;
  metadata?: {
    docId?: string;
    chunkIndex?: number;
    filename?: string;
  };
}

import type { KnowledgeStoreRoot } from '@kontourai/station-contracts/knowledge-store';
import type {
  LayoutConfig,
  LayoutMetadata,
  LayoutOwner,
  LayoutTemplate,
} from '@kontourai/station-contracts/layout';
import type {
  ProjectConfig,
  ProjectMetadata,
} from '@kontourai/station-contracts/project';
import type { ProviderConnectionConfig } from '@kontourai/station-contracts/tool';
import {
  InvalidPathSegmentError,
  isSafePathSegment,
} from '../knowledge-index/path-safety.js';
import type {
  ProjectStoredFileRevision,
  StoredFileRevision,
} from './project-file-transactions.js';

export interface ConversationRecord {
  id: string;
  projectId: string;
  title: string;
  agentSlug: string;
  layoutId?: string;
  providerId?: string;
  model?: string;
  createdAt: string;
  updatedAt: string;
}

export interface DocumentRecord {
  id: string;
  projectId: string;
  filename: string;
  mimeType: string;
  size: number;
  source: 'upload' | 'directory-scan' | 'url';
  sourceUri?: string;
  chunkCount: number;
  status: 'pending' | 'processing' | 'embedded' | 'error';
  error?: string;
  embeddedAt?: string;
  createdAt: string;
}

export interface LayoutAgentReference {
  /**
   * Who owns the referencing Layout. Required: the sweep covers non-project
   * roots too (#2060), and a reference that reports only a project slug
   * cannot name a Board at all — which is how a Board's agent reference
   * became invisible to `deleteAgent`.
   */
  owner: LayoutOwner;
  /** Present for a project-owned reference only; mirrors `owner`. */
  projectSlug?: string;
  layoutSlug: string;
}

/** Strict filename segment validation for every layout-storage boundary. */
export function assertSafeLayoutPathSegment(
  kind: 'project slug' | 'layout slug' | 'terminal id',
  value: unknown,
): asserts value is string {
  if (!isSafePathSegment(value) || value === '.') {
    throw new InvalidPathSegmentError(kind, value);
  }
}

export interface IStorageAdapter {
  // Projects
  listProjects(): ProjectMetadata[];
  getProject(slug: string): ProjectConfig;
  projectRevision(slug: string): ProjectStoredFileRevision<ProjectConfig>;
  createProject(config: ProjectConfig): Promise<void>;
  /** Must publish Project and portable identity together or refuse before visibility. */
  createProjectWithIdentity?(
    config: ProjectConfig,
    identity: import('@kontourai/station-contracts/project-identity').ProjectPortableIdentity,
  ): Promise<void>;
  deleteProject(slug: string): Promise<void>;

  // Layouts
  listLayouts(projectSlug: string): LayoutMetadata[];
  getLayout(projectSlug: string, layoutSlug: string): LayoutConfig;
  layoutRevision(
    projectSlug: string,
    layoutSlug: string,
  ): StoredFileRevision<LayoutConfig>;
  createLayout(projectSlug: string, config: LayoutConfig): Promise<void>;
  deleteLayout(projectSlug: string, layoutSlug: string): Promise<void>;
  findLayoutsUsingAgent(agentSlug: string): LayoutAgentReference[];

  // Owner-scoped layouts (#2060). A project owner routes to the four methods
  // above; principal- and instance-owned records are stored outside
  // `projects/`, so no project layout route can list or read one.
  listOwnedLayouts?(owner: LayoutOwner): LayoutMetadata[];
  getOwnedLayout?(owner: LayoutOwner, layoutSlug: string): LayoutConfig;
  createOwnedLayout?(owner: LayoutOwner, config: LayoutConfig): Promise<void>;
  deleteOwnedLayout?(owner: LayoutOwner, layoutSlug: string): Promise<void>;
  /**
   * Serialized read-modify-write for one non-project Layout (#2061). The
   * updater sees `undefined` when no record exists, so create and update are
   * the same transaction and neither needs an existence probe outside the
   * lock.
   */
  mutateOwnedLayout?(
    owner: LayoutOwner,
    layoutSlug: string,
    update: (current: LayoutConfig | undefined) => LayoutConfig,
  ): Promise<LayoutConfig>;

  // Provider connections
  listProviderConnections(): ProviderConnectionConfig[];
  getProviderConnection(id: string): ProviderConnectionConfig;
  saveProviderConnection(config: ProviderConnectionConfig): Promise<void>;
  deleteProviderConnection(id: string): Promise<void>;

  // Conversations
  listConversations(
    projectSlug: string,
    opts?: { limit?: number; offset?: number },
  ): ConversationRecord[];
  getConversation(id: string): ConversationRecord | null;
  saveConversation(record: ConversationRecord): Promise<void>;
  deleteConversation(id: string): Promise<void>;

  // Documents
  listDocuments(projectSlug: string): DocumentRecord[];
  getDocument(id: string): DocumentRecord | null;
  saveDocument(record: DocumentRecord): Promise<void>;
  deleteDocument(id: string): Promise<void>;

  // Layout Templates
  listTemplates(): LayoutTemplate[];
  getTemplate(id: string): LayoutTemplate | null;
  saveTemplate(template: LayoutTemplate): Promise<void>;
  deleteTemplate(id: string): Promise<void>;

  // Knowledge store roots (K2) — metadata only; never the store's own record files.
  listKnowledgeStoreRoots(): KnowledgeStoreRoot[];
  saveKnowledgeStoreRoot(root: KnowledgeStoreRoot): Promise<void>;
  removeKnowledgeStoreRoot(id: string): Promise<void>;
}

import {
  KnowledgeDocumentMeta,
  KnowledgeNamespaceConfig,
  KnowledgeSearchFilter,
  KnowledgeTreeNode,
} from '@kontourai/station-contracts/knowledge';
import type { IStorageAdapter } from '../../domain/storage-adapter.js';
import type {
  IEmbeddingProvider,
  IVectorDbProvider,
} from '../../providers/llm/model-provider-types.js';
import {
  buildKnowledgeInjectContext,
  buildKnowledgeRagContextDetailed,
  findKnowledgeDocumentNamespace,
  type KnowledgeRagContextResult,
} from './knowledge-context.js';
import {
  deleteKnowledgeDocument,
  getKnowledgeDocumentContent,
  updateKnowledgeDocument,
  uploadKnowledgeDocument,
} from './knowledge-documents.js';
import {
  buildKnowledgeDirectoryTree,
  listKnowledgeDocuments,
  scanKnowledgeDirectories,
} from './knowledge-filesystem.js';
import {
  getKnowledgeNamespaceConfig,
  listKnowledgeNamespaces,
  registerKnowledgeNamespace,
  removeKnowledgeNamespace,
  resolveKnowledgeStorageDir,
  updateKnowledgeNamespace,
} from './knowledge-namespaces.js';
import { observeKnowledgeOperation } from './knowledge-observability.js';
import { searchKnowledgeDocuments } from './knowledge-search.js';
import { DEFAULT_KNOWLEDGE_NAMESPACE } from './knowledge-storage.js';

const DEFAULT_NS = DEFAULT_KNOWLEDGE_NAMESPACE;
/** The built-in `rules` namespace (`project-rules.md`), superseded by the Project brief. */
const BUILTIN_RULES_NAMESPACE = 'rules';
/** Where "Index directory" puts the project's files when no namespace is named. */
const DEFAULT_SCAN_NAMESPACE: KnowledgeNamespaceConfig = {
  id: 'code',
  label: 'Code',
  behavior: 'rag',
};

// ── Service ────────────────────────────────────────────────────────

export class KnowledgeService {
  constructor(
    private resolveVectorDb: () => IVectorDbProvider | null,
    private resolveEmbedding: () => IEmbeddingProvider | null,
    private dataDir: string,
    private storageAdapter?: IStorageAdapter,
  ) {}

  /**
   * #5062: whether a Project's brief now carries its legacy rules (the
   * `project-coordination` preview is on and the rules were copied). Set by
   * runtime composition; absent means the rules inject as before.
   */
  private briefCarriesRules?: (projectSlug: string) => boolean;

  setBriefCarriesRules(predicate: (projectSlug: string) => boolean): void {
    this.briefCarriesRules = predicate;
  }

  // ── Storage resolution ──

  private resolveStorageDir(projectSlug: string, namespace: string): string {
    return resolveKnowledgeStorageDir(
      projectSlug,
      namespace,
      this.dataDir,
      this.storageAdapter,
    );
  }

  private getNamespaceConfig(projectSlug: string, namespace: string) {
    return getKnowledgeNamespaceConfig(
      projectSlug,
      namespace,
      this.storageAdapter,
    );
  }

  // ── Namespace management ──

  listNamespaces(projectSlug: string): KnowledgeNamespaceConfig[] {
    return listKnowledgeNamespaces(projectSlug, this.storageAdapter);
  }

  async registerNamespace(
    projectSlug: string,
    ns: KnowledgeNamespaceConfig,
  ): Promise<void> {
    await registerKnowledgeNamespace(projectSlug, ns, this.storageAdapter);
  }

  async removeNamespace(
    projectSlug: string,
    namespaceId: string,
  ): Promise<void> {
    await removeKnowledgeNamespace(
      projectSlug,
      namespaceId,
      this.storageAdapter,
    );
  }

  async updateNamespace(
    projectSlug: string,
    namespaceId: string,
    updates: Partial<KnowledgeNamespaceConfig>,
  ): Promise<void> {
    await updateKnowledgeNamespace(
      projectSlug,
      namespaceId,
      updates,
      this.storageAdapter,
    );
  }

  // ── Document CRUD ──

  async uploadDocument(
    projectSlug: string,
    filename: string,
    content: string,
    source: 'upload' | 'directory-scan' | 'sync' = 'upload',
    namespace: string = DEFAULT_NS,
    extraMeta?: Record<string, any>,
  ): Promise<KnowledgeDocumentMeta> {
    const meta = await uploadKnowledgeDocument(
      {
        vectorDb: this.resolveVectorDb(),
        embeddingProvider: this.resolveEmbedding(),
        dataDir: this.dataDir,
        resolveStorageDir: (slug, targetNamespace) =>
          this.resolveStorageDir(slug, targetNamespace),
        getNamespaceConfig: (slug, targetNamespace) =>
          this.getNamespaceConfig(slug, targetNamespace),
        findDocNamespace: (slug, docId) => this.findDocNamespace(slug, docId),
      },
      projectSlug,
      filename,
      content,
      source,
      namespace,
      extraMeta,
    );
    observeKnowledgeOperation('index');
    return meta;
  }

  async searchDocuments(
    projectSlug: string,
    query: string,
    topK = 5,
    namespace?: string,
  ) {
    const allResults = await searchKnowledgeDocuments({
      projectSlug,
      query,
      topK,
      namespace,
      vectorDb: this.resolveVectorDb(),
      embeddingProvider: this.resolveEmbedding(),
      listNamespaces: (slug) => this.listNamespaces(slug),
      listAuthoritativeDocuments: async (slug, targetNamespace) =>
        new Map(
          (await this.listDocuments(slug, targetNamespace)).map((document) => [
            document.id,
            document.contentHash ?? null,
          ]),
        ),
    });
    observeKnowledgeOperation('query');
    return allResults;
  }

  async listDocuments(
    projectSlug: string,
    namespace?: string,
    filter?: KnowledgeSearchFilter,
  ): Promise<KnowledgeDocumentMeta[]> {
    return listKnowledgeDocuments({
      projectSlug,
      namespace,
      filter,
      dataDir: this.dataDir,
      listNamespaces: (slug) => this.listNamespaces(slug),
      resolveStorageDir: (slug, targetNamespace) =>
        this.resolveStorageDir(slug, targetNamespace),
    });
  }

  async deleteDocument(
    projectSlug: string,
    docId: string,
    namespace?: string,
  ): Promise<void> {
    await deleteKnowledgeDocument(
      {
        vectorDb: this.resolveVectorDb(),
        embeddingProvider: this.resolveEmbedding(),
        dataDir: this.dataDir,
        resolveStorageDir: (slug, targetNamespace) =>
          this.resolveStorageDir(slug, targetNamespace),
        getNamespaceConfig: (slug, targetNamespace) =>
          this.getNamespaceConfig(slug, targetNamespace),
        findDocNamespace: (slug, targetDocId) =>
          this.findDocNamespace(slug, targetDocId),
      },
      projectSlug,
      docId,
      namespace,
    );
    observeKnowledgeOperation('delete');
  }

  // ── Document content retrieval ──

  async getDocumentContent(
    projectSlug: string,
    docId: string,
    namespace?: string,
  ): Promise<string> {
    return getKnowledgeDocumentContent(
      {
        vectorDb: this.resolveVectorDb(),
        embeddingProvider: this.resolveEmbedding(),
        dataDir: this.dataDir,
        resolveStorageDir: (slug, targetNamespace) =>
          this.resolveStorageDir(slug, targetNamespace),
        getNamespaceConfig: (slug, targetNamespace) =>
          this.getNamespaceConfig(slug, targetNamespace),
        findDocNamespace: (slug, targetDocId) =>
          this.findDocNamespace(slug, targetDocId),
      },
      projectSlug,
      docId,
      namespace,
    );
  }

  // ── Update document in-place ──

  async updateDocument(
    projectSlug: string,
    docId: string,
    updates: { content?: string; metadata?: Record<string, any> },
    namespace?: string,
  ): Promise<KnowledgeDocumentMeta> {
    const updatedMeta = await updateKnowledgeDocument(
      {
        vectorDb: this.resolveVectorDb(),
        embeddingProvider: this.resolveEmbedding(),
        dataDir: this.dataDir,
        resolveStorageDir: (slug, targetNamespace) =>
          this.resolveStorageDir(slug, targetNamespace),
        getNamespaceConfig: (slug, targetNamespace) =>
          this.getNamespaceConfig(slug, targetNamespace),
        findDocNamespace: (slug, targetDocId) =>
          this.findDocNamespace(slug, targetDocId),
      },
      projectSlug,
      docId,
      updates,
      namespace,
    );
    observeKnowledgeOperation('update');
    return updatedMeta;
  }

  // ── Directory tree ──

  getDirectoryTree(
    projectSlug: string,
    namespace: string,
  ): Promise<KnowledgeTreeNode> {
    return buildKnowledgeDirectoryTree({
      projectSlug,
      namespace,
      dataDir: this.dataDir,
      resolveStorageDir: (slug, targetNamespace) =>
        this.resolveStorageDir(slug, targetNamespace),
    });
  }

  // ── Context injection ──

  /**
   * RAG context — searches rag-behavior namespaces for relevant content, and
   * returns the chunk/source facts that describe the returned string
   * alongside it (archive#2649). ONE derivation for the injected text and its
   * receipt (see `buildKnowledgeRagContextDetailed`), so the per-turn context
   * record cannot name a chunk the model never saw.
   */
  async getRAGContextDetailed(
    projectSlug: string,
    userMessage: string,
    topK = 4,
    threshold = 0.25,
  ): Promise<KnowledgeRagContextResult | null> {
    const results = await this.searchDocuments(projectSlug, userMessage, topK);
    return buildKnowledgeRagContextDetailed(results, threshold);
  }

  /**
   * Inject context — concatenates ALL content from inject-behavior namespaces.
   * Returns formatted string for system prompt prepending, or null if empty.
   */
  async getInjectContext(projectSlug: string): Promise<string | null> {
    // #5062: once a Project's rules were copied into its brief, the brief
    // carries them on every engine, so the `rules` namespace stops injecting.
    let rulesInBrief = false;
    try {
      rulesInBrief = this.briefCarriesRules?.(projectSlug) === true;
    } catch {
      rulesInBrief = false;
    }
    const namespaces = this.listNamespaces(projectSlug).filter(
      (n) =>
        n.behavior === 'inject' &&
        !(rulesInBrief && n.id === BUILTIN_RULES_NAMESPACE),
    );
    if (namespaces.length === 0) return null;

    const vectorDb = this.resolveVectorDb();
    if (!vectorDb) return null;
    const embeddingProvider = this.resolveEmbedding();
    if (!embeddingProvider) return null;

    return buildKnowledgeInjectContext({
      projectSlug,
      namespaces,
      dataDir: this.dataDir,
      resolveStorageDir: (slug, namespace) =>
        this.resolveStorageDir(slug, namespace),
      vectorDb,
      embeddingProvider,
    });
  }

  // ── Directory scanning ──

  /**
   * Index the project's directory. With no namespace named, the files go to
   * the `code` namespace, which is registered on the project first: the
   * project-wide document list, status counts and search read registered
   * namespaces only, so an unregistered `code` held every scanned file out of
   * sight while the scan reported them indexed.
   */
  async scanDirectories(
    projectSlug: string,
    extensions?: string[],
    includePatterns?: string[],
    excludePatterns?: string[],
    explicitNamespace?: string,
  ): Promise<{ indexed: number; skipped: number }> {
    const namespace = explicitNamespace ?? DEFAULT_SCAN_NAMESPACE.id;
    if (
      !explicitNamespace &&
      this.storageAdapter &&
      !this.getNamespaceConfig(projectSlug, namespace)
    ) {
      await this.registerNamespace(projectSlug, DEFAULT_SCAN_NAMESPACE);
    }
    return scanKnowledgeDirectories({
      projectSlug,
      namespace,
      extensions,
      includePatterns,
      excludePatterns,
      storageAdapter: this.storageAdapter,
      // archive#1501: `dataDir` IS the Station home this service's
      // `storageAdapter` was constructed over (`runtime-service-bootstrap.ts`
      // passes `context.projectHomeDir` to both), so the resource resolver
      // reads the same projects/manifests/bindings rather than whatever
      // `STATION_HOME` happens to say at call time.
      workspacePathOptions: { resolverOptions: { homeDir: this.dataDir } },
      getNamespaceConfig: (slug, targetNamespace) =>
        this.getNamespaceConfig(slug, targetNamespace),
      uploadDocument: async (
        slug,
        filename,
        content,
        source,
        targetNamespace,
      ) =>
        this.uploadDocument(slug, filename, content, source, targetNamespace),
    });
  }

  // ── Private helpers ──

  private findDocNamespace(
    projectSlug: string,
    docId: string,
  ): Promise<string | null> {
    return findKnowledgeDocumentNamespace({
      projectSlug,
      docId,
      namespaces: this.listNamespaces(projectSlug),
      dataDir: this.dataDir,
      resolveStorageDir: (slug, namespace) =>
        this.resolveStorageDir(slug, namespace),
    });
  }
}

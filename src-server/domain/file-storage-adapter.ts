import { type Dirent, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { KnowledgeStoreRoot } from '@kontourai/station-contracts/knowledge-store';
import type {
  LayoutConfig,
  LayoutMetadata,
  LayoutTemplate,
} from '@kontourai/station-contracts/layout';
import type {
  ProjectConfig,
  ProjectMetadata,
} from '@kontourai/station-contracts/project';
import type { ProviderConnectionConfig } from '@kontourai/station-contracts/tool';
import {
  assertObservationTreeBudget,
  KnowledgeObservationRefusal,
  readObservationFile,
} from '../knowledge-store/adapters/shared/observation-file.js';
import type { KnowledgeRootObservation } from '../knowledge-store/knowledge-record-observation.js';
import { mutateJsonFile, readJsonFile } from './file-storage-helpers.js';
import {
  buildLayoutAgentReferences,
  deleteProjectScopedRecord,
  deleteStoredRecord,
  findStoredRecordAcrossProjects,
  listSortedConversations,
  listStoredRecords,
  saveProjectScopedRecord,
  saveStoredRecord,
} from './file-storage-records.js';
import {
  parseConversationRecords,
  parseDocumentRecords,
  parseKnowledgeStoreRoots,
  parseLayoutConfig,
  parseLayoutTemplates,
  parseProjectConfig,
} from './file-storage-schemas.js';
import {
  FileStorageNotFoundError,
  type ProjectFileTransactionFaults,
  ProjectFileTransactions,
  type ProjectStoredFileRevision,
  type StoredFileRevision,
} from './project-file-transactions.js';
import {
  assertSafeLayoutPathSegment,
  type ConversationRecord,
  type DocumentRecord,
  type IStorageAdapter,
  type LayoutAgentReference,
} from './storage-adapter.js';
/**
 * The server-owned project order (archive#3315): explicit positions first,
 * ascending; projects without one after them, in name order. Exported so its
 * fallback arms are testable directly — a listProjects round-trip cannot
 * discriminate the name fallback when readdir order happens to coincide.
 */
export function compareProjectListOrder(
  a: Pick<ProjectMetadata, 'name' | 'position'>,
  b: Pick<ProjectMetadata, 'name' | 'position'>,
): number {
  if (a.position !== undefined && b.position !== undefined) {
    if (a.position !== b.position) return a.position - b.position;
  } else if (a.position !== undefined) {
    return -1;
  } else if (b.position !== undefined) {
    return 1;
  }
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

export class FileStorageAdapter implements IStorageAdapter {
  readonly #transactions: ProjectFileTransactions;

  constructor(
    private readonly projectHomeDir: string,
    faults?: ProjectFileTransactionFaults,
  ) {
    this.#transactions = new ProjectFileTransactions(
      projectHomeDir,
      faults,
      parseProjectConfig,
    );
  }

  listProjects(): ProjectMetadata[] {
    const dir = join(this.projectHomeDir, 'projects');
    const projects = readDirectoryEntries(dir)
      .filter((entry) => entry.isDirectory())
      .flatMap((entry) => {
        let config: ProjectConfig;
        try {
          config = this.projectRevision(entry.name).value;
        } catch (error) {
          if (error instanceof FileStorageNotFoundError) return [];
          throw error;
        }
        if (config.slug !== entry.name) {
          throw new Error(
            `project record identity does not match directory '${entry.name}'`,
          );
        }
        const layoutsDir = join(dir, entry.name, 'layouts');
        const layoutCount = readDirectoryNames(layoutsDir).filter((file) =>
          file.endsWith('.json'),
        ).length;
        return [
          {
            id: config.id,
            slug: config.slug,
            name: config.name,
            icon: config.icon,
            description: config.description,
            hasWorkingDirectory: !!config.workingDirectory,
            workingDirectory: config.workingDirectory,
            layoutCount,
            hasKnowledge: pathExists(
              join(dir, entry.name, 'documents', 'metadata.json'),
            ),
            defaultProviderId: config.defaultProviderId,
            ...(config.position !== undefined
              ? { position: config.position }
              : {}),
          } satisfies ProjectMetadata,
        ];
      });
    // Server-owned order (archive#3315): explicit positions first, ascending;
    // projects without one append after them in name order, so directory
    // readdir order (arbitrary, machine-dependent) never reaches a consumer.
    return projects.sort(compareProjectListOrder);
  }

  getProject(slug: string): ProjectConfig {
    return this.projectRevision(slug).value;
  }

  projectRevision(slug: string): ProjectStoredFileRevision<ProjectConfig> {
    assertSafeLayoutPathSegment('project slug', slug);
    const stored = this.#transactions.readProject(slug, parseProjectConfig);
    if (stored.value.slug !== slug) {
      throw new Error(
        `project record identity does not match directory '${slug}'`,
      );
    }
    return Object.freeze({
      value: stored.value,
      replace: async (next: ProjectConfig) => {
        const parsed = parseProjectConfig(next);
        assertSafeLayoutPathSegment('project slug', parsed.slug);
        if (parsed.slug !== slug || parsed.id !== stored.value.id) {
          throw new Error('project id and slug are immutable');
        }
        await stored.replace(parsed);
      },
      remove: () => stored.remove(),
      createLayout: async (layoutSlug: string, value: unknown) => {
        const parsed = parseLayoutConfig(value);
        assertSafeLayoutPathSegment('layout slug', layoutSlug);
        if (parsed.slug !== layoutSlug || parsed.projectSlug !== slug) {
          throw new Error(
            'layout identity does not match its Project revision',
          );
        }
        await stored.createLayout(layoutSlug, parsed);
      },
    });
  }

  async createProject(config: ProjectConfig): Promise<void> {
    assertSafeLayoutPathSegment('project slug', config.slug);
    const parsed = parseProjectConfig(config);
    await this.#transactions.createProject(parsed.slug, parsed);
  }

  async deleteProject(slug: string): Promise<void> {
    await this.projectRevision(slug).remove();
  }

  listLayouts(projectSlug: string): LayoutMetadata[] {
    assertSafeLayoutPathSegment('project slug', projectSlug);
    const dir = join(this.projectHomeDir, 'projects', projectSlug, 'layouts');
    return readDirectoryNames(dir)
      .filter((file) => file.endsWith('.json'))
      .flatMap((file) => {
        const layoutSlug = file.slice(0, -'.json'.length);
        let config: LayoutConfig;
        try {
          config = this.layoutRevision(projectSlug, layoutSlug).value;
        } catch (error) {
          if (error instanceof FileStorageNotFoundError) return [];
          throw error;
        }
        return [
          {
            id: config.id,
            slug: config.slug,
            projectSlug: config.projectSlug,
            type: config.type,
            name: config.name,
            icon: config.icon,
            description: config.description,
            // archive#1497 — `LayoutConfig.config` is required by the
            // contract, but a record persisted without one is reachable on
            // disk today (the create route only materialized it as a side
            // effect of copying a working directory in). Dereferencing it
            // unconditionally made a single such record 500 the entire
            // project's layout list, permanently and with no write that could
            // repair it. Tolerate the absence on read; the write paths now
            // materialize it so no new record can have the shape.
            plugin:
              typeof config.config?.plugin === 'string'
                ? config.config.plugin
                : undefined,
            tabCount: Array.isArray(config.config?.tabs)
              ? config.config.tabs.length
              : undefined,
          } satisfies LayoutMetadata,
        ];
      });
  }

  getLayout(projectSlug: string, layoutSlug: string): LayoutConfig {
    return this.layoutRevision(projectSlug, layoutSlug).value;
  }

  layoutRevision(
    projectSlug: string,
    layoutSlug: string,
  ): StoredFileRevision<LayoutConfig> {
    assertSafeLayoutPathSegment('project slug', projectSlug);
    assertSafeLayoutPathSegment('layout slug', layoutSlug);
    const stored = this.#transactions.readLayout(
      projectSlug,
      layoutSlug,
      parseLayoutConfig,
    );
    if (
      stored.value.slug !== layoutSlug ||
      stored.value.projectSlug !== projectSlug
    ) {
      throw new Error(
        `layout record identity does not match '${projectSlug}/${layoutSlug}'`,
      );
    }
    return Object.freeze({
      value: stored.value,
      replace: async (next: LayoutConfig) => {
        const parsed = parseLayoutConfig(next);
        assertSafeLayoutPathSegment('project slug', parsed.projectSlug);
        assertSafeLayoutPathSegment('layout slug', parsed.slug);
        if (
          parsed.slug !== layoutSlug ||
          parsed.projectSlug !== projectSlug ||
          parsed.id !== stored.value.id
        ) {
          throw new Error('layout id, projectSlug, and slug are immutable');
        }
        await stored.replace(parsed);
      },
      remove: () => stored.remove(),
    });
  }

  async createLayout(projectSlug: string, config: LayoutConfig): Promise<void> {
    assertSafeLayoutPathSegment('project slug', projectSlug);
    assertSafeLayoutPathSegment('layout slug', config.slug);
    const parsed = parseLayoutConfig(config);
    if (parsed.projectSlug !== projectSlug) {
      throw new Error('layout projectSlug does not match its project path');
    }
    await this.projectRevision(projectSlug).createLayout(parsed.slug, parsed);
  }

  async deleteLayout(projectSlug: string, layoutSlug: string): Promise<void> {
    assertSafeLayoutPathSegment('project slug', projectSlug);
    assertSafeLayoutPathSegment('layout slug', layoutSlug);
    await this.layoutRevision(projectSlug, layoutSlug).remove();
  }

  findLayoutsUsingAgent(agentSlug: string): LayoutAgentReference[] {
    return buildLayoutAgentReferences(
      this.listProjects(),
      (projectSlug) => this.listLayouts(projectSlug),
      (projectSlug, layoutSlug) => this.getLayout(projectSlug, layoutSlug),
      agentSlug,
      (a, b) => a === b,
    );
  }

  private get providersPath(): string {
    return join(this.projectHomeDir, 'config', 'providers.json');
  }

  private validateProviders(value: unknown): ProviderConnectionConfig[] {
    const providers = value;
    if (!Array.isArray(providers)) {
      throw new Error('provider config must contain an array.');
    }
    if (providers.length > 4096) {
      throw new Error('provider config exceeds the connection limit.');
    }
    return providers as ProviderConnectionConfig[];
  }

  private readProviders(): ProviderConnectionConfig[] {
    return this.validateProviders(
      readJsonFile<unknown>(this.providersPath, [], {
        maxBytes: 2 * 1024 * 1024,
        label: 'provider config',
      }),
    );
  }

  listProviderConnections(): ProviderConnectionConfig[] {
    return this.readProviders();
  }

  getProviderConnection(id: string): ProviderConnectionConfig {
    const found = this.readProviders().find((provider) => provider.id === id);
    if (!found) throw new Error(`Provider connection '${id}' not found`);
    return found;
  }

  async saveProviderConnection(
    config: ProviderConnectionConfig,
  ): Promise<void> {
    await mutateJsonFile<unknown>(
      this.providersPath,
      [],
      (value) => {
        const providers = this.validateProviders(value);
        const index = providers.findIndex(
          (provider) => provider.id === config.id,
        );
        if (index >= 0) providers[index] = config;
        else providers.push(config);
        return this.validateProviders(providers);
      },
      { maxBytes: 2 * 1024 * 1024, label: 'provider config' },
    );
  }

  async deleteProviderConnection(id: string): Promise<void> {
    await mutateJsonFile<unknown>(
      this.providersPath,
      [],
      (value) => {
        const providers = this.validateProviders(value);
        const index = providers.findIndex((provider) => provider.id === id);
        if (index < 0) {
          throw new Error(`Provider connection '${id}' not found`);
        }
        providers.splice(index, 1);
        return providers;
      },
      { maxBytes: 2 * 1024 * 1024, label: 'provider config' },
    );
  }

  // Knowledge store roots (K2) — root METADATA only (id/scope/adapterId/storeRoot
  // path/displayName/createdAt), following the exact persistence precedent of
  // `config/providers.json` above. Never the store's own record files — those live
  // at the root's own `storeRoot` path, owned by the root's adapter, and must remain
  // valid for non-Station consumers (Obsidian, the Kit CLI).
  private get knowledgeStoreRootsPath(): string {
    return join(this.projectHomeDir, 'config', 'knowledge-store-roots.json');
  }

  private readKnowledgeStoreRoots(): KnowledgeStoreRoot[] {
    return parseKnowledgeStoreRoots(
      readJsonFile<unknown>(this.knowledgeStoreRootsPath, []),
    );
  }

  listKnowledgeStoreRoots(): KnowledgeStoreRoot[] {
    return this.readKnowledgeStoreRoots();
  }

  /** No construction, bootstrap, write lock, read-repair, or directory creation. */
  observeKnowledgeStoreRoots(): KnowledgeRootObservation {
    const file = readObservationFile(this.knowledgeStoreRootsPath, 1024 * 1024);
    if (!file) return { roots: [], digest: 'missing' };
    let value: unknown;
    try {
      value = JSON.parse(file.text);
    } catch {
      throw new KnowledgeObservationRefusal('corrupt');
    }
    assertObservationTreeBudget(value);
    if (!Array.isArray(value)) throw new KnowledgeObservationRefusal('corrupt');
    if (value.length > 1024) {
      throw new KnowledgeObservationRefusal('over-budget');
    }
    let roots: KnowledgeStoreRoot[];
    try {
      roots = parseKnowledgeStoreRoots(value);
    } catch {
      throw new KnowledgeObservationRefusal('corrupt');
    }
    if (new Set(roots.map((root) => root.id)).size !== roots.length) {
      throw new KnowledgeObservationRefusal('corrupt');
    }
    file.recheck();
    return { roots, digest: file.digest };
  }

  async saveKnowledgeStoreRoot(root: KnowledgeStoreRoot): Promise<void> {
    parseKnowledgeStoreRoots([root]);
    await mutateJsonFile<unknown>(this.knowledgeStoreRootsPath, [], (value) => {
      const roots = parseKnowledgeStoreRoots(value);
      const index = roots.findIndex((candidate) => candidate.id === root.id);
      if (index >= 0) roots[index] = root;
      else roots.push(root);
      return roots;
    });
  }

  async removeKnowledgeStoreRoot(id: string): Promise<void> {
    await mutateJsonFile<unknown>(this.knowledgeStoreRootsPath, [], (value) => {
      const roots = parseKnowledgeStoreRoots(value);
      const index = roots.findIndex((root) => root.id === id);
      if (index < 0) throw new Error(`Knowledge store root '${id}' not found`);
      roots.splice(index, 1);
      return roots;
    });
  }

  private conversationsFile(projectSlug: string): string {
    return join(
      this.projectHomeDir,
      'projects',
      projectSlug,
      'conversations.json',
    );
  }

  listConversations(
    projectSlug: string,
    opts?: { limit?: number; offset?: number },
  ): ConversationRecord[] {
    return listSortedConversations(
      this.conversationsFile(projectSlug),
      opts,
      parseConversationRecords,
    );
  }

  getConversation(id: string): ConversationRecord | null {
    return findStoredRecordAcrossProjects(
      this.projectHomeDir,
      (projectSlug) => this.conversationsFile(projectSlug),
      id,
      parseConversationRecords,
    );
  }

  async saveConversation(record: ConversationRecord): Promise<void> {
    parseConversationRecords([record]);
    await saveProjectScopedRecord(
      this.projectHomeDir,
      (projectSlug) => this.conversationsFile(projectSlug),
      record,
      parseConversationRecords,
      this.#transactions,
    );
  }

  async deleteConversation(id: string): Promise<void> {
    await deleteProjectScopedRecord<ConversationRecord>(
      this.projectHomeDir,
      (projectSlug) => this.conversationsFile(projectSlug),
      id,
      parseConversationRecords,
      this.#transactions,
    );
  }

  private documentsFile(projectSlug: string): string {
    return join(
      this.projectHomeDir,
      'projects',
      projectSlug,
      'documents',
      'metadata.json',
    );
  }

  listDocuments(projectSlug: string): DocumentRecord[] {
    return listStoredRecords(
      this.documentsFile(projectSlug),
      [],
      parseDocumentRecords,
    );
  }

  getDocument(id: string): DocumentRecord | null {
    return findStoredRecordAcrossProjects(
      this.projectHomeDir,
      (projectSlug) => this.documentsFile(projectSlug),
      id,
      parseDocumentRecords,
    );
  }

  async saveDocument(record: DocumentRecord): Promise<void> {
    parseDocumentRecords([record]);
    await saveProjectScopedRecord(
      this.projectHomeDir,
      (projectSlug) => this.documentsFile(projectSlug),
      record,
      parseDocumentRecords,
      this.#transactions,
    );
  }

  async deleteDocument(id: string): Promise<void> {
    await deleteProjectScopedRecord<DocumentRecord>(
      this.projectHomeDir,
      (projectSlug) => this.documentsFile(projectSlug),
      id,
      parseDocumentRecords,
      this.#transactions,
    );
  }

  private get templatesPath(): string {
    return join(this.projectHomeDir, 'config', 'templates.json');
  }

  listTemplates(): LayoutTemplate[] {
    return listStoredRecords(this.templatesPath, [], parseLayoutTemplates);
  }

  getTemplate(id: string): LayoutTemplate | null {
    return (
      listStoredRecords<LayoutTemplate>(
        this.templatesPath,
        [],
        parseLayoutTemplates,
      ).find((template) => template.id === id) ?? null
    );
  }

  async saveTemplate(template: LayoutTemplate): Promise<void> {
    parseLayoutTemplates([template]);
    await saveStoredRecord(this.templatesPath, template, parseLayoutTemplates);
  }

  async deleteTemplate(id: string): Promise<void> {
    if (
      !(await deleteStoredRecord<LayoutTemplate>(
        this.templatesPath,
        id,
        parseLayoutTemplates,
      ))
    ) {
      throw new Error(`Template '${id}' not found`);
    }
  }
}

function readDirectoryEntries(path: string): Dirent[] {
  try {
    return readdirSync(path, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

function readDirectoryNames(path: string): string[] {
  try {
    return readdirSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

function pathExists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

import { readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { KnowledgeStoreRoot } from '@kontourai/station-contracts/knowledge-store';
import {
  type LayoutConfig,
  type LayoutMetadata,
  type LayoutOwner,
  type LayoutTemplate,
  layoutOwner,
  layoutOwnerProjectSlug,
} from '@kontourai/station-contracts/layout';
import type {
  ProjectConfig,
  ProjectMetadata,
} from '@kontourai/station-contracts/project';
import type { ProjectPortableIdentity } from '@kontourai/station-contracts/project-identity';
import type { ProviderConnectionConfig } from '@kontourai/station-contracts/tool';
import {
  assertObservationTreeBudget,
  KnowledgeObservationRefusal,
  readObservationFile,
} from '../knowledge-store/adapters/shared/observation-file.js';
import type { KnowledgeRootObservation } from '../knowledge-store/knowledge-record-observation.js';
import {
  FileWriteConflictError,
  mutateJsonFile,
  readJsonFile,
  writeJsonFile,
} from './file-storage-helpers.js';
import {
  buildLayoutAgentReferences,
  deleteProjectScopedRecord,
  deleteStoredRecord,
  findStoredRecordAcrossProjects,
  layoutConfigReferencesAgent,
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
  describeLayoutOwner,
  isSameLayoutOwner,
  layoutOwnerDirectory,
  normalizeProjectLayoutRecord,
} from './layout-owner-storage.js';
import {
  FileStorageConflictError,
  FileStorageNotFoundError,
  type ProjectFileTransactionFaults,
  ProjectFileTransactions,
  type ProjectStoredFileRevision,
  type StoredFileRevision,
} from './project-file-transactions.js';
import { parseProjectPortableIdentity } from './project-identity-record.js';
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

/**
 * Distinguishes "no such layout record" from a record whose content happens
 * to be `null` — `readJsonFile`'s fallback is otherwise indistinguishable
 * from a real parsed value.
 */
const MISSING_LAYOUT: unique symbol = Symbol('missing layout record');

/** The read bound `getOwnedLayout` already applies, shared with the updater. */
const OWNED_LAYOUT_MAX_BYTES = 2 * 1024 * 1024;

/**
 * What an update may not change on an existing owned Layout. `slug` and
 * `owner` are absent on purpose: both are checked against the caller's own
 * path scope in `#ownedLayoutWithMatchingIdentity`, which is stricter than a
 * comparison against the previous record.
 */
const OWNED_LAYOUT_IMMUTABLE_FIELDS = ['id', 'createdAt'] as const;

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
    const projects = readSubdirectoryNames(dir).flatMap((name) => {
      let config: ProjectConfig;
      try {
        config = this.projectRevision(name).value;
      } catch (error) {
        if (error instanceof FileStorageNotFoundError) return [];
        throw error;
      }
      if (config.slug !== name) {
        throw new Error(
          `project record identity does not match directory '${name}'`,
        );
      }
      const layoutsDir = join(dir, name, 'layouts');
      const layoutCount = readLayoutRecordNames(layoutsDir).length;
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
            join(dir, name, 'documents', 'metadata.json'),
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
      withCurrentRead: <R>(operation: (value: ProjectConfig) => Promise<R>) =>
        stored.withCurrentRead!(operation),
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
        if (
          parsed.slug !== layoutSlug ||
          !isSameLayoutOwner(layoutOwner(parsed), {
            kind: 'project',
            projectSlug: slug,
          })
        ) {
          throw new Error(
            'layout identity does not match its Project revision',
          );
        }
        await stored.createLayout(
          layoutSlug,
          normalizeProjectLayoutRecord(parsed, slug),
        );
      },
    });
  }

  async createProject(config: ProjectConfig): Promise<void> {
    assertSafeLayoutPathSegment('project slug', config.slug);
    const parsed = parseProjectConfig(config);
    await this.#transactions.createProject(parsed.slug, parsed);
  }

  async createProjectWithIdentity(
    config: ProjectConfig,
    identity: ProjectPortableIdentity,
  ): Promise<void> {
    assertSafeLayoutPathSegment('project slug', config.slug);
    const parsed = parseProjectConfig(config);
    const portable = parseProjectPortableIdentity(identity);
    await this.#transactions.createProjectWithManifest(
      parsed.slug,
      parsed,
      portable,
    );
  }

  async deleteProject(slug: string): Promise<void> {
    await this.projectRevision(slug).remove();
  }

  listLayouts(projectSlug: string): LayoutMetadata[] {
    assertSafeLayoutPathSegment('project slug', projectSlug);
    const dir = join(this.projectHomeDir, 'projects', projectSlug, 'layouts');
    return readLayoutRecordNames(dir).flatMap((file) => {
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
          projectSlug: layoutOwnerProjectSlug(config),
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
      !isSameLayoutOwner(layoutOwner(stored.value), {
        kind: 'project',
        projectSlug,
      })
    ) {
      throw new Error(
        `layout record identity does not match '${projectSlug}/${layoutSlug}'`,
      );
    }
    return Object.freeze({
      value: stored.value,
      replace: async (next: LayoutConfig) => {
        const parsed = parseLayoutConfig(next);
        assertSafeLayoutPathSegment('layout slug', parsed.slug);
        if (
          parsed.slug !== layoutSlug ||
          !isSameLayoutOwner(layoutOwner(parsed), {
            kind: 'project',
            projectSlug,
          }) ||
          parsed.id !== stored.value.id
        ) {
          throw new Error('layout id, owner, and slug are immutable');
        }
        await stored.replace(normalizeProjectLayoutRecord(parsed, projectSlug));
      },
      remove: () => stored.remove(),
    });
  }

  async createLayout(projectSlug: string, config: LayoutConfig): Promise<void> {
    assertSafeLayoutPathSegment('project slug', projectSlug);
    assertSafeLayoutPathSegment('layout slug', config.slug);
    const parsed = parseLayoutConfig(config);
    const owner = layoutOwner(parsed);
    if (!isSameLayoutOwner(owner, { kind: 'project', projectSlug })) {
      throw new Error(
        `layout owned by ${describeLayoutOwner(owner)} cannot be written to project '${projectSlug}'`,
      );
    }
    await this.projectRevision(projectSlug).createLayout(parsed.slug, parsed);
  }

  // ── Owner-scoped layout storage (#2060) ──────────────────────────────────
  // One entry point per operation for all three owners. A project owner
  // delegates to the project-transaction paths above (project lock, project
  // fingerprint); the personal and instance roots are plain owned files
  // outside `projects/`, so nothing a project route reads can reach them.

  listOwnedLayouts(owner: LayoutOwner): LayoutMetadata[] {
    if (owner.kind === 'project') return this.listLayouts(owner.projectSlug);
    const dir = layoutOwnerDirectory(this.projectHomeDir, owner);
    return readLayoutRecordNames(dir)
      .map((file) => file.slice(0, -'.json'.length))
      .sort()
      .flatMap((layoutSlug) => {
        let config: LayoutConfig;
        try {
          config = this.getOwnedLayout(owner, layoutSlug);
        } catch (error) {
          if (error instanceof FileStorageNotFoundError) return [];
          throw error;
        }
        return [
          {
            id: config.id,
            slug: config.slug,
            owner: layoutOwner(config),
            type: config.type,
            name: config.name,
            icon: config.icon,
            description: config.description,
            // Same tolerance as the project listing: a record persisted
            // without `config` must not 500 the whole list.
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

  getOwnedLayout(owner: LayoutOwner, layoutSlug: string): LayoutConfig {
    if (owner.kind === 'project') {
      return this.getLayout(owner.projectSlug, layoutSlug);
    }
    assertSafeLayoutPathSegment('layout slug', layoutSlug);
    const path = this.#ownedLayoutPath(owner, layoutSlug);
    const raw = readJsonFile<unknown>(path, MISSING_LAYOUT, {
      maxBytes: OWNED_LAYOUT_MAX_BYTES,
      label: 'layout record',
    });
    if (raw === MISSING_LAYOUT) {
      throw new FileStorageNotFoundError(
        `Layout '${layoutSlug}' not found for ${describeLayoutOwner(owner)}`,
      );
    }
    const parsed = parseLayoutConfig(raw);
    if (
      parsed.slug !== layoutSlug ||
      !isSameLayoutOwner(layoutOwner(parsed), owner)
    ) {
      throw new Error(
        `layout record identity does not match '${layoutSlug}' for ${describeLayoutOwner(owner)}`,
      );
    }
    return parsed;
  }

  async createOwnedLayout(
    owner: LayoutOwner,
    config: LayoutConfig,
  ): Promise<void> {
    if (owner.kind === 'project') {
      await this.createLayout(owner.projectSlug, config);
      return;
    }
    assertSafeLayoutPathSegment('layout slug', config.slug);
    const parsed = parseLayoutConfig(config);
    const declared = layoutOwner(parsed);
    if (!isSameLayoutOwner(declared, owner)) {
      throw new Error(
        `layout owned by ${describeLayoutOwner(declared)} cannot be written under ${describeLayoutOwner(owner)}`,
      );
    }
    try {
      // `expectedFingerprint: null` is the create: it publishes only if no
      // record is there, under the same mutation lock, so a concurrent second
      // create loses rather than silently replacing the first (and with it the
      // record's immutable id). The project path refuses the same way.
      await writeJsonFile(this.#ownedLayoutPath(owner, parsed.slug), parsed, {
        expectedFingerprint: null,
      });
    } catch (error) {
      if (error instanceof FileWriteConflictError) {
        throw new FileStorageConflictError(
          `Layout '${parsed.slug}' already exists for ${describeLayoutOwner(owner)}`,
        );
      }
      throw error;
    }
  }

  async deleteOwnedLayout(
    owner: LayoutOwner,
    layoutSlug: string,
  ): Promise<void> {
    if (owner.kind === 'project') {
      await this.deleteLayout(owner.projectSlug, layoutSlug);
      return;
    }
    assertSafeLayoutPathSegment('layout slug', layoutSlug);
    const path = this.#ownedLayoutPath(owner, layoutSlug);
    try {
      rmSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new FileStorageNotFoundError(
          `Layout '${layoutSlug}' not found for ${describeLayoutOwner(owner)}`,
        );
      }
      throw error;
    }
  }

  /**
   * Read-modify-write one non-project Layout inside a capability that spans
   * the read AND the publish (#2061).
   *
   * `mutateJsonFile` holds the per-path `${path}.mutation` lock across
   * read/derive/publish, so two concurrent writes to the same Board serialize
   * instead of both reading the same base and the later one erasing the
   * earlier. That is the CAS-less read-modify-write class this repo has hit
   * repeatedly (archive#1588/#1600/#1606) and the reason `BoardStore` reaches
   * for the same primitive rather than a bare read-then-`writeJsonFile`.
   *
   * `update` is handed `undefined` when no record exists, so create and update
   * are ONE serialized transaction: a create that refuses an occupied slug and
   * an update that refuses a missing one both decide inside the lock. There is
   * no separate existence probe for a concurrent writer to slip through.
   *
   * The stored record reaches `update` as a DEFENSIVE COPY, and the pristine
   * value stays here to check the fields an update may not change. Without the
   * copy, an updater that mutates its argument in place and returns it would
   * be compared against ITSELF — `next.id !== current.id` is false once the
   * same object carries the new value — so an id or createdAt change would be
   * published unchallenged, and every reference to that Board would break.
   * (`owner` and `slug` are checked against the CALLER'S owner and slug rather
   * than against `current`, so those two are not exposed to that hazard; the
   * copy is what closes it for the rest.)
   */
  async mutateOwnedLayout(
    owner: LayoutOwner,
    layoutSlug: string,
    update: (current: LayoutConfig | undefined) => LayoutConfig,
  ): Promise<LayoutConfig> {
    if (owner.kind === 'project') {
      // A project layout is written through the project transaction (project
      // lock, project fingerprint, agent-reference integrity). Routing one
      // here would make this a second, weaker writer of the same records.
      throw new Error(
        'mutateOwnedLayout does not write project-owned layouts; use projectRevision().createLayout',
      );
    }
    assertSafeLayoutPathSegment('layout slug', layoutSlug);
    const published = await mutateJsonFile<unknown>(
      this.#ownedLayoutPath(owner, layoutSlug),
      MISSING_LAYOUT,
      (raw) => {
        const current =
          raw === MISSING_LAYOUT
            ? undefined
            : this.#ownedLayoutWithMatchingIdentity(
                parseLayoutConfig(raw),
                owner,
                layoutSlug,
              );
        const next = this.#ownedLayoutWithMatchingIdentity(
          parseLayoutConfig(
            update(
              current === undefined ? undefined : structuredClone(current),
            ),
          ),
          owner,
          layoutSlug,
        );
        if (current !== undefined) {
          for (const field of OWNED_LAYOUT_IMMUTABLE_FIELDS) {
            if (next[field] !== current[field]) {
              throw new Error(
                `layout '${layoutSlug}' ${field} is immutable for ${describeLayoutOwner(owner)}`,
              );
            }
          }
        }
        return next;
      },
      { maxBytes: OWNED_LAYOUT_MAX_BYTES, label: 'layout record' },
    );
    return parseLayoutConfig(published);
  }

  /**
   * A stored or proposed record must name the owner and slug it is filed
   * under. The path already scopes reads and writes to one owner's directory;
   * this refuses a record whose CONTENT disagrees with that path rather than
   * letting the two readings diverge.
   */
  #ownedLayoutWithMatchingIdentity(
    config: LayoutConfig,
    owner: LayoutOwner,
    layoutSlug: string,
  ): LayoutConfig {
    if (
      config.slug !== layoutSlug ||
      !isSameLayoutOwner(layoutOwner(config), owner)
    ) {
      throw new Error(
        `layout record identity does not match '${layoutSlug}' for ${describeLayoutOwner(owner)}`,
      );
    }
    return config;
  }

  #ownedLayoutPath(owner: LayoutOwner, layoutSlug: string): string {
    return join(
      layoutOwnerDirectory(this.projectHomeDir, owner),
      `${layoutSlug}.json`,
    );
  }

  async deleteLayout(projectSlug: string, layoutSlug: string): Promise<void> {
    assertSafeLayoutPathSegment('project slug', projectSlug);
    assertSafeLayoutPathSegment('layout slug', layoutSlug);
    await this.layoutRevision(projectSlug, layoutSlug).remove();
  }

  findLayoutsUsingAgent(agentSlug: string): LayoutAgentReference[] {
    // Every layout root, not just `projects/` (#2060 review MED-4): a Board
    // referencing an agent is still a reason not to delete that agent, and a
    // sweep that cannot see one reports "no dependents" — a delete guard
    // answering from an incomplete corpus.
    return [
      ...buildLayoutAgentReferences(
        this.listProjects(),
        (projectSlug) => this.listLayouts(projectSlug),
        (projectSlug, layoutSlug) => this.getLayout(projectSlug, layoutSlug),
        agentSlug,
        (a, b) => a === b,
      ),
      ...this.#listNonProjectLayouts()
        .filter((layout) =>
          layoutConfigReferencesAgent(layout.config, agentSlug),
        )
        .map((layout) => ({
          owner: layoutOwner(layout),
          layoutSlug: layout.slug,
        })),
    ];
  }

  /**
   * Every principal- and instance-owned record on disk, in a stable order.
   * A record whose own owner does not place it in the directory it was found
   * in is skipped rather than reported: it is not this owner's layout, and
   * `getOwnedLayout` refuses it by name for whoever asks for it directly.
   * A record that fails `parseLayoutConfig` is NOT skipped — it throws, in
   * parity with the project sweep, so a corrupt record cannot be read as
   * "this agent has no dependents".
   *
   * Only directories under `personal/` are principal roots: a stray file the
   * filesystem leaves there (Finder's `.DS_Store`) is not a key, and reading
   * it as one raised ENOTDIR out of every `deleteAgent` on the machine.
   */
  #listNonProjectLayouts(): LayoutConfig[] {
    const root = join(this.projectHomeDir, 'layouts');
    const directories = [
      join(root, 'instance'),
      ...readSubdirectoryNames(join(root, 'personal'))
        .sort()
        .map((key) => join(root, 'personal', key)),
    ];
    const layouts: LayoutConfig[] = [];
    for (const directory of directories) {
      for (const file of readLayoutRecordNames(directory).sort()) {
        const layoutSlug = file.slice(0, -'.json'.length);
        const raw = readJsonFile<unknown>(
          join(directory, file),
          MISSING_LAYOUT,
          {
            maxBytes: 2 * 1024 * 1024,
            label: 'layout record',
          },
        );
        if (raw === MISSING_LAYOUT) continue;
        const parsed = parseLayoutConfig(raw);
        const owner = layoutOwner(parsed);
        if (parsed.slug !== layoutSlug) continue;
        if (
          join(layoutOwnerDirectory(this.projectHomeDir, owner)) !== directory
        )
          continue;
        layouts.push(parsed);
      }
    }
    return layouts;
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

function readDirectoryNames(path: string): string[] {
  try {
    return readdirSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

/**
 * What an entry IS, through a symlink. `Dirent.isDirectory()` reports the
 * link itself, so a symlinked project or principal directory was invisible
 * to every sweep while `getLayout`/`getOwnedLayout` on the same path read
 * it fine (#2076) -- a delete guard blind to a dependent it can otherwise
 * see. A dangling link (`ENOENT` on stat) is nothing, not an error.
 */
function entryKind(path: string): 'directory' | 'file' | null {
  try {
    const stat = statSync(path);
    if (stat.isDirectory()) return 'directory';
    if (stat.isFile()) return 'file';
    return null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/** Child directories of `path` by name, symlinks followed. Missing = none. */
function readSubdirectoryNames(path: string): string[] {
  return readDirectoryNames(path).filter(
    (name) => entryKind(join(path, name)) === 'directory',
  );
}

/**
 * The `*.json` FILES in a layout directory. Suffix alone admitted a
 * directory named `x.json`, which every lister then opened as a record and
 * died on with `EISDIR` (#2076). Nothing writes such a thing; a sweep that
 * throws on it still answers "no dependents" to nobody.
 */
function readLayoutRecordNames(path: string): string[] {
  return readDirectoryNames(path).filter(
    (name) => name.endsWith('.json') && entryKind(join(path, name)) === 'file',
  );
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

/**
 * `KnowledgeStoreProvider` — the K2 seam Station's services/routes consume
 * (docs/design/knowledge-foundation.md K2 section). Holds the root registry
 * (personal + per-project `KnowledgeStoreRoot`s, persisted via the storage adapter's
 * `config/knowledge-store-roots.json`) and the additive adapter registry, and wraps
 * every root's adapter with a thin proxy that fires `onRecordsChanged` + OTel
 * instruments synchronously after each successful Station-driven mutation.
 *
 * Out of scope for K2 (accepted, named gap — see the s200-knowledge-store plan):
 * detecting out-of-band edits to a store's files (e.g. hand-editing a `.md` file in
 * Obsidian outside of Station) via filesystem watching. `onRecordsChanged` only
 * covers mutations that flow through this provider.
 */
import type {
  ApplyEvidence,
  CreateInput,
  KitLink,
  KnowledgeAdapterDescriptor,
  KnowledgeStoreAdapter,
  KnowledgeStoreProvider as KnowledgeStoreProviderContract,
  KnowledgeStoreRoot,
  LinkEvidence,
  ProposeEvidence,
  RejectEvidence,
  RetireEvidence,
  SupersedeEvidence,
  UpdateEvidence,
  UpdateFields,
} from '@kontourai/station-contracts/knowledge-store';
import { isSafePathSegment } from '../knowledge-index/path-safety.js';
import {
  knowledgeStoreRecordOps,
  knowledgeStoreRootOps,
} from '../telemetry/metrics.js';
import { createLogger } from '../utils/logger.js';
import { KnowledgeAdapterRegistry } from './adapter-registry.js';
import { kitDefaultStoreAdapterDescriptor } from './adapters/default-store.js';
import { kitObsidianStoreAdapterDescriptor } from './adapters/obsidian-store.js';
import { observeExactKnowledgeRecordFile } from './adapters/shared/file-transactions.js';
import { parseMarkdown } from './adapters/shared/frontmatter.js';
import {
  assertObservationTreeBudget,
  KnowledgeObservationRefusal,
} from './adapters/shared/observation-file.js';
import { assertKitRecord } from './adapters/shared/record-schema.js';
import type {
  KnowledgeRecordObservation,
  KnowledgeRecordObservationPolicy,
  KnowledgeRootObservation,
} from './knowledge-record-observation.js';

const logger = createLogger({ name: 'knowledge-store-provider' });

function warnObserverFailure(
  message: string,
  fields: Record<string, unknown>,
): void {
  try {
    logger.warn(message, fields);
  } catch {
    // Logging is also an observer.
  }
}

function observeRootOperation(attributes: Record<string, string>): void {
  try {
    knowledgeStoreRootOps.add(1, attributes);
  } catch (error) {
    warnObserverFailure('Knowledge root metrics observer failed', {
      attributes,
      error,
    });
  }
}

/** The subset of `IStorageAdapter` this provider needs — a structural (duck-typed)
 * dependency so this module doesn't have to import the full storage-adapter surface. */
export interface KnowledgeStoreRootPersistence {
  listKnowledgeStoreRoots(): KnowledgeStoreRoot[];
  saveKnowledgeStoreRoot(root: KnowledgeStoreRoot): Promise<void> | void;
  removeKnowledgeStoreRoot(id: string): Promise<void> | void;
  /** Explicit opt-in; ordinary list/get is NOT a zero-write observation fallback. */
  observeKnowledgeStoreRoots?(): KnowledgeRootObservation;
}

type RecordsChangedListener = (event: {
  rootId: string;
  recordIds: string[];
}) => void;

export class KnowledgeStoreProvider implements KnowledgeStoreProviderContract {
  private readonly registry = new KnowledgeAdapterRegistry();
  private readonly adapterInstances = new Map<string, KnowledgeStoreAdapter>();
  private readonly listeners = new Set<RecordsChangedListener>();
  private readonly observationPolicy?: {
    stationHome: string;
    authorize: KnowledgeRecordObservationPolicy['authorize'];
  };

  constructor(
    private readonly persistence: KnowledgeStoreRootPersistence,
    observationPolicy?: KnowledgeRecordObservationPolicy,
  ) {
    if (observationPolicy) {
      const authorize = observationPolicy.authorize;
      this.observationPolicy = {
        stationHome: observationPolicy.stationHome,
        authorize: (target, authority) =>
          Reflect.apply(authorize, observationPolicy, [target, authority]),
      };
    }
    // Pre-register both Station-owned Kit-format adapters (Wave 1: default-file;
    // Wave 2: Obsidian). Additive — plugins may register further adapters via
    // `registerAdapter`.
    this.registry.register(kitDefaultStoreAdapterDescriptor);
    this.registry.register(kitObsidianStoreAdapterDescriptor);
  }

  // ── Root registry ────────────────────────────────────────────────────

  async listRoots(): Promise<KnowledgeStoreRoot[]> {
    observeRootOperation({ op: 'list' });
    return this.persistence.listKnowledgeStoreRoots();
  }

  async getRoot(rootId: string): Promise<KnowledgeStoreRoot | null> {
    const roots = this.persistence.listKnowledgeStoreRoots();
    return roots.find((r) => r.id === rootId) ?? null;
  }

  async createRoot(
    input: Omit<KnowledgeStoreRoot, 'id' | 'createdAt'>,
  ): Promise<KnowledgeStoreRoot> {
    const id = this.generateRootId(input);
    const root: KnowledgeStoreRoot = {
      ...input,
      id,
      createdAt: new Date().toISOString(),
    };
    await this.persistence.saveKnowledgeStoreRoot(root);
    observeRootOperation({
      op: 'create',
      scope: root.scope.kind,
    });
    return root;
  }

  async removeRoot(rootId: string): Promise<void> {
    const root = await this.getRoot(rootId);
    await this.persistence.removeKnowledgeStoreRoot(rootId);
    this.adapterInstances.delete(rootId);
    observeRootOperation({
      op: 'remove',
      scope: root ? root.scope.kind : 'unknown',
    });
  }

  private generateRootId(
    input: Omit<KnowledgeStoreRoot, 'id' | 'createdAt'>,
  ): string {
    const base =
      input.scope.kind === 'personal'
        ? 'root:personal'
        : `root:project-${input.scope.projectSlug}`;
    const existingIds = new Set(
      this.persistence.listKnowledgeStoreRoots().map((r) => r.id),
    );
    if (!existingIds.has(base)) return base;
    let suffix = 2;
    while (existingIds.has(`${base}:${suffix}`)) suffix += 1;
    return `${base}:${suffix}`;
  }

  // ── Adapter registry (additive; plugins may contribute) ────────────────

  registerAdapter(descriptor: KnowledgeAdapterDescriptor): void {
    this.registry.register(descriptor);
  }

  listAdapters(): KnowledgeAdapterDescriptor[] {
    return this.registry.list();
  }

  /**
   * K4 onboarding hook — see the contract's doc comment
   * (`packages/contracts/src/knowledge-store.ts`) for the full honesty
   * contract. Reuses the existing root-ops counter (no new OTel instrument)
   * with `op: 'validate'`.
   */
  async validateRootForAdapter(
    adapterId: string,
    storeRoot: string,
  ): Promise<{ ok: boolean; reason?: string }> {
    observeRootOperation({ op: 'validate', adapterId });
    const descriptor = this.registry.get(adapterId);
    if (!descriptor) {
      return {
        ok: false,
        reason: `Unknown knowledge store adapter '${adapterId}'`,
      };
    }
    if (!descriptor.validateRoot) {
      // No validation hook == no known failure condition (e.g. kit-default-store,
      // which always creates a fresh store) — trivially valid.
      return { ok: true };
    }
    return descriptor.validateRoot(storeRoot);
  }

  // ── Record access — thin delegation to the root's adapter instance ────

  /**
   * Owner-only source observation. No runtime/HTTP/UI composition exists yet;
   * absent host policy denies even localhost and registered-root requests.
   */
  observeExactRecord(
    rootId: string,
    recordId: string,
    authority: unknown,
  ): KnowledgeRecordObservation {
    if (
      typeof rootId !== 'string' ||
      !rootId ||
      rootId.length > 200 ||
      typeof recordId !== 'string' ||
      recordId.length > 200 ||
      !isSafePathSegment(recordId)
    ) {
      return { state: 'invalid-input' };
    }
    const policy = this.observationPolicy;
    if (!policy) return { state: 'restricted' };
    const target = Object.freeze({ rootId, recordId });
    const authorize = (): 'allowed' | 'restricted' | 'unavailable' => {
      const result = policy.authorize(target, authority);
      return result === 'allowed' || result === 'restricted'
        ? result
        : 'unavailable';
    };
    try {
      const initialAccess = authorize();
      if (initialAccess !== 'allowed') return { state: initialAccess };
      const readRegistry = this.persistence.observeKnowledgeStoreRoots;
      if (!readRegistry) return { state: 'unsupported' };
      const registry = Reflect.apply(
        readRegistry,
        this.persistence,
        [],
      ) as KnowledgeRootObservation;
      const root = registry.roots.find((entry) => entry.id === rootId);
      if (!root) return { state: 'missing' };
      if (root.adapterId !== 'kit-default-store')
        return { state: 'unsupported' };
      const rootSnapshot = JSON.stringify(root);
      const beforeReadAccess = authorize();
      if (beforeReadAccess !== 'allowed') return { state: beforeReadAccess };
      const observed = observeExactKnowledgeRecordFile(
        root.storeRoot,
        policy.stationHome,
        recordId,
      );
      let outcome: KnowledgeRecordObservation = { state: 'missing' };
      if (observed.file) {
        const text = observed.file.text;
        const metadataEnd = text.indexOf('\n---\n', 4);
        if (!text.startsWith('---\n') || metadataEnd < 0)
          return { state: 'corrupt' };
        if (metadataEnd > 64 * 1024) return { state: 'over-budget' };
        let parsed: ReturnType<typeof parseMarkdown>;
        try {
          parsed = parseMarkdown(text, {
            maxDepth: 32,
            maxAliases: 0,
            maxTotalMergeKeys: 0,
          });
        } catch {
          return { state: 'corrupt' };
        }
        assertObservationTreeBudget(parsed.meta);
        if (
          parsed.meta.status !== undefined &&
          typeof parsed.meta.status !== 'string'
        ) {
          return { state: 'corrupt' };
        }
        let record: ReturnType<typeof assertKitRecord>;
        try {
          record = assertKitRecord(parsed.meta, parsed.body, 'observed record');
        } catch {
          return { state: 'corrupt' };
        }
        if (record.id !== recordId) return { state: 'corrupt' };
        outcome = {
          state: 'observed',
          source: {
            rootId,
            recordId,
            adapterId: 'kit-default-store',
            type: record.type,
            title: record.title,
            category: record.category,
            body: record.body,
            provenance: {
              agent: record.provenance.agent,
              ...(record.provenance.source_ids === undefined
                ? {}
                : { source_ids: [...record.provenance.source_ids] }),
              ...(record.provenance.session_id === undefined
                ? {}
                : { session_id: record.provenance.session_id }),
              ...(record.provenance.note === undefined
                ? {}
                : { note: record.provenance.note }),
            },
            created_at: record.created_at,
            updated_at: record.updated_at,
            ...(record.status === undefined ? {} : { status: record.status }),
          },
          observation: {
            observedAt: new Date().toISOString(),
            contentDigest: observed.file.digest,
            ownerRevision: 'unknown',
            consistency: 'non-atomic',
            transactionState: 'unknown',
          },
        };
      }
      const finalAccess = authorize();
      if (finalAccess !== 'allowed') return { state: finalAccess };
      const currentRegistry = Reflect.apply(
        readRegistry,
        this.persistence,
        [],
      ) as KnowledgeRootObservation;
      if (
        currentRegistry.digest !== registry.digest ||
        JSON.stringify(
          currentRegistry.roots.find((entry) => entry.id === rootId),
        ) !== rootSnapshot
      ) {
        return { state: 'unavailable' };
      }
      observed.recheck();
      return outcome;
    } catch (error) {
      return {
        state:
          error instanceof KnowledgeObservationRefusal
            ? error.state
            : 'unavailable',
      };
    }
  }

  async adapterFor(rootId: string): Promise<KnowledgeStoreAdapter> {
    const cached = this.adapterInstances.get(rootId);
    if (cached) return cached;

    const root = await this.getRoot(rootId);
    if (!root) throw new Error(`Knowledge store root '${rootId}' not found`);

    const descriptor = this.registry.get(root.adapterId);
    if (!descriptor) {
      throw new Error(
        `Knowledge store adapter '${root.adapterId}' is not registered (root '${rootId}')`,
      );
    }

    const rawAdapter = await descriptor.create({ storeRoot: root.storeRoot });
    const wrapped = this.wrapWithChangeEvents(
      rawAdapter,
      rootId,
      root.adapterId,
    );
    this.adapterInstances.set(rootId, wrapped);
    return wrapped;
  }

  // ── Change signal for the derived index (K3 subscribes) ────────────────

  onRecordsChanged(listener: RecordsChangedListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notifyRecordsChanged(rootId: string, recordIds: string[]): void {
    for (const listener of this.listeners) {
      try {
        listener({ rootId, recordIds });
      } catch (error) {
        warnObserverFailure('Knowledge record-change observer failed', {
          rootId,
          recordIds,
          error,
        });
      }
    }
  }

  /**
   * Wrap an adapter so every successful Station-driven mutation call fires
   * `onRecordsChanged` and the `station.knowledge.record.operations` counter. Reads
   * (`get`/`getLinks`/`listByCategory`/`listByType`) pass through unwrapped.
   */
  private wrapWithChangeEvents(
    adapter: KnowledgeStoreAdapter,
    rootId: string,
    adapterId: string,
  ): KnowledgeStoreAdapter {
    const notify = (recordIds: string[], op: string) => {
      try {
        knowledgeStoreRecordOps.add(1, { op, adapterId });
      } catch (error) {
        warnObserverFailure('Knowledge record metric observer failed', {
          rootId,
          recordIds,
          op,
          adapterId,
          error,
        });
      }
      this.notifyRecordsChanged(rootId, recordIds);
    };

    return {
      create: async (record: CreateInput) => {
        const id = await adapter.create(record);
        notify([id], 'create');
        return id;
      },
      update: async (
        id: string,
        fields: UpdateFields,
        evidence: UpdateEvidence,
      ) => {
        await adapter.update(id, fields, evidence);
        notify([id], 'update');
      },
      link: async (
        sourceId: string,
        links: KitLink[],
        evidence: LinkEvidence,
      ) => {
        await adapter.link(sourceId, links, evidence);
        notify([sourceId], 'link');
      },
      propose: async (
        conceptId: string,
        proposerId: string,
        evidence: ProposeEvidence,
      ) => {
        await adapter.propose(conceptId, proposerId, evidence);
        notify([conceptId, proposerId], 'propose');
      },
      apply: async (
        conceptId: string,
        proposerId: string,
        evidence: ApplyEvidence,
      ) => {
        await adapter.apply(conceptId, proposerId, evidence);
        notify([conceptId], 'apply');
      },
      reject: async (
        conceptId: string,
        proposerId: string,
        evidence: RejectEvidence,
      ) => {
        await adapter.reject(conceptId, proposerId, evidence);
        notify([conceptId], 'reject');
      },
      supersede: async (
        newId: string,
        supersededIds: string[],
        evidence: SupersedeEvidence,
      ) => {
        await adapter.supersede(newId, supersededIds, evidence);
        notify([newId, ...supersededIds], 'supersede');
      },
      retire: async (
        id: string,
        targetStatus: 'implemented' | 'retired',
        evidence: RetireEvidence,
      ) => {
        await adapter.retire(id, targetStatus, evidence);
        notify([id], 'retire');
      },
      get: (idOrHandle: string) => adapter.get(idOrHandle),
      getLinks: (idOrHandle: string) => adapter.getLinks(idOrHandle),
      listByCategory: (category, options) =>
        adapter.listByCategory(category, options),
      listByType: (type, options) => adapter.listByType(type, options),
    };
  }
}

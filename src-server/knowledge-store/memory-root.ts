import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  assertAdapterBoundTo,
  type KitRecord as CorpusRecord,
  type CreateInput,
  type KitCreateProposal,
  KitDefaultStoreAdapter,
  type ProposeEvidence,
} from '@kontourai/corpus-store';
import type { KnowledgeIndexProvider } from '@kontourai/station-contracts/knowledge-index';
import type {
  KitRecord,
  KitRecordType,
  KnowledgeStoreAdapter,
  KnowledgeStoreRoot,
} from '@kontourai/station-contracts/knowledge-store';
import {
  isSessionReadAuthority,
  type SessionReadAuthority,
} from '@kontourai/station-contracts/tenancy';
import { acquireFileMutationLockAsync } from '@kontourai/station-shared/lifecycle-events';
import { FileStorageConflictError } from '../domain/project-file-transactions.js';
import { assertExistingPathInside } from '../utils/path-containment.js';
import { resolveHomeDir } from '../utils/paths.js';
import { ReadOnlyStoreError } from './errors.js';
import type {
  KnowledgeStoreProvider,
  KnowledgeStoreRootPersistence,
} from './knowledge-store-provider.js';
import {
  assertKnowledgeWriteAuthority,
  withKnowledgeWriteAuthority,
} from './knowledge-write-authority.js';
import { MemoryErasureIntentStore } from './memory-erasure-intent.js';

export const MEMORY_ADAPTER_ID = 'corpus-private-memory';

/** The one derivation of an owner's directory and root id; review records use the same key. */
export function memoryOwnerHash(owner: string): string {
  return createHash('sha256').update(owner).digest('hex');
}

/** Corpus tombstones are not ordinary Knowledge records. The erasure surface owns their projection. */
function readableRecord(record: CorpusRecord): KitRecord | null {
  const { status, ...rest } = record;
  if (status === 'purged') return null;
  return status === undefined ? rest : { ...rest, status };
}

function reader(
  adapter: KitDefaultStoreAdapter,
  check: () => void,
): KnowledgeStoreAdapter {
  const refused = async (): Promise<never> => {
    throw new ReadOnlyStoreError('mutation');
  };
  return {
    create: refused,
    update: refused,
    link: refused,
    propose: refused,
    apply: refused,
    reject: refused,
    supersede: refused,
    retire: refused,
    get: async (id) => {
      check();
      const record = await adapter.get(id);
      return record ? readableRecord(record) : null;
    },
    getLinks: (id) => {
      check();
      return adapter.getLinks(id);
    },
    listByCategory: async (category, options) => {
      check();
      return (await adapter.listByCategory(category, options)).flatMap(
        (record) => {
          const visible = readableRecord(record);
          return visible ? [visible] : [];
        },
      );
    },
    listByType: async (type, options) => {
      check();
      return (await adapter.listByType(type, options)).flatMap((record) => {
        const visible = readableRecord(record);
        return visible ? [visible] : [];
      });
    },
  };
}

/** The manager is an internal host seam; callers must supply request-derived authority. */
export class MemoryRootManager {
  private readonly adapters = new Map<string, KitDefaultStoreAdapter>();
  private readonly home: string;

  constructor(
    private readonly store: KnowledgeStoreProvider,
    private readonly persistence: KnowledgeStoreRootPersistence,
    home: string,
    private readonly enabled: () => boolean,
  ) {
    this.home = resolve(home);
    store.registerAdapter({
      id: MEMORY_ADAPTER_ID,
      displayName: 'Private memory',
      validateRegistration: (root) => {
        if (!this.isMemoryRoot(root))
          throw new Error('Private memory registration is invalid.');
      },
      create: async ({ storeRoot }) =>
        reader(this.corpus(storeRoot), () => {
          this.corpus(storeRoot);
        }),
    });
  }

  isMemoryRoot(root: KnowledgeStoreRoot): boolean {
    const owner = root.readPolicy?.ownerId;
    if (!owner) return false;
    const hash = createHash('sha256').update(owner).digest('hex');
    try {
      return (
        root.id === `root:memory:${hash}` &&
        this.verify(
          root,
          owner,
          join(this.home, 'knowledge', 'memory', hash),
        ) === root
      );
    } catch {
      return false;
    }
  }

  private requireOwner(authority: SessionReadAuthority | undefined): string {
    if (
      !this.enabled() ||
      !isSessionReadAuthority(authority) ||
      authority.mode !== 'personal' ||
      !authority.userId.trim()
    )
      throw new Error('Private memory is unavailable.');
    return authority.userId;
  }

  private corpus(
    path: string,
    mode: 'read' | 'erase' | 'recovery' = 'read',
  ): KitDefaultStoreAdapter {
    if (!this.enabled() && mode !== 'recovery')
      throw new Error('Private memory is unavailable.');
    assertExistingPathInside(this.home, path, 'Private memory root');
    const cacheKey = JSON.stringify([path, mode]);
    const existing = this.adapters.get(cacheKey);
    if (existing) {
      assertAdapterBoundTo(existing, path);
      return existing;
    }
    const home = this.home;
    const adapter = new KitDefaultStoreAdapter({
      storeRoot: path,
      coordinationDirectory: join(
        home,
        'coordination',
        'knowledge-file-transactions',
      ),
      lock: acquireFileMutationLockAsync,
      coordinationIdentity: () => {
        if (
          (!this.enabled() && mode !== 'recovery') ||
          resolve(resolveHomeDir()) !== home
        )
          throw new Error(
            'Station home changed or private memory is unavailable.',
          );
        const stat = lstatSync(home);
        const real = realpathSync.native(home);
        if (!stat.isDirectory() || stat.isSymbolicLink())
          throw new Error('Station home unavailable.');
        return () => {
          const current = lstatSync(home);
          if (
            (!this.enabled() && mode !== 'recovery') ||
            resolve(resolveHomeDir()) !== home ||
            !current.isDirectory() ||
            current.isSymbolicLink() ||
            current.dev !== stat.dev ||
            current.ino !== stat.ino ||
            realpathSync.native(home) !== real
          )
            throw new Error('Station home changed.');
          assertKnowledgeWriteAuthority(path);
        };
      },
      allowPurge: mode === 'erase',
    });
    assertAdapterBoundTo(adapter, path);
    this.adapters.set(cacheKey, adapter);
    return adapter;
  }

  async findRoot(
    authority: SessionReadAuthority | undefined,
    assertCurrent: () => void,
  ): Promise<KnowledgeStoreRoot | null> {
    const owner = this.requireOwner(authority);
    assertCurrent();
    const hash = createHash('sha256').update(owner).digest('hex');
    const root = await this.store.getRoot(`root:memory:${hash}`);
    this.requireOwner(authority);
    assertCurrent();
    return root
      ? this.verify(root, owner, join(this.home, 'knowledge', 'memory', hash))
      : null;
  }

  async ensureRoot(
    authority: SessionReadAuthority | undefined,
    assertCurrent: () => void,
  ): Promise<KnowledgeStoreRoot> {
    const owner = this.requireOwner(authority);
    assertCurrent();
    const hash = createHash('sha256').update(owner).digest('hex');
    const id = `root:memory:${hash}`;
    const path = join(this.home, 'knowledge', 'memory', hash);
    assertExistingPathInside(this.home, path, 'Private memory root');
    const existing = await this.store.getRoot(id);
    if (existing)
      return this.bindRegisteredRoot(
        this.verify(existing, owner, path),
        authority,
        assertCurrent,
      );
    const root: KnowledgeStoreRoot = {
      id,
      scope: { kind: 'personal' },
      readPolicy: { kind: 'author-private', ownerId: owner },
      registrationId: randomUUID(),
      adapterId: MEMORY_ADAPTER_ID,
      storeRoot: path,
      displayName: 'Private memory',
      createdAt: new Date().toISOString(),
    };
    try {
      assertCurrent();
      await this.persistence.saveKnowledgeStoreRoot(root, {
        createOnly: true,
        assertCurrent: () => {
          this.requireOwner(authority);
          assertCurrent();
        },
      });
      return await this.bindRegisteredRoot(root, authority, assertCurrent);
    } catch (error) {
      if (!(error instanceof FileStorageConflictError)) throw error;
      const current = await this.store.getRoot(id);
      if (!current) throw error;
      this.requireOwner(authority);
      assertCurrent();
      return this.bindRegisteredRoot(
        this.verify(current, owner, path),
        authority,
        assertCurrent,
      );
    }
  }

  private async bindRegisteredRoot(
    root: KnowledgeStoreRoot,
    authority: SessionReadAuthority | undefined,
    assertCurrent: () => void,
  ): Promise<KnowledgeStoreRoot> {
    if (!this.store.withRootRevision)
      throw new Error('Private memory revision is unavailable.');
    const check = () => {
      this.requireOwner(authority);
      assertCurrent();
    };
    check();
    return withKnowledgeWriteAuthority(root.storeRoot, check, () =>
      this.store.withRootRevision!(root, async () => {
        check();
        this.corpus(root.storeRoot);
        return root;
      }),
    );
  }

  private verify(
    root: KnowledgeStoreRoot,
    owner: string,
    path: string,
  ): KnowledgeStoreRoot {
    if (
      root.scope.kind !== 'personal' ||
      root.readPolicy?.kind !== 'author-private' ||
      root.readPolicy.ownerId !== owner ||
      root.adapterId !== MEMORY_ADAPTER_ID ||
      root.storeRoot !== path ||
      !root.registrationId
    )
      throw new Error('Private memory registration is invalid.');
    return root;
  }

  private async withOwner<T>(
    authority: SessionReadAuthority | undefined,
    root: KnowledgeStoreRoot,
    assertCurrent: () => void,
    operation: (adapter: KitDefaultStoreAdapter) => Promise<T>,
    mode: 'read' | 'erase' = 'read',
  ): Promise<T> {
    const owner = this.requireOwner(authority);
    const hash = createHash('sha256').update(owner).digest('hex');
    this.verify(root, owner, join(this.home, 'knowledge', 'memory', hash));
    if (root.id !== `root:memory:${hash}` || !this.store.withRootRevision)
      throw new Error('Private memory revision is unavailable.');
    return this.store.withRootRevision(root, async () => {
      this.requireOwner(authority);
      assertCurrent();
      return withKnowledgeWriteAuthority(
        root.storeRoot,
        () => {
          this.requireOwner(authority);
          assertCurrent();
        },
        () => operation(this.corpus(root.storeRoot, mode)),
      );
    });
  }

  withErasure<T>(
    authority: SessionReadAuthority,
    root: KnowledgeStoreRoot,
    assertCurrent: () => void,
    operation: (
      adapter: Pick<
        KitDefaultStoreAdapter,
        | 'rootBinding'
        | 'get'
        | 'getProposal'
        | 'listProposals'
        | 'previewPurge'
        | 'previewPurgeProposal'
        | 'purge'
        | 'purgeProposal'
      >,
    ) => Promise<T>,
  ): Promise<T> {
    return this.withOwner(
      authority,
      root,
      assertCurrent,
      (adapter) =>
        operation({
          rootBinding: () => adapter.rootBinding(),
          get: (id) => adapter.get(id),
          getProposal: (id) => adapter.getProposal(id),
          listProposals: () => adapter.listProposals(),
          previewPurge: (ids) => adapter.previewPurge(ids),
          previewPurgeProposal: (id) => adapter.previewPurgeProposal(id),
          purge: (ids, evidence, options) =>
            adapter.purge(ids, evidence, options),
          purgeProposal: (id, evidence, options) =>
            adapter.purgeProposal(id, evidence, options),
        }),
      'erase',
    );
  }

  private async withRecovery<T>(
    root: KnowledgeStoreRoot,
    operation: (adapter: KitDefaultStoreAdapter) => Promise<T>,
  ): Promise<T> {
    if (!this.isMemoryRoot(root) || !this.persistence.withKnowledgeStoreRoot)
      throw new Error('Private memory recovery is unavailable.');
    return this.persistence.withKnowledgeStoreRoot(root, () =>
      withKnowledgeWriteAuthority(
        root.storeRoot,
        () => {
          if (!this.isMemoryRoot(root))
            throw new Error('Private memory root changed.');
        },
        () => operation(this.corpus(root.storeRoot, 'recovery')),
      ),
    );
  }

  async recoveryTargetErased(
    root: KnowledgeStoreRoot,
    kind: 'record' | 'proposal',
    id: string,
  ): Promise<boolean> {
    return this.withRecovery(root, async (adapter) => {
      if (kind === 'proposal')
        return Boolean((await adapter.getProposal(id))?.erasure);
      return (await adapter.get(id))?.status === 'purged';
    });
  }

  async withRecoveryStatus<T>(
    root: KnowledgeStoreRoot,
    kind: 'record' | 'proposal',
    id: string,
    expectedBinding: string,
    operation: (erased: boolean) => Promise<T>,
  ): Promise<T> {
    return this.withRecovery(root, async (adapter) => {
      if (adapter.rootBinding() !== expectedBinding)
        throw new Error('Private memory binding changed before recovery.');
      const erased =
        kind === 'proposal'
          ? Boolean((await adapter.getProposal(id))?.erasure)
          : (await adapter.get(id))?.status === 'purged';
      return operation(erased);
    });
  }

  async withRecoveryTombstones<T>(
    root: KnowledgeStoreRoot,
    operation: (ids: string[], binding: string) => Promise<T>,
  ): Promise<T> {
    return this.withRecovery(root, async (adapter) => {
      const types: KitRecordType[] = [
        'raw',
        'compiled',
        'concept',
        'snapshot',
        'person',
      ];
      const ids: string[] = [];
      for (const type of types) {
        for (const record of await adapter.listByType(type, {
          includeHistory: true,
        }))
          if (record.status === 'purged') ids.push(record.id);
      }
      return operation(ids, adapter.rootBinding());
    });
  }

  async listProposals(
    authority: SessionReadAuthority,
    root: KnowledgeStoreRoot,
    assertCurrent: () => void,
  ) {
    return this.withOwner(authority, root, assertCurrent, (adapter) =>
      adapter.listProposals(),
    );
  }

  async withProposals<T>(
    authority: SessionReadAuthority,
    root: KnowledgeStoreRoot,
    assertCurrent: () => void,
    operation: (proposals: KitCreateProposal[]) => Promise<T>,
  ): Promise<T> {
    return this.withOwner(authority, root, assertCurrent, async (adapter) => {
      if (
        existsSync(join(this.home, 'data', 'memory-erasure', 'intents.sqlite'))
      ) {
        const journal = new MemoryErasureIntentStore(this.home);
        try {
          const open = journal.open();
          if (
            open.kind !== 'entries' ||
            open.entries.some(
              (entry) => journal.decode(entry).rootId === root.id,
            )
          )
            throw new Error('Memory erasure cleanup is pending.');
        } finally {
          await journal.close();
        }
      }
      const proposals = await adapter.listProposals();
      const checked = new Map<string, boolean>();
      const readable: KitCreateProposal[] = [];
      for (const proposal of proposals) {
        const sources = new Set([
          ...(proposal.candidate.provenance?.source_ids ?? []),
          ...(proposal.candidate.links ?? [])
            .filter((link) => link.kind === 'source')
            .map((link) => link.target_id),
        ]);
        let permitted = true;
        for (const id of sources) {
          if (!checked.has(id)) {
            const record = await adapter.get(id);
            checked.set(id, Boolean(record && record.status !== 'purged'));
          }
          if (!checked.get(id)) permitted = false;
        }
        if (permitted) readable.push(proposal);
      }
      return operation(readable);
    });
  }

  /** Fence Station-mediated writes while the index snapshots and publishes. */
  rebuildFence(
    authority: SessionReadAuthority,
    root: KnowledgeStoreRoot,
    assertCurrent: () => void,
  ): NonNullable<
    Parameters<KnowledgeIndexProvider['rebuildRoot']>[1]['withRootRevision']
  > {
    let captured = false;
    let anchor: string | undefined;
    let revision: string | undefined;
    return (operation, phase) =>
      this.withOwner(authority, root, assertCurrent, async (adapter) => {
        const readAdapter = reader(adapter, () => this.corpus(root.storeRoot));
        if (phase === 'snapshot') {
          if (captured)
            throw new Error('Memory snapshot was already captured.');
          const records = await operation(readAdapter);
          if (!Array.isArray(records))
            throw new Error('Memory snapshot is invalid.');
          anchor = records[0]?.id;
          if (anchor)
            revision = (await adapter.previewPurge([anchor])).revision;
          captured = true;
          return records;
        }
        if (!captured || (phase !== 'pre-embed' && phase !== 'publish'))
          throw new Error('Memory snapshot is unavailable.');
        if (
          anchor &&
          (await adapter.previewPurge([anchor])).revision !== revision
        )
          throw new Error('Memory changed during index rebuild.');
        return operation(readAdapter);
      });
  }

  async previewErasureTarget(
    authority: SessionReadAuthority,
    root: KnowledgeStoreRoot,
    assertCurrent: () => void,
    kind: 'record' | 'proposal',
    id: string,
  ) {
    return this.withOwner(authority, root, assertCurrent, async (adapter) => {
      if (kind === 'proposal') {
        const proposal = await adapter.getProposal(id);
        if (!proposal || proposal.erasure) return null;
        const before = await adapter.previewPurgeProposal(proposal.id);
        const current = await adapter.getProposal(proposal.id);
        const impact = await adapter.previewPurgeProposal(proposal.id);
        if (!current || current.erasure || before.revision !== impact.revision)
          throw new Error('Private memory changed during preview.');
        return { kind, id: current.id, title: current.candidate.title, impact };
      }
      const record = await adapter.get(id);
      if (!record || record.status === 'purged' || record.id !== id)
        return null;
      const before = await adapter.previewPurge([record.id]);
      const current = await adapter.get(record.id);
      const impact = await adapter.previewPurge([record.id]);
      if (
        !current ||
        current.status === 'purged' ||
        before.revision !== impact.revision
      )
        throw new Error('Private memory changed during preview.');
      return { kind, id: current.id, title: current.title, impact };
    });
  }

  async applyCreate(
    authority: SessionReadAuthority,
    root: KnowledgeStoreRoot,
    assertCurrent: () => void,
    proposalId: string,
  ) {
    return this.withOwner(authority, root, assertCurrent, (adapter) =>
      adapter.applyCreate(proposalId, authority.userId),
    );
  }

  async rejectCreate(
    authority: SessionReadAuthority,
    root: KnowledgeStoreRoot,
    assertCurrent: () => void,
    proposalId: string,
    rationale: string,
  ) {
    return this.withOwner(authority, root, assertCurrent, (adapter) =>
      adapter.rejectCreate(proposalId, authority.userId, rationale),
    );
  }

  /** The host must attest proposerId to the actual proposer; request data alone is not authority. */
  async propose(
    authority: SessionReadAuthority,
    root: KnowledgeStoreRoot,
    assertCurrent: () => void,
    candidate: CreateInput,
    evidence: ProposeEvidence,
    proposerId: string,
    requestKey: string,
  ): Promise<string> {
    const capturedCandidate = structuredClone(candidate);
    const capturedEvidence = structuredClone(evidence);
    return this.withOwner(authority, root, assertCurrent, (adapter) =>
      adapter.proposeCreate(capturedCandidate, proposerId, capturedEvidence, {
        requestKey,
      }),
    );
  }
}

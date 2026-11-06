import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  assertAdapterBoundTo,
  type KitRecord as CorpusRecord,
  type CreateInput,
  KitDefaultStoreAdapter,
  type ProposeEvidence,
} from '@kontourai/corpus-store';
import type {
  KitRecord,
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

  private corpus(path: string): KitDefaultStoreAdapter {
    if (!this.enabled()) throw new Error('Private memory is unavailable.');
    assertExistingPathInside(this.home, path, 'Private memory root');
    const existing = this.adapters.get(path);
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
        if (!this.enabled() || resolve(resolveHomeDir()) !== home)
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
            !this.enabled() ||
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
    });
    assertAdapterBoundTo(adapter, path);
    this.adapters.set(path, adapter);
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
        () => operation(this.corpus(root.storeRoot)),
      );
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
        return { kind, id: proposal.id, title: proposal.candidate.title };
      }
      const record = await adapter.get(id);
      if (!record || record.status === 'purged' || record.id !== id)
        return null;
      return { kind, id: record.id, title: record.title };
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

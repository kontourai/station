import { createHash } from 'node:crypto';
import type { KitCreateProposal, PurgeResult } from '@kontourai/corpus-store';
import type { KnowledgeIndexProvider } from '@kontourai/station-contracts/knowledge-index';
import type { KnowledgeStoreRoot } from '@kontourai/station-contracts/knowledge-store';
import type { SessionReadAuthority } from '@kontourai/station-contracts/tenancy';
import type { KnowledgeStoreProvider } from './knowledge-store-provider.js';
import {
  type MemoryErasureIntent,
  MemoryErasureIntentStore,
  type MemoryErasureReceipt,
} from './memory-erasure-intent.js';
import { memoryReviewBindings } from './memory-review.js';
import { MemoryReviewStore } from './memory-review-store.js';
import { MemoryRootManager, memoryOwnerHash } from './memory-root.js';

export class MemoryErasureError extends Error {
  constructor(
    readonly code:
      | 'STALE_REVISION'
      | 'REQUEST_KEY_CONFLICT'
      | 'CLEANUP_PENDING',
  ) {
    super(code);
  }
}

function erasedIds(result: PurgeResult | undefined): string[] {
  return result
    ? [
        ...new Set([
          ...result.purged,
          ...result.cascaded,
          ...result.alreadyPurged,
        ]),
      ]
    : [];
}

/** Corpus owns the purge plan; Monument retains its content-free cleanup intent. */
export class MemoryErasureCoordinator {
  constructor(
    private readonly home: string,
    private readonly store: KnowledgeStoreProvider,
    private readonly manager: MemoryRootManager,
    private readonly index: KnowledgeIndexProvider,
  ) {}

  private async cleanReview(
    owner: string,
    proposals: KitCreateProposal[],
  ): Promise<void> {
    await new MemoryReviewStore(this.home, memoryOwnerHash(owner)).pruneItems(
      memoryReviewBindings(proposals),
    );
  }

  private async clean(
    journal: MemoryErasureIntentStore,
    parent: MemoryErasureIntent,
    ids: string[],
  ): Promise<void> {
    if (!this.index.removeErasedRecords)
      throw new Error('Knowledge index erasure is unavailable.');
    const claimedIds: Array<{ id: string; key: string }> = [];
    for (const id of ids) {
      const key = createHash('sha256')
        .update(JSON.stringify([parent.purgeId, id]))
        .digest('hex');
      const intent: MemoryErasureIntent = {
        ...parent,
        operation: 'cleanup',
        purgeId: key,
        parentPurgeId: parent.purgeId,
        targetKind: 'record',
        targetId: id,
        impact: undefined,
      };
      const submitted = journal.submit(intent);
      if (submitted.kind !== 'accepted' && submitted.kind !== 'existing')
        throw new Error('Memory index cleanup intent is unavailable.');
      const alreadyPlaced =
        submitted.kind === 'existing' && submitted.entry.state === 'placed';
      if (!alreadyPlaced) {
        const claimed = journal.claimNext(parent.rootId, key, 'cleanup', id);
        if (
          (claimed.kind !== 'claimed' && claimed.kind !== 'in-flight') ||
          claimed.entry.key !== key
        )
          throw new Error('Memory index cleanup is pending.');
        claimedIds.push({ id, key });
      }
    }
    if (ids.length) await this.index.removeErasedRecords(parent.rootId, ids);
    for (const { id, key } of claimedIds) {
      if (
        journal.settle(parent.rootId, key, 'placed', null, 'cleanup', id)
          .kind !== 'applied'
      )
        throw new Error('Memory index cleanup is pending.');
    }
  }

  async erase(
    authority: SessionReadAuthority,
    root: KnowledgeStoreRoot,
    assertCurrent: () => void,
    kind: 'record' | 'proposal',
    id: string,
    revision: string,
    purgeId: string,
  ): Promise<MemoryErasureReceipt | null> {
    if (!this.index.removeErasedRecords || !root.registrationId)
      throw new Error('Knowledge index erasure is unavailable.');
    const receipt = await this.manager.withErasure(
      authority,
      root,
      assertCurrent,
      async (adapter) => {
        const journal = new MemoryErasureIntentStore(this.home);
        try {
          const existing = journal.read(root.id, purgeId);
          if (existing.kind === 'found') {
            const intent = journal.decode(existing.entry);
            if (
              intent.operation !== 'purge' ||
              intent.ownerId !== authority.userId ||
              intent.binding !== adapter.rootBinding() ||
              intent.targetKind !== kind ||
              intent.targetId !== id ||
              intent.revision !== revision
            )
              throw new MemoryErasureError('REQUEST_KEY_CONFLICT');
            if (existing.entry.state === 'placed')
              return journal.decodeReceipt(existing.entry);
            if (existing.entry.state === 'refused')
              throw new MemoryErasureError('STALE_REVISION');
            if (existing.entry.state === 'placing') {
              const erased =
                kind === 'proposal'
                  ? Boolean((await adapter.getProposal(id))?.erasure)
                  : (await adapter.get(id))?.status === 'purged';
              if (!erased) {
                if (
                  journal.settle(root.id, purgeId, 'refused', null).kind !==
                  'applied'
                )
                  throw new MemoryErasureError('CLEANUP_PENDING');
                throw new MemoryErasureError('STALE_REVISION');
              }
              await this.clean(journal, intent, erasedIds(intent.impact));
              await this.cleanReview(
                intent.ownerId,
                await adapter.reviewableProposals(),
              );
              if (
                journal.settle(root.id, purgeId, 'placed', null).kind !==
                'applied'
              )
                throw new MemoryErasureError('CLEANUP_PENDING');
              return null;
            }
            throw new MemoryErasureError('CLEANUP_PENDING');
          }
          if (existing.kind !== 'absent')
            throw new Error('Memory erasure journal is unavailable.');

          const preview =
            kind === 'record'
              ? await adapter.previewPurge([id])
              : await adapter.previewPurgeProposal(id);
          if (preview.revision !== revision)
            throw new MemoryErasureError('STALE_REVISION');
          const impact = 'proposalId' in preview ? preview.record : preview;
          await new MemoryReviewStore(
            this.home,
            memoryOwnerHash(authority.userId),
          ).bindItems(
            memoryReviewBindings(await adapter.reviewableProposals()),
          );
          const intent: MemoryErasureIntent = {
            version: 1,
            operation: 'purge',
            purgeId,
            rootId: root.id,
            ownerId: authority.userId,
            registrationId: root.registrationId!,
            binding: adapter.rootBinding(),
            targetKind: kind,
            targetId: id,
            revision,
            ...(impact ? { impact } : {}),
          };
          const submitted = journal.submit(intent);
          if (submitted.kind === 'conflict')
            throw new MemoryErasureError('REQUEST_KEY_CONFLICT');
          if (submitted.kind !== 'accepted')
            throw new MemoryErasureError('CLEANUP_PENDING');
          const claimed = journal.claimNext(root.id, purgeId);
          if (claimed.kind !== 'claimed' || claimed.entry.key !== purgeId)
            throw new MemoryErasureError('CLEANUP_PENDING');
          let actual: MemoryErasureReceipt;
          try {
            const evidence = {
              agent: authority.userId,
              rationale: 'Owner requested erasure',
            };
            actual =
              kind === 'record'
                ? {
                    kind,
                    result: await adapter.purge([id], evidence, {
                      expectedRevision: revision,
                    }),
                  }
                : {
                    kind,
                    result: await adapter.purgeProposal(id, evidence, {
                      expectedRevision: revision,
                    }),
                  };
          } catch (error) {
            if (
              error &&
              typeof error === 'object' &&
              'code' in error &&
              error.code === 'STALE_REVISION'
            ) {
              journal.settle(root.id, purgeId, 'refused', null);
              throw new MemoryErasureError('STALE_REVISION');
            }
            throw error;
          }
          const result =
            actual.kind === 'record' ? actual.result : actual.result.record;
          await this.clean(journal, intent, erasedIds(result));
          await this.cleanReview(
            intent.ownerId,
            await adapter.reviewableProposals(),
          );
          const settled = journal.settle(root.id, purgeId, 'placed', actual);
          if (settled.kind !== 'applied')
            throw new MemoryErasureError('CLEANUP_PENDING');
          return actual;
        } finally {
          await journal.close();
        }
      },
    );
    await this.reconcileRoot(root);
    return receipt;
  }

  async recoverAll(): Promise<void> {
    const roots = (await this.store.listRoots()).filter((root) =>
      this.manager.isMemoryRoot(root),
    );
    if (!roots.length) return;
    const journal = new MemoryErasureIntentStore(this.home);
    try {
      const open = journal.open();
      if (open.kind !== 'entries')
        throw new Error('Memory erasure journal is unavailable.');
      for (const entry of open.entries) {
        const intent = journal.decode(entry);
        const root = roots.find(
          (candidate) =>
            candidate.id === intent.rootId &&
            candidate.readPolicy?.ownerId === intent.ownerId,
        );
        if (!root)
          throw new Error('Memory erasure root changed before recovery.');
        // A re-registration may recover only against the same bound store;
        // withRecoveryStatus checks that binding under the current root lease.
        await this.manager.withRecoveryStatus(
          root,
          intent.targetKind,
          intent.targetId,
          intent.binding,
          async (erased, proposals) => {
            const latest = journal.read(
              root.id,
              intent.purgeId,
              intent.operation,
              intent.targetId,
            );
            if (
              latest.kind === 'found' &&
              (latest.entry.state === 'placed' ||
                latest.entry.state === 'refused')
            )
              return;
            if (latest.kind !== 'found')
              throw new Error('Memory erasure recovery is unavailable.');
            const claimed = journal.claimNext(
              root.id,
              intent.purgeId,
              intent.operation,
              intent.targetId,
            );
            if (
              (claimed.kind !== 'claimed' && claimed.kind !== 'in-flight') ||
              claimed.entry.key !== intent.purgeId
            )
              throw new Error('Memory erasure recovery is unavailable.');
            if (erased) {
              const ids =
                intent.operation === 'cleanup'
                  ? [intent.targetId]
                  : erasedIds(intent.impact);
              if (intent.operation === 'cleanup') {
                await this.index.removeErasedRecords!(root.id, ids);
              } else {
                await this.clean(journal, intent, ids);
                await this.cleanReview(intent.ownerId, proposals);
              }
            }
            const settled = journal.settle(
              root.id,
              intent.purgeId,
              erased ? 'placed' : 'refused',
              null,
              intent.operation,
              intent.targetId,
            );
            if (settled.kind !== 'applied')
              throw new Error('Memory erasure recovery is unavailable.');
          },
        );
      }
    } finally {
      await journal.close();
    }
    for (const root of roots) await this.reconcileRoot(root);
  }

  async reconcileRoot(root: KnowledgeStoreRoot): Promise<void> {
    if (
      !root.registrationId ||
      !root.readPolicy?.ownerId ||
      !this.index.removeErasedRecords
    )
      throw new Error('Memory erasure reconciliation is unavailable.');
    await this.manager.withRecoveryTombstones(
      root,
      async (ids, binding, proposals) => {
        await this.cleanReview(root.readPolicy!.ownerId, proposals);
        if (!ids.length) return;
        const journal = new MemoryErasureIntentStore(this.home);
        try {
          const parent: MemoryErasureIntent = {
            version: 1,
            operation: 'purge',
            purgeId: createHash('sha256')
              .update(
                JSON.stringify([
                  'reconcile',
                  root.id,
                  root.registrationId,
                  binding,
                ]),
              )
              .digest('hex'),
            rootId: root.id,
            ownerId: root.readPolicy!.ownerId,
            registrationId: root.registrationId!,
            binding,
            targetKind: 'record',
            targetId: ids[0],
            revision: 'reconcile',
          };
          await this.clean(journal, parent, ids);
        } finally {
          await journal.close();
        }
      },
    );
  }
}

/**
 * #4003 layer 4 (Learning): a done Task's standing decisions and dead ends
 * as candidates for its Project's knowledge store, reviewed by a person.
 *
 * - Candidates are DERIVED on read from Task memory
 *   (`TaskMemoryStore.listStandingRecords`). Nothing is copied until a
 *   person promotes one.
 * - A promotion is one `create` through the Project store's own adapter
 *   (`KnowledgeStoreProvider.adapterFor`), the same write path
 *   `POST /api/knowledge/roots/:rootId/records` uses, with the Task, record
 *   version and work item in the record's creation provenance.
 * - The record's id is derived from the Task incarnation and the record
 *   version, so a store refuses a second record for one version.
 * - Across stores, a version is promoted once (review F9): before the
 *   knowledge write, the promotion inserts one append-only row naming its
 *   store (`task_learning_promotions`, migration 022). A later or
 *   concurrent promotion of that version finds the row and writes, or reads
 *   back, only in that store, so two people choosing two stores still get
 *   one record. When the row's write failed or was interrupted, the next
 *   promotion finishes it in the row's store, with that request's edited
 *   title and text. The row pins the store's identity (adapter and
 *   directory), since root ids are reused. A version whose pinned store is
 *   no longer one of the Project's answers `promotion-store-gone`, is never
 *   written elsewhere, and reads as a closed review.
 *   The dismissal check runs inside the row's transaction too, and a
 *   dismissal is refused once the row exists, so a claimed promotion whose
 *   write failed can still be finished. "Promoted"
 *   in the candidate list is still read back from the stores.
 * - A dismissal is kept in `task_learning_dismissals` (migration 021).
 *
 * Authority is the caller's: the routes pass a person's Task-room access.
 * No station-control tool names these routes, so an agent never reaches them.
 */
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import type {
  KitRecord,
  KnowledgeStoreProvider,
  KnowledgeStoreRoot,
} from '@kontourai/station-contracts/knowledge-store';
import type { TaskRecord } from '@kontourai/station-contracts/task-graph';
import {
  TASK_LEARNING_LIMITS,
  TASK_LEARNING_VERSION,
  type TaskLearningCandidate,
  type TaskLearningDismissal,
  type TaskLearningKind,
  type TaskLearningPromotion,
  type TaskLearningStore,
  type TaskLearningView,
  type TaskMemoryRecord,
} from '@kontourai/station-contracts/task-memory';
import { CONVERSATION_STORE_ADAPTER_ID } from '../../knowledge-store/adapters/conversation-store.js';
import type {
  TaskLearningDismissalRecord,
  TaskMemoryIncarnation,
  TaskMemoryStore,
} from '../orchestration/task-memory-store.js';

/** `provenance.agent` of a promoted record: the process that wrote it. */
export const TASK_LEARNING_PROVENANCE_AGENT = 'station-task-learning';

const CATEGORY: Record<TaskLearningKind, string> = {
  decision: 'task-learning.decisions',
  dead_end: 'task-learning.dead-ends',
};
const KIND_SLUG: Record<TaskLearningKind, string> = {
  decision: 'decision',
  dead_end: 'dead-end',
};

/** A person's Task-room access, as `ProjectTaskRoomRuntime` grants it. */
export interface TaskLearningAccess {
  readonly memory: TaskMemoryStore;
  readonly task: TaskRecord;
  /** The room's Project id, which dismissals are recorded under. */
  readonly projectId: string;
  /** The Project slug its knowledge stores are scoped by. */
  readonly projectSlug: string;
  readonly principalId: string;
  /** False once the Task incarnation or its room changed. */
  readonly isCurrent: () => boolean;
}

export type TaskLearningRefusal =
  | { readonly kind: 'not-done' }
  | { readonly kind: 'not-a-candidate' }
  | { readonly kind: 'was-dismissed' }
  /** A promotion of this version stands; it cannot be dismissed. */
  | { readonly kind: 'was-promoted' }
  | { readonly kind: 'no-store' }
  /** The version's promotion is recorded for a store the Project no longer has. */
  | { readonly kind: 'promotion-store-gone' }
  | { readonly kind: 'invalid'; readonly field: 'title' | 'text' }
  | { readonly kind: 'stale' }
  | { readonly kind: 'store-failed'; readonly error: unknown };

export type TaskLearningPromoteResult =
  | {
      readonly kind: 'promoted' | 'already-promoted';
      readonly rootId: string;
      readonly record: KitRecord;
    }
  | TaskLearningRefusal;

export type TaskLearningDismissOutcome =
  | {
      readonly kind: 'dismissed' | 'already-dismissed';
      readonly dismissal: TaskLearningDismissalRecord;
    }
  | TaskLearningRefusal;

const incarnationOf = (task: TaskRecord): TaskMemoryIncarnation => ({
  taskId: task.id,
  taskCreatedAt: task.createdAt,
});

/**
 * The knowledge record id a promotion of this record version writes: the
 * kind, key and version, readable in the store's files, then a digest of
 * the Task incarnation and that version (a re-created Task's records are new
 * ones). The fixed-length digest at the end keeps one candidate's id from
 * being a prefix of another's, since a store's `get` also resolves prefixes.
 */
export function taskLearningKnowledgeRecordId(
  incarnation: TaskMemoryIncarnation,
  record: { readonly kind: TaskLearningKind; key: string; version: number },
): string {
  const readable = `${KIND_SLUG[record.kind]}-${record.key}-v${record.version}`;
  const digest = createHash('sha256')
    .update(`${incarnation.taskId}\n${incarnation.taskCreatedAt}\n${readable}`)
    .digest('hex')
    .slice(0, 16);
  return `task-${readable}-${digest}`;
}

/** The Project's stores a person can promote into: writable, Project-scoped. */
async function projectStores(
  store: KnowledgeStoreProvider,
  projectSlug: string,
): Promise<KnowledgeStoreRoot[]> {
  return (await store.listRoots()).filter(
    (root) =>
      root.scope.kind === 'project' &&
      root.scope.projectSlug === projectSlug &&
      root.adapterId !== CONVERSATION_STORE_ADAPTER_ID,
  );
}

function standingCandidates(
  access: TaskLearningAccess,
): Array<TaskMemoryRecord & { kind: TaskLearningKind }> {
  const { decisions, deadEnds } = access.memory.listStandingRecords(
    incarnationOf(access.task),
  );
  return [...decisions, ...deadEnds] as Array<
    TaskMemoryRecord & { kind: TaskLearningKind }
  >;
}

/**
 * A store directory as one identity (review round 6): absolute, without
 * trailing separators, and through `realpath` when it exists, so `/tmp` and
 * `/private/tmp`, a trailing `/`, a `./` segment or a symlink name one
 * directory. A directory that no longer exists falls back to its resolved
 * path. The native `realpath` is used because it returns the filesystem's
 * own spelling: on a case-insensitive volume (macOS by default) `.../A`
 * and `.../a` come back as one path, which `realpathSync`'s JS form does
 * not do (review round 7). Paths are never lowercased by hand. Registration
 * stores the path as given, so every comparison goes through this.
 */
export function storeIdentity(storeRoot: string): string {
  const resolved = resolve(storeRoot);
  try {
    return realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

/**
 * The current Project store a promotion row pinned: the same adapter and
 * directory identity. A root id alone is not enough, since a removed
 * store's id is reused by the next store created (review round 5).
 */
function pinnedRoot(
  roots: readonly KnowledgeStoreRoot[],
  promotion: { readonly adapterId: string; readonly storeRoot: string },
): KnowledgeStoreRoot | undefined {
  const pinned = storeIdentity(promotion.storeRoot);
  return roots.find(
    (root) =>
      root.adapterId === promotion.adapterId &&
      storeIdentity(root.storeRoot) === pinned,
  );
}

type PromotionState =
  /** The record is in a current Project store. */
  | {
      readonly kind: 'promoted';
      readonly rootId: string;
      readonly record: KitRecord;
    }
  /** A promotion is recorded, its store is here, the record is not in it. */
  | { readonly kind: 'pending'; readonly target: KnowledgeStoreRoot }
  /** A promotion is recorded, the record is nowhere, its store is gone. */
  | { readonly kind: 'store-gone'; readonly rootId: string }
  /** No promotion recorded and no record. */
  | { readonly kind: 'none' };

/**
 * The one decision of a version's promotion state, which the candidate
 * list and `promoteTaskLearning` both use, so a read and a write can never
 * disagree (review round 6): promoted whenever the record is in ANY current
 * Project store; otherwise pending or store-gone by the pinned store.
 */
async function promotionState(
  store: KnowledgeStoreProvider,
  roots: readonly KnowledgeStoreRoot[],
  knowledgeRecordId: string,
  taskId: string,
  promotion:
    | {
        readonly rootId: string;
        readonly adapterId: string;
        readonly storeRoot: string;
      }
    | undefined,
): Promise<PromotionState> {
  const found = await findPromoted(store, roots, knowledgeRecordId, taskId);
  if (found) return { kind: 'promoted', ...found };
  if (!promotion) return { kind: 'none' };
  const target = pinnedRoot(roots, promotion);
  return target
    ? { kind: 'pending', target }
    : { kind: 'store-gone', rootId: promotion.rootId };
}

/** The store holding this id, if any: a promotion is read back, not recorded. */
async function findPromoted(
  store: KnowledgeStoreProvider,
  roots: readonly KnowledgeStoreRoot[],
  id: string,
  taskId: string,
): Promise<{ rootId: string; record: KitRecord } | undefined> {
  for (const root of roots) {
    const record = await (await store.adapterFor(root.id)).get(id);
    // `get` also resolves aliases and id prefixes; only the exact id counts.
    if (record?.id === id && isTaskLearningRecord(record, taskId))
      return { rootId: root.id, record };
  }
  return undefined;
}

/**
 * Whether a record with a candidate's id is this Task's promotion: written
 * by this process (`provenance.agent`) with this Task in its note. A person
 * can create a record under any id, so the id alone proves nothing (review
 * round 7).
 */
function isTaskLearningRecord(record: KitRecord, taskId: string): boolean {
  return (
    record.provenance?.agent === TASK_LEARNING_PROVENANCE_AGENT &&
    typeof record.provenance.note === 'string' &&
    record.provenance.note.split('\n').includes(`task: ${taskId}`)
  );
}

export async function readTaskLearning(
  store: KnowledgeStoreProvider,
  access: TaskLearningAccess,
): Promise<TaskLearningView> {
  const roots = await projectStores(store, access.projectSlug);
  const offered = access.task.status === 'done';
  const incarnation = incarnationOf(access.task);
  const candidates: TaskLearningCandidate[] = [];
  if (offered) {
    const dismissals = new Map(
      access.memory
        .listLearningDismissals(incarnation)
        .map((d) => [`${d.kind}:${d.key}:${d.version}`, d]),
    );
    const promotions = new Map(
      access.memory
        .listLearningPromotions(incarnation)
        .map((p) => [`${p.kind}:${p.key}:${p.version}`, p]),
    );
    for (const record of standingCandidates(access)) {
      const knowledgeRecordId = taskLearningKnowledgeRecordId(
        incarnation,
        record,
      );
      const identity = `${record.kind}:${record.key}:${record.version}`;
      const dismissed = dismissals.get(identity);
      const promotion = promotions.get(identity);
      // One state function for reads and writes (review round 6).
      const state = dismissed
        ? undefined
        : await promotionState(
            store,
            roots,
            knowledgeRecordId,
            access.task.id,
            promotion,
          );
      const review: TaskLearningCandidate['review'] = dismissed
        ? {
            state: 'dismissed',
            dismissedAt: dismissed.dismissedAt,
            dismissedBy: dismissed.principalId,
          }
        : state!.kind === 'promoted'
          ? { state: 'promoted', rootId: state!.rootId, knowledgeRecordId }
          : state!.kind === 'pending'
            ? { state: 'pending', rootId: state!.target.id }
            : state!.kind === 'store-gone'
              ? { state: 'promotion-store-gone', rootId: state!.rootId }
              : { state: 'open' };
      candidates.push({ record, knowledgeRecordId, review });
    }
  }
  const stores: TaskLearningStore[] = roots.map((root) => ({
    rootId: root.id,
    displayName: root.displayName,
  }));
  return {
    version: TASK_LEARNING_VERSION,
    taskId: access.task.id,
    offered,
    projectSlug: access.projectSlug,
    ...(access.task.workItemRef
      ? { workItemRef: access.task.workItemRef }
      : {}),
    stores,
    candidates,
    limits: TASK_LEARNING_LIMITS,
  };
}

/** The current candidate for this version, or why there is none. */
function candidateFor(
  access: TaskLearningAccess,
  wanted: TaskLearningDismissal,
):
  | { kind: 'candidate'; record: TaskMemoryRecord & { kind: TaskLearningKind } }
  | TaskLearningRefusal {
  if (access.task.status !== 'done') return { kind: 'not-done' };
  const record = standingCandidates(access).find(
    (r) =>
      r.kind === wanted.kind &&
      r.key === wanted.key &&
      r.version === wanted.version,
  );
  return record ? { kind: 'candidate', record } : { kind: 'not-a-candidate' };
}

function provenanceNote(
  access: TaskLearningAccess,
  record: TaskMemoryRecord,
): string {
  return [
    `Promoted by ${access.principalId} from Station Task memory.`,
    `task: ${access.task.id}`,
    `task created: ${access.task.createdAt}`,
    `record: ${record.kind}/${record.key} v${record.version}`,
    ...(access.task.workItemRef
      ? [`work item: ${access.task.workItemRef}`]
      : []),
  ].join('\n');
}

export async function promoteTaskLearning(
  store: KnowledgeStoreProvider,
  access: TaskLearningAccess,
  promotion: TaskLearningPromotion,
): Promise<TaskLearningPromoteResult> {
  const title = promotion.title.trim();
  const body = promotion.text.trim();
  if (!title || title.length > TASK_LEARNING_LIMITS.titleChars)
    return { kind: 'invalid', field: 'title' };
  if (!body || body.length > TASK_LEARNING_LIMITS.bodyChars)
    return { kind: 'invalid', field: 'text' };
  const found = candidateFor(access, promotion);
  if (found.kind !== 'candidate') return found;
  const { record } = found;
  const incarnation = incarnationOf(access.task);
  const dismissed = access.memory
    .listLearningDismissals(incarnation)
    .some(
      (d) =>
        d.kind === record.kind &&
        d.key === record.key &&
        d.version === record.version,
    );
  if (dismissed) return { kind: 'was-dismissed' };
  const roots = await projectStores(store, access.projectSlug);
  const root = roots.find((r) => r.id === promotion.rootId);
  if (!root) return { kind: 'no-store' };
  const id = taskLearningKnowledgeRecordId(incarnation, record);
  try {
    // Any Project store already holding this version: it was promoted.
    const before = await promotionState(
      store,
      roots,
      id,
      access.task.id,
      undefined,
    );
    if (before.kind === 'promoted')
      return {
        kind: 'already-promoted',
        rootId: before.rootId,
        record: before.record,
      };
    // The one decision across stores, made before the knowledge write.
    const claim = access.memory.claimLearningPromotion({
      ...incarnation,
      kind: record.kind,
      key: record.key,
      version: record.version,
      projectId: access.projectId,
      rootId: root.id,
      adapterId: root.adapterId,
      storeRoot: root.storeRoot,
      principalId: access.principalId,
      beforeCommit: access.isCurrent,
    });
    if (claim.kind === 'stale') return { kind: 'stale' };
    if (claim.kind === 'dismissed') return { kind: 'was-dismissed' };
    // The same state the candidate list reads. Its pinned store, by
    // identity, is the only place it is written; if that store is no
    // longer one of the Project's, nothing is written anywhere else.
    const state = await promotionState(
      store,
      roots,
      id,
      access.task.id,
      claim.promotion,
    );
    if (state.kind === 'promoted')
      return {
        kind: 'already-promoted',
        rootId: state.rootId,
        record: state.record,
      };
    if (state.kind !== 'pending') return { kind: 'promotion-store-gone' };
    const target = state.target;
    if (!access.isCurrent()) return { kind: 'stale' };
    const adapter = await store.adapterFor(target.id);
    try {
      await adapter.create({
        id,
        type: 'raw',
        title,
        body,
        category: CATEGORY[record.kind],
        tags: ['task-learning', KIND_SLUG[record.kind]],
        provenance: {
          agent: TASK_LEARNING_PROVENANCE_AGENT,
          ...(record.author.kind === 'session'
            ? { session_id: record.author.sessionId }
            : {}),
          note: provenanceNote(access, record),
        },
      });
    } catch (error) {
      // A concurrent promotion of the same version won the create: the store
      // refuses an existing id, so read back the record it wrote.
      const raced = await findPromoted(store, [target], id, access.task.id);
      if (raced) return { kind: 'already-promoted', ...raced };
      throw error;
    }
    const written = await adapter.get(id);
    if (!written)
      throw new Error('The promoted record could not be read back.');
    return { kind: 'promoted', rootId: target.id, record: written };
  } catch (error) {
    return { kind: 'store-failed', error };
  }
}

export function dismissTaskLearning(
  access: TaskLearningAccess,
  dismissal: TaskLearningDismissal,
): TaskLearningDismissOutcome {
  if (access.task.status !== 'done') return { kind: 'not-done' };
  const result = access.memory.dismissLearningCandidate({
    ...incarnationOf(access.task),
    ...dismissal,
    projectId: access.projectId,
    principalId: access.principalId,
    beforeCommit: access.isCurrent,
  });
  return result.kind === 'promoted' ? { kind: 'was-promoted' } : result;
}
